import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedPostgresFixture } from "../packages/testing/src/postgres-test-fixture.js";
import { applyDatabaseMigrations } from "../services/control-plane/src/postgres/migrations.js";
import { ConversationCipher } from "../services/process-shell/src/conversation-store.js";
import { createReceptionistComposition, type ReceptionistComposition } from "../services/process-shell/src/receptionist-composition.js";
import { RECEPTIONIST_REALTIME_MODEL, type SidebandSocket, type SidebandSocketFactory } from "../services/process-shell/src/receptionist-openai.js";
import { receptionistAppInstanceSchema, type VoiceAppInstance } from "../services/process-shell/src/receptionist-policy.js";

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_CLIP_BYTES = 4_000_000;
const MAX_SOURCE_BYTES = 2_000_000;
const offlineTwilioAuthToken = "t".repeat(32);
const offlineWebhookSecret = `whsec_${Buffer.from("local-app-bridge-webhook").toString("base64")}`;
const offlinePublicOrigin = "https://local-fixture.invalid";
const offlineCompositions = new WeakSet<ReceptionistComposition>();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A selected source snapshot, not a transitive dependency closure or exact runtime identity.
const appSourcePaths = [
  "services/process-shell/src/receptionist-composition.ts", "services/process-shell/src/receptionist-app.ts",
  "services/process-shell/src/receptionist-main.ts", "services/process-shell/src/conversation-console.ts",
  "services/process-shell/src/receptionist-sip-ingress.ts", "services/process-shell/src/receptionist-sip-binding.ts",
  "services/process-shell/src/receptionist-voice-runtime.ts", "services/process-shell/src/receptionist-voice-session.ts",
  "services/process-shell/src/receptionist-tool-gateway.ts", "services/process-shell/src/receptionist-openai.ts",
  "services/process-shell/src/receptionist-policy.ts", "services/process-shell/src/receptionist-http.ts",
  "services/process-shell/src/receptionist-openai-transport.ts", "services/process-shell/src/conversation-ingress.ts",
  "services/process-shell/src/conversation-job-worker.ts", "services/process-shell/src/receptionist-recovery.ts",
  "services/process-shell/src/conversation-contract.ts", "services/process-shell/src/conversation-store.ts",
  "services/process-shell/src/conversation-jobs.ts",
  "services/process-shell/src/receptionist-speech-assessor.ts",
  "services/process-shell/src/receptionist-public-faq.ts",
  "services/process-shell/src/simulated-route-outcome.ts",
] as const;

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) throw new Error("voice_fixture_file_size_or_type_invalid");
    const bytes = Buffer.allocUnsafe(before.size);
    for (let offset = 0; offset < bytes.length;) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new Error("voice_fixture_file_changed_during_read");
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("voice_fixture_file_changed_during_read");
    return bytes;
  } finally { await file.close(); }
}

export type SelectedSourceFingerprint = Readonly<{ sha256: string; files: readonly { path: string; sha256: string }[] }>;

export async function fingerprintSourceFiles(rootPath: string, paths: readonly string[]): Promise<SelectedSourceFingerprint> {
  if (paths.length < 1 || paths.length > 32 || new Set(paths).size !== paths.length) throw new Error("local_app_source_paths_invalid");
  const root = await realpath(rootPath);
  const files: Array<{ path: string; sha256: string }> = [];
  for (const name of paths) {
    if (!name || isAbsolute(name)) throw new Error("local_app_source_path_invalid");
    const path = await realpath(resolve(root, name));
    if (!contained(root, path)) throw new Error("local_app_source_path_invalid");
    files.push({ path: name, sha256: sha256(await readBoundedRegularFile(path, MAX_SOURCE_BYTES)) });
  }
  return { sha256: sha256(JSON.stringify(files)), files };
}

async function currentSelectedSourceFingerprints() {
  return { appSelectedFiles: await fingerprintSourceFiles(runtimeRoot, appSourcePaths),
    harnessFile: await fingerprintSourceFiles(runtimeRoot, ["scripts/verification-voice-app.ts"]) };
}

