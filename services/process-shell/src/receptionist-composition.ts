import { verifyReceptionistVoicePromotion } from "./receptionist-voice-promotion.js";
import { ReceptionistTransferAudioAssets } from "./receptionist-transfer-audio.js";
import { OpenAIRealtimeProvider, OpenAIStreamingSpeechProvider, TwilioMediaStreamsProvider, TwilioHmacRequestValidator, WsOpenAIRealtimeSocketFactory, type RealtimeVoiceProvider, type OpenAIRealtimeEvent, type SpeechFetch } from "@salven/voice-runtime";
import { ReceptionistCallbackAudioSession } from "./receptionist-callback-audio.js";
import { CALLBACK_SPEECH_MODEL, CALLBACK_SPEECH_DELIVERY, CALLBACK_VAD, resolveReceptionistVoiceReleaseProfile } from "./receptionist-voice-config.js";
import { receptionistVoiceReleaseProfileHash, type ReceptionistVoiceReleaseProfile } from "./receptionist-voice-release.js";
import { parseReceptionistCandidateFixtureId } from "./receptionist-voice-candidate.js";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Conversation, ConversationScope } from "./conversation-contract.js";
import type { SpeechMonitor } from "./conversation-monitor.js";
import { PostgresConversationJobs } from "./conversation-jobs.js";
import { ConversationCipher, PostgresConversationStore, type TransitionReceipt } from "./conversation-store.js";
import { createConversationStaffExtension, type ConversationConsoleView } from "./conversation-staff.js";
import { ConversationScriptedTextSink, ReceptionistFallbackRenderer, ReceptionistFallbackTransport, type FallbackTransportAuthenticator } from "./receptionist-fallback.js";
import { createConversationObserver, type ConversationObservation } from "./conversation-observability.js";
import { createRealtimeUsageObserver } from "./receptionist-usage.js";
import { createVoiceControlObserver } from "./receptionist-voice-control-observer.js";
import { ConversationEvaluationWorker } from "./conversation-evaluation.js";
import { createEvaluationPersistence } from "./conversation-evaluation-store.js";
import { ReceptionistOpenAIAdapter, RECEPTIONIST_REALTIME_MODEL, RECEPTIONIST_TRANSCRIPTION_MODEL, type SidebandSocketFactory } from "./receptionist-openai.js";
import { OpenAIWebhookVerifier, WsOpenAISidebandSocketFactory } from "./receptionist-openai-transport.js";
import type { VoiceAppInstance } from "./receptionist-policy.js";
import type { SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import { ReceptionistRecoveryController } from "./receptionist-recovery.js";
import { createReceptionistSipIngress } from "./receptionist-sip-ingress.js";
import { PostgresSipBindings } from "./receptionist-sip-binding.js";
import { TwilioParentCallPort } from "./twilio-parent-call.js";
import { ReceptionistVoiceRuntime } from "./receptionist-voice-runtime.js";
import { createReceptionistApp, type ReceptionistApp, type ReceptionistVoiceJobHandlers } from "./receptionist-app.js";
import type { AuthenticatedStaffExtension } from "./staff-extension.js";
import { createRelayUpgrade } from "./receptionist-relay-upgrade.js";
import { ReceptionistRelaySession } from "./receptionist-relay.js";
import { OpenAIReceptionistRelayInterpreter, OpenAIReceptionistTextInterpreter, type ReceptionistTextTransport } from "./receptionist-text-model.js";
import type { SmsProvider } from "./sms-dispatcher.js";
import { createF2Runtime } from "./f2-runtime.js";
import { ControlledTestTransfer, type ControlledTransferMap } from "./controlled-test-transfer.js";
import { ControlledTransferCoordinator } from "./controlled-transfer-coordinator.js";
import { createControlledTransferHttp } from "./controlled-transfer-http.js";
import { sipDialTwiml } from "./receptionist-sip-binding.js";
import { TwilioCallRecordingsPort } from "./twilio-call-recordings.js";
import { RecordingTranscriptProcessor } from "./recording-transcript.js";
import { PostgresRecordingTranscriptStore } from "./recording-transcript-store.js";
import { PostgresControlledSyntheticVoiceFixtures, type ControlledSyntheticVoiceFixture } from "./controlled-synthetic-voice-fixture.js";
import { PostgresControlledVoiceRendezvous } from "./controlled-voice-rendezvous.js";
import { PostgresControlledActionConfirmationFailure } from "./controlled-action-confirmation-failure.js";
import { SimulatedRouteOutcomeRecorder } from "./simulated-route-outcome.js";

export type ConfiguredReceptionistMonitor = Pick<SpeechMonitor, "observe" | "drain"> & {
  /** Configuration and local dependencies are verified here; provider canaries remain a separate operation. */
  ready(): Promise<boolean>;
};

type StaffGateway = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

/** The existing authentication gateway owns its session policy; composition only mounts the channel console. */
export type ReceptionistStaffMount = {
  mount(extension: AuthenticatedStaffExtension): StaffGateway;
  render(view: ConversationConsoleView): { title: string; body: string };
};

/**
 * Carrier callbacks stay an injected authority. The composition supplies the durable
 * controller and transports, but cannot infer a parent call or claim attachment evidence.
 */
export type ReceptionistComposition = {
  readonly app: ReceptionistApp;
  voiceReleaseProfile(): ReceptionistVoiceReleaseProfile | null;
  readonly store: PostgresConversationStore;
  readonly jobs: PostgresConversationJobs;
  readonly bindings: PostgresSipBindings;
  readonly sipIngress: ReturnType<typeof createReceptionistSipIngress>;
  readonly voiceRuntime: ReceptionistVoiceRuntime;
  readonly recovery: ReceptionistRecoveryController;
  readonly recordings?: TwilioCallRecordingsPort;
  readonly controlledTransfer?: ControlledTransferCoordinator;
  /** Deterministic synthetic-demo control; never initiates a provider transfer. */
  readonly simulatedRoute: SimulatedRouteOutcomeRecorder;
  readonly fallback: { readonly relay: ReceptionistFallbackTransport; readonly scripted: ReceptionistFallbackTransport };
  start(input?: { host?: string; port?: number }): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
};

export function createReceptionistComposition(options: {
  instance: VoiceAppInstance;
  syntheticDataset?: SyntheticDatasetScope;
  controlledTransferMap?: ControlledTransferMap;
  controlledVoiceFixtures?: readonly ControlledSyntheticVoiceFixture[];
  controlledVoiceFixturesEnabled?: boolean;
  voiceCandidateEnabled?: boolean;
  directDemoEnabled?: boolean;
  voicePromotionJSON?: string;
  callbackRealtimeFactory?: (onEvent: (event: OpenAIRealtimeEvent) => void) => RealtimeVoiceProvider;
  controlledCallbackSaveFailures?: boolean;
  controlledProtectedReadFailure?: boolean;
  controlledActionConfirmationFailure?: boolean;
  controlledOfferExpiry?: boolean;
  /** Default-off server fixture for the internal receptionist review; never a model tool. */
  simulatedRouteOutcome?: "staff_answered" | "no_answer" | "after_hours";
  databaseUrl: string;
  cipher: ConversationCipher;
  publicOrigin: string;
  twilioAuthToken: string;
  openAIApiKey: string;
  openAIWebhookSecret: string;
  openAIProjectId: string;
  textModel: string;
  realtimeVoice: string;
  voiceDialoguePolicy?: "legacy" | "adaptive";
  voiceMutationPolicy?: "disabled" | "synthetic_exact_readback";
  recordCalls?: boolean;
  transcribeRecordingsSince?: string;
  fallback: { capabilitySecret: string; scriptedPrompt: string };
  fallbackAuthenticator: FallbackTransportAuthenticator;
  monitor: ConfiguredReceptionistMonitor;
  observations: { secret: Buffer; sink(line: string): void };
  staff: ReceptionistStaffMount;
  voiceJobs: Pick<ReceptionistVoiceJobHandlers, "recovery" | "claimEffect">;
  onTransferFinished(input: { scope: ConversationScope; receipt: TransitionReceipt }): Promise<void>;
  fetch?: typeof globalThis.fetch;
  sidebandSocketFactory?: SidebandSocketFactory;
  textTransport?: ReceptionistTextTransport;
  smsProvider?: SmsProvider;
  workerIdleMs?: number;
  shutdownGraceMs?: number;
}): ReceptionistComposition {
  if (options.voiceCandidateEnabled === true && (options.instance.mode !== "receptionist" || options.instance.dataMode !== "synthetic_only" || options.recordCalls === true)) throw new Error("voice_candidate_receptionist_synthetic_only");
  if (options.directDemoEnabled === true && (options.voiceCandidateEnabled !== true || options.instance.mode !== "receptionist"
    || options.instance.dataMode !== "synthetic_only" || options.instance.numberBinding.sourceNumberE164 !== "+17025550100"
    || options.realtimeVoice !== "marin"
    || options.recordCalls === true || options.voicePromotionJSON !== undefined || options.controlledVoiceFixturesEnabled === true
    || options.controlledTransferMap?.enabled !== true
    || options.controlledTransferMap.sourceNumberE164 !== options.instance.numberBinding.sourceNumberE164
    || Object.values(options.controlledTransferMap.recipients).some(recipient => recipient.destination !== "+17025550101"))) throw new Error("direct_demo_scope_invalid");
  const voiceProfile = options.voiceCandidateEnabled === true || options.voicePromotionJSON !== undefined ? resolveReceptionistVoiceReleaseProfile(options) : null;
  const candidateHash = voiceProfile === null ? null : receptionistVoiceReleaseProfileHash(voiceProfile);
  const promotion = options.voicePromotionJSON === undefined ? null : verifyReceptionistVoicePromotion(options.voicePromotionJSON, options.fallback.capabilitySecret, voiceProfile!);
  const candidateBoundHash = (state: Conversation): string | null => {
    const receipt = state.admission.controlledHours;
    const parsed = receipt === null ? { kind: "legacy" as const } : parseReceptionistCandidateFixtureId(receipt.fixtureId);
    if (parsed.kind === "legacy" && receipt?.candidate === undefined) {
      if (state.admission.voiceRelease === undefined) return null;
      const bound = state.admission.voiceRelease;
      if (bound.stage === "operator_demo") {
        if (bound.profileSha256 !== candidateHash || state.admission.mode !== "receptionist" || state.admission.channel !== "voice"
          || state.admission.accountId !== options.instance.accountId || state.admission.destination !== options.instance.numberBinding.sourceNumberE164
          || state.admission.controlledHours !== null) throw new Error("voice_operator_demo_call_binding_invalid");
        return candidateHash;
      }
      if (promotion === null || bound.profileSha256 !== candidateHash || bound.qualificationSha256 !== promotion.qualificationSha256
        || state.admission.mode !== "receptionist" || state.admission.channel !== "voice" || state.admission.accountId !== options.instance.accountId
        || state.admission.destination !== options.instance.numberBinding.sourceNumberE164) throw new Error("voice_promotion_call_binding_invalid");
      return candidateHash;
    }
    if (parsed.kind !== "candidate" || receipt?.candidate === undefined || candidateHash === null || state.admission.mode !== "receptionist"
      || state.admission.accountId !== options.instance.accountId || state.admission.destination !== options.instance.numberBinding.sourceNumberE164
      || receipt.parentCallId !== state.admission.externalId || receipt.candidate.profileSha256 !== candidateHash
      || parsed.binding.profileSha256 !== candidateHash || parsed.binding.nonce !== receipt.candidate.nonce
      || parsed.binding.caseId !== receipt.candidate.caseId || receipt.outcome !== parsed.binding.hoursFixture || state.admission.hours !== receipt.outcome) throw new Error("voice_candidate_binding_invalid");
    return candidateHash;
  };
  if (options.controlledTransferMap !== undefined && (options.instance.mode !== "receptionist" || options.instance.dataMode !== "synthetic_only")) {
    throw new Error("controlled_transfer_receptionist_synthetic_only");
  }
  if (options.controlledTransferMap?.enabled === true && options.simulatedRouteOutcome !== undefined) throw new Error("controlled_transfer_simulated_route_conflict");
  if (options.simulatedRouteOutcome !== undefined && (options.instance.mode !== "receptionist" || options.instance.dataMode !== "synthetic_only")) throw new Error("simulated_route_receptionist_synthetic_only");
  if (options.controlledCallbackSaveFailures === true && (options.instance.mode !== "full" || options.instance.dataMode !== "synthetic_only")) throw new Error("controlled_callback_failure_synthetic_full_only");
  if (options.controlledProtectedReadFailure === true && (options.instance.mode !== "full" || options.instance.dataMode !== "synthetic_only" || options.controlledVoiceFixturesEnabled !== true || options.recordCalls === true)) throw new Error("controlled_protected_read_failure_synthetic_fixture_only");
  if (options.controlledActionConfirmationFailure === true && (options.instance.mode !== "full" || options.instance.dataMode !== "synthetic_only" || options.controlledVoiceFixturesEnabled !== true || options.recordCalls === true)) throw new Error("controlled_action_confirmation_failure_synthetic_fixture_only");
  if (options.controlledOfferExpiry === true && (options.instance.mode !== "full" || options.instance.dataMode !== "synthetic_only" || options.controlledVoiceFixturesEnabled !== true || options.recordCalls === true)) throw new Error("controlled_offer_expiry_synthetic_fixture_only");
  if (options.controlledVoiceFixturesEnabled === true && (options.instance.mode !== "full" || options.instance.dataMode !== "synthetic_only")) throw new Error("controlled_voice_fixture_synthetic_full_only");
  if (options.controlledVoiceFixturesEnabled === true && options.recordCalls === true) throw new Error("controlled_voice_fixture_recording_forbidden");
  if (options.controlledVoiceFixtures !== undefined && options.controlledVoiceFixturesEnabled !== true) throw new Error("controlled_voice_fixture_disabled");
  if ((options.instance.mode === "full") !== (options.syntheticDataset !== undefined)) throw new Error("full_dataset_configuration_required");
  if (options.voiceDialoguePolicy === "adaptive" && options.instance.mode !== "full") throw new Error("voice_dialogue_policy_full_only");
  if (typeof options.monitor?.ready !== "function" || typeof options.monitor.observe !== "function" || typeof options.monitor.drain !== "function") throw new Error("receptionist_monitor_required");
  if (typeof options.staff?.mount !== "function" || typeof options.staff.render !== "function") throw new Error("receptionist_staff_mount_required");
  if (typeof options.fallbackAuthenticator?.verify !== "function") throw new Error("receptionist_voice_http_required");
  if (typeof options.voiceJobs?.recovery !== "function" || typeof options.voiceJobs.claimEffect !== "function") throw new Error("receptionist_voice_jobs_required");
  if (!Buffer.isBuffer(options.observations?.secret) || typeof options.observations.sink !== "function") throw new Error("receptionist_observations_required");
  if (options.recordCalls === true && options.instance.dataMode !== "synthetic_only") throw new Error("recording_synthetic_only");
  if (options.transcribeRecordingsSince !== undefined && !Number.isFinite(Date.parse(options.transcribeRecordingsSince))) throw new Error("transcription_configuration_invalid");

  const store = new PostgresConversationStore(options.databaseUrl, options.cipher);
  const simulatedRoute = new SimulatedRouteOutcomeRecorder(store);
  const observe = createConversationObserver(options.observations);
  const observeUsage = createRealtimeUsageObserver(options.observations);
  const observeVoiceControl = createVoiceControlObserver(options.observations);
  let controlledTransfer: ControlledTransferCoordinator | undefined;
  const full = options.instance.mode === "full" ? createF2Runtime({ instance: options.instance, dataset: options.syntheticDataset!,
    databaseUrl: options.databaseUrl, cipher: options.cipher, conversations: store, textModel: options.textModel, openAIApiKey: options.openAIApiKey,
    dialoguePolicy: options.voiceDialoguePolicy ?? "legacy",
    voiceMutationPolicy: options.voiceMutationPolicy ?? "disabled",
    controlledCallbackSaveFailures: options.controlledCallbackSaveFailures ?? false,
    controlledProtectedReadFailure: options.controlledProtectedReadFailure ?? false,
    controlledOfferExpiry: options.controlledOfferExpiry ?? false,
    onSmsFailure: ({ scope, stage }) => { observe({ conversationId: scope.conversationId, instanceId: options.instance.instanceId,
      configVersion: options.instance.configVersion, promptVersion: options.instance.promptVersion }, {
      stage: stage === "dispatch" ? "tool" : stage === "render" ? "speech" : stage === "queue" ? "dispatch" : "interpretation",
      result: "failed", channel: "sms", ...(stage === "queue" ? { reason: "storage_unavailable" as const } : {}),
    }); },
    ...(options.controlledTransferMap === undefined ? {} : { controlledTransfer: { start: (input) => controlledTransfer!.start(input) } }) }) : undefined;
  const observeServer = (stage: ConversationObservation["stage"], result: ConversationObservation["result"], reason?: ConversationObservation["reason"],
    timing?: Pick<ConversationObservation, "admissionStep" | "durationMs">): void => {
    observe({ conversationId: `runtime-${options.instance.instanceId}`, instanceId: options.instance.instanceId,
      configVersion: options.instance.configVersion, promptVersion: options.instance.promptVersion }, { stage, result, channel: "voice", ...(reason === undefined ? {} : { reason }), ...(timing === undefined ? {} : timing) });
  };
  const jobs = new PostgresConversationJobs(options.databaseUrl, options.cipher);
  const bindings = new PostgresSipBindings(options.databaseUrl, options.cipher);
  const controlledFixtures = (options.controlledVoiceFixturesEnabled === true || options.voiceCandidateEnabled === true) ? new PostgresControlledSyntheticVoiceFixtures(options.databaseUrl, options.cipher) : undefined;
  const controlledSchema = options.controlledVoiceFixturesEnabled === true || options.voiceCandidateEnabled === true || options.controlledCallbackSaveFailures === true
    ? new PostgresControlledVoiceRendezvous(options.databaseUrl, options.cipher) : undefined;
  const controlledRendezvous = options.controlledVoiceFixturesEnabled === true || options.voiceCandidateEnabled === true ? controlledSchema : undefined;
  const controlledActionConfirmationFailure = options.controlledActionConfirmationFailure === true ? new PostgresControlledActionConfirmationFailure(options.databaseUrl, options.cipher) : undefined;
  const controlledScope = { practiceId: options.instance.practiceId, instanceId: options.instance.instanceId };
  const controlledAdmission = controlledRendezvous === undefined || options.directDemoEnabled === true ? undefined : {
    claim: async (input: { accountId: string; caller: string; destination: string; parentCallId: string }) =>
      await controlledRendezvous.claimChallenge({ ...input, scope: controlledScope, now: new Date().toISOString(), admissionMode: options.instance.mode, ...(candidateHash === null ? {} : { candidateProfileSha256: candidateHash }) }),
    confirm: async (input: { attemptId: string; accountId: string; caller: string; destination: string; parentCallId: string; digits: string }) => {
      const redeemed = await controlledRendezvous.redeem({ ...input, scope: controlledScope, now: new Date().toISOString(), admissionMode: options.instance.mode, ...(candidateHash === null ? {} : { candidateProfileSha256: candidateHash }) });
      return redeemed !== null && await controlledRendezvous.markRedirected({ attemptId: redeemed.attemptId, scope: controlledScope, parentCallId: redeemed.parentCallId });
    },
  };
  const controlledFixturePort = controlledFixtures === undefined ? undefined : {
    claim: controlledFixtures.claim.bind(controlledFixtures),
    bind: async (input: { fixtureId: string; practiceId: string; instanceId: string; parentCallId: string; conversationId: string }) => {
      await controlledFixtures.bind(input);
      const attemptId = input.fixtureId.startsWith("fixture_") ? input.fixtureId.slice("fixture_".length) : "";
      if (!attemptId) return;
      const binding = await controlledRendezvous?.readBinding({ attemptId, scope: controlledScope });
      if (binding?.parentCallId === input.parentCallId) {
        await controlledRendezvous!.bindConversation({ attemptId, scope: controlledScope, parentCallId: input.parentCallId, conversationId: input.conversationId });
      }
    },
  };
  const provider = new ReceptionistOpenAIAdapter({ apiKey: options.openAIApiKey,
    fetch: async (url, init) => ({ status: (await (options.fetch ?? globalThis.fetch)(url, init)).status }),
    sideband: options.sidebandSocketFactory ?? new WsOpenAISidebandSocketFactory({ apiKey: options.openAIApiKey }) });
  const verifier = new OpenAIWebhookVerifier({ webhookSecret: options.openAIWebhookSecret });
  const sipTwiml = (binding: Parameters<typeof sipDialTwiml>[0]) => sipDialTwiml(binding, { recordCalls: options.recordCalls === true });
  const sipIngress = createReceptionistSipIngress({ instance: options.instance, projectId: options.openAIProjectId, recordCalls: options.recordCalls === true, store, bindings, verifier,
    ...(candidateHash === null ? {} : { candidateProfileSha256: candidateHash }),
    requireCandidateRelease: options.voiceCandidateEnabled === true && promotion === null && options.directDemoEnabled !== true,
    ...(options.directDemoEnabled !== true ? {} : { operatorDemoVoiceRelease: { stage: "operator_demo" as const, profileSha256: candidateHash! } }),
    ...(promotion === null ? {} : { promotedVoiceRelease: { stage: "rehearsal" as const, profileSha256: promotion.profileSha256, qualificationSha256: promotion.qualificationSha256 } }),
    ...(controlledFixturePort === undefined ? {} : { controlledFixtures: controlledFixturePort }),
    observeAdmission: (correlation, observation) => observe({ conversationId: correlation, instanceId: options.instance.instanceId,
      configVersion: options.instance.configVersion, promptVersion: options.instance.promptVersion }, observation) });
  // Construction validates the bounded existing-parent adapter but performs no carrier request.
  const parent = new TwilioParentCallPort({ accountSid: options.instance.accountId, authToken: options.twilioAuthToken,
    sourceNumber: options.instance.numberBinding.sourceNumberE164, publicOrigin: options.publicOrigin, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  const recovery = new ReceptionistRecoveryController({ store, parent });
  const transferAdapter = options.controlledTransferMap?.enabled !== true ? undefined : new ControlledTestTransfer({
    recipientMap: options.controlledTransferMap, callbackOrigin: options.publicOrigin, hmacSecret: options.fallback.capabilitySecret });
  if (transferAdapter !== undefined) controlledTransfer = new ControlledTransferCoordinator({ store, transfer: transferAdapter, parentRedirect: parent,
    fallback: { resume: async ({ scope }) => sipTwiml(await bindings.create({ scope, projectId: options.openAIProjectId })) } });
  const candidateSpeech = voiceProfile === null ? null : new OpenAIStreamingSpeechProvider({ apiKey: options.openAIApiKey, projectId: options.openAIProjectId,
    model: voiceProfile.callback.speechModel, voice: voiceProfile.callback.voice, instructions: CALLBACK_SPEECH_DELIVERY,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch as unknown as SpeechFetch }),
    onUsage: usage => console.info(JSON.stringify({ kind: "callback_speech_usage", model: CALLBACK_SPEECH_MODEL, characters: usage.characters })) });
  const announcementAssets = candidateSpeech === null ? null : new ReceptionistTransferAudioAssets({ speech: candidateSpeech,
    publicOrigin: options.publicOrigin, secret: options.fallback.capabilitySecret, store, currentProfile: candidateBoundHash });
  const controlledTransferHttp = controlledTransfer === undefined || transferAdapter === undefined ? undefined
    : createControlledTransferHttp({ instance: options.instance, store, coordinator: controlledTransfer, transfer: transferAdapter,
      announcementAudio: async (state, attempt) => candidateBoundHash(state) === null ? null : await announcementAssets!.prepare(state, attempt) });
  const evaluation = new ConversationEvaluationWorker({ store, results: createEvaluationPersistence(store) });
  const relayRenderer = new ReceptionistFallbackRenderer({ target: "relay", publicBaseUrl: options.publicOrigin,
    capabilitySecret: options.fallback.capabilitySecret, scriptedPrompt: options.fallback.scriptedPrompt });
  const scriptedRenderer = new ReceptionistFallbackRenderer({ target: "scripted", publicBaseUrl: options.publicOrigin,
    capabilitySecret: options.fallback.capabilitySecret, scriptedPrompt: options.fallback.scriptedPrompt });
  const scriptedText = new ConversationScriptedTextSink({ store });
  const candidateProfileFor = async (scope: ConversationScope): Promise<string | null> => {
    const state = await store.get(scope); if (!state) return null;
    const profile = candidateBoundHash(state);
    if (profile !== null && (state.owner !== "ai" || state.phase !== "active" || state.suppressed)) throw new Error("voice_candidate_authority_lost");
    return profile;
  };
  const mediaProfileFor = async ({ scope, recoveryId }: { scope: ConversationScope; recoveryId: string }): Promise<string | null> => {
    const state = await store.get(scope); if (!state) return null;
    const profile = await candidateProfileFor(scope), handoff = state.recoveries.find(item => item.id === recoveryId);
    return profile !== null && handoff?.failureDomain === "callback_intake" && handoff.target === "relay" ? profile : null;
  };
  const outageProfileFor = async ({ scope, recoveryId }: { scope: ConversationScope; recoveryId: string }): Promise<string | null> => {
    const state = await store.get(scope); if (!state) return null;
    const profile = await candidateProfileFor(scope), handoff = state.recoveries.find(item => item.id === recoveryId);
    // Ordinary callback failures remain unqualified and preserve/end; only an actual
    // separately recorded provider outage may use the explicitly declared backup voice.
    return profile !== null && handoff !== undefined && handoff.failureDomain !== "callback_intake" ? profile : null;
  };
  const fallback = {
    relay: new ReceptionistFallbackTransport({ renderer: relayRenderer, recovery, authenticator: options.fallbackAuthenticator, candidateProfile: candidateProfileFor, mediaProfile: mediaProfileFor, outageProfile: outageProfileFor,
      relayOpeningPrompt: async ({ scope, recoveryId }) => {
        const state = await store.get(scope);
        const handoff = state?.recoveries.find((item) => item.id === recoveryId);
        if (!state || !handoff) return null;
        // Callback intake starts from authenticated Relay setup so a stale welcome snapshot cannot ask a field.
        return handoff.failureDomain === "callback_intake" ? "" : candidateBoundHash(state) === null ? undefined
          : "I’m sorry, the live assistant was interrupted. I’m using a backup voice, and I can still take a message for the team. How can I help?";
      } }),
    scripted: new ReceptionistFallbackTransport({ renderer: scriptedRenderer, recovery, authenticator: options.fallbackAuthenticator, scriptedText, candidateProfile: candidateProfileFor, outageProfile: outageProfileFor }),
  } as const;
  // Recovery fallback TwiML is outside the realtime SIP Dial segment and is not recorded by this demo-only flag.
  const voiceRuntime = new ReceptionistVoiceRuntime({ instance: options.instance, voice: options.realtimeVoice, store, bindings, provider,
    onUsage: ({ scope, model, usage }) => { observeUsage({ conversationId: scope.conversationId, instanceId: scope.instanceId, model, usage }); },
    onControlTrace: ({ scope, callId, trace }) => { observeVoiceControl({ conversationId: scope.conversationId, callId }, trace); },
    ...(full?.controlledOfferExpiry === undefined ? {} : { onControlledOfferDrain: full.controlledOfferExpiry.drained.bind(full.controlledOfferExpiry) }),
    ...(controlledActionConfirmationFailure === undefined ? {} : { controlledActionConfirmationFailure }),
    ...(options.simulatedRouteOutcome === undefined ? {} : { simulatedRoute: { outcome: options.simulatedRouteOutcome, recorder: simulatedRoute } }),
    ...(controlledTransfer === undefined ? {} : { controlledTransfer: { start: (input) => controlledTransfer!.start(input) } }),
    recover: async (input) => { await recovery.recover(input); },
    enqueueRecovery: async (input) => {
      await jobs.enqueue({ scope: input.scope, kind: "voice_recovery", key: `realtime-watchdog-${input.voiceEpoch}`,
        payload: { callId: input.callId, voiceEpoch: input.voiceEpoch }, availableAt: new Date().toISOString() });
    },
    monitor: options.monitor, ...(full === undefined ? {} : { fullMode: full.voice }) });
  const recordings = options.recordCalls === true ? new TwilioCallRecordingsPort({ accountSid: options.instance.accountId, authToken: options.twilioAuthToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }) }) : undefined;
  const transcriptStore = options.transcribeRecordingsSince === undefined ? undefined : new PostgresRecordingTranscriptStore(options.databaseUrl, options.cipher);
  const transcriptProcessor = transcriptStore === undefined || recordings === undefined ? undefined
    : new RecordingTranscriptProcessor({ store: transcriptStore, recordings, openAiApiKey: options.openAIApiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  let transcriptTimer: ReturnType<typeof setInterval> | undefined;
  let transcriptWork: Promise<void> | null = null;
  let transcriptOffset = 0;
  const scanTranscripts = () => {
    if (stopped || transcriptWork !== null || transcriptProcessor === undefined) return;
    transcriptWork = (async () => {
      const rows = await store.list({ practiceId: options.instance.practiceId, instanceId: options.instance.instanceId, channel: "voice", limit: 100, offset: transcriptOffset });
      transcriptOffset = rows.length < 100 ? 0 : transcriptOffset + rows.length;
      for (const row of rows) {
        if (stopped) break;
        if (row.phase !== "disconnected" || Date.parse(row.createdAt) < Date.parse(options.transcribeRecordingsSince!)) continue;
        const results = await transcriptProcessor.run({ scope: { practiceId: row.admission.practiceId, instanceId: row.admission.instanceId, conversationId: row.id }, parentCallId: row.admission.externalId });
        if (results.some((result) => result.state === "failed" || result.state === "unavailable")) observeServer("evaluation", "failed", "provider_unavailable");
      }
    })().catch(() => { observeServer("evaluation", "failed", "storage_unavailable"); }).finally(() => { transcriptWork = null; });
  };
  const staffExtension = createConversationStaffExtension({ store, projection: store, practiceId: options.instance.practiceId,
    instanceId: options.instance.instanceId, render: options.staff.render,
    ...(recordings === undefined ? {} : { recordings }),
    ...(transcriptStore === undefined ? {} : { transcripts: transcriptStore }),
    onVoiceOwnershipChanged: async ({ scope, conversation }) => {
      await voiceRuntime.onOwnershipChanged({ scope, ownerEpoch: conversation.ownerEpoch });
    },
    ...(full === undefined ? {} : { resolveCallerProvidedIdentity: (scope: ConversationScope) => full.practice.getCallerProvidedIdentity(scope) }) });
  const authenticatedStaff = options.staff.mount(staffExtension);
  const relayInterpreter = new OpenAIReceptionistRelayInterpreter({ apiKey: options.openAIApiKey, model: options.textModel,
    ...(options.textTransport === undefined ? {} : { transport: options.textTransport }) });
  const relayUpgrade = createRelayUpgrade({ publicOrigin: options.publicOrigin, authToken: options.twilioAuthToken,
    setup: async ({ recoveryId, raw, socket, signal }) => {
      const setup: unknown = JSON.parse(raw);
      if (setup === null || typeof setup !== "object" || Array.isArray(setup)) throw new Error("relay_setup_invalid");
      const { type, callSid } = setup as Record<string, unknown>;
      if (type !== "setup" || typeof callSid !== "string" || !/^CA[a-fA-F0-9]{32}$/.test(callSid)) throw new Error("relay_setup_invalid");
      const conversation = await store.findVoiceByParent({ practiceId: options.instance.practiceId, instanceId: options.instance.instanceId,
        accountId: options.instance.accountId, parentCallId: callSid });
      if (signal.aborted || conversation === null || conversation.phase !== "active") throw new Error("relay_call_not_active");
      const scope = { practiceId: conversation.admission.practiceId, instanceId: conversation.admission.instanceId, conversationId: conversation.id };
      const reconcileClosed = async () => { await recovery.reconcileRelayClosed({ scope, recoveryId, connectionId: `relay-close-${recoveryId}` }); };
      let attached;
      try { attached = await fallback.relay.relaySetup({ scope, recoveryId, parentCallId: callSid, rawSetup: raw, signal }); }
      catch (error) { await reconcileClosed(); throw error; }
      if (signal.aborted) { await reconcileClosed(); throw new Error("relay_setup_aborted"); }
      if (attached.kind !== "attached") throw new Error("relay_binding_rejected");
      const session = new ReceptionistRelaySession({ socket, scope, parentCallId: callSid, recoveryId, store,
        instance: options.instance, model: options.textModel, interpreter: relayInterpreter,
        observeProtocolShape: (shape) => { console.info(JSON.stringify({ kind: "relay_protocol_shape", ...shape })); } });
      await session.receive(raw);
      return { receive: (message: string) => session.receive(message), close: async () => { const callerEnded = session.endedByCaller(); session.close(); if (!callerEnded) await reconcileClosed(); } };
    } });
  const mediaConnections = new Set<string>();
  const audioUpgrade = createRelayUpgrade({ publicOrigin: options.publicOrigin, authToken: options.twilioAuthToken, stage: "audio", setupTimeoutMs: 8000,
    setup: async ({ recoveryId, raw, socket, signal, signature, publicUrl }) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      const start = message.start as Record<string, unknown> | undefined;
      if (message.event !== "start" || typeof start?.callSid !== "string" || !/^CA[a-fA-F0-9]{32}$/.test(start.callSid)) throw new Error("media_setup_invalid");
      const conversation = await store.findVoiceByParent({ practiceId: options.instance.practiceId, instanceId: options.instance.instanceId, accountId: options.instance.accountId, parentCallId: start.callSid });
      if (!conversation || signal.aborted) throw new Error("media_parent_missing");
      const scope = { practiceId: conversation.admission.practiceId, instanceId: conversation.admission.instanceId, conversationId: conversation.id };
      const profileHash = candidateBoundHash(conversation);
      if (profileHash === null || voiceProfile === null) throw new Error("media_candidate_required");
      const key = `${conversation.id}:${recoveryId}`;
      if (mediaConnections.has(key)) throw new Error("media_connection_duplicate");
      mediaConnections.add(key);
      try {
        const attached = await fallback.relay.mediaSetup({ scope, recoveryId, parentCallId: start.callSid, expectedAccountId: options.instance.accountId, rawStart: raw, signal });
        if (attached.kind !== "attached" || signal.aborted) throw new Error("media_binding_rejected");
        const telephony = new TwilioMediaStreamsProvider(null, () => undefined, Date.now, options.instance.accountId, options.observations.secret);
        const capability = telephony.authorizeUpgrade({ validator: new TwilioHmacRequestValidator(options.twilioAuthToken), signature, url: publicUrl,
          expectedCallId: conversation.admission.externalId, expiresAtMs: Date.now() + 30_000 });
        const bound = telephony.acceptStart(raw, socket, capability);
        const speech = new OpenAIStreamingSpeechProvider({ apiKey: options.openAIApiKey, projectId: options.openAIProjectId,
          model: voiceProfile.callback.speechModel, voice: voiceProfile.callback.voice, instructions: CALLBACK_SPEECH_DELIVERY,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch as unknown as SpeechFetch }) });
        const session = new ReceptionistCallbackAudioSession({ scope, parentCallId: conversation.admission.externalId, streamId: bound.streamId, recoveryId, attachmentId: attached.attachmentId, profileSha256: profileHash, signal,
          telephony, store, instance: options.instance, model: options.textModel, interpreter: relayInterpreter, speech,
          currentProfile: candidateBoundHash, onFailure: reason => console.info(JSON.stringify({ kind: "callback_audio_failure", reason })),
          onInputClockDiagnostic: value => console.info(JSON.stringify({ kind: "callback_input_presentation_timing", ...value })),
          realtimeFactory: options.callbackRealtimeFactory ?? (onRealtimeEvent => new OpenAIRealtimeProvider({ model: RECEPTIONIST_REALTIME_MODEL, voice: options.realtimeVoice,
            instructions: "Transcribe the current caller only. Never generate speech, tools, policy, or an action.",
            factory: new WsOpenAIRealtimeSocketFactory(options.openAIApiKey, undefined, options.openAIProjectId), onRealtimeEvent,
            onSetupDiagnostic: diagnostic => console.info(JSON.stringify({ kind: "callback_input_setup_diagnostic", ...diagnostic })),
            inputTranscription: { model: RECEPTIONIST_TRANSCRIPTION_MODEL, language: "en" }, inputVad: CALLBACK_VAD })) });
        await session.start();
        if (signal.aborted) { session.close(); throw new Error("media_setup_aborted"); }
        return { receive: (value: string) => session.receive(value), close: async () => {
          const ended = session.endedByCaller(); session.close(); await session.drain(); mediaConnections.delete(key);
          if (!ended) {
            const current = await store.get(scope), recoveryRecord = current?.recoveries.find(item => item.id === recoveryId);
            if (current?.phase === "active" && recoveryRecord?.state === "attached" && current.voiceEpoch === recoveryRecord.fromEpoch + 1) {
              await store.execute({ scope, eventId: `candidate-media-close-${recoveryId}`, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
                actor: { kind: "system", id: "receptionist-callback-audio" }, command: { type: "voice.late_evidence", recoveryId, providerEventId: `media-close-${recoveryId}`, observedState: "disconnected" } });
            }
          }
        } };
      } catch (error) { mediaConnections.delete(key); console.info(JSON.stringify({ kind: "callback_audio_setup_failure", reason: error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/.test(error.message) ? error.message : "setup_failed" })); throw error; }
    } });
  const disconnectTerminalParentStatus = async (conversation: Conversation, parentCallId: string): Promise<void> => {
    const scope = { practiceId: conversation.admission.practiceId, instanceId: conversation.admission.instanceId, conversationId: conversation.id };
    const eventId = (current: Conversation) => `voice-parent-status-terminal-${parentCallId}-r${current.revision}-o${current.ownerEpoch}`;
    const disconnect = async (current: Conversation) => await store.execute({ scope, eventId: eventId(current),
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
      actor: { kind: "provider", id: "twilio-parent-status" }, command: { type: "conversation.disconnect" } });
    let receipt = await disconnect(conversation);
    if (!receipt.accepted && (receipt.error === "stale_revision" || receipt.error === "stale_owner_epoch")) {
      const current = await store.get(scope);
      if (current === null) throw new Error("voice_parent_status_current_missing");
      if (current.phase === "disconnected") return;
      if (current.admission.accountId !== options.instance.accountId || current.admission.externalId !== parentCallId) {
        throw new Error("voice_parent_status_binding_changed");
      }
      // The refreshed revision gives the single retry a distinct durable identity.
      receipt = await disconnect(current);
    }
    if (!receipt.accepted && (await store.get(scope))?.phase !== "disconnected") throw new Error("voice_parent_status_disconnect_rejected");
  };
  const app = createReceptionistApp({ instance: options.instance, databaseUrl: options.databaseUrl, cipher: options.cipher,
    ...(controlledTransferHttp === undefined ? {} : { controlledTransfer: controlledTransferHttp }),
    ...(controlledAdmission === undefined ? {} : { controlledVoiceAdmission: controlledAdmission }),
    publicOrigin: options.publicOrigin, twilioAuthToken: options.twilioAuthToken, openAIApiKey: options.openAIApiKey, textModel: options.textModel,
    ...(options.textTransport === undefined ? {} : { smsInterpreter: new OpenAIReceptionistTextInterpreter({ apiKey: options.openAIApiKey, transport: options.textTransport }) }),
    ...(options.smsProvider === undefined ? {} : { smsProvider: options.smsProvider }),
    ...(full === undefined ? {} : { fullSmsTurn: full.sms, onSmsDelivered: (input: { scope: ConversationScope; messageId: string }) => full.delivery.smsDelivered(input) }),
    voice: async (input) => {
      if (input.kind === "inbound") return await sipIngress.inbound(input.parameters);
      const parentCallId = input.parameters.CallSid;
      if (parentCallId === undefined) throw new Error("recovery_parent_call_missing");
      const conversation = await store.findVoiceByParent({ practiceId: options.instance.practiceId, instanceId: options.instance.instanceId,
        accountId: options.instance.accountId, parentCallId });
      if (input.kind === "status") {
        if (!terminalTwilioStatus(input.parameters.CallStatus) || conversation === null || conversation.phase === "disconnected") return "<Response/>";
        await disconnectTerminalParentStatus(conversation, parentCallId);
        return "<Response/>";
      }
      if (conversation === null) throw new Error("recovery_parent_call_missing");
      const scope = { practiceId: conversation.admission.practiceId, instanceId: conversation.admission.instanceId, conversationId: conversation.id };
      if (input.kind === "action") {
        // DialCallStatus describes the child leg; failed/no-answer is the recovery trigger while the parent stays active.
        if (input.actionAttemptId === undefined) throw new Error("recovery_attempt_missing");
        const attempt = await bindings.get(scope, input.actionAttemptId);
        // An unbound SIP attempt is a durable opaque correlation, never an asserted OpenAI call ID.
        if (attempt === null || attempt.binding.parentCallId !== parentCallId) throw new Error("recovery_sip_attempt_missing");
        if (conversation.phase === "disconnected") {
          if (attempt.callId !== null) voiceRuntime.disconnect(attempt.callId);
          return "<Response/>";
        }
        if (terminalTwilioStatus(input.parameters.CallStatus)) {
          const disconnected = await store.execute({ scope, eventId: `voice-parent-terminal-${attempt.binding.attemptId}`,
            expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch,
            actor: { kind: "provider", id: "twilio-parent-call" }, command: { type: "conversation.disconnect" } });
          if (!disconnected.accepted) throw new Error("voice_parent_disconnect_rejected");
          // No recovery or redirect follows authoritative parent termination.
          if (attempt.callId !== null) voiceRuntime.disconnect(attempt.callId);
          return "<Response/>";
        }
        if (attempt.closeRequested && attempt.callId !== null) {
          // The SIP child exited after an exact saved-message close request. End
          // the parent leg; its signed terminal callback owns durable disconnect.
          if (attempt.callId !== null) voiceRuntime.disconnect(attempt.callId);
          return "<Response><Hangup/></Response>";
        }
        const outcome = await recovery.recoverFromAction({ scope, callId: attempt.callId ?? attempt.binding.attemptId, voiceEpoch: attempt.binding.voiceEpoch });
        if (outcome.kind !== "claimed_for_action" && outcome.kind !== "outcome_unknown") throw new Error("recovery_action_not_claimed");
        const current = await store.get(scope);
        const durable = current?.recoveries.find((item) => item.id === outcome.recoveryId);
        if (durable === undefined || durable.parentCallId !== parentCallId) throw new Error("recovery_action_binding_missing");
        // The watchdog may already own the provider redirect. Its callback and
        // this Dial action can safely serve the same durable TwiML document.
        if (outcome.kind === "outcome_unknown" && durable.state !== "redirecting") throw new Error("recovery_action_not_claimed");
        const rendered = await (durable.target === "relay" ? fallback.relay : fallback.scripted).serve({ scope, recoveryId: durable.id, parentCallId });
        if (rendered.kind !== "rendered") throw new Error("recovery_action_not_rendered");
        return rendered.twiml;
      }
      if (input.recoveryId === undefined || input.recoveryTarget === undefined || input.recoveryStage === undefined) throw new Error("recovery_callback_invalid");
      if (input.recoveryStage === "complete") {
        if (input.recoveryTarget !== "relay" || input.completion?.parentCallId !== parentCallId) throw new Error("relay_completion_binding_invalid");
        const completion = await fallback.relay.relayComplete({ scope, recoveryId: input.recoveryId, parentCallId, capability: input.completion.capability });
        if (completion.kind === "caller_ended" || completion.kind === "candidate_failed") return completion.twiml;
        if (completion.kind !== "continue") throw new Error("relay_completion_not_authorized");
        // A failed Relay returns into the existing action winner, never a terminal suffix.
        const outcome = await recovery.recoverFromAction({ scope, callId: `relay-close-${input.recoveryId}`,
          voiceEpoch: completion.voiceEpoch, failureDomain: "relay_transport" });
        if (outcome.kind !== "claimed_for_action" && outcome.kind !== "outcome_unknown") throw new Error("relay_completion_recovery_not_claimed");
        const current = await store.get(scope), next = current?.recoveries.find((item) => item.id === outcome.recoveryId);
        if (next?.target !== "scripted" || next.parentCallId !== parentCallId) throw new Error("relay_completion_recovery_binding_invalid");
        const rendered = await fallback.scripted.serve({ scope, recoveryId: next.id, parentCallId });
        if (rendered.kind !== "rendered") throw new Error("relay_completion_recovery_not_rendered");
        return rendered.twiml;
      }
      if (input.recoveryStage === "gather") {
        const durable = conversation.recoveries.find((item) => item.id === input.recoveryId);
        if (input.gather === undefined || input.recoveryTarget !== "scripted" || durable?.target !== "scripted"
          || durable.parentCallId !== parentCallId || input.gather.parentCallId !== parentCallId) throw new Error("recovery_gather_binding_invalid");
        const result = await fallback.scripted.scriptedGather({ scope, recoveryId: durable.id, parentCallId,
          childCorrelationId: durable.childCallId, capability: input.gather.capability, sourceId: input.gather.sourceId, emptyAttempts: input.gather.emptyAttempts,
          speech: input.parameters.SpeechResult ?? "", ...(input.parameters.Digits === undefined ? {} : { digits: input.parameters.Digits }) });
        if (result.kind !== "rendered") throw new Error("recovery_gather_not_rendered");
        return result.twiml;
      }
      const rendered = await (input.recoveryTarget === "relay" ? fallback.relay : fallback.scripted).serve({ scope, recoveryId: input.recoveryId, parentCallId });
      if (rendered.kind !== "rendered") throw new Error("recovery_not_rendered");
      return rendered.twiml;
    }, openAIWebhook: async (request) => {
      observeServer("admission", "started");
      try { await sipIngress.webhook(request); observeServer("admission", "accepted"); }
      catch (error) { observeServer("admission", "failed", "binding_mismatch"); throw error; }
    }, staff: async (request, response) => {
      observeServer("staff", "started");
      try { await authenticatedStaff(request, response); observeServer("staff", "completed"); }
      catch (error) { observeServer("staff", "failed", "storage_unavailable"); throw error; }
    },
    voiceJobs: { accept: voiceRuntime.accept, recovery: options.voiceJobs.recovery, evaluation: async (job) => {
      await options.monitor.drain(job.scope);
      return await evaluation.handle(job);
    }, claimEffect: options.voiceJobs.claimEffect },
    onTransferFinished: options.onTransferFinished, monitor: options.monitor, observe, store, jobs,
    voiceRelease: () => ({ candidateProfileSha256: options.voiceCandidateEnabled === true ? candidateHash : null, rehearsalProfileSha256: promotion?.profileSha256 ?? null,
      ...(options.directDemoEnabled === true ? { operatorDemoProfileSha256: candidateHash } : {}) }),
    ...(announcementAssets === null ? {} : { audioAsset: (request, response) => announcementAssets.serve(request, response) }),
    upgrade: (request, socket, head) => request.url?.startsWith("/voice/recovery/relay/") && request.url.endsWith("/audio")
      ? audioUpgrade.upgrade(request, socket, head) : relayUpgrade.upgrade(request, socket, head),
    ...(options.workerIdleMs === undefined ? {} : { workerIdleMs: options.workerIdleMs }),
    ...(options.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: options.shutdownGraceMs }),
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    announcementAssets?.close();
    if (transcriptTimer !== undefined) clearInterval(transcriptTimer);
    await transcriptWork;
    let failure: Error | undefined;
    for (const close of [async () => await audioUpgrade.stop(), async () => await relayUpgrade.stop(), async () => await app.stop(), async () => await voiceRuntime.stop(), async () => await options.monitor.drain(),
      async () => await bindings.close(), async () => await controlledActionConfirmationFailure?.close(), async () => await controlledSchema?.close(), async () => await controlledFixtures?.close(), async () => await jobs.close(), async () => await full?.stop(), async () => await transcriptStore?.close(), async () => await store.close()]) {
      try { await close(); } catch (error) { failure ??= error instanceof Error ? error : new Error("receptionist_composition_stop_failed"); }
    }
    if (failure !== undefined) throw failure;
  };
  return {
    voiceReleaseProfile: () => voiceProfile === null ? null : structuredClone(voiceProfile),
    app, store, jobs, bindings, sipIngress, voiceRuntime, recovery, simulatedRoute, fallback, ...(recordings === undefined ? {} : { recordings }),
    ...(controlledTransfer === undefined ? {} : { controlledTransfer }),
    async start(input) {
      if (stopped) throw new Error("receptionist_composition_stopped");
      observeServer("monitor", "started");
      try {
        await controlledSchema?.ready({ voiceFixtures: options.controlledVoiceFixturesEnabled === true || options.voiceCandidateEnabled === true, callbackFailures: options.controlledCallbackSaveFailures === true });
        await controlledActionConfirmationFailure?.ready();
        if (controlledFixtures !== undefined && options.controlledVoiceFixtures !== undefined) await controlledFixtures.provision(options.controlledVoiceFixtures);
        await full?.start();
        if (transcriptProcessor !== undefined) await transcriptStore?.initialize();
        const address = await app.start(input);
        if (transcriptProcessor !== undefined) { transcriptTimer = setInterval(scanTranscripts, 30_000); transcriptTimer.unref(); scanTranscripts(); }
        observeServer("monitor", "accepted");
        return address;
      } catch (error) {
        observeServer("monitor", "failed", "storage_unavailable");
        try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "receptionist_start_and_cleanup_failed"); }
        throw error;
      }
    },
    stop,
  };
}

function terminalTwilioStatus(value: string | undefined): boolean {
  return value === "completed" || value === "canceled" || value === "failed" || value === "busy" || value === "no-answer";
}
