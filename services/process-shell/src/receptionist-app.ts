import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";

import { ConversationJobWorker, type ConversationJobHandlerContext, type ConversationJobWorkerOptions } from "./conversation-job-worker.js";
import { PostgresConversationJobs, type ClaimedConversationJob, type ConversationJobResult } from "./conversation-jobs.js";
import { ConversationCipher, PostgresConversationStore, type ConversationStore, type TransitionReceipt } from "./conversation-store.js";
import { conversationIdSchema, scopeOf, type ConversationScope } from "./conversation-contract.js";
import { createTwilioIngressVerifier } from "./conversation-ingress.js";
import { createReceptionistHttpHandler, type ControlledVoiceAdmissionPort, type ReceptionistHttpPorts } from "./receptionist-http.js";
import { voiceAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { createReceptionistSmsStatusHandler } from "./receptionist-sms-status.js";
import { ReceptionistSmsTurn, type SmsTurnInterpreter } from "./receptionist-sms-turn.js";
import { OpenAIReceptionistTextInterpreter } from "./receptionist-text-model.js";
import { BoundedSmsDispatcher, type SmsDispatchClaim, type SmsProvider } from "./sms-dispatcher.js";
import { TwilioSmsProvider } from "./twilio-sms-provider.js";
import type { ConversationObservation, ObservationContext } from "./conversation-observability.js";

type VoicePort = ReceptionistHttpPorts["voice"];
type OpenAIWebhookPort = (request: IncomingMessage) => Promise<void>;
type StaffGateway = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
type TransferFinishedPort = (input: { scope: ConversationScope; receipt: TransitionReceipt }) => Promise<void>;
export type ReceptionistMonitorPort = { ready(): Promise<boolean>; drain(): Promise<void> };
export type ReceptionistObservationPort = (context: ObservationContext, observation: ConversationObservation) => boolean;
type ReceptionistStore = ConversationStore & Pick<PostgresConversationStore, "admitInboundSms" | "getDispatchAttempt"> & {
  transportIsolationReady(): Promise<boolean>;
};
type ReceptionistJobs = Pick<PostgresConversationJobs, "claim" | "markEffectStarted" | "complete" | "recordLateEvidence" | "close">;
type SmsEffectOwner = { scope: ConversationScope; jobId: string; leaseToken: string; attemptId: string; messageId: string };
export type ReceptionistVoiceJobHandler = (job: ClaimedConversationJob, context: ConversationJobHandlerContext & { effectAttemptId: string }) => Promise<ConversationJobResult>;
export type ReceptionistEvaluationJobHandler = (job: ClaimedConversationJob, context: ConversationJobHandlerContext) => Promise<ConversationJobResult>;
export type ReceptionistVoiceJobHandlers = {
  accept: ReceptionistVoiceJobHandler;
  recovery: ReceptionistVoiceJobHandler;
  evaluation: ReceptionistEvaluationJobHandler;
  claimEffect(job: ClaimedConversationJob): Promise<{ attemptId: string } | null>;
};

export type ReceptionistApp = {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>;
  /** Compatibility access to the dedicated SMS-send lane. */
  readonly worker: ConversationJobWorker;
  readonly workers: {
    readonly voice: readonly ConversationJobWorker[];
    readonly recovery: ConversationJobWorker;
    readonly smsTurn: ConversationJobWorker;
    readonly smsSend: ConversationJobWorker;
    readonly timeout: ConversationJobWorker;
    readonly evaluation: ConversationJobWorker;
  };
  readonly health: () => Promise<boolean>;
  start(input?: { host?: string; port?: number }): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
};

/**
 * Isolated receptionist composition. It deliberately does not initialize the
 * database: migrations are an explicit deployment step, never a call-admission side effect.
 */
export function createReceptionistApp(options: {
  instance: VoiceAppInstance;
  databaseUrl: string;
  cipher: ConversationCipher;
  publicOrigin: string;
  twilioAuthToken: string;
  openAIApiKey: string;
  textModel: string;
  voice: VoicePort;
  openAIWebhook: OpenAIWebhookPort;
  staff: StaffGateway;
  voiceJobs: ReceptionistVoiceJobHandlers;
  onTransferFinished: TransferFinishedPort;
  monitor: ReceptionistMonitorPort;
  observe?: ReceptionistObservationPort;
  threadExpirySeconds?: number;
  smsProvider?: SmsProvider;
  smsInterpreter?: SmsTurnInterpreter;
  fullSmsTurn?: { handleSmsTurn(job: ClaimedConversationJob, context: { signal?: AbortSignal }): Promise<ConversationJobResult> };
  controlledTransfer?: ReceptionistHttpPorts["controlledTransfer"];
  controlledVoiceAdmission?: ControlledVoiceAdmissionPort;
  voiceRelease?: ReceptionistHttpPorts["voiceRelease"];
  audioAsset?: ReceptionistHttpPorts["audioAsset"];
  onSmsDelivered?(input: { scope: ConversationScope; messageId: string }): Promise<void>;
  store?: ReceptionistStore;
  jobs?: ReceptionistJobs;
  workerIdleMs?: number;
  shutdownGraceMs?: number;
  smsSubmitTimeoutMs?: number;
  smsShutdownGraceMs?: number;
  upgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}): ReceptionistApp {
  const instance = voiceAppInstanceSchema.parse(options.instance);
  if (instance.mode === "full" && options.fullSmsTurn === undefined) throw new Error("full_sms_driver_required");
  if (typeof options.voiceJobs?.accept !== "function" || typeof options.voiceJobs.recovery !== "function" || typeof options.voiceJobs.evaluation !== "function") throw new Error("voice_job_handlers_required");
  if (typeof options.monitor?.ready !== "function" || typeof options.monitor.drain !== "function") throw new Error("receptionist_monitor_required");
  const threadExpirySeconds = options.threadExpirySeconds ?? 86_400;
  const shutdownGraceMs = options.shutdownGraceMs ?? 1_000;
  if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1 || shutdownGraceMs > 30_000) throw new Error("receptionist_shutdown_grace_invalid");
  const ownsStore = options.store === undefined;
  const ownsJobs = options.jobs === undefined;
  const store = options.store ?? new PostgresConversationStore(options.databaseUrl, options.cipher);
  const jobs = options.jobs ?? new PostgresConversationJobs(options.databaseUrl, options.cipher);
  const verifyTwilio = createTwilioIngressVerifier({ publicOrigin: options.publicOrigin, accountSid: instance.accountId,
    authToken: options.twilioAuthToken, destination: instance.numberBinding.sourceNumberE164 });
  const observe = (conversationId: string, observation: ConversationObservation): void => {
    options.observe?.({ conversationId, instanceId: instance.instanceId, configVersion: instance.configVersion, promptVersion: instance.promptVersion }, observation);
  };

  // The worker serializes jobs. Claiming persists `submitting` before effect-start; the handler only sends that claim.
  const effectAttempts = new Map<string, string>();
  const smsEffects = new Map<string, { attemptId: string; send: boolean }>();
  const smsEffectOwners = new Map<string, SmsEffectOwner>();
  const effectKey = (job: Pick<ClaimedConversationJob, "id" | "leaseToken">) => `${job.id}:${job.leaseToken}`;
  const smsEffectOwnerKey = (scope: ConversationScope, messageId: string, attemptId: string) => JSON.stringify([scope.practiceId, scope.instanceId, scope.conversationId, messageId, attemptId]);
  const dispatcher = new BoundedSmsDispatcher({
    store,
    provider: options.smsProvider ?? new TwilioSmsProvider({ accountSid: instance.accountId, authToken: options.twilioAuthToken,
      from: instance.numberBinding.sourceNumberE164, ...(instance.numberBinding.whatsappSandboxNumberE164 === undefined ? {} : { whatsappSandboxNumberE164: instance.numberBinding.whatsappSandboxNumberE164 }),
      statusCallbackBaseUrl: new URL("/sms/status", options.publicOrigin).toString() }),
    ...(options.smsSubmitTimeoutMs === undefined ? {} : { submitTimeoutMs: options.smsSubmitTimeoutMs }),
    ...(options.smsShutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.smsShutdownGraceMs }),
    lateEvidence: async ({ scope, messageId, evidence }) => await appendSmsProviderEvidence(scope, messageId, evidence.attemptId,
      { code: "provider_accepted", providerId: evidence.providerId, attemptId: evidence.attemptId, state: "accepted" }),
    unresolvedTimedOutAttempts: async ({ attemptIds }) => {
      await Promise.all(attemptIds.map(async (attemptId) => {
        const owners = [...smsEffectOwners.values()].filter((candidate) => candidate.attemptId === attemptId);
        if (owners.length !== 1) throw new Error("sms_effect_owner_missing");
        const owner = owners[0]!;
        await appendSmsProviderEvidence(owner.scope, owner.messageId, attemptId,
          { code: "provider_unknown", attemptId, state: "unknown" });
      }));
    },
  });
  const interpreter = options.smsInterpreter ?? new OpenAIReceptionistTextInterpreter({ apiKey: options.openAIApiKey });
  const smsTurn = instance.mode === "full" ? options.fullSmsTurn! : new ReceptionistSmsTurn({ store, instance, model: options.textModel, interpreter });
  const workerOptions: Omit<ConversationJobWorkerOptions, "kinds"> = {
    jobs,
    scope: { practiceId: instance.practiceId, instanceId: instance.instanceId },
    ...(options.workerIdleMs === undefined ? {} : { idleMs: options.workerIdleMs }),
    gate: async (job) => {
      if (job.kind === "sms_send") return await claimSmsEffect(job);
      if (job.kind === "voice_accept" || job.kind === "voice_recovery") {
        const effect = await options.voiceJobs.claimEffect(job);
        if (effect === null || !validVoiceEffectAttemptId(effect.attemptId)) return { allowed: false, result: { code: "not_needed" } };
        effectAttempts.set(effectKey(job), effect.attemptId);
        return { allowed: true, effect };
      }
      return { allowed: true };
    },
    handlers: {
      sms_turn: async (job, context) => await observeJob(job, "interpretation", "sms", async () => await smsTurn.handleSmsTurn(job, { signal: context.signal })),
      sms_send: async (job, context) => await observeJob(job, "dispatch", "sms", async () => await submitSmsEffect(job, context.signal)),
      voice_accept: async (job, context) => await observeJob(job, "greeting", "voice", async () => await runVoiceJob(options.voiceJobs.accept, job, context)),
      voice_recovery: async (job, context) => await observeJob(job, "recovery", "voice", async () => await runVoiceJob(options.voiceJobs.recovery, job, context)),
      stub_timeout: async (job) => await observeJob(job, "transfer", "voice", async () => await finishStubTimeout(job)),
      post_call_eval: async (job, context) => {
        const channel = await channelOf(job);
        return await observeJob(job, "evaluation", channel, async () => await options.voiceJobs.evaluation(job, context));
      },
    },
    lateEvidence: async (evidence) => await jobs.recordLateEvidence(evidence),
  };
  const voiceWorkers = Array.from({ length: 3 }, () => new ConversationJobWorker({ ...workerOptions, kinds: ["voice_accept"] }));
  const recoveryWorker = new ConversationJobWorker({ ...workerOptions, kinds: ["voice_recovery"] });
  const smsTurnWorker = new ConversationJobWorker({ ...workerOptions, kinds: ["sms_turn"] });
  const smsSendWorker = new ConversationJobWorker({ ...workerOptions, kinds: ["sms_send"] });
  const timeoutWorker = new ConversationJobWorker({ ...workerOptions, kinds: ["stub_timeout"] });
  const evaluationWorker = new ConversationJobWorker({ ...workerOptions, kinds: ["post_call_eval"] });
  const workers = { voice: voiceWorkers, recovery: recoveryWorker, smsTurn: smsTurnWorker, smsSend: smsSendWorker, timeout: timeoutWorker, evaluation: evaluationWorker } as const;
  const allWorkers = [...voiceWorkers, recoveryWorker, smsTurnWorker, smsSendWorker, timeoutWorker, evaluationWorker];

  async function claimSmsEffect(job: ClaimedConversationJob) {
    const messageId = messageIdOf(job.payload);
    if (messageId === null) return { allowed: false, result: { code: "not_needed" } } as const;
    const current = await store.get(job.scope);
    const message = current?.messages.find((item) => item.id === messageId);
    if (current === null || message === undefined || current.suppressed) return { allowed: false, result: { code: "not_needed" } } as const;
    const key = effectKey(job);
    if (message.state === "submitting" && message.dispatchAttemptId !== null) {
      // A prior worker can only leave this state before effect-started; no provider call is permitted
      // until the effect row exists, so the recovered worker must submit the same durable attempt.
      const claim = await dispatcher.claim({ scope: job.scope, messageId, attemptId: message.dispatchAttemptId });
      if (claim === null) return { allowed: false, result: { code: "not_needed" } } as const;
      smsEffects.set(key, { attemptId: claim.attemptId, send: true });
      return { allowed: true, effect: { attemptId: claim.attemptId } } as const;
    }
    if (message.state !== "queued") return { allowed: false, result: { code: "not_needed" } } as const;
    const claim = await dispatcher.claim({ scope: job.scope, messageId, attemptId: `attempt-${randomUUID()}` });
    if (claim === null) return { allowed: false, result: { code: "not_needed" } } as const;
    smsEffects.set(key, { attemptId: claim.attemptId, send: true });
    return { allowed: true, effect: { attemptId: claim.attemptId } } as const;
  }

  async function observeJob(job: ClaimedConversationJob, stage: ConversationObservation["stage"], channel: "voice" | "sms", handler: () => Promise<ConversationJobResult>): Promise<ConversationJobResult> {
    const startedAt = Date.now();
    observe(job.scope.conversationId, { stage, result: "started", channel });
    try {
      const result = await handler();
      observe(job.scope.conversationId, { stage, result: observationResult(result), channel, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      observe(job.scope.conversationId, { stage, result: "failed", channel, durationMs: Date.now() - startedAt, reason: "provider_unavailable" });
      throw error;
    }
  }

  async function channelOf(job: ClaimedConversationJob): Promise<"voice" | "sms"> {
    return (await store.get(job.scope))?.admission.channel ?? "voice";
  }

  async function submitSmsEffect(job: ClaimedConversationJob, signal?: AbortSignal): Promise<ConversationJobResult> {
    const messageId = messageIdOf(job.payload);
    if (messageId === null) return { code: "not_needed" };
    const effect = smsEffects.get(effectKey(job));
    if (effect === undefined) return { code: "provider_unknown" };
    const ownerKey = smsEffectOwnerKey(job.scope, messageId, effect.attemptId);
    if (effect.send) smsEffectOwners.set(ownerKey, { scope: job.scope, jobId: job.id, leaseToken: job.leaseToken, attemptId: effect.attemptId, messageId });
    let retainEvidenceOwner = effect.send;
    try {
      if (!effect.send) return { code: "provider_unknown", attemptId: effect.attemptId, state: "unknown" };
      const claim: SmsDispatchClaim = { scope: job.scope, messageId, attemptId: effect.attemptId };
      const result = await dispatcher.submitClaim(claim, signal);
      retainEvidenceOwner = result.status === "outcome_unknown";
      if (result.status === "submitted" && result.providerEvidence !== undefined) {
        return { code: "provider_accepted", providerId: result.providerEvidence.providerId, attemptId: result.providerEvidence.attemptId, state: "accepted" };
      }
      if (result.status === "provider_rejected") return { code: "provider_failed", attemptId: result.attemptId, state: "failed" };
      if (result.status === "outcome_unknown") return { code: "provider_unknown", attemptId: result.attemptId, state: "unknown" };
      return { code: "not_needed" };
    } finally {
      smsEffects.delete(effectKey(job));
      if (!retainEvidenceOwner) smsEffectOwners.delete(ownerKey);
    }
  }

  async function appendSmsProviderEvidence(scope: ConversationScope, messageId: string, attemptId: string, result: Extract<ConversationJobResult, { code: "provider_accepted" | "provider_unknown" }>): Promise<void> {
    const owner = smsEffectOwners.get(smsEffectOwnerKey(scope, messageId, attemptId));
    if (owner === undefined) throw new Error("sms_effect_owner_missing");
    const recorded = await jobs.recordLateEvidence({ scope: owner.scope, jobId: owner.jobId, kind: "sms_send", leaseToken: owner.leaseToken,
      observedAt: new Date().toISOString(), result });
    if (!recorded) throw new Error("sms_late_evidence_unrecorded");
    if (result.code === "provider_accepted") smsEffectOwners.delete(smsEffectOwnerKey(scope, messageId, attemptId));
  }

  async function runVoiceJob(handler: ReceptionistVoiceJobHandler, job: ClaimedConversationJob, context: ConversationJobHandlerContext): Promise<ConversationJobResult> {
    const key = effectKey(job), effectAttemptId = effectAttempts.get(key);
    if (effectAttemptId === undefined) return { code: "provider_unknown" };
    try { return await handler(job, { ...context, effectAttemptId }); }
    finally { effectAttempts.delete(key); }
  }

  async function finishStubTimeout(job: ClaimedConversationJob): Promise<ConversationJobResult> {
    const transferId = transferIdOf(job.payload);
    if (transferId === null) return { code: "not_needed" };
    const eventId = `stub-timeout-${job.id}`;
    const existing = await store.getEvent(job.scope, eventId);
    if (existing !== null) {
      if (!existing.receipt.accepted || existing.input.command.type !== "transfer.finish" || existing.input.command.transferId !== transferId || existing.input.command.state !== "no_answer") return { code: "not_needed" };
      await options.onTransferFinished({ scope: job.scope, receipt: existing.receipt });
      return { code: "completed" };
    }
    const current = await store.get(job.scope);
    if (current === null || !sameScope(scopeOf(current), job.scope)) return { code: "not_needed" };
    const transfer = current.transfers.find((candidate) => candidate.id === transferId);
    if (transfer === undefined || transfer.state !== "trying" || transfer.voiceEpoch !== current.voiceEpoch || transfer.deadline !== job.availableAt) return { code: "not_needed" };
    const receipt = await store.execute({ scope: job.scope, eventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
      actor: { kind: "system", id: "receptionist-stub-timeout" }, command: { type: "transfer.finish", transferId, state: "no_answer" } });
    if (!receipt.accepted) return { code: "not_needed" };
    await options.onTransferFinished({ scope: job.scope, receipt });
    return { code: "completed" };
  }

  const smsStatus = createReceptionistSmsStatusHandler({ practiceId: instance.practiceId, instanceId: instance.instanceId,
    accountId: instance.accountId,
    getDispatchAttempt: (input) => store.getDispatchAttempt(input), dispatcher,
    ...(options.onSmsDelivered === undefined ? {} : { onDelivered: options.onSmsDelivered }) });
  const transportIsolationReady = async (): Promise<boolean> => {
    try { return await store.transportIsolationReady(); }
    catch { return false; }
  };
  const ready = async (): Promise<boolean> => {
    try { return await transportIsolationReady() && await store.ready() && await options.monitor.ready(); }
    catch { return false; }
  };
  let accepting = false;
  const handler = createReceptionistHttpHandler({ instance, threadExpirySeconds, ports: {
    ...(options.controlledTransfer === undefined ? {} : { controlledTransfer: async (input) => {
      if (!accepting) throw new Error("receptionist_stopping");
      return await options.controlledTransfer!(input);
    } }),
    ...(options.controlledVoiceAdmission === undefined ? {} : { controlledVoiceAdmission: options.controlledVoiceAdmission }),
    ready, verifyTwilio,
    ...(options.voiceRelease === undefined ? {} : { voiceRelease: options.voiceRelease }),
    ...(options.audioAsset === undefined ? {} : { audioAsset: options.audioAsset }),
    admitSms: async (input) => {
      if (!accepting) throw new Error("receptionist_stopping");
      const receipt = await store.admitInboundSms(input);
      observe(receipt.conversation.id, { stage: "admission", result: receipt.disposition === "accepted" ? "accepted" : "rejected", channel: "sms", revision: receipt.conversation.revision, ownerEpoch: receipt.conversation.ownerEpoch,
        ...(receipt.disposition === "accepted" ? {} : { reason: receipt.disposition === "suppressed" ? "suppressed" : "input_invalid" }) });
      return receipt;
    }, smsStatus: async (input) => {
      if (!accepting) throw new Error("receptionist_stopping");
      await smsStatus(input);
    },
    voice: async (input) => {
      if (!accepting) throw new Error("receptionist_stopping");
      const correlation = input.parameters.AccountSid !== undefined && input.parameters.CallSid !== undefined
        ? `${input.parameters.AccountSid}:${input.parameters.CallSid}` : "voice-unbound";
      const stage = input.kind === "recover" ? "recovery" : input.kind === "status" ? "disconnect" : "admission";
      observe(correlation, { stage, result: "started", channel: "voice" });
      try {
        const result = await options.voice(input);
        observe(correlation, { stage, result: "accepted", channel: "voice" });
        return result;
      } catch (error) {
        if (input.kind === "recover") {
          observe(correlation, { stage, result: "failed", channel: "voice", reason: "recovery_handler_failed",
            recoveryStage: input.recoveryStage, recoveryTarget: input.recoveryTarget });
        } else {
          observe(correlation, { stage, result: "failed", channel: "voice", reason: "provider_unavailable" });
        }
        throw error;
      }
    },
    openAIWebhook: async (request) => {
      if (!accepting) throw new Error("receptionist_stopping");
      await options.openAIWebhook(request);
    }, staff: async (request, response) => {
      if (!accepting) throw new Error("receptionist_stopping");
      await options.staff(request, response);
    },
  } });
  let server: Server | null = null;
  let stopped = false;
  let startPromise: Promise<{ host: string; port: number }> | null = null;
  let startupAbort: AbortController | null = null;
  const sockets = new Set<Socket>();

  return {
    handler,
    worker: smsSendWorker,
    workers,
    health: ready,
    async start(input = {}) {
      if (stopped) throw new Error("receptionist_app_stopped");
      if (startPromise !== null) return await startPromise;
      if (server !== null) return serverAddress(server);
      const starting = (async () => {
        const controller = new AbortController();
        startupAbort = controller;
        accepting = false;
        try {
          if (!await awaitStartup(transportIsolationReady(), controller.signal)) throw new Error("sms_transport_cutover_required");
          if (stopped) throw new Error("receptionist_app_stopped");
          const created = createServer((request, response) => { void handler(request, response); });
          server = created;
          created.on("upgrade", (request, socket, head) => {
            if (!accepting || options.upgrade === undefined) { socket.destroy(); return; }
            try { options.upgrade(request, socket, head); } catch { socket.destroy(); }
          });
          created.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
          try {
            await listenServer(created, input, controller.signal);
          } catch (error) {
            if (server === created) server = null;
            if (controller.signal.aborted) {
              await closeAbortedStartupCandidate(created, sockets, shutdownGraceMs);
              throw new Error("receptionist_app_stopped");
            }
            created.close();
            throw error;
          }
          if (stopped) {
            if (server === created) server = null;
            await closeServer(created, sockets, shutdownGraceMs);
            throw new Error("receptionist_app_stopped");
          }
          for (const lane of allWorkers) lane.start();
          accepting = true;
          return serverAddress(created);
        } finally {
          if (startupAbort === controller) startupAbort = null;
        }
      })();
      startPromise = starting;
      try { return await starting; }
      finally { if (startPromise === starting) startPromise = null; }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      accepting = false;
      let failure: Error | null = null;
      const pendingStartup = startPromise;
      startupAbort?.abort();
      if (pendingStartup !== null) {
        try { await pendingStartup; }
        catch (error) { if (!isStoppedStartup(error)) failure = asError(error); }
      }
      try { await closeServer(server, sockets, shutdownGraceMs); } catch (error) { failure = asError(error); }
      const workerStops = await Promise.allSettled(allWorkers.map(async (lane) => await lane.stop()));
      for (const result of workerStops) if (result.status === "rejected") failure ??= asError(result.reason);
      try {
        if (!await dispatcher.drainEvidence()) failure ??= new Error("sms_dispatch_evidence_not_drained");
      } catch (error) { failure ??= asError(error); }
      try { if (ownsJobs) await jobs.close(); } catch (error) { failure ??= asError(error); }
      try { if (ownsStore) await store.close(); } catch (error) { failure ??= asError(error); }
      if (failure !== null) throw failure;
    },
  };
}

function messageIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const messageId = (payload as Record<string, unknown>).messageId;
  return conversationIdSchema.safeParse(messageId).success ? messageId as string : null;
}

function transferIdOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const transferId = (payload as Record<string, unknown>).transferId;
  return typeof transferId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(transferId) ? transferId : null;
}

function sameScope(left: ConversationScope, right: ConversationScope): boolean {
  return left.practiceId === right.practiceId && left.instanceId === right.instanceId && left.conversationId === right.conversationId;
}

function validVoiceEffectAttemptId(value: string): boolean { return /^[A-Za-z0-9._:-]{1,200}$/.test(value); }

function observationResult(result: ConversationJobResult): ConversationObservation["result"] {
  if (result.code === "completed" || result.code === "provider_accepted") return "completed";
  if (result.code === "not_needed") return "stale";
  if (result.code === "provider_unknown") return "unknown";
  return "failed";
}

function serverAddress(server: Server): { host: string; port: number } {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("receptionist_server_address_missing");
  return { host: address.address, port: address.port };
}

async function awaitStartup<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      action();
    };
    const abort = () => finish(() => reject(new Error("receptionist_app_stopped")));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void operation.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

async function listenServer(server: Server, input: { host?: string; port?: number }, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      server.off("error", onError);
      server.off("listening", onListening);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onListening = () => finish(resolve);
    const onAbort = () => finish(() => reject(new Error("receptionist_app_stopped")));
    if (signal.aborted) { onAbort(); return; }
    server.once("error", onError);
    server.once("listening", onListening);
    signal.addEventListener("abort", onAbort, { once: true });
    try { server.listen({ port: input.port ?? 0, host: input.host ?? "127.0.0.1", signal }); }
    catch (error) { finish(() => reject(error)); }
  });
}

async function closeAbortedStartupCandidate(server: Server, sockets: ReadonlySet<Socket>, graceMs: number): Promise<void> {
  const wasListening = server.listening;
  try { await closeServer(server, sockets, graceMs); }
  catch (error) {
    if (!wasListening && (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") return;
    throw error;
  }
}

async function closeServer(server: Server | null, sockets: ReadonlySet<Socket>, graceMs: number): Promise<void> {
  if (server === null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, graceMs);
    timer.unref();
    server.close((error) => {
      clearTimeout(timer);
      error === undefined ? resolve() : reject(error);
    });
  });
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error("receptionist_shutdown_failed"); }

function isStoppedStartup(value: unknown): boolean { return value instanceof Error && value.message === "receptionist_app_stopped"; }