/** Audio and text are caller-supplied fixtures, never evidence of ASR, model comprehension, or heard output. */
export type VerifiedCallerFixture = Readonly<{
  kind: "supplied_pcm_and_transcript_fixture";
  fixtureId: string;
  manifestSha256: string;
  clipSha256: string;
  transcriptSha256: string;
  transcript: string;
  pcm: Buffer;
  sampleRate: 16_000;
  channels: 1;
  samples: number;
}>;

export async function loadCallerFixture(input: { manifestPath: string; expectedManifestSha256: string; fixtureId: string }): Promise<VerifiedCallerFixture> {
  const root = await realpath(dirname(resolve(input.manifestPath)));
  const manifestPath = await realpath(input.manifestPath);
  if (!contained(root, manifestPath)) throw new Error("voice_fixture_path_invalid");
  const raw = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  if (sha256(raw) !== input.expectedManifestSha256) throw new Error("voice_fixture_manifest_hash_mismatch");
  const manifest: unknown = JSON.parse(raw.toString("utf8"));
  if (!record(manifest) || !record(manifest.format) || manifest.format.container !== "WAV" || manifest.format.encoding !== "PCM_S16LE"
    || manifest.format.sample_rate !== 16_000 || manifest.format.channels !== 1 || !Array.isArray(manifest.clips)) throw new Error("voice_fixture_manifest_invalid");
  const matches = manifest.clips.filter((entry): entry is Record<string, unknown> => record(entry) && `${entry.profile}/${entry.utterance}` === input.fixtureId);
  if (matches.length !== 1) throw new Error("voice_fixture_id_missing_or_duplicate");
  const clip = matches[0]!;
  if (typeof clip.file !== "string" || typeof clip.transcript !== "string" || clip.transcript.trim().length === 0 || !record(clip.audio)
    || typeof clip.audio.sha256 !== "string" || typeof clip.audio.duration_seconds !== "number") throw new Error("voice_fixture_metadata_invalid");
  if (isAbsolute(clip.file)) throw new Error("voice_fixture_path_invalid");
  const path = await realpath(resolve(root, clip.file));
  if (!contained(root, path)) throw new Error("voice_fixture_path_invalid");
  const wav = await readBoundedRegularFile(path, MAX_CLIP_BYTES);
  if (sha256(wav) !== clip.audio.sha256) throw new Error("voice_fixture_clip_hash_mismatch");
  const pcm = extractPcm16(wav);
  const samples = pcm.length / 2;
  if (Math.abs(samples / 16_000 - clip.audio.duration_seconds) > 0.002) throw new Error("voice_fixture_duration_mismatch");
  return Object.freeze({ kind: "supplied_pcm_and_transcript_fixture", fixtureId: input.fixtureId, manifestSha256: sha256(raw),
    clipSha256: sha256(wav), transcriptSha256: sha256(clip.transcript), transcript: clip.transcript, pcm,
    sampleRate: 16_000, channels: 1, samples });
}

function extractPcm16(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE"
    || wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("voice_fixture_wav_invalid");
  let format = false, pcm: Buffer | undefined;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), start = at + 8, end = start + size;
    if (end > wav.length) throw new Error("voice_fixture_wav_invalid");
    const kind = wav.toString("ascii", at, at + 4);
    if (kind === "fmt ") {
      if (format || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1
        || wav.readUInt32LE(start + 4) !== 16_000 || wav.readUInt32LE(start + 8) !== 32_000
        || wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) throw new Error("voice_fixture_wav_format_invalid");
      format = true;
    }
    if (kind === "data") { if (pcm !== undefined || size === 0 || size % 2 !== 0) throw new Error("voice_fixture_wav_data_invalid"); pcm = wav.subarray(start, end); }
    at = end + (size % 2);
  }
  if (!format || pcm === undefined) throw new Error("voice_fixture_wav_invalid");
  return pcm;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

type ReadbackReceipt = { receipt: { accepted: boolean; eventId: string }; input: { scope: { practiceId: string; instanceId: string; conversationId: string }; command: unknown; proposal?: unknown } } | null;
type ReadbackConversation = { id: string; inputs: readonly { id: string; body: string }[];
  requests: readonly { id: string; sourceIds: readonly string[]; category: string | null; originalRequest: string }[] };

