import {
  TELEPHONY_PCMU_BYTES_PER_20MS,
  TELEPHONY_SAMPLE_RATE_HZ,
  type ControlPlaneSpokenDirective,
  type NormalizedAudioChunk,
  type TelephonyMediaFrame,
  type VadState,
  type VoiceActivitySignal,
  type VoiceCallBinding,
} from "./ports.js";

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("telephony_media_invalid_base64");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function assertPosition(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("telephony_media_invalid_position");
}

/** Splits one provider message into deterministic 20 ms chunks without changing its message sequence. */
export function normalizeTelephonyMedia(frame: TelephonyMediaFrame): readonly NormalizedAudioChunk[] {
  if (frame.encoding !== "audio/pcmu" || frame.sampleRateHz !== TELEPHONY_SAMPLE_RATE_HZ) {
    throw new Error("telephony_media_unsupported_format");
  }
  assertPosition(frame.providerMessageSequenceNumber);
  assertPosition(frame.mediaChunkNumber);
  assertPosition(frame.timestampMs);
  const bytes = decodeBase64(frame.payloadBase64);
  if (bytes.length === 0 || bytes.length % TELEPHONY_PCMU_BYTES_PER_20MS !== 0) {
    throw new Error("telephony_media_invalid_frame_size");
  }
  const chunks: NormalizedAudioChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += TELEPHONY_PCMU_BYTES_PER_20MS) {
    const position = offset / TELEPHONY_PCMU_BYTES_PER_20MS;
    chunks.push({
      callId: frame.callId,
      streamId: frame.streamId,
      providerMessageSequenceNumber: frame.providerMessageSequenceNumber,
      mediaChunkNumber: frame.mediaChunkNumber + position,
      startedAtMs: frame.timestampMs + (position * 20),
      durationMs: 20,
      encoding: frame.encoding,
      sampleRateHz: frame.sampleRateHz,
      bytes: bytes.slice(offset, offset + TELEPHONY_PCMU_BYTES_PER_20MS),
    });
  }
  return chunks;
}

export type TelephonyContinuityDomain = "provider_message" | "media_chunk" | "media_timestamp";
export type TelephonyContinuityIssue = "duplicate" | "out_of_order" | "gap";

export class TelephonyMediaContinuityError extends Error {
  constructor(
    readonly domain: TelephonyContinuityDomain,
    readonly issue: TelephonyContinuityIssue,
    readonly expected: number,
    readonly received: number,
  ) {
    super(`telephony_media_${domain}_${issue}`);
  }
}

interface StreamCursor {
  readonly initialTimestampMs: number;
  readonly receivedDurationMs: number;
  readonly lastProviderMessageSequenceNumber: number;
  readonly lastMediaChunkNumber: number;
  readonly lastTimestampMs: number;
  readonly expectedProviderMessageSequenceNumber: number;
  readonly expectedMediaChunkNumber: number;
  readonly expectedTimestampMs: number;
}

function continuityIssue(received: number, expected: number, last: number): TelephonyContinuityIssue {
  if (received >= last && received < expected) return "duplicate";
  return received > expected ? "gap" : "out_of_order";
}

export type OrderedPcmInputClock = Readonly<{ kind: "ordered_pcm_samples_v1"; maxPresentationStepErrorMs: 20; maxPresentationCumulativeDriftMs: 300 }>;
export type PresentationTimingDeviation = Readonly<{ rawTimestampMs: number; expectedTimestampMs: number; stepErrorMs: number; cumulativeDriftMs: number }>;

/** Tracks provider protocol messages, media chunks, and media-clock timestamps as independent domains. */
export class TelephonyMediaContinuityTracker {
  private readonly streams = new Map<string, StreamCursor>();
  private readonly initialControls = new Map<string, number>();
  constructor(private readonly inputClock?: OrderedPcmInputClock, private readonly onPresentationDeviation?: (value: PresentationTimingDeviation) => void) {
    if (inputClock !== undefined && (inputClock.kind !== "ordered_pcm_samples_v1" || inputClock.maxPresentationStepErrorMs !== 20 || inputClock.maxPresentationCumulativeDriftMs !== 300)) throw new Error("telephony_input_clock_policy_invalid");
  }

