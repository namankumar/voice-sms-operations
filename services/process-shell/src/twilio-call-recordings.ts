const ACCOUNT_ID = /^AC[a-fA-F0-9]{32}$/;
const CALL_ID = /^CA[a-fA-F0-9]{32}$/;
const RECORDING_ID = /^RE[a-fA-F0-9]{32}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export type CallRecording = Readonly<{ id: string; status: "completed" | "in-progress" | "absent"; durationSeconds: number | null }>;
export type CallRecordingList = Readonly<{ state: "available"; recordings: readonly CallRecording[] } | { state: "unavailable" }>;
export type CallRecordingAudio = Readonly<{ state: "available"; bytes: Uint8Array } | { state: "unavailable" }>;

/** Reads only recordings bound to a known inbound parent call; media is proxied through authenticated staff routes. */
export class TwilioCallRecordingsPort {
  private readonly timeout: number;
  constructor(private readonly options: { accountSid: string; authToken: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }) {
    if (!ACCOUNT_ID.test(options.accountSid) || options.authToken.length === 0) throw new Error("twilio_recording_config_invalid");
    this.timeout = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 100 || this.timeout > 15_000) throw new Error("twilio_recording_timeout_invalid");
  }
  async list(input: { parentCallId: string }): Promise<CallRecordingList> {
    if (!CALL_ID.test(input.parentCallId)) return { state: "unavailable" };
    const url = this.url("Recordings.json"); url.searchParams.set("CallSid", input.parentCallId); url.searchParams.set("PageSize", "5");
    const payload = await this.json(url);
    if (!Array.isArray(payload?.recordings)) return { state: "unavailable" };
    // Do not follow provider pagination dynamically: a partial segment set must never look complete to staff or transcription.
    if (payload.next_page_uri !== null && payload.next_page_uri !== undefined) return { state: "unavailable" };
    return { state: "available", recordings: payload.recordings.map((row) => parseRecording(row, input.parentCallId, this.options.accountSid)).filter((row): row is CallRecording => row !== null) };
  }
  async audio(input: { parentCallId: string; recordingId: string }): Promise<CallRecordingAudio> {
    if (!CALL_ID.test(input.parentCallId) || !RECORDING_ID.test(input.recordingId)) return { state: "unavailable" };
    const recording = parseRecording(await this.json(this.url(`Recordings/${input.recordingId}.json`)), input.parentCallId, this.options.accountSid);
    if (recording === null || recording.id !== input.recordingId || recording.status !== "completed") return { state: "unavailable" };
    const media = await this.bytes(this.url(`Recordings/${input.recordingId}.mp3`));
    if (media === null || media.contentType !== "audio/mpeg") return { state: "unavailable" };
    return { state: "available", bytes: media.bytes };
  }
  private url(path: string): URL { return new URL(`/2010-04-01/Accounts/${this.options.accountSid}/${path}`, "https://api.twilio.com"); }
  private async json(url: URL): Promise<Record<string, unknown> | null> {
    const result = await this.bytes(url); if (result === null) return null;
    try { const value: unknown = JSON.parse(Buffer.from(result.bytes).toString("utf8")); return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
  }
  private async bytes(url: URL): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await (this.options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}` } });
      if (!response.ok || response.body === null) return null;
      const bytes = await boundedBytes(response); if (bytes === null) return null;
      return { bytes, contentType: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "" };
    }
    catch { return null; } finally { clearTimeout(timer); controller.abort(); }
  }
}
function parseRecording(value: unknown, parentCallId: string, accountId: string): CallRecording | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, status = row.status, duration = row.duration === null || row.duration === undefined ? null : Number(row.duration);
  if (!RECORDING_ID.test(String(row.sid)) || row.account_sid !== accountId || row.call_sid !== parentCallId || (status !== "completed" && status !== "in-progress" && status !== "absent")) return null;
  return { id: String(row.sid), status, durationSeconds: duration !== null && Number.isSafeInteger(duration) && duration >= 0 ? duration : null };
}
async function boundedBytes(response: Response): Promise<Uint8Array | null> {
  const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => undefined); return null; } chunks.push(part.value); }
    const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
  } catch { return null; } finally { reader.releaseLock(); }
}