/** A fixture proposal is not evidence until both persisted receipts and the selected request agree. */
export function assertLocalFixtureReadback(input: {
  durable: ReadbackConversation;
  transcriptReceipt: ReadbackReceipt;
  toolReceipt: ReadbackReceipt;
  expected: { practiceId: string; instanceId: string; sourceId: string; transcript: string; category: string;
    promptVersion: string; transcriptReceiptId: string; toolReceiptId: string };
}): string {
  const { durable, transcriptReceipt, toolReceipt, expected } = input;
  const sourceInputs = durable.inputs.filter((item) => item.id === expected.sourceId);
  const requests = durable.requests.filter((item) => item.sourceIds.includes(expected.sourceId));
  if (sourceInputs.length !== 1 || sourceInputs[0]!.body !== expected.transcript || requests.length !== 1
    || requests[0]!.sourceIds.length !== 1 || requests[0]!.sourceIds[0] !== expected.sourceId
    || requests[0]!.category !== expected.category || requests[0]!.originalRequest !== expected.transcript)
    throw new Error("local_app_durable_readback_mismatch");
  const scopeMatches = (receipt: NonNullable<ReadbackReceipt>) => receipt.input.scope.practiceId === expected.practiceId
    && receipt.input.scope.instanceId === expected.instanceId && receipt.input.scope.conversationId === durable.id;
  if (!transcriptReceipt?.receipt.accepted || transcriptReceipt.receipt.eventId !== expected.transcriptReceiptId || !scopeMatches(transcriptReceipt)
    || !record(transcriptReceipt.input.command) || transcriptReceipt.input.command.type !== "input.record"
    || transcriptReceipt.input.command.sourceId !== expected.sourceId || transcriptReceipt.input.command.body !== expected.transcript)
    throw new Error("local_app_durable_receipt_mismatch");
  const command = toolReceipt?.input.command, proposal = toolReceipt?.input.proposal;
  if (!toolReceipt?.receipt.accepted || toolReceipt.receipt.eventId !== expected.toolReceiptId || !scopeMatches(toolReceipt)
    || !record(command) || command.type !== "request.draft" || command.requestId !== requests[0]!.id
    || command.sourceEventId !== expected.sourceId || command.category !== expected.category
    || !record(proposal) || proposal.sourceId !== expected.sourceId || proposal.tool !== "propose_receptionist_intent"
    || proposal.promptVersion !== expected.promptVersion || proposal.model !== RECEPTIONIST_REALTIME_MODEL
    || proposal.provider !== "openai" || !record(proposal.arguments) || proposal.arguments.category !== expected.category)
    throw new Error("local_app_durable_receipt_mismatch");
  return requests[0]!.id;
}