  accept(frame: TelephonyMediaFrame, chunkCount: number): void {
    const key = JSON.stringify([frame.callId, frame.streamId]);
    const cursor = this.streams.get(key);
    const priorControl = this.initialControls.get(key);
    if (cursor === undefined && this.inputClock !== undefined && frame.mediaChunkNumber !== 1) throw new TelephonyMediaContinuityError("media_chunk", "gap", 1, frame.mediaChunkNumber);
    if (cursor === undefined && priorControl !== undefined) this.assertDomain("provider_message", frame.providerMessageSequenceNumber, priorControl + 1, priorControl);
    this.initialControls.delete(key);
    if (cursor !== undefined) {
      this.assertDomain(
        "provider_message",
        frame.providerMessageSequenceNumber,
        cursor.expectedProviderMessageSequenceNumber,
        cursor.lastProviderMessageSequenceNumber,
      );
      this.assertDomain("media_chunk", frame.mediaChunkNumber, cursor.expectedMediaChunkNumber, cursor.lastMediaChunkNumber);
      if (this.inputClock === undefined) this.assertDomain("media_timestamp", frame.timestampMs, cursor.expectedTimestampMs, cursor.lastTimestampMs);
      else {
        const stepErrorMs = frame.timestampMs - cursor.expectedTimestampMs;
        const cumulativeDriftMs = frame.timestampMs - (cursor.initialTimestampMs + cursor.receivedDurationMs);
        if (frame.timestampMs <= cursor.lastTimestampMs || Math.abs(stepErrorMs) > this.inputClock.maxPresentationStepErrorMs || Math.abs(cumulativeDriftMs) > this.inputClock.maxPresentationCumulativeDriftMs)
          throw new TelephonyMediaContinuityError("media_timestamp", continuityIssue(frame.timestampMs, cursor.expectedTimestampMs, cursor.lastTimestampMs), cursor.expectedTimestampMs, frame.timestampMs);
        if (stepErrorMs !== 0) try { this.onPresentationDeviation?.({ rawTimestampMs: frame.timestampMs, expectedTimestampMs: cursor.expectedTimestampMs, stepErrorMs, cumulativeDriftMs }); } catch { /* Diagnostics cannot change continuity. */ }
      }
    }
    this.streams.set(key, {
      initialTimestampMs: cursor?.initialTimestampMs ?? frame.timestampMs, receivedDurationMs: (cursor?.receivedDurationMs ?? 0) + chunkCount * 20,
      lastProviderMessageSequenceNumber: frame.providerMessageSequenceNumber,
      lastMediaChunkNumber: frame.mediaChunkNumber,
      lastTimestampMs: frame.timestampMs,
      expectedProviderMessageSequenceNumber: frame.providerMessageSequenceNumber + 1,
      expectedMediaChunkNumber: frame.mediaChunkNumber + chunkCount,
      expectedTimestampMs: frame.timestampMs + (chunkCount * 20),
    });
  }

  /** Controls advance the provider clock, never the independent media chunk or timestamp domains. */
  observeControl(input: { callId: string; streamId: string; providerSequenceNumber: number }): void {
    if (!Number.isSafeInteger(input.providerSequenceNumber) || input.providerSequenceNumber < 0) throw new Error("telephony_control_sequence_invalid");
    const key = JSON.stringify([input.callId, input.streamId]), cursor = this.streams.get(key);
    if (cursor === undefined) {
      const prior = this.initialControls.get(key);
      if (prior !== undefined) this.assertDomain("provider_message", input.providerSequenceNumber, prior + 1, prior);
      this.initialControls.set(key, input.providerSequenceNumber); return;
    }
    this.assertDomain("provider_message", input.providerSequenceNumber, cursor.expectedProviderMessageSequenceNumber, cursor.lastProviderMessageSequenceNumber);
    this.streams.set(key, { ...cursor, lastProviderMessageSequenceNumber: input.providerSequenceNumber, expectedProviderMessageSequenceNumber: input.providerSequenceNumber + 1 });
  }
  reset(): void { this.streams.clear(); this.initialControls.clear(); }

  private assertDomain(domain: TelephonyContinuityDomain, received: number, expected: number, last: number): void {
    if (received === expected) return;
    throw new TelephonyMediaContinuityError(domain, continuityIssue(received, expected, last), expected, received);
  }
}

