import { z } from "zod";

import { ConversationCipher } from "./conversation-store.js";
import { createReceptionistComposition, type ConfiguredReceptionistMonitor, type ReceptionistComposition, type ReceptionistStaffMount } from "./receptionist-composition.js";
import type { FallbackTransportAuthenticator } from "./receptionist-fallback.js";
import type { ReceptionistVoiceJobHandlers } from "./receptionist-app.js";
import type { ConversationScope } from "./conversation-contract.js";
import type { TransitionReceipt } from "./conversation-store.js";
import { syntheticDatasetScopeSchema, type SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import { voiceAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { controlledSyntheticVoiceFixtureSchema, type ControlledSyntheticVoiceFixture } from "./controlled-synthetic-voice-fixture.js";
import { controlledTransferMapSchema, type ControlledTransferMap } from "./controlled-test-transfer.js";

const port = z.coerce.number().int().min(1).max(65_535);
const identifier = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const required = z.string().trim().min(1);
const environmentSchema = z.object({
  DATABASE_URL: required,
  RECEPTIONIST_INSTANCE_JSON: required,
  RECEPTIONIST_PUBLIC_ORIGIN: required,
  TWILIO_AUTH_TOKEN: required,
  OPENAI_API_KEY: required,
  OPENAI_WEBHOOK_SECRET: required,
  OPENAI_PROJECT_ID: z.string().regex(/^proj_[A-Za-z0-9_-]{1,160}$/),
  OPENAI_TEXT_MODEL: identifier,
  RECEPTIONIST_REALTIME_VOICE: identifier,
  RECEPTIONIST_FALLBACK_CAPABILITY_SECRET: z.string().min(32),
  RECEPTIONIST_SCRIPTED_PROMPT: z.string().trim().min(1).max(1_000),
  RECEPTIONIST_OBSERVATION_SECRET: z.string().min(32),
  RECEPTIONIST_CIPHER_KEY: z.string().min(1),
  RECEPTIONIST_SYNTHETIC_DATASET_JSON: z.string().trim().min(1).optional(),
  RECEPTIONIST_CONTROLLED_TRANSFER_MAP_JSON: z.string().trim().min(1).optional(),
  RECEPTIONIST_VOICE_PROMOTION_JSON: z.string().min(1).max(4096).optional(),
  RECEPTIONIST_VOICE_CANDIDATE_ENABLED: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_DIRECT_DEMO_ENABLED: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_CONTROLLED_VOICE_FIXTURES: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_CONTROLLED_VOICE_FIXTURES_JSON: z.string().trim().min(1).optional(),
  RECEPTIONIST_CONTROLLED_CALLBACK_SAVE_FAILURES: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_CONTROLLED_PROTECTED_READ_FAILURE: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_CONTROLLED_ACTION_CONFIRMATION_FAILURE: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_CONTROLLED_OFFER_EXPIRY: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_SIMULATED_ROUTE_OUTCOME: z.enum(["staff_answered", "no_answer", "after_hours"]).optional(),
  RECEPTIONIST_VOICE_DIALOGUE_POLICY: z.enum(["legacy", "adaptive"]).default("legacy"),
  RECEPTIONIST_VOICE_MUTATION_POLICY: z.enum(["disabled", "synthetic_exact_readback"]).default("disabled"),
  RECEPTIONIST_RECORD_CALLS: z.enum(["true", "false"]).default("false"),
  RECEPTIONIST_TRANSCRIBE_RECORDINGS_SINCE: z.string().datetime().optional(),
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: port.default(3000),
}).strict();

export type ReceptionistRuntimeConfig = {
  databaseUrl: string;
  instance: VoiceAppInstance;
  syntheticDataset?: SyntheticDatasetScope;
  controlledTransferMap?: ControlledTransferMap;
  controlledVoiceFixtures?: readonly ControlledSyntheticVoiceFixture[];
  controlledVoiceFixturesEnabled: boolean;
  voiceCandidateEnabled: boolean;
  directDemoEnabled: boolean;
  voicePromotionJSON?: string;
  controlledCallbackSaveFailures: boolean;
  controlledProtectedReadFailure: boolean;
  controlledActionConfirmationFailure: boolean;
  controlledOfferExpiry: boolean;
  simulatedRouteOutcome?: "staff_answered" | "no_answer" | "after_hours";
  publicOrigin: string;
  twilioAuthToken: string;
  openAIApiKey: string;
  openAIWebhookSecret: string;
  openAIProjectId: string;
  textModel: string;
  realtimeVoice: string;
  voiceDialoguePolicy: "legacy" | "adaptive";
  voiceMutationPolicy: "disabled" | "synthetic_exact_readback";
  recordCalls: boolean;
  transcribeRecordingsSince?: string;
  fallback: { capabilitySecret: string; scriptedPrompt: string };
  observationSecret: Buffer;
  cipherKey: Buffer;
  host: string;
  port: number;
};

/** Parses only explicit runtime configuration; it neither migrates nor contacts providers. */
export function parseReceptionistRuntimeConfig(environment: NodeJS.ProcessEnv): ReceptionistRuntimeConfig {
  const raw = environmentSchema.parse(pickEnvironment(environment));
  const publicOrigin = checkedPublicOrigin(raw.RECEPTIONIST_PUBLIC_ORIGIN);
  let instanceValue: unknown;
  try { instanceValue = JSON.parse(raw.RECEPTIONIST_INSTANCE_JSON); }
  catch { throw new Error("receptionist_instance_json_invalid"); }
  const instance = voiceAppInstanceSchema.parse(instanceValue);
  let syntheticDataset: SyntheticDatasetScope | undefined;
  if (instance.mode === "full") {
    if (raw.RECEPTIONIST_SYNTHETIC_DATASET_JSON === undefined) throw new Error("receptionist_synthetic_dataset_required");
    try { syntheticDataset = syntheticDatasetScopeSchema.parse(JSON.parse(raw.RECEPTIONIST_SYNTHETIC_DATASET_JSON)); }
    catch { throw new Error("receptionist_synthetic_dataset_invalid"); }
  } else if (raw.RECEPTIONIST_SYNTHETIC_DATASET_JSON !== undefined) throw new Error("receptionist_synthetic_dataset_r1_forbidden");
  if (raw.RECEPTIONIST_VOICE_DIALOGUE_POLICY === "adaptive" && instance.mode !== "full") throw new Error("voice_dialogue_policy_full_only");
  if (raw.RECEPTIONIST_VOICE_MUTATION_POLICY === "synthetic_exact_readback" && instance.mode !== "full") throw new Error("voice_mutation_policy_full_only");
  if (raw.RECEPTIONIST_SIMULATED_ROUTE_OUTCOME !== undefined && (instance.mode !== "receptionist" || instance.dataMode !== "synthetic_only")) {
    throw new Error("simulated_route_receptionist_synthetic_only");
  }
  let controlledTransferMap: ControlledTransferMap | undefined;
  if (raw.RECEPTIONIST_CONTROLLED_TRANSFER_MAP_JSON !== undefined) {
    if (instance.mode !== "receptionist" || instance.dataMode !== "synthetic_only") throw new Error("controlled_transfer_receptionist_synthetic_only");
    try { controlledTransferMap = controlledTransferMapSchema.parse(JSON.parse(raw.RECEPTIONIST_CONTROLLED_TRANSFER_MAP_JSON)); }
    catch { throw new Error("controlled_transfer_map_invalid"); }
  }
  if (controlledTransferMap?.enabled === true && raw.RECEPTIONIST_SIMULATED_ROUTE_OUTCOME !== undefined) throw new Error("controlled_transfer_simulated_route_conflict");
  if (raw.RECEPTIONIST_DIRECT_DEMO_ENABLED === "true" && (instance.mode !== "receptionist" || instance.dataMode !== "synthetic_only"
    || instance.numberBinding.sourceNumberE164 !== "+17025550100" || raw.RECEPTIONIST_VOICE_CANDIDATE_ENABLED !== "true"
    || raw.RECEPTIONIST_REALTIME_VOICE !== "marin"
    || raw.RECEPTIONIST_RECORD_CALLS !== "false" || raw.RECEPTIONIST_VOICE_PROMOTION_JSON !== undefined
    || raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES !== "false" || controlledTransferMap?.enabled !== true
    || controlledTransferMap.sourceNumberE164 !== instance.numberBinding.sourceNumberE164
    || Object.values(controlledTransferMap.recipients).some(recipient => recipient.destination !== "+17025550101"))) throw new Error("direct_demo_scope_invalid");
  let controlledVoiceFixtures: readonly ControlledSyntheticVoiceFixture[] | undefined;
  if (raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES === "true" && (instance.mode !== "full" || instance.dataMode !== "synthetic_only")) {
    throw new Error("controlled_voice_fixture_synthetic_full_only");
  }
  if (raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES === "true" && raw.RECEPTIONIST_RECORD_CALLS === "true") {
    throw new Error("controlled_voice_fixture_recording_forbidden");
  }
  if (raw.RECEPTIONIST_CONTROLLED_CALLBACK_SAVE_FAILURES === "true" && (instance.mode !== "full" || instance.dataMode !== "synthetic_only")) throw new Error("controlled_callback_failure_synthetic_full_only");
  if (raw.RECEPTIONIST_CONTROLLED_PROTECTED_READ_FAILURE === "true" && (instance.mode !== "full" || instance.dataMode !== "synthetic_only" || raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES !== "true" || raw.RECEPTIONIST_RECORD_CALLS === "true")) throw new Error("controlled_protected_read_failure_synthetic_fixture_only");
  if (raw.RECEPTIONIST_CONTROLLED_ACTION_CONFIRMATION_FAILURE === "true" && (instance.mode !== "full" || instance.dataMode !== "synthetic_only" || raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES !== "true" || raw.RECEPTIONIST_RECORD_CALLS === "true")) throw new Error("controlled_action_confirmation_failure_synthetic_fixture_only");
  if (raw.RECEPTIONIST_CONTROLLED_OFFER_EXPIRY === "true" && (instance.mode !== "full" || instance.dataMode !== "synthetic_only" || raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES !== "true" || raw.RECEPTIONIST_RECORD_CALLS === "true")) throw new Error("controlled_offer_expiry_synthetic_fixture_only");
  if (raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES_JSON !== undefined) {
    if (raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES !== "true") throw new Error("controlled_voice_fixture_disabled");
    try { controlledVoiceFixtures = z.array(controlledSyntheticVoiceFixtureSchema).min(1).max(16).parse(JSON.parse(raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES_JSON)); }
    catch { throw new Error("controlled_voice_fixture_invalid"); }
  }
  return { databaseUrl: raw.DATABASE_URL, instance, ...(syntheticDataset === undefined ? {} : { syntheticDataset }),
    ...(controlledTransferMap === undefined ? {} : { controlledTransferMap }),
    ...(controlledVoiceFixtures === undefined ? {} : { controlledVoiceFixtures }),
    voiceCandidateEnabled: raw.RECEPTIONIST_VOICE_CANDIDATE_ENABLED === "true",
    directDemoEnabled: raw.RECEPTIONIST_DIRECT_DEMO_ENABLED === "true",
    ...(raw.RECEPTIONIST_VOICE_PROMOTION_JSON === undefined ? {} : { voicePromotionJSON: raw.RECEPTIONIST_VOICE_PROMOTION_JSON }),
    controlledVoiceFixturesEnabled: raw.RECEPTIONIST_CONTROLLED_VOICE_FIXTURES === "true",
    controlledCallbackSaveFailures: raw.RECEPTIONIST_CONTROLLED_CALLBACK_SAVE_FAILURES === "true",
    controlledProtectedReadFailure: raw.RECEPTIONIST_CONTROLLED_PROTECTED_READ_FAILURE === "true",
    controlledActionConfirmationFailure: raw.RECEPTIONIST_CONTROLLED_ACTION_CONFIRMATION_FAILURE === "true",
    controlledOfferExpiry: raw.RECEPTIONIST_CONTROLLED_OFFER_EXPIRY === "true",
    ...(raw.RECEPTIONIST_SIMULATED_ROUTE_OUTCOME === undefined ? {} : { simulatedRouteOutcome: raw.RECEPTIONIST_SIMULATED_ROUTE_OUTCOME }),
    publicOrigin,
    twilioAuthToken: raw.TWILIO_AUTH_TOKEN, openAIApiKey: raw.OPENAI_API_KEY, openAIWebhookSecret: raw.OPENAI_WEBHOOK_SECRET,
    openAIProjectId: raw.OPENAI_PROJECT_ID, textModel: raw.OPENAI_TEXT_MODEL, realtimeVoice: raw.RECEPTIONIST_REALTIME_VOICE,
    voiceDialoguePolicy: raw.RECEPTIONIST_VOICE_DIALOGUE_POLICY,
    voiceMutationPolicy: raw.RECEPTIONIST_VOICE_MUTATION_POLICY, recordCalls: raw.RECEPTIONIST_RECORD_CALLS === "true",
    ...(raw.RECEPTIONIST_TRANSCRIBE_RECORDINGS_SINCE === undefined ? {} : { transcribeRecordingsSince: raw.RECEPTIONIST_TRANSCRIBE_RECORDINGS_SINCE }),
    fallback: { capabilitySecret: raw.RECEPTIONIST_FALLBACK_CAPABILITY_SECRET, scriptedPrompt: raw.RECEPTIONIST_SCRIPTED_PROMPT },
    observationSecret: Buffer.from(raw.RECEPTIONIST_OBSERVATION_SECRET, "utf8"), cipherKey: decodeCipherKey(raw.RECEPTIONIST_CIPHER_KEY), host: raw.HOST, port: raw.PORT };
}

export async function startReceptionistMain(input: {
  environment: NodeJS.ProcessEnv;
  monitor: ConfiguredReceptionistMonitor;
  staff: ReceptionistStaffMount;
  fallbackAuthenticator: FallbackTransportAuthenticator;
  voiceJobs: Pick<ReceptionistVoiceJobHandlers, "recovery" | "claimEffect">;
  onTransferFinished(input: { scope: ConversationScope; receipt: TransitionReceipt }): Promise<void>;
  observationSink(line: string): void;
  fetch?: typeof globalThis.fetch;
}): Promise<ReceptionistComposition> {
  const config = parseReceptionistRuntimeConfig(input.environment);
  const composition = createReceptionistComposition({ ...config, cipher: new ConversationCipher(config.cipherKey), monitor: input.monitor, staff: input.staff,
    fallbackAuthenticator: input.fallbackAuthenticator, voiceJobs: input.voiceJobs, onTransferFinished: input.onTransferFinished,
    observations: { secret: config.observationSecret, sink: input.observationSink }, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  await composition.start({ host: config.host, port: config.port });
  return composition;
}

/** Stops admission and drains owned work exactly once for SIGINT or SIGTERM. */
export function installReceptionistSignalShutdown(composition: Pick<ReceptionistComposition, "stop">, processPort: {
  on(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", handler: () => void): unknown;
} = process): { stopped: Promise<void>; dispose(): void } {
  let stopping: Promise<void> | undefined;
  const stop = (): void => {
    stopping ??= composition.stop().finally(() => {
      processPort.off("SIGINT", stop);
      processPort.off("SIGTERM", stop);
    });
  };
  processPort.on("SIGINT", stop);
  processPort.on("SIGTERM", stop);
  return { get stopped() { return stopping ?? Promise.resolve(); }, dispose: () => {
    processPort.off("SIGINT", stop);
    processPort.off("SIGTERM", stop);
  } };
}

function pickEnvironment(environment: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(Object.keys(environmentSchema.shape).map((key) => [key, environment[key]]));
}

function checkedPublicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("receptionist_public_origin_invalid"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new Error("receptionist_public_origin_invalid");
  return url.toString();
}

function decodeCipherKey(value: string): Buffer {
  try {
    const key = Buffer.from(value, "base64url");
    if (key.length !== 32) throw new Error("invalid");
    return key;
  } catch { throw new Error("receptionist_cipher_key_invalid"); }
}
