import type { CallRecording, CallRecordingAudio, CallRecordingList } from "./twilio-call-recordings.js";

const OPENAI_TRANSCRIPT_URL = "https://api.openai.com/v1/audio/transcriptions";
const MAX_RECORDING_SECONDS = 30 * 60;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export type RecordingTranscriptScope = Readonly<{ practiceId: string; instanceId: string; conversationId: string }>;
export type RecordingTranscriptStatus = "complete" | "no_speech" | "failed" | "partial" | "unavailable";
export type RecordingTranscriptSegment = Readonly<{ speaker: string; start: number; end: number; text: string }>;
export type RecordingTranscript = Readonly<{
  scope: RecordingTranscriptScope;
  recordingId: string;
  source: "twilio_recording";
  model: "gpt-4o-transcribe-diarize";
  status: RecordingTranscriptStatus;
  text: string;
  segments: readonly RecordingTranscriptSegment[];
  failureCode: string | null;
}>;

/** A claim is durable before media is sent, preventing a timeout from being billed twice. */
export interface RecordingTranscriptStore {
  /** Read-only preflight for polling schedulers; true means no media should be downloaded again. */
  isClaimed?(input: { scope: RecordingTranscriptScope; recordingId: string }): Promise<boolean>;
  claim(input: { scope: RecordingTranscriptScope; recordingId: string }): Promise<"claimed" | "already_claimed">;
  save(transcript: RecordingTranscript): Promise<void>;
}

export interface TwilioCallRecordingsPortLike {
  list(input: { parentCallId: string }): Promise<CallRecordingList>;
  audio(input: { parentCallId: string; recordingId: string }): Promise<CallRecordingAudio>;
}

export type RecordingTranscriptRun = Readonly<{
  recordingId: string | null;
  state: RecordingTranscriptStatus | "over_limit" | "already_claimed" | "unavailable";
}>;

type TranscriptionRequestResult =
  | Readonly<{ state: "success"; value: unknown }>
  | Readonly<{ state: "failed"; failureCode: string }>;

