import type { DecisionContext } from "@salven/contracts";

/** Provider-neutral media and realtime control ports. These ports expose no policy or EHR operations. */

export const TELEPHONY_SAMPLE_RATE_HZ = 8_000;
export const TELEPHONY_PCMU_BYTES_PER_20MS = 160;

export interface TelephonyMediaFrame {
  readonly callId: string;
  readonly streamId: string;
  /** Sequence of provider protocol messages. It advances once per frame, not once per media chunk. */
  readonly providerMessageSequenceNumber: number;
  /** Sequence of 20 ms media chunks represented by this frame. */
  readonly mediaChunkNumber: number;
  /** Provider media-clock timestamp for the first chunk in this frame. */
  readonly timestampMs: number;
  readonly encoding: "audio/pcmu";
  readonly sampleRateHz: typeof TELEPHONY_SAMPLE_RATE_HZ;
  readonly payloadBase64: string;
}

export interface NormalizedAudioChunk {
  readonly callId: string;
  readonly streamId: string;
  readonly providerMessageSequenceNumber: number;
  readonly mediaChunkNumber: number;
  readonly startedAtMs: number;
  readonly durationMs: 20;
  readonly encoding: "audio/pcmu";
  readonly sampleRateHz: typeof TELEPHONY_SAMPLE_RATE_HZ;
  readonly bytes: Uint8Array;
}

export interface ProviderConnectionContract {
  readonly authentication: {
    readonly owner: "adapter";
    readonly credentialsExposedToRuntime: false;
  };
  readonly reconnect: {
    readonly owner: "adapter";
    readonly policy: "fail_closed" | "bounded_retry_then_fail_closed";
    readonly maxAttempts: number;
  };
  readonly resume: {
    readonly owner: "adapter";
    readonly supported: boolean;
    readonly continuityTokenExposedToRuntime: false;
  };
}

export interface TelephonyProvider {
  readonly name: string;
  readonly connectionContract: ProviderConnectionContract;
  sendAudio(callId: string, audio: NormalizedAudioChunk, outputDirectiveId: string, signal: AbortSignal): Promise<void>;
  /** Telephony clear is call-wide. Providers may subsequently emit marks for audio that was cleared. */
  clearAudio(callId: string, signal: AbortSignal): Promise<void>;
  sendMark(callId: string, markId: string, signal: AbortSignal): Promise<void>;
  closeCall(callId: string): Promise<void>;
}

export type VadSource = "server" | "client";
export type VadState = "speech_started" | "speech_ended";

export interface VoiceActivitySignal {
  readonly source: VadSource;
  readonly state: VadState;
  readonly atMs: number;
  readonly confidence: number | null;
}

export interface RealtimeTranscript {
  readonly turnId: string;
  readonly segmentId: string;
  readonly sequenceNumber: number;
  readonly text: string;
  readonly isFinal: boolean;
}

export interface RealtimeVoiceProvider {
  readonly name: string;
  readonly connectionContract: ProviderConnectionContract;
  openSession(input: { callId: string }, signal: AbortSignal): Promise<string>;
  appendAudio(sessionId: string, audio: NormalizedAudioChunk, signal: AbortSignal): Promise<void>;
  cancelOutput(sessionId: string, outputDirectiveId: string, signal: AbortSignal): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

/** Language-only proposal port. The caller must validate every result through the authority kernel. */
export interface RealtimeDecisionProvider {
  requestNextMove(sessionId: string, context: DecisionContext, signal: AbortSignal): Promise<unknown>;
}

/** Renders only an already-authorized directive; generated audio cannot choose content or actions. */
export interface RealtimeSpeechProvider {
  renderAuthorizedSpeech(
    sessionId: string,
    directive: ControlPlaneSpokenDirective,
    signal: AbortSignal,
  ): Promise<TelephonyMediaFrame>;
}

/** Streams audio derived only from an already-authorized server text directive. */
export interface StreamingSpeechProvider {
  streamAuthorizedSpeech(
    sessionId: string,
    directive: ControlPlaneSpokenDirective,
    signal: AbortSignal,
  ): AsyncIterable<TelephonyMediaFrame>;
}

export interface VoiceCallBinding {
  readonly practiceId: string;
  readonly callId: string;
  readonly lifecycleId: string;
  readonly traceId: string;
  readonly caseId: string;
  readonly stateVersion: number;
  readonly activeGoalId: string;
}

export interface AuthenticatedTelephonyMark {
  readonly authority: "telephony_adapter";
  readonly issuerId: string;
  readonly authorityReceiptId: string;
  readonly authorityNonce: string;
  readonly authorityExpiresAtMs: number;
  readonly providerEventId: string;
  readonly providerName: string;
  readonly receivedAtMs: number;
  readonly callId: string;
  readonly callLifecycleId: string;
  readonly outputDirectiveId: string;
  readonly markId: string;
}

/** Authenticates and atomically consumes one provider event; mark text alone has no authority. */
export interface TelephonyMarkAuthority {
  readonly name: string;
  verifyAndConsume(input: {
    readonly mark: AuthenticatedTelephonyMark;
    readonly call: VoiceCallBinding;
    readonly expectedProviderName: string;
    readonly expectedOutputDirectiveId: string;
    readonly expectedMarkId: string;
    readonly nowMs: number;
  }): Promise<boolean>;
}

export type TrustedTerminalOutcome = "completed" | "caller_hangup" | "provider_ended";

export interface TrustedTerminalOutcomeReceipt {
  readonly authority: "call_orchestrator";
  readonly issuerId: string;
  readonly authorityReceiptId: string;
  readonly authorityNonce: string;
  readonly authorityExpiresAtMs: number;
  readonly callId: string;
  readonly callLifecycleId: string;
  readonly callStateVersion: number;
  readonly goalId: string;
  readonly outcome: TrustedTerminalOutcome;
}

/** Verifies and atomically consumes a terminal decision before low-level provider teardown. */
export interface TerminalOutcomeAuthority {
  readonly name: string;
  verifyAndConsume(input: {
    readonly receipt: TrustedTerminalOutcomeReceipt;
    readonly call: VoiceCallBinding;
    readonly nowMs: number;
  }): Promise<boolean>;
}

export interface SpokenDirectiveProvenance {
  readonly authority: "control_plane";
  readonly issuerId: string;
  readonly authorityReceiptId: string;
  readonly authorityNonce: string;
  readonly authorityExpiresAtMs: number;
  readonly traceId: string;
  readonly issuedAtMs: number;
  readonly sourceEventIds: readonly string[];
}

/** Control-plane output object. The runtime validates its bindings and takes an immutable snapshot before I/O. */
export interface ControlPlaneSpokenDirective {
  readonly id: string;
  readonly kind: "speak";
  readonly purpose: "acknowledgement" | "progress" | "response";
  readonly callId: string;
  readonly callLifecycleId: string;
  readonly turnId: string;
  readonly callStateVersion: number;
  readonly goalId: string;
  readonly text: string;
  readonly provenance: SpokenDirectiveProvenance;
}

/** Local authenticity boundary, typically backed by a control-plane signature or receipt verifier. */
export interface SpokenDirectiveAuthority {
  readonly name: string;
  /** Verifies authenticity/freshness and atomically consumes the authority receipt against replay. */
  verifyAndConsume(input: {
    readonly directive: ControlPlaneSpokenDirective;
    readonly call: VoiceCallBinding;
    readonly nowMs: number;
  }): Promise<boolean>;
}
