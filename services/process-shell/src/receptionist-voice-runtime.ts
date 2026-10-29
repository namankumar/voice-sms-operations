import { z } from "zod";
import type { ReceptionistVoiceJobHandler } from "./receptionist-app.js";
import type { ConversationScope, RecoveryFailureDomain } from "./conversation-contract.js";
import type { ConversationStore, TransitionReceipt } from "./conversation-store.js";
import type { SpeechMonitor, SpeechReview } from "./conversation-monitor.js";
import { compileReceptionistPrompt, voiceAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { RECEPTIONIST_REALTIME_MODEL, RECEPTIONIST_TRANSCRIPTION_MODEL, type ProtectedSidebandClose, type ProtectedSidebandEvent, type ReceptionistOpenAIAdapter, type SanitizedSidebandError } from "./receptionist-openai.js";
import type { PostgresSipBindings } from "./receptionist-sip-binding.js";
import { ReceptionistVoiceSession, type FullModeVoiceDriver } from "./receptionist-voice-session.js";
import type { RealtimeUsage } from "./receptionist-usage.js";
import { startupErrors, type VoiceControlTrace } from "./receptionist-voice-control-observer.js";
import type { ControlledActionConfirmationFailurePort } from "./controlled-action-confirmation-failure.js";
import type { ControlledTransferCoordinator } from "./controlled-transfer-coordinator.js";

const payloadSchema = z.object({ attemptId: z.string().uuid(), callId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), voiceEpoch: z.number().int().nonnegative() }).strict();
type SidebandInput = { kind: "event"; value: ProtectedSidebandEvent } | { kind: "error"; value: SanitizedSidebandError } | { kind: "close"; value: ProtectedSidebandClose };
type LiveSession = { scope: ConversationScope; attemptId: string; voiceEpoch: number; callId: string; session: ReceptionistVoiceSession };

/** Live-session owner for this process. Durable bindings and job fences remain authoritative across restarts. */
export class ReceptionistVoiceRuntime {
  private readonly instance: VoiceAppInstance;
  private readonly sessions = new Map<string, ReceptionistVoiceSession>();
  /** Only a fully opened sideband is eligible for monitor or timeout callbacks. */
  private readonly liveSessions = new Map<string, LiveSession>();
  private readonly accepting = new Set<string>();
  private readonly disconnected = new Set<string>();
  private readonly recoveryTasks = new Map<string, () => Promise<void>>();
  private readonly heartbeatStops = new Map<string, () => void>();
  private readonly monitorDrains = new Map<string, Promise<void>>();
  private readonly monitorDrainFailures = new Map<string, Error>();
  private stopped = false;
  constructor(private readonly options: {
    instance: VoiceAppInstance; voice: string;
    /** Full voice admissions are disabled unless their server-owned driver is installed. */
    fullMode?: FullModeVoiceDriver;
    store: Pick<ConversationStore, "get" | "execute" | "getEvent">;
    bindings: Pick<PostgresSipBindings, "get" | "requestClose" | "cancelClose">;
    provider: Pick<ReceptionistOpenAIAdapter, "accept" | "connectSideband" | "hangup">;
    recover(input: { scope: ConversationScope; callId: string; voiceEpoch: number; ownerEpoch?: number; failureDomain?: RecoveryFailureDomain }): Promise<void>;
    /** Publishes the post-accept recovery path when the in-memory watchdog cannot persist it. */
    enqueueRecovery(input: { scope: ConversationScope; callId: string; voiceEpoch: number }): Promise<void>;
    monitor?: Pick<SpeechMonitor, "observe" | "drain">;
    onUsage?: (input: { scope: ConversationScope; model: string; usage: RealtimeUsage }) => void;
    onControlTrace?: (input: { scope: ConversationScope; callId: string; trace: VoiceControlTrace }) => void;
    onControlledOfferDrain?: (input: { scope: ConversationScope; responseId: string; outputItemId: string; ownerEpoch: number; voiceEpoch: number }) => Promise<void>;
    controlledActionConfirmationFailure?: ControlledActionConfirmationFailurePort;
    controlledTransfer?: Pick<ControlledTransferCoordinator, "start">;
    simulatedRoute?: { outcome: "staff_answered" | "no_answer" | "after_hours"; recorder: { record(input: { scope: ConversationScope; requestId: string; sourceId: string; requestRevision: number; ownerEpoch: number; category: "scheduling" | "referrals" | "billing_or_insurance" | "clinical" | "records_or_administrative" | "general_or_uncertain"; outcome: "staff_answered" | "no_answer" | "after_hours" }): Promise<TransitionReceipt> } };
    now?: () => Date;
  }) { this.instance = voiceAppInstanceSchema.parse(options.instance); }