export interface NormalizedVadSignal {
  readonly state: VadState;
  readonly atMs: number;
  readonly sources: readonly VoiceActivitySignal["source"][];
}

/** One instance belongs to exactly one turn. */
export class VadNormalizer {
  private state: VadState | null = null;
  private atMs = -1;

  normalize(signal: VoiceActivitySignal): NormalizedVadSignal | null {
    if (!Number.isFinite(signal.atMs) || signal.atMs < this.atMs) throw new Error("vad_timestamp_out_of_order");
    if (signal.confidence !== null && (!Number.isFinite(signal.confidence) || signal.confidence < 0 || signal.confidence > 1)) {
      throw new Error("vad_confidence_invalid");
    }
    this.atMs = signal.atMs;
    if (this.state === signal.state) return null;
    if (this.state === null && signal.state === "speech_ended") return null;
    this.state = signal.state;
    return { state: signal.state, atMs: signal.atMs, sources: [signal.source] };
  }
}

export interface StabilizedTranscript {
  readonly turnId: string;
  readonly segmentId: string;
  readonly sequenceNumber: number;
  readonly text: string;
  readonly isFinal: boolean;
}

interface TranscriptState { sequenceNumber: number; text: string; final: boolean; }

/** One instance belongs to exactly one turn and seals final segments. */
export class TranscriptStabilizer {
  private readonly segments = new Map<string, TranscriptState>();

  stabilize(input: import("./ports.js").RealtimeTranscript): StabilizedTranscript | null {
    const prior = this.segments.get(input.segmentId);
    if (prior !== undefined) {
      if (prior.final || input.sequenceNumber <= prior.sequenceNumber) return null;
      if (input.text.length < prior.text.length && !input.isFinal) return null;
    }
    this.segments.set(input.segmentId, { sequenceNumber: input.sequenceNumber, text: input.text, final: input.isFinal });
    return { ...input };
  }
}

function assertIdentifier(value: string, field: string): void {
  if (value.length < 3 || value.length > 200) throw new Error(`spoken_directive_invalid_${field}`);
}

/** Validates authority bindings, then clones and deeply freezes the directive before provider I/O. */
export function snapshotSpokenDirective(
  directive: ControlPlaneSpokenDirective,
  call: VoiceCallBinding,
  turnId: string,
): ControlPlaneSpokenDirective {
  assertIdentifier(directive.id, "id");
  assertIdentifier(directive.provenance.issuerId, "issuer");
  assertIdentifier(directive.provenance.authorityReceiptId, "authority_receipt");
  assertIdentifier(directive.provenance.authorityNonce, "authority_nonce");
  assertIdentifier(directive.provenance.traceId, "trace");
  if (directive.provenance.authority !== "control_plane") throw new Error("spoken_directive_wrong_authority");
  if (!Number.isSafeInteger(directive.provenance.issuedAtMs) || directive.provenance.issuedAtMs < 0) throw new Error("spoken_directive_invalid_issued_at");
  if (!Number.isSafeInteger(directive.provenance.authorityExpiresAtMs) || directive.provenance.authorityExpiresAtMs < 0) {
    throw new Error("spoken_directive_invalid_expiry");
  }
  if (directive.callId !== call.callId) throw new Error("spoken_directive_call_mismatch");
  if (directive.callLifecycleId !== call.lifecycleId) throw new Error("spoken_directive_lifecycle_mismatch");
  if (directive.turnId !== turnId) throw new Error("spoken_directive_turn_mismatch");
  if (directive.callStateVersion !== call.stateVersion) throw new Error("spoken_directive_state_mismatch");
  if (directive.goalId !== call.activeGoalId) throw new Error("spoken_directive_goal_mismatch");
  if (directive.text.trim().length === 0 || directive.text.length > 4_000) throw new Error("spoken_directive_invalid_text");
  const sourceEventIds = Object.freeze([...directive.provenance.sourceEventIds]);
  if (sourceEventIds.length === 0) throw new Error("spoken_directive_missing_source_event");
  sourceEventIds.forEach((sourceEventId) => assertIdentifier(sourceEventId, "source_event"));
  const provenance = Object.freeze({ ...directive.provenance, sourceEventIds });
  return Object.freeze({ ...directive, provenance });
}