export class RecordingTranscriptWorker {
  private readonly timeoutMs: number;
  constructor(private readonly options: {
    recordings: TwilioCallRecordingsPortLike;
    store: RecordingTranscriptStore;
    openAiApiKey: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  }) {
    if (options.openAiApiKey.length === 0) throw new Error("recording_transcript_openai_key_invalid");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60_000) throw new Error("recording_transcript_timeout_invalid");
  }

  async run(input: { scope: RecordingTranscriptScope; parentCallId: string }): Promise<readonly RecordingTranscriptRun[]> {
    if (!validScope(input.scope)) throw new Error("recording_transcript_scope_invalid");
    const listed = await this.options.recordings.list({ parentCallId: input.parentCallId }).catch(() => ({ state: "unavailable" } as const));
    if (listed.state !== "available") return [{ recordingId: null, state: "unavailable" }];
    return await Promise.all(listed.recordings.map((recording) => this.transcribe(input, recording)));
  }

  private async transcribe(input: { scope: RecordingTranscriptScope; parentCallId: string }, recording: CallRecording): Promise<RecordingTranscriptRun> {
    if (recording.status !== "completed") return { recordingId: recording.id, state: "unavailable" };
    if (this.options.store.isClaimed !== undefined) {
      try { if (await this.options.store.isClaimed({ scope: input.scope, recordingId: recording.id })) return { recordingId: recording.id, state: "already_claimed" }; }
      catch { return { recordingId: recording.id, state: "unavailable" }; }
    }
    if (recording.durationSeconds !== null && recording.durationSeconds > MAX_RECORDING_SECONDS) {
      let claim: "claimed" | "already_claimed";
      try { claim = await this.options.store.claim({ scope: input.scope, recordingId: recording.id }); }
      catch { return { recordingId: recording.id, state: "unavailable" }; }
      if (claim !== "claimed") return { recordingId: recording.id, state: "already_claimed" };
      await this.persist(input.scope, recording.id, "unavailable", "recording_over_limit");
      return { recordingId: recording.id, state: "over_limit" };
    }
    const audio = await this.options.recordings.audio({ parentCallId: input.parentCallId, recordingId: recording.id }).catch(() => ({ state: "unavailable" } as const));
    if (audio.state !== "available" || audio.bytes.byteLength === 0) return { recordingId: recording.id, state: "unavailable" };
    let claim: "claimed" | "already_claimed";
    try { claim = await this.options.store.claim({ scope: input.scope, recordingId: recording.id }); }
    catch { return { recordingId: recording.id, state: "unavailable" }; }
    if (claim !== "claimed") return { recordingId: recording.id, state: "already_claimed" };

    // Any ambiguous OpenAI outcome remains claimed; a later worker run must not resend the audio.
    const result = await this.request(audio.bytes);
    if (result.state === "failed") return await this.persist(input.scope, recording.id, "failed", result.failureCode);
    const parsed = parseDiarized(result.value);
    if (parsed === null) return await this.persist(input.scope, recording.id, "failed", "transcription_response_invalid");
    const status: RecordingTranscriptStatus = parsed.segments.length === 0 && parsed.text.trim().length === 0 ? "no_speech" : parsed.complete ? "complete" : "partial";
    return await this.persist(input.scope, recording.id, status, null, parsed.text, parsed.segments);
  }

  private async persist(scope: RecordingTranscriptScope, recordingId: string, status: RecordingTranscriptStatus, failureCode: string | null, text = "", segments: readonly RecordingTranscriptSegment[] = []): Promise<RecordingTranscriptRun> {
    try {
      await this.options.store.save({ scope, recordingId, source: "twilio_recording", model: "gpt-4o-transcribe-diarize", status, text, segments, failureCode });
      return { recordingId, state: status };
    } catch {
      // The durable claim is intentionally retained, because the paid result may have been produced.
      return { recordingId, state: "failed" };
    }
  }

  private async request(audio: Uint8Array): Promise<TranscriptionRequestResult> {
    const form = new FormData();
    form.set("model", "gpt-4o-transcribe-diarize");
    form.set("response_format", "diarized_json");
    form.set("chunking_strategy", "auto");
    form.set("file", new Blob([Uint8Array.from(audio).buffer], { type: "audio/mpeg" }), "recording.mp3");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await (this.options.fetch ?? fetch)(OPENAI_TRANSCRIPT_URL, { method: "POST", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${this.options.openAiApiKey}` }, body: form });
      if (!response.ok) return { state: "failed", failureCode: "transcription_request_http_" + response.status };
      if (response.body === null) return { state: "failed", failureCode: "transcription_response_body_unavailable" };
      const bytes = await boundedBytes(response, MAX_RESPONSE_BYTES);
      if (bytes === null) return { state: "failed", failureCode: controller.signal.aborted ? "transcription_request_timed_out" : "transcription_response_body_invalid" };
      try { return { state: "success", value: JSON.parse(Buffer.from(bytes).toString("utf8")) }; }
      catch { return { state: "failed", failureCode: "transcription_response_json_invalid" }; }
    } catch {
      return { state: "failed", failureCode: controller.signal.aborted ? "transcription_request_timed_out" : "transcription_request_network_failed" };
    } finally { clearTimeout(timer); controller.abort(); }
  }
}

/** Integration-facing name: invoke independently of post-call evaluation work. */
export { RecordingTranscriptWorker as RecordingTranscriptProcessor };

function validScope(scope: RecordingTranscriptScope): boolean {
  return [scope.practiceId, scope.instanceId, scope.conversationId].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200);
}
function parseDiarized(value: unknown): { text: string; segments: readonly RecordingTranscriptSegment[]; complete: boolean } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.text !== "string" || !Array.isArray(body.segments)) return null;
  const segments: RecordingTranscriptSegment[] = [];
  for (const raw of body.segments) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const segment = raw as Record<string, unknown>;
    if (typeof segment.speaker !== "string" || segment.speaker.length === 0 || typeof segment.text !== "string" || !finiteTime(segment.start) || !finiteTime(segment.end) || segment.end < segment.start) return null;
    segments.push({ speaker: segment.speaker, start: segment.start, end: segment.end, text: segment.text });
  }
  // Keep the provider's raw text and segments, but mark disagreement as partial rather than reconciling it ourselves.
  return { text: body.text, segments, complete: segments.length > 0 && normalized(segments.map((segment) => segment.text).join(" ")) === normalized(body.text) };
}
function finiteTime(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function normalized(value: string): string { return value.trim().replace(/\s+/g, " "); }
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array | null> {
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { void reader.cancel().catch(() => undefined); return null; } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
  } catch { return null; } finally { reader.releaseLock(); }
}