export class LocalFixtureSideband implements SidebandSocketFactory, SidebandSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly receivedFixtureEvents: Array<{ eventId: string; type: string }> = [];
  readonly callerPcmFrames: Buffer[] = [];
  readonly callerPcmProvenance = "fixture_only_not_provider_audio" as const;
  connectedCallId: string | null = null;
  failConnect = false;
  failSend = false;
  private readonly message = new Set<(payload: string) => void>();
  private readonly error = new Set<(error: unknown) => void>();
  private readonly closeHandlers = new Set<(input: { code: number | null }) => void>();
  async connect(input: { url: string; signal: AbortSignal; maxPayloadBytes: number }): Promise<SidebandSocket> {
    if (this.failConnect) throw new Error("fixture_sideband_unavailable");
    const url = new URL(input.url);
    if (input.signal.aborted || url.origin !== "wss://api.openai.com" || url.pathname !== "/v1/realtime"
      || url.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(url.searchParams.get("call_id") ?? "") || input.maxPayloadBytes < 1_024)
      throw new Error("fixture_sideband_binding_invalid");
    this.connectedCallId = url.searchParams.get("call_id");
    return this;
  }
  async send(payload: string): Promise<void> {
    if (this.failSend) throw new Error("fixture_sideband_send_failed");
    const parsed: unknown = JSON.parse(payload);
    if (!record(parsed)) throw new Error("fixture_sideband_payload_invalid");
    this.sent.push(parsed);
  }
  close(): void { this.connectedCallId = null; }
  onMessage(handler: (payload: string | Uint8Array) => void): () => void { this.message.add(handler); return () => this.message.delete(handler); }
  onError(handler: (error: unknown) => void): () => void { this.error.add(handler); return () => this.error.delete(handler); }
  onClose(handler: (input: { code: number | null }) => void): () => void { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }
  injectEvent(eventId: string, type: string, payload: Record<string, unknown>): void {
    if (this.connectedCallId === null || !/^[A-Za-z0-9_-]{1,200}$/.test(eventId) || this.receivedFixtureEvents.some((item) => item.eventId === eventId))
      throw new Error("fixture_sideband_event_invalid");
    this.receivedFixtureEvents.push({ eventId, type });
    const value = JSON.stringify({ ...payload, type, event_id: eventId });
    for (const handler of this.message) handler(value);
  }
  injectCallerPcm(fixture: VerifiedCallerFixture): void {
    if (this.connectedCallId === null || fixture.kind !== "supplied_pcm_and_transcript_fixture") throw new Error("fixture_caller_audio_unbound");
    this.callerPcmFrames.length = 0;
    for (let at = 0; at < fixture.pcm.length; at += 640) this.callerPcmFrames.push(Buffer.from(fixture.pcm.subarray(at, at + 640)));
    if (sha256(Buffer.concat(this.callerPcmFrames)) !== sha256(fixture.pcm)) throw new Error("fixture_caller_audio_corrupt");
  }
  latestResponseToken(): string | null {
    for (let index = this.sent.length - 1; index >= 0; index--) {
      const event = this.sent[index]!;
      if (event.type === "response.create" && record(event.response) && record(event.response.metadata)
        && typeof event.response.metadata.receptionist_response_token === "string") return event.response.metadata.receptionist_response_token;
    }
    return null;
  }
}

export type OfflineVoiceFailureMode = "none" | "provider_rejected" | "sideband_unavailable" | "sideband_send_failed";

type OfflineVoiceApp = Readonly<{
  composition: ReceptionistComposition;
  instance: VoiceAppInstance;
  socket: LocalFixtureSideband;
  parentCallId: string;
  providerCallId: string;
  sourceId: string;
  providerRequests: string[];
}>;

function createOfflineVoiceApp(databaseUrl: string, fixtureId: string, failureMode: OfflineVoiceFailureMode): OfflineVoiceApp {
  const digest = sha256(fixtureId);
  const parentCallId = `CA${digest.slice(0, 32)}`;
  const providerCallId = `rtc_fixture_${digest.slice(0, 24)}`;
  const sourceId = `fixture_${digest.slice(0, 24)}`;
  const instance = receptionistAppInstanceSchema.parse({ schemaVersion: 1, configVersion: "fixture-config-1",
    instanceId: "fixture-instance", practiceId: "fixture-practice", accountId: `AC${"a".repeat(32)}`,
    mode: "receptionist", dataMode: "synthetic_only", promptVersion: "fixture-prompt-1",
    numberBinding: { sourceNumberE164: "+17025550100", channels: ["voice", "sms"] },
    hours: { kind: "demo_fixture", fixture: "demo_open" },
    routes: Object.fromEntries(["scheduling", "referrals", "billing_or_insurance", "clinical", "records_or_administrative", "general_or_uncertain"]
      .map((category) => [category, { kind: "stub", stubId: `stub-${category}` }])) });
  const socket = new LocalFixtureSideband();
  socket.failConnect = failureMode === "sideband_unavailable";
  socket.failSend = failureMode === "sideband_send_failed";
  const providerRequests: string[] = [];
  const providerFetch: typeof globalThis.fetch = async (resource, init) => {
    const url = String(resource);
    providerRequests.push(url);
    if (url === `https://api.openai.com/v1/realtime/calls/${providerCallId}/accept` && init?.method === "POST")
      return new Response(null, { status: failureMode === "provider_rejected" ? 401 : 200 });
    throw new Error("local_app_external_network_denied");
  };
  let composition!: ReceptionistComposition;
  composition = createReceptionistComposition({ instance, databaseUrl, cipher: new ConversationCipher(randomBytes(32)),
    publicOrigin: offlinePublicOrigin, twilioAuthToken: offlineTwilioAuthToken, openAIApiKey: "fixture-only-key",
    openAIWebhookSecret: offlineWebhookSecret, openAIProjectId: "proj_fixture", textModel: "fixture-text-model", realtimeVoice: "marin",
    sidebandSocketFactory: socket, fetch: providerFetch,
    textTransport: async () => { throw new Error("offline_text_provider_denied"); },
    smsProvider: { submit: async () => { throw new Error("offline_sms_provider_denied"); },
      read: async () => { throw new Error("offline_sms_provider_denied"); } },
    fallback: { capabilitySecret: "a".repeat(32), scriptedPrompt: "Please leave a message." },
    fallbackAuthenticator: { verify: async () => true },
    monitor: { ready: async () => true, observe: async () => { throw new Error("fixture_monitor_not_exercised"); }, drain: async () => undefined },
    staff: { mount: () => async (_request, response) => { response.end(); }, render: () => ({ title: "Staff", body: "" }) },
    voiceJobs: { recovery: async () => ({ code: "not_needed" }), claimEffect: async (job) => {
      const attemptId = `fixture-${job.id.slice(0, 24)}`;
      const claimed = await composition.jobs.markEffectStarted({ scope: job.scope, id: job.id, kind: job.kind, leaseToken: job.leaseToken,
        attemptId, now: new Date().toISOString() });
      return claimed ? { attemptId } : null;
    } },
    onTransferFinished: async () => undefined, observations: { secret: randomBytes(32), sink: () => undefined }, workerIdleMs: 25 });
  offlineCompositions.add(composition);
  return { composition, instance, socket, parentCallId, providerCallId, sourceId, providerRequests };
}