  readonly accept: ReceptionistVoiceJobHandler = async (job, context) => {
    if (this.stopped || context.signal.aborted || job.kind !== "voice_accept") return { code: "not_needed" };
    if (this.instance.mode === "full" && this.options.fullMode === undefined) return { code: "not_needed" };
    const payload = payloadSchema.parse(job.payload);
    if (job.scope.practiceId !== this.instance.practiceId || job.scope.instanceId !== this.instance.instanceId) throw new Error("voice_job_scope_mismatch");
    if (this.sessions.has(payload.callId) || this.accepting.has(payload.callId)) return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
    const overCapacity = this.sessions.size + this.accepting.size >= 32;
    this.accepting.add(payload.callId);
    this.monitorDrainFailures.delete(payload.callId);
    let durable, current;
    try {
      durable = await this.options.bindings.get(job.scope, payload.attemptId);
      current = await this.options.store.get(job.scope);
    } catch {
      this.accepting.delete(payload.callId); this.disconnected.delete(payload.callId);
      throw new Error("voice_binding_read_failed");
    }
    if (this.stopped || context.signal.aborted || this.disconnected.has(payload.callId) || !durable || durable.callId !== payload.callId
      || durable.binding.voiceEpoch !== payload.voiceEpoch || !current || current.phase !== "active" || current.voiceEpoch !== payload.voiceEpoch || current.providerTier !== "realtime") {
      this.accepting.delete(payload.callId); this.disconnected.delete(payload.callId);
      return { code: "not_needed" };
    }
    let session: ReceptionistVoiceSession | null = null;
    let recoveryStarted = false;
    let recoveryFailed = false;
    let recoveryPromise: Promise<void> | null = null;
    let recoveryWork: Promise<void> | null = null;
    const recover = async (ownerEpoch?: number, failureDomain: RecoveryFailureDomain = "openai_provider_or_scope_unknown") => {
      if (recoveryStarted) return;
      if (recoveryPromise) return recoveryPromise;
      this.stopHeartbeat(payload.callId);
      recoveryWork ??= this.options.recover({ scope: job.scope, callId: payload.callId, voiceEpoch: payload.voiceEpoch,
        ownerEpoch: ownerEpoch ?? current.ownerEpoch, failureDomain }).then(() => {
        recoveryStarted = true;
        if (session !== null) this.retainMonitorDrain(payload.callId, session);
        session?.close();
        this.dropSession(payload.callId);
        this.recoveryTasks.delete(payload.callId);
      }).finally(() => { recoveryWork = null; });
      recoveryPromise = boundedRecovery(recoveryWork).catch(async () => {
        recoveryFailed = true;
        // The durable transition is unconfirmed. Publish an idempotent recovery
        // job before releasing the sideband; the worker owns later retries.
        await this.options.enqueueRecovery({ scope: job.scope, callId: payload.callId, voiceEpoch: payload.voiceEpoch });
        if (session !== null) this.retainMonitorDrain(payload.callId, session);
        session?.close();
        this.dropSession(payload.callId);
        this.recoveryTasks.delete(payload.callId);
        throw new Error("voice_recovery_not_persisted");
      }).finally(() => { recoveryPromise = null; });
      return recoveryPromise;
    };
    this.recoveryTasks.set(payload.callId, recover);
    const discardStartup = () => {
      if (session !== null) this.retainMonitorDrain(payload.callId, session);
      session?.close();
      this.dropSession(payload.callId);
      this.recoveryTasks.delete(payload.callId);
    };
    const buffered: SidebandInput[] = [];
    let bufferOverflow = false;
    let initialized = false;
    let terminalObserved = false;
    let startupStage: NonNullable<VoiceControlTrace["startupStage"]> = "prompt";
    const traceRuntimeFailure = (failureClass: "runtime_event_exception" | "runtime_accept_exception", error?: unknown) => {
      const code = error instanceof Error ? error.message : "other";
      const startupError = startupErrors.find((value) => value === code) ?? "other";
      try { this.options.onControlTrace?.({ scope: job.scope, callId: payload.callId, trace: { event: "control_failure", failureClass,
        ...(failureClass === "runtime_accept_exception" ? { startupStage, startupError } : {}) } }); }
      catch { /* Observation cannot affect call recovery. */ }
    };
    const deliver = (input: SidebandInput): void => {
      if (input.kind === "close" || (input.kind === "error" && input.value.code !== "sideband_invalid_event")) terminalObserved = true;
      if (session === null || !initialized) {
        if (buffered.length >= 64) bufferOverflow = true; else buffered.push(input);
        return;
      }
      const eventOwnerEpoch = session.currentRecoveryOwnerEpoch() ?? current.ownerEpoch;
      const work = input.kind === "event" ? session.onSidebandEvent(input.value)
        : input.kind === "error" ? session.onSidebandError(input.value) : session.onSidebandClose(input.value);
      void work.catch(() => { traceRuntimeFailure("runtime_event_exception"); return recover(eventOwnerEpoch); })
        .catch(() => { session?.close(); });
    };
    try {
      if (context.signal.aborted) return { code: "not_needed" };
      if (overCapacity) {
        await recover();
        return { code: "provider_failed", attemptId: context.effectAttemptId, providerId: payload.callId, state: "failed" };
      }
      const initialPrompt = this.instance.mode === "receptionist"
        ? compileReceptionistPrompt(this.instance, current)
        : await this.options.fullMode!.prompt({ reason: "opening", conversation: structuredClone(current),
          binding: { scope: job.scope, voiceEpoch: payload.voiceEpoch, callId: payload.callId }, signal: context.signal });
      if (context.signal.aborted || this.stopped || this.disconnected.has(payload.callId)) return { code: "not_needed" };
      startupStage = "accept";
      const result = await this.options.provider.accept({ callId: payload.callId, prompt: initialPrompt, voice: this.options.voice });
      if (this.disconnected.has(payload.callId)) return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      if (result.kind !== "accepted") {
        await recover(undefined, result.kind === "rejected" && [401, 403, 429].includes(result.status) ? "openai_account_or_quota" : "openai_provider_or_scope_unknown");
        return { code: result.kind === "rejected" ? "provider_failed" : "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      }
      if (context.signal.aborted || this.stopped) { await recover(); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      startupStage = "connect";
      const port = await this.options.provider.connectSideband({ callId: payload.callId,
        onEvent: (value) => deliver({ kind: "event", value }), onError: (value) => deliver({ kind: "error", value }), onClose: (value) => deliver({ kind: "close", value }) });
      if (this.disconnected.has(payload.callId)) { port.close(); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      const terminalBuffered = buffered.some((input) => input.kind === "close" || (input.kind === "error" && input.value.code !== "sideband_invalid_event"));
      if (bufferOverflow || terminalBuffered || context.signal.aborted || this.stopped) { port.close(); await recover(); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      startupStage = "session_start";
      session = new ReceptionistVoiceSession({ instance: this.instance, model: RECEPTIONIST_REALTIME_MODEL, store: this.options.store,
        binding: { scope: job.scope, voiceEpoch: payload.voiceEpoch, callId: payload.callId }, port,
        empatheticClosing: true, controlledCallback: this.instance.mode === "receptionist",
        recordCloseIntent: async (callId) => {
          if (callId !== payload.callId) throw new Error("voice_close_call_mismatch");
          await this.options.bindings.requestClose(job.scope, payload.attemptId, callId);
        },
        cancelCloseIntent: async (callId) => {
          if (callId !== payload.callId) throw new Error("voice_close_call_mismatch");
          await this.options.bindings.cancelClose(job.scope, payload.attemptId, callId);
        },
        hangup: async (callId) => await this.options.provider.hangup(callId),
        onUsage: (usage) => this.options.onUsage?.({ scope: job.scope,
          model: usage.kind === "transcription" ? RECEPTIONIST_TRANSCRIPTION_MODEL : RECEPTIONIST_REALTIME_MODEL, usage }),
        onControlTrace: (trace) => this.options.onControlTrace?.({ scope: job.scope, callId: payload.callId, trace }),
        ...(this.options.onControlledOfferDrain === undefined ? {} : { onControlledOfferDrain: this.options.onControlledOfferDrain }),
        ...(this.options.controlledActionConfirmationFailure === undefined ? {} : { controlledActionConfirmationFailure: this.options.controlledActionConfirmationFailure }),
        ...(this.options.controlledTransfer === undefined ? {} : { controlledTransfer: this.options.controlledTransfer }),
        ...(this.options.simulatedRoute === undefined ? {} : { simulatedRoute: this.options.simulatedRoute }),
        openingOwnerEpoch: current.ownerEpoch,
        recovery: async (input) => { await recover(input.ownerEpoch, input.failureDomain); },
        ...(this.instance.mode === "full" ? { fullMode: this.options.fullMode!, initialPrompt } : {}),
        ...(this.options.monitor === undefined ? {} : { monitor: this.options.monitor }),
        monitorFailure: async (input) => { await recover(input.ownerEpoch); } });
      this.sessions.set(payload.callId, session);
      const startup = new AbortController();
      let startupInterrupted: "deadline" | "aborted" | null = null;
      let interruptStartup!: (reason: "deadline" | "aborted") => void;
      const interrupted = new Promise<void>((resolve) => {
        interruptStartup = (reason) => {
          if (startupInterrupted !== null) return;
          startupInterrupted = reason;
          startup.abort();
          // Close before accepting the timeout branch so a late store read
          // cannot activate a response owner on this sideband.
          session?.close();
          resolve();
        };
      });
      const abortStartup = () => interruptStartup("aborted");
      context.signal.addEventListener("abort", abortStartup, { once: true });
      const startupTimer = setTimeout(() => interruptStartup("deadline"), this.instance.latency.textGenerationDeadlineMs);
      const started = await (async () => {
        try { return await Promise.race([session.start(startup.signal), interrupted.then(() => ({ kind: "ignored" } as const))]); }
        finally {
          clearTimeout(startupTimer);
          context.signal.removeEventListener("abort", abortStartup);
        }
      })();
      if (startupInterrupted === "deadline") {
        if (!this.stopped && !context.signal.aborted && !this.disconnected.has(payload.callId)) await recover(current.ownerEpoch);
        else discardStartup();
        return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      }
      if (startupInterrupted === "aborted" || this.stopped || context.signal.aborted || this.disconnected.has(payload.callId)) {
        discardStartup();
        return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      }
      if (started.kind !== "opened") { session.close(); await recover(current.ownerEpoch); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      this.liveSessions.set(scopeKey(job.scope), { scope: job.scope, attemptId: payload.attemptId, voiceEpoch: payload.voiceEpoch, callId: payload.callId, session });
      startupStage = "buffer_drain";
      while (buffered.length > 0) {
        const input = buffered.shift()!;
        if (input.kind === "event") await session.onSidebandEvent(input.value);
        else if (input.kind === "error") await session.onSidebandError(input.value);
        else await session.onSidebandClose(input.value);
      }
      initialized = true;
      if (this.disconnected.has(payload.callId)) { session.close(); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      if (terminalObserved || bufferOverflow || recoveryPromise || recoveryStarted) {
        await recover();
        return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      }
      startupStage = "heartbeat";
      await this.startHeartbeat(payload.callId, job.scope, payload.voiceEpoch, recover,
        () => session?.currentRecoveryOwnerEpoch() ?? current.ownerEpoch);
      if (this.disconnected.has(payload.callId)) { session.close(); return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId }; }
      if (terminalObserved || bufferOverflow || recoveryPromise || recoveryStarted) {
        await recover();
        return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
      }
      return { code: "provider_accepted", attemptId: context.effectAttemptId, providerId: payload.callId, state: "accepted" };
    } catch (error) {
      traceRuntimeFailure("runtime_accept_exception", error);
      session?.close();
      if (recoveryFailed) throw new Error("voice_recovery_not_persisted");
      if (!this.stopped && !context.signal.aborted && !this.disconnected.has(payload.callId)) await recover(current.ownerEpoch,
        startupStage === "connect" && error instanceof Error && error.message === "openai_sideband_connect_timeout"
          ? "realtime_transport_only" : "openai_provider_or_scope_unknown");
      else discardStartup();
      return { code: "provider_unknown", attemptId: context.effectAttemptId, providerId: payload.callId };
    } finally {
      this.accepting.delete(payload.callId);
      if (this.disconnected.delete(payload.callId)) this.recoveryTasks.delete(payload.callId);
    }
  };

  disconnect(callId: string): void {
    if (this.accepting.has(callId)) this.disconnected.add(callId);
    this.stopHeartbeat(callId);
    const session = this.sessions.get(callId);
    if (session !== undefined) this.retainMonitorDrain(callId, session);
    session?.close(); this.dropSession(callId); this.recoveryTasks.delete(callId);
  }

  /** Retains the sideband while a staff ownership transition fences stale AI output. */
  async onOwnershipChanged(input: { scope: ConversationScope; ownerEpoch: number }): Promise<void> {
    const live = this.liveSessions.get(scopeKey(input.scope));
    if (live === undefined || !sameScope(live.scope, input.scope) || this.sessions.get(live.callId) !== live.session) return;
    const state = await this.options.store.get(input.scope).catch(() => null);
    if (state === null || state.phase !== "active" || state.voiceEpoch !== live.voiceEpoch || state.ownerEpoch !== input.ownerEpoch) return;
    await live.session.onOwnershipChanged({ owner: state.owner, ownerEpoch: state.ownerEpoch });
  }

  /** Delivers a monitor correction only to the current sideband bound to this durable voice epoch. */
  async correctSpeech(input: { scope?: ConversationScope; review: SpeechReview; directive: string; signal?: AbortSignal }): Promise<"generated" | "unheard"> {
    const scope = input.scope ?? input.review.scope;
    if (input.signal?.aborted || !sameScope(scope, input.review.scope)) return "unheard";
    const live = await this.currentLiveSession(scope, input.review.voiceEpoch, input.signal);
    if (live === null) return "unheard";
    return await live.session.correctSpeech(input.review, input.directive, input.signal);
  }

  /** Delivers a committed transfer timeout only to its still-owning live sideband. */
  async onTransferFinished(input: { scope: ConversationScope; receipt: TransitionReceipt }): Promise<void> {
    const live = await this.currentLiveSession(input.scope, undefined);
    if (live === null) return;
    const durable = await this.options.store.getEvent(input.scope, input.receipt.eventId).catch(() => null);
    if (durable === null || !durable.receipt.accepted || !sameScope(durable.input.scope, input.scope)
      || durable.input.command.type !== "transfer.finish" || durable.receipt.eventId !== input.receipt.eventId) return;
    await live.session.onDurableChange(input.receipt).catch(() => undefined);
  }
  /** Terminal handlers may await this before evaluating; disconnect itself remains non-blocking. */
  async drainMonitor(callId: string): Promise<void> {
    const live = this.sessions.get(callId);
    if (live !== undefined) return await live.drainMonitor();
    await this.monitorDrains.get(callId);
    const failure = this.monitorDrainFailures.get(callId);
    if (failure !== undefined) throw failure;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const stop of this.heartbeatStops.values()) stop();
    this.heartbeatStops.clear();
    const results = await Promise.allSettled([...this.recoveryTasks.values()].map((recover) => recover()));
    for (const [callId, session] of this.sessions) this.retainMonitorDrain(callId, session);
    const monitorResults = await Promise.allSettled([...this.monitorDrains.values()]);
    let monitorFailed = this.monitorDrainFailures.size > 0 || monitorResults.some((result) => result.status === "rejected");
    try { await this.options.monitor?.drain(); }
    catch { monitorFailed = true; }
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.liveSessions.clear();
    if (results.some((result) => result.status === "rejected")) throw new Error("voice_shutdown_recovery_pending");
    if (monitorFailed || this.monitorDrainFailures.size > 0) throw new Error("voice_shutdown_monitor_pending");
  }
  get activeCount(): number { return this.sessions.size; }

  private async startHeartbeat(callId: string, scope: ConversationScope, voiceEpoch: number,
    recover: (ownerEpoch?: number) => Promise<void>, currentOwnerEpoch: () => number): Promise<void> {
    let stopped = false, running = false, sequence = 1;
    let interval: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (interval !== undefined) clearInterval(interval);
      this.heartbeatStops.delete(callId);
    };
    const beat = async (): Promise<void> => {
      if (stopped || running || this.stopped) return;
      running = true;
      try {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const state = await this.options.store.get(scope);
          if (state === null || state.admission.channel !== "voice" || state.phase !== "active" || state.voiceEpoch !== voiceEpoch) throw new Error("voice_heartbeat_state_invalid");
          const now = this.options.now?.() ?? new Date();
          const leaseUntil = new Date(now.getTime() + 45_000).toISOString();
          const receipt = await this.options.store.execute({ scope, eventId: `voice-heartbeat-${callId}-${sequence++}`,
            expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "system", id: "receptionist-voice-runtime" },
            command: { type: "conversation.heartbeat", voiceEpoch, leaseUntil } });
          if (receipt.accepted) return;
          if (receipt.error !== "stale_revision") throw new Error("voice_heartbeat_rejected");
        }
        throw new Error("voice_heartbeat_conflict_exhausted");
      } finally { running = false; }
    };
    const fail = (ownerEpoch: number) => { stop(); void recover(ownerEpoch).catch(() => undefined); };
    this.heartbeatStops.set(callId, stop);
    try { await beat(); }
    catch (error) { stop(); throw error; }
    if (stopped || this.stopped) return;
    interval = setInterval(() => { const ownerEpoch = currentOwnerEpoch(); void beat().catch(() => fail(ownerEpoch)); }, 15_000);
    interval.unref();
  }

  private stopHeartbeat(callId: string): void { this.heartbeatStops.get(callId)?.(); }
  private dropSession(callId: string): void {
    this.sessions.delete(callId);
    for (const [key, live] of this.liveSessions) if (live.callId === callId) this.liveSessions.delete(key);
  }
  private async currentLiveSession(scope: ConversationScope, voiceEpoch: number | undefined, signal?: AbortSignal): Promise<LiveSession | null> {
    if (this.stopped || signal?.aborted || scope.practiceId !== this.instance.practiceId || scope.instanceId !== this.instance.instanceId) return null;
    const live = this.liveSessions.get(scopeKey(scope));
    if (live === undefined || !sameScope(live.scope, scope) || (voiceEpoch !== undefined && live.voiceEpoch !== voiceEpoch)
      || this.sessions.get(live.callId) !== live.session) return null;
    try {
      const [state, binding] = await Promise.all([this.options.store.get(scope), this.options.bindings.get(scope, live.attemptId)]);
      if (signal?.aborted || state === null || state.phase !== "active" || state.voiceEpoch !== live.voiceEpoch || state.providerTier !== "realtime"
        || binding === null || binding.callId !== live.callId || binding.binding.voiceEpoch !== live.voiceEpoch || !sameScope(binding.binding.scope, scope)) return null;
      return live;
    } catch { return null; }
  }
  private retainMonitorDrain(callId: string, session: ReceptionistVoiceSession): void {
    if (this.monitorDrains.has(callId)) return;
    const work = session.drainMonitor().catch(() => {
      const failure = new Error("voice_monitor_drain_failed");
      this.monitorDrainFailures.set(callId, failure);
      while (this.monitorDrainFailures.size > 64) this.monitorDrainFailures.delete(this.monitorDrainFailures.keys().next().value!);
      throw failure;
    });
    this.monitorDrains.set(callId, work);
    void work.then(
      () => { if (this.monitorDrains.get(callId) === work) this.monitorDrains.delete(callId); },
      () => { if (this.monitorDrains.get(callId) === work) this.monitorDrains.delete(callId); },
    );
  }
}

async function boundedRecovery(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("voice_recovery_deadline")), 5_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}

function scopeKey(scope: ConversationScope): string { return JSON.stringify([scope.practiceId, scope.instanceId, scope.conversationId]); }
function sameScope(left: ConversationScope, right: ConversationScope): boolean {
  return left.practiceId === right.practiceId && left.instanceId === right.instanceId && left.conversationId === right.conversationId;
}
