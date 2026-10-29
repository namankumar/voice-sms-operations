import { randomBytes } from "node:crypto";

import type { ControlPlaneSpokenDirective, StreamingSpeechProvider, TelephonyMediaFrame } from "./ports.js";
import { providerCorrelationId, providerEvent, type ProviderEventSink } from "./provider-events.js";

export interface SpeechResponseBody {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
}
export interface SpeechFetchResponse { readonly ok: boolean; readonly status: number; readonly body: SpeechResponseBody | null; }
export type SpeechFetch = (url: string, init: {
  method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal;
}) => Promise<SpeechFetchResponse>;

export interface OpenAIStreamingSpeechOptions {
  readonly apiKey: string;
  readonly projectId: string;
  readonly organizationId?: string;
  readonly model: string;
  readonly voice: string;
  readonly instructions?: string;
  readonly fetch?: SpeechFetch;
  readonly onDiagnosticEvent?: ProviderEventSink;
  readonly onUsage?: (event: { requestId: string; characters: number }) => void;
  readonly diagnosticHashKey?: Uint8Array;
  readonly now?: () => number;
}

/** Fixed-endpoint text-to-speech adapter. It has no language-decision or tool authority. */
export class OpenAIStreamingSpeechProvider implements StreamingSpeechProvider {
  private readonly fetch: SpeechFetch;
  private readonly diagnosticSink: ProviderEventSink;
  private readonly diagnosticHashKey: Uint8Array;
  private readonly now: () => number;

  constructor(private readonly options: OpenAIStreamingSpeechOptions) {
    if (options.apiKey.length < 20) throw new Error("openai_speech_api_key_required");
    if (!safeToken(options.projectId) || !safeToken(options.model) || !safeToken(options.voice)) {
      throw new Error("openai_speech_configuration_invalid");
    }
    if (options.organizationId !== undefined && !safeToken(options.organizationId)) throw new Error("openai_speech_configuration_invalid");
    if (options.instructions !== undefined && (!options.instructions.trim() || options.instructions.length > 1000)) throw new Error("openai_speech_instructions_invalid");
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init) as Promise<SpeechFetchResponse>);
    this.diagnosticSink = options.onDiagnosticEvent ?? (() => undefined);
    this.diagnosticHashKey = options.diagnosticHashKey ?? randomBytes(32);
    this.now = options.now ?? Date.now;
  }

  async *streamAuthorizedSpeech(_sessionId: string, directive: ControlPlaneSpokenDirective,
    signal: AbortSignal): AsyncIterable<TelephonyMediaFrame> {
    if (directive.text.trim().length === 0 || directive.text.length > 4_000) throw new Error("openai_speech_text_invalid");
    const requestId = `speech-${randomBytes(12).toString("base64url")}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      "content-type": "application/json",
      "x-client-request-id": requestId,
    };
    if (this.options.projectId.trim().toLowerCase() !== "default") headers["OpenAI-Project"] = this.options.projectId.trim();
    if (this.options.organizationId !== undefined) headers["OpenAI-Organization"] = this.options.organizationId;
    this.emit("speech.requested", directive.callId, requestId, { characterCount: directive.text.length });
    const response = await this.fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST", headers, signal,
      body: JSON.stringify({ model: this.options.model, voice: this.options.voice, input: directive.text, response_format: "pcm", ...(this.options.instructions === undefined ? {} : { instructions: this.options.instructions }) }),
    });
    if (!response.ok || response.body === null) {
      this.emit("speech.failed", directive.callId, requestId, { status: response.status });
      throw new Error("openai_speech_request_failed");
    }
    const reader = response.body.getReader(); const codec = new Pcm24kToPcmu8kFramer();
    let sequence = 0; let byteCount = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        if (item.value === undefined || item.value.length === 0) continue;
        byteCount += item.value.length;
        for (const bytes of codec.push(item.value)) {
          yield frame(directive.callId, directive.id, bytes, sequence, this.now()); sequence += 1;
        }
      }
      for (const bytes of codec.finish()) {
        yield frame(directive.callId, directive.id, bytes, sequence, this.now()); sequence += 1;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      this.emit(signal.aborted ? "speech.cancelled" : "speech.failed", directive.callId, requestId, { status: 0 });
      throw error;
    }
    if (sequence === 0) {
      this.emit("speech.failed", directive.callId, requestId, { status: response.status, code: "empty_audio" });
      throw new Error("openai_speech_empty_audio");
    }
    this.options.onUsage?.({ requestId, characters: directive.text.length });
    this.emit("speech.completed", directive.callId, requestId, { sourceByteCount: byteCount, frameCount: sequence });
  }

  private emit(type: string, callId: string, requestId: string,
    details: Record<string, string | number | boolean | null>): void {
    this.diagnosticSink(providerEvent("openai", type, { now: this.now,
      details: { ...details, callCorrelationId: providerCorrelationId(callId, this.diagnosticHashKey),
        requestCorrelationId: providerCorrelationId(requestId, this.diagnosticHashKey) } }));
  }
}

class Pcm24kToPcmu8kFramer {
  private trailingByte: number | null = null;
  private sampleCount = 0;
  private sampleSum = 0;
  private readonly output: number[] = [];

  push(chunk: Uint8Array): readonly Uint8Array[] {
    let bytes = chunk;
    if (this.trailingByte !== null) {
      const joined = new Uint8Array(chunk.length + 1); joined[0] = this.trailingByte; joined.set(chunk, 1);
      bytes = joined; this.trailingByte = null;
    }
    const limit = bytes.length - (bytes.length % 2);
    for (let offset = 0; offset < limit; offset += 2) {
      const sample = (bytes[offset]! | (bytes[offset + 1]! << 8));
      const signed = sample >= 0x8000 ? sample - 0x10000 : sample;
      this.sampleSum += signed; this.sampleCount += 1;
      if (this.sampleCount === 3) {
        this.output.push(linearPcmToMulaw(Math.round(this.sampleSum / this.sampleCount)));
        this.sampleCount = 0; this.sampleSum = 0;
      }
    }
    if (limit < bytes.length) this.trailingByte = bytes[limit]!;
    return this.drain(false);
  }

  finish(): readonly Uint8Array[] {
    if (this.trailingByte !== null) throw new Error("openai_speech_pcm_truncated");
    if (this.sampleCount > 0) {
      this.output.push(linearPcmToMulaw(Math.round(this.sampleSum / this.sampleCount)));
      this.sampleCount = 0; this.sampleSum = 0;
    }
    return this.drain(true);
  }

  private drain(final: boolean): readonly Uint8Array[] {
    const frames: Uint8Array[] = [];
    while (this.output.length >= 160) frames.push(Uint8Array.from(this.output.splice(0, 160)));
    if (final && this.output.length > 0) {
      while (this.output.length < 160) this.output.push(0xff);
      frames.push(Uint8Array.from(this.output.splice(0, 160)));
    }
    return frames;
  }
}

function linearPcmToMulaw(input: number): number {
  const BIAS = 0x84; const CLIP = 32635;
  let sample = Math.max(-CLIP, Math.min(CLIP, input)); const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function frame(callId: string, directiveId: string, bytes: Uint8Array, sequence: number, nowMs: number): TelephonyMediaFrame {
  return { callId, streamId: `openai-speech-${directiveId}`, providerMessageSequenceNumber: sequence,
    mediaChunkNumber: sequence, timestampMs: nowMs, encoding: "audio/pcmu", sampleRateHz: 8_000,
    payloadBase64: Buffer.from(bytes).toString("base64") };
}
function safeToken(value: string): boolean { return /^[A-Za-z0-9._:-]{2,200}$/.test(value); }