export type LocalAppBridgeEvidence = Readonly<{
  schemaVersion: "local-voice-app-fixture/v2";
  kind: "local_app_fixture_execution_not_carrier_or_model_evidence";
  sourceIdentityScope: "selected_source_files_only_not_exact_runtime_identity";
  fixtureId: string;
  fixtureManifestSha256: string;
  fixtureClipSha256: string;
  fixtureTranscriptSha256: string;
  sourceId: string;
  providerCallId: string;
  parentCallId: string;
  conversationId: string;
  databaseFixtureId: string;
  sipAttemptId: string;
  configVersion: string;
  promptVersion: string;
  selectedSourceFingerprints: Readonly<{ appSelectedFiles: SelectedSourceFingerprint; harnessFile: SelectedSourceFingerprint }>;
  voiceEpoch: number;
  inputSourceIds: readonly string[];
  requestSourceIds: readonly string[];
  requestCategory: string;
  transcriptReceiptId: string;
  toolReceiptId: string;
  normalizedFixtureEvents: readonly { eventId: string; type: string }[];
  offlineProviderRequests: readonly string[];
  callerPcmProvenance: "fixture_only_not_provider_audio";
}>;

/** Immutable synthetic-safe observation: no audio, text, model/provider payload, or mutable runtime object. */
export type LocalAppBridgeObservation = Readonly<{
  responseToken: string; responseCreateEventIndex: number; conversationId: string; sipAttemptId: string;
  transcriptReceiptId: string; toolReceiptId: string;
}>;

export type LocalAppBridgeInput = Readonly<{
  fixtureSource: { manifestPath: string; expectedManifestSha256: string; fixtureId: string };
  expectedCategory: "scheduling" | "referrals" | "billing_or_insurance" | "clinical" | "records_or_administrative" | "general_or_uncertain";
  evidencePath: string;
  failureMode?: OfflineVoiceFailureMode;
  waitMs?: number;
  observe?: (observation: LocalAppBridgeObservation) => void | Promise<void>;
}>;

function validateOfflineInput(value: unknown): asserts value is LocalAppBridgeInput {
  if (!record(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["fixtureSource", "expectedCategory", "evidencePath", "failureMode", "waitMs", "observe"].includes(key)))
    throw new Error("local_app_untrusted_injection");
  const source = value.fixtureSource;
  if (!record(source) || ![Object.prototype, null].includes(Object.getPrototypeOf(source))
    || Reflect.ownKeys(source).some((key) => typeof key !== "string" || !["manifestPath", "expectedManifestSha256", "fixtureId"].includes(key))
    || typeof source.manifestPath !== "string" || source.manifestPath.length < 1
    || typeof source.expectedManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.expectedManifestSha256)
    || typeof source.fixtureId !== "string" || !/^[A-Za-z0-9/_-]{1,120}$/.test(source.fixtureId)
    || !["scheduling", "referrals", "billing_or_insurance", "clinical", "records_or_administrative", "general_or_uncertain"].includes(String(value.expectedCategory))
    || typeof value.evidencePath !== "string" || value.evidencePath.length < 1
    || (value.failureMode !== undefined && !["none", "provider_rejected", "sideband_unavailable", "sideband_send_failed"].includes(String(value.failureMode)))
    || (value.waitMs !== undefined && (!Number.isSafeInteger(value.waitMs) || (value.waitMs as number) < 100 || (value.waitMs as number) > 30_000))
    || (value.observe !== undefined && typeof value.observe !== "function"))
    throw new Error("local_app_untrusted_injection");
}

export async function runLocalVoiceAppFixture(input: LocalAppBridgeInput): Promise<LocalAppBridgeEvidence> {
  validateOfflineInput(input);
  const selectedSourceFingerprints = await currentSelectedSourceFingerprints();
  let database: Awaited<ReturnType<typeof createIsolatedPostgresFixture>> | undefined;
  let offline: OfflineVoiceApp | undefined;
  try {
    const fixture = await loadCallerFixture(input.fixtureSource);
    database = await createIsolatedPostgresFixture({ name: `local-voice-${sha256(fixture.fixtureId).slice(0, 8)}`,
      rerunCommand: "VOICE_BENCHMARK_SOURCE_ROOT=<product-directory> pnpm exec vitest run scripts/verification-voice-app.test.ts",
      initializeDatabase: applyDatabaseMigrations });
    offline = createOfflineVoiceApp(database.databaseURL, fixture.fixtureId, input.failureMode ?? "none");
    const evidence = await executeLocalVoiceAppFixture({ ...offline, fixture, expectedCategory: input.expectedCategory, observe: input.observe,
      waitMs: input.waitMs ?? 8_000, databaseFixtureId: database.identity.fixtureId }, selectedSourceFingerprints);
    await offline.composition.stop();
    offline = undefined;
    await database.close({ status: "passed" });
    database = undefined;
    await writeNewJson(input.evidencePath, evidence);
    return evidence;
  } catch (error) {
    let failure: unknown = error;
    if (offline !== undefined) {
      try { await offline.composition.stop(); }
      catch (stopError) { failure = new AggregateError([failure, stopError], "local_app_stop_failed"); }
    }
    if (database !== undefined) {
      try { await database.close({ status: "failed", phase: "local-app-bridge", error: failure }); }
      catch (closeError) { failure = new AggregateError([failure, closeError], "local_app_database_close_failed"); }
    }
    const reason = error instanceof Error && /^[a-z0-9_]{1,120}$/.test(error.message) ? error.message : "local_app_fixture_failed";
    try {
      await writeNewJson(`${input.evidencePath}.failure.json`, { schemaVersion: "local-voice-app-fixture/v2",
        kind: "local_app_fixture_failure_not_carrier_or_model_evidence",
        sourceIdentityScope: "selected_source_files_only_not_exact_runtime_identity",
        fixtureId: input.fixtureSource.fixtureId, expectedManifestSha256: input.fixtureSource.expectedManifestSha256,
        configVersion: "fixture-config-1", promptVersion: "fixture-prompt-1", selectedSourceFingerprints,
        parentCallId: offline?.parentCallId ?? null, providerCallId: offline?.providerCallId ?? null,
        sourceId: offline?.sourceId ?? null, reason });
    } catch (reportError) { throw new AggregateError([failure, reportError], "local_app_failure_report_unavailable"); }
    throw failure;
  }
}

type InternalAppBridgeInput = OfflineVoiceApp & Readonly<{ fixture: VerifiedCallerFixture; expectedCategory: LocalAppBridgeInput["expectedCategory"]; waitMs: number; databaseFixtureId: string; observe?: LocalAppBridgeInput["observe"] }>;

async function executeLocalVoiceAppFixture(input: InternalAppBridgeInput, selectedSourceFingerprints: Awaited<ReturnType<typeof currentSelectedSourceFingerprints>>): Promise<LocalAppBridgeEvidence> {
  const { composition, instance, socket, fixture } = input;
  if (!offlineCompositions.has(composition)) throw new Error("local_app_untrusted_composition");
  if (!/^CA[a-fA-F0-9]{32}$/.test(input.parentCallId) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.providerCallId)
    || !/^[A-Za-z0-9_-]{1,200}$/.test(input.sourceId) || !/^[a-f0-9]{64}$/.test(fixture.clipSha256)) throw new Error("local_app_fixture_binding_invalid");
  const address = await composition.start({ host: "127.0.0.1", port: 0 });
  const local = `http://127.0.0.1:${address.port}`;
  const form = { AccountSid: instance.accountId, CallSid: input.parentCallId, From: "+17025550123", To: instance.numberBinding.sourceNumberE164,
    Direction: "inbound", CallStatus: "in-progress" };
  const path = "/voice/inbound";
  const signature = createHmac("sha1", offlineTwilioAuthToken).update(offlinePublicOrigin + path + Object.keys(form).sort().map((key) => key + form[key as keyof typeof form]).join("")).digest("base64");
  const admission = await fetch(`${local}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature }, body: new URLSearchParams(form) });
  const twiml = await admission.text();
  if (admission.status !== 200) throw new Error("local_app_admission_failed");
  const token = twiml.match(/X-Voice-Operation-Correlation=([A-Za-z0-9_-]{43})/)?.[1];
  if (!token) throw new Error("local_app_sip_binding_missing");
  const webhookId = `evt_${input.sourceId}`;
  const body = JSON.stringify({ id: webhookId, type: "realtime.call.incoming", data: { call_id: input.providerCallId,
    sip_media_security: "srtp", sip_headers: [{ name: "X-Voice-Operation-Correlation", value: token }] } });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const webhookSignature = createHmac("sha256", Buffer.from(offlineWebhookSecret.slice(6), "base64"))
    .update(`${webhookId}.${timestamp}.${body}`).digest("base64");
  const webhook = await fetch(`${local}/openai/webhook`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": webhookId,
    "webhook-timestamp": timestamp, "webhook-signature": `v1,${webhookSignature}` }, body });
  if (webhook.status !== 200) throw new Error("local_app_webhook_failed");
  const waitMs = input.waitMs;
  const conversation = await poll(async () => await composition.store.findVoiceByParent({ practiceId: instance.practiceId, instanceId: instance.instanceId,
    accountId: instance.accountId, parentCallId: input.parentCallId }), (value) => value !== null, waitMs);
  if (conversation === null) throw new Error("local_app_conversation_missing");
  await poll(async () => socket.connectedCallId, (value) => value === input.providerCallId, waitMs);
  const openingToken = await poll(async () => socket.latestResponseToken(), (value) => value !== null, waitMs);
  if (openingToken === null) throw new Error("local_app_opening_token_missing");
  socket.injectCallerPcm(fixture);
  socket.injectEvent(`${input.sourceId}_speech`, "input_audio_buffer.speech_started", { item_id: input.sourceId });
  socket.injectEvent(`${input.sourceId}_transcript`, "conversation.item.input_audio_transcription.completed", { item_id: input.sourceId, transcript: fixture.transcript });
  await poll(async () => (await composition.store.get({ practiceId: instance.practiceId, instanceId: instance.instanceId, conversationId: conversation.id }))?.inputs.some((value) => value.id === input.sourceId), Boolean, waitMs);
  const tokenAfterTranscript = await awaitNewResponseToken(socket, openingToken, waitMs);
  const responseId = `response_${input.sourceId}`;
  socket.injectEvent(`${input.sourceId}_response`, "response.created", { response: { id: responseId, metadata: { receptionist_response_token: tokenAfterTranscript } } });
  socket.injectEvent(`${input.sourceId}_tool`, "response.function_call_arguments.done", { response_id: responseId, call_id: `tool_${input.sourceId}`,
    name: "propose_receptionist_intent", arguments: JSON.stringify({ category: input.expectedCategory, callerSummary: "Fixture model proposal, not asserted fact", requestMeaning: "route_request" }) });
  const durable = await poll(async () => await composition.store.get({ practiceId: instance.practiceId, instanceId: instance.instanceId, conversationId: conversation.id }),
    (value) => value?.requests.some((request) => request.sourceIds.includes(input.sourceId)) ?? false, waitMs);
  if (!durable) throw new Error("local_app_durable_readback_mismatch");
  const scope = { practiceId: instance.practiceId, instanceId: instance.instanceId, conversationId: durable.id };
  const bound = await composition.bindings.forVoiceEpoch(scope, durable.voiceEpoch);
  if (bound?.callId !== input.providerCallId || bound.binding.parentCallId !== input.parentCallId
    || bound.binding.configVersion !== instance.configVersion || bound.binding.scope.conversationId !== durable.id)
    throw new Error("local_app_sip_readback_mismatch");
  const transcriptReceiptId = `voice-transcript-${sha256(input.sourceId).slice(0, 32)}`;
  const toolReceiptId = `tool-voice-${sha256(`${input.providerCallId}:tool_${input.sourceId}`).slice(0, 32)}`;
  const [transcriptReceipt, toolReceipt] = await Promise.all([composition.store.getEvent(scope, transcriptReceiptId), composition.store.getEvent(scope, toolReceiptId)]);
  const requestId = assertLocalFixtureReadback({ durable, transcriptReceipt, toolReceipt,
    expected: { practiceId: instance.practiceId, instanceId: instance.instanceId, sourceId: input.sourceId, transcript: fixture.transcript,
      category: input.expectedCategory, promptVersion: instance.promptVersion, transcriptReceiptId, toolReceiptId } });
  const request = durable.requests.find((item) => item.id === requestId)!;
  if (JSON.stringify(await currentSelectedSourceFingerprints()) !== JSON.stringify(selectedSourceFingerprints)) throw new Error("local_app_selected_source_changed_during_run");
  const evidence: LocalAppBridgeEvidence = { schemaVersion: "local-voice-app-fixture/v2",
    kind: "local_app_fixture_execution_not_carrier_or_model_evidence",
    sourceIdentityScope: "selected_source_files_only_not_exact_runtime_identity", fixtureId: fixture.fixtureId,
    fixtureManifestSha256: fixture.manifestSha256, fixtureClipSha256: fixture.clipSha256, fixtureTranscriptSha256: fixture.transcriptSha256,
    sourceId: input.sourceId, providerCallId: input.providerCallId, parentCallId: input.parentCallId, conversationId: durable.id,
    sipAttemptId: bound.binding.attemptId, databaseFixtureId: input.databaseFixtureId,
    configVersion: instance.configVersion, promptVersion: instance.promptVersion, selectedSourceFingerprints, voiceEpoch: durable.voiceEpoch,
    inputSourceIds: durable.inputs.map((item) => item.id), requestSourceIds: request.sourceIds, requestCategory: input.expectedCategory,
    transcriptReceiptId, toolReceiptId,
    normalizedFixtureEvents: [...socket.receivedFixtureEvents], offlineProviderRequests: [...input.providerRequests], callerPcmProvenance: socket.callerPcmProvenance };
  const responseCreateEventIndex = socket.sent.findIndex((event) => event.type === "response.create" && record(event.response)
    && record(event.response.metadata) && event.response.metadata.receptionist_response_token === tokenAfterTranscript);
  if (responseCreateEventIndex < 0) throw new Error("local_app_response_frame_missing");
  if (input.observe !== undefined) await input.observe(Object.freeze({ responseToken: tokenAfterTranscript, responseCreateEventIndex,
    conversationId: durable.id, sipAttemptId: bound.binding.attemptId, transcriptReceiptId, toolReceiptId }));
  return evidence;
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); }
}

export async function awaitNewResponseToken(socket: Pick<LocalFixtureSideband, "latestResponseToken">, previous: string, waitMs: number): Promise<string> {
  const value = await poll(async () => socket.latestResponseToken(), (token) => token !== null && token !== previous, waitMs);
  if (value === null) throw new Error("local_app_response_token_missing");
  return value;
}

async function poll<T>(read: () => Promise<T>, accept: (value: T) => boolean, waitMs: number): Promise<T> {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("local_app_fixture_timeout");
}
