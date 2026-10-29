import {
  normalizeTelephonyMedia,
  snapshotSpokenDirective,
  TelephonyMediaContinuityError,
  TelephonyMediaContinuityTracker, type OrderedPcmInputClock,
  TranscriptStabilizer,
  VadNormalizer,
} from "./normalization.js";
import type { DecisionContext } from "@salven/contracts";
import type {
  AuthenticatedTelephonyMark,
  ControlPlaneSpokenDirective,
  NormalizedAudioChunk,
  RealtimeTranscript,
  RealtimeDecisionProvider,
  RealtimeSpeechProvider,
  RealtimeVoiceProvider,
  StreamingSpeechProvider,
  SpokenDirectiveAuthority,
  TelephonyMarkAuthority,
  TelephonyMediaFrame,
  TelephonyProvider,
  TerminalOutcomeAuthority,
  TrustedTerminalOutcomeReceipt,
  VoiceActivitySignal,
  VoiceCallBinding,
} from "./ports.js";
import { processingCueAsset } from "./processing-cue.js";
import { LatencyWatchdog, type LatencyPrediction, type LatencyTreatment } from "./watchdog.js";

export type VoiceRuntimeEventType =
  | "call.opened"
  | "call.failed"
  | "call.ended"
  | "turn.started"
  | "turn.first_acknowledged"
  | "turn.progressed"
  | "turn.timing_breached"
  | "vad.normalized"
  | "transcript.stabilized"
  | "decision.proposed"
  | "decision.failed"
  | "latency.acknowledgement_cancelled"
  | "latency.predicted"
  | "generic_processing_started"
  | "processing.cleared"
  | "media.presentation_timing_deviation"
  | "media.discontinuity"
  | "media.backpressure_overflow"
  | "output.registered"
  | "output.mark_armed"
  | "output.heard"
  | "output.interrupted"
  | "output.cleared_mark_discarded";

/** Audit-safe event. Transcript text, media, provider payloads, and caller data never cross this boundary. */
export interface VoiceRuntimeEvent {
  readonly schemaVersion: 1;
  readonly type: VoiceRuntimeEventType;
  readonly practiceId: string;
  readonly callId: string;
  readonly lifecycleId: string;
  readonly traceId: string;
  readonly caseId: string;
  readonly goalId: string;
  readonly callStateVersion: number;
  readonly turnId: string | null;
  readonly outputDirectiveId: string | null;
  readonly atMs: number;
  readonly redaction: Readonly<{
    policy: "phi_safe_metadata_only";
    transcriptExcluded: true;
    mediaExcluded: true;
    providerPayloadExcluded: true;
  }>;
  readonly providers: Readonly<{
    telephony: Readonly<{ name: string }>;
    realtime: Readonly<{ name: string }>;
  }>;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface VoiceRuntimeClock { now(): number; }

export interface VoiceRuntimeOptions {
  readonly clock?: VoiceRuntimeClock;
  readonly inputClock?: OrderedPcmInputClock;
  readonly firstAckDeadlineMs?: number;
  readonly progressDeadlineMs?: number;
  readonly maxPendingChunks?: number;
  readonly maxAuditEvents?: number;
  readonly maxDirectivesPerCall?: number;
  readonly progressIntervalMs?: number;
  readonly operationTimeoutMs?: number;
  readonly onEvent?: (event: VoiceRuntimeEvent) => void;
}

type TurnState = "listening" | "responding" | "interrupted" | "completed";
type TimingCheckpoint = "first_ack" | "progress";

interface Turn {
  state: TurnState;
  readonly startedAtMs: number;
  firstAcknowledgedAtMs: number | null;
  progressedAtMs: number | null;
  readonly timingBreaches: Set<TimingCheckpoint>;
  readonly vad: VadNormalizer;
  readonly transcripts: TranscriptStabilizer;
}

interface ActiveCall extends VoiceCallBinding {
  status: "opening" | "active" | "terminating";
  sessionId: string | null;
  readonly abortController: AbortController;
}

interface PendingOutput {
  readonly directive: ControlPlaneSpokenDirective;
  readonly markId: string;
  readonly abortController: AbortController;
  readonly inFlightOperations: Set<Promise<unknown>>;
  status: "registered" | "playing" | "clearing";
}

interface PreparedOutput {
  readonly call: ActiveCall;
  readonly directive: ControlPlaneSpokenDirective;
  readonly output: PendingOutput;
  readonly signal: AbortSignal;
  audioStarted: boolean;
}

interface ClearedMark {
  readonly turnId: string;
  readonly outputDirectiveId: string;
}

interface ActiveProcessingCue {
  readonly turnId: string;
  readonly treatmentId: string;
  readonly processingEventId: string;
  readonly abortController: AbortController;
}

function isClearing(output: PendingOutput): boolean {
  return output.status === "clearing";
}

function supportsDecisions(provider: RealtimeVoiceProvider): provider is RealtimeVoiceProvider & RealtimeDecisionProvider {
  return "requestNextMove" in provider && typeof provider.requestNextMove === "function";
}

function supportsAuthorizedSpeech(provider: RealtimeVoiceProvider): provider is RealtimeVoiceProvider & RealtimeSpeechProvider {
  return "renderAuthorizedSpeech" in provider && typeof provider.renderAuthorizedSpeech === "function";
}

function supportsStreamingSpeech(provider: RealtimeVoiceProvider): provider is RealtimeVoiceProvider & StreamingSpeechProvider {
  return "streamAuthorizedSpeech" in provider && typeof provider.streamAuthorizedSpeech === "function";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("voice_runtime_unknown_failure");
}

class VoiceAuditFailure extends Error {}

function isVoiceAuditFailure(error: unknown): error is VoiceAuditFailure {
  return error instanceof VoiceAuditFailure;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`voice_runtime_invalid_${name}`);
}

function assertAuthorityIdentifier(value: string, name: string): void {
  if (typeof value !== "string" || value.length < 3 || value.length > 200) {
    throw new Error(`voice_authority_invalid_${name}`);
  }
}

function snapshotTelephonyMark(mark: AuthenticatedTelephonyMark): AuthenticatedTelephonyMark {
  assertAuthorityIdentifier(mark.issuerId, "mark_issuer");
  assertAuthorityIdentifier(mark.authorityReceiptId, "mark_receipt");
  assertAuthorityIdentifier(mark.authorityNonce, "mark_nonce");
  assertAuthorityIdentifier(mark.providerEventId, "provider_event");
  assertAuthorityIdentifier(mark.providerName, "provider_name");
  assertAuthorityIdentifier(mark.callId, "mark_call");
  assertAuthorityIdentifier(mark.callLifecycleId, "mark_lifecycle");
  assertAuthorityIdentifier(mark.outputDirectiveId, "mark_directive");
  assertAuthorityIdentifier(mark.markId, "mark_id");
  if (mark.authority !== "telephony_adapter") throw new Error("voice_mark_wrong_authority");
  if (!Number.isSafeInteger(mark.authorityExpiresAtMs) || mark.authorityExpiresAtMs < 0) {
    throw new Error("voice_mark_invalid_expiry");
  }
  if (!Number.isSafeInteger(mark.receivedAtMs) || mark.receivedAtMs < 0) throw new Error("voice_mark_invalid_received_at");
  return Object.freeze({ ...mark });
}

function snapshotTerminalReceipt(receipt: TrustedTerminalOutcomeReceipt): TrustedTerminalOutcomeReceipt {
  assertAuthorityIdentifier(receipt.issuerId, "terminal_issuer");
  assertAuthorityIdentifier(receipt.authorityReceiptId, "terminal_receipt");
  assertAuthorityIdentifier(receipt.authorityNonce, "terminal_nonce");
  assertAuthorityIdentifier(receipt.callId, "terminal_call");
  assertAuthorityIdentifier(receipt.callLifecycleId, "terminal_lifecycle");
  assertAuthorityIdentifier(receipt.goalId, "terminal_goal");
  if (receipt.authority !== "call_orchestrator") throw new Error("voice_terminal_wrong_authority");
  if (!Number.isSafeInteger(receipt.authorityExpiresAtMs) || receipt.authorityExpiresAtMs < 0) {
    throw new Error("voice_terminal_invalid_expiry");
  }
  if (!Number.isSafeInteger(receipt.callStateVersion) || receipt.callStateVersion < 0) {
    throw new Error("voice_terminal_invalid_state_version");
  }
  return Object.freeze({ ...receipt });
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("voice_provider_operation_aborted");
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("voice_provider_operation_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export class LowLatencyVoiceHarness {
  private readonly clock: VoiceRuntimeClock;
  private readonly firstAckDeadlineMs: number;
  private readonly progressDeadlineMs: number;
  private readonly maxPendingChunks: number;
  private readonly maxAuditEvents: number;
  private readonly maxDirectivesPerCall: number;
  private readonly onEvent: (event: VoiceRuntimeEvent) => void;
  private readonly latencyWatchdog: LatencyWatchdog;
  private readonly events: VoiceRuntimeEvent[] = [];
  private readonly mediaContinuity: TelephonyMediaContinuityTracker;
  private readonly turns = new Map<string, Turn>();
  private readonly outputs = new Map<string, PendingOutput>();
  private readonly usedDirectiveIds = new Set<string>();
  private readonly clearedMarks = new Map<string, ClearedMark>();
  private readonly inFlightOperations = new Set<Promise<unknown>>();
  private appendTail: Promise<void> = Promise.resolve();
  private pendingChunks = 0;
  private call: ActiveCall | null = null;
  private activeOutputId: string | null = null;
  private activeProcessingCue: ActiveProcessingCue | null = null;
  private termination: Promise<number> | null = null;
  private sinkFailures = 0;

  constructor(
    private readonly telephony: TelephonyProvider,
    private readonly realtime: RealtimeVoiceProvider,
    private readonly directiveAuthority: SpokenDirectiveAuthority,
    private readonly markAuthority: TelephonyMarkAuthority,
    private readonly terminalOutcomeAuthority: TerminalOutcomeAuthority,
    options: VoiceRuntimeOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.mediaContinuity = new TelephonyMediaContinuityTracker(options.inputClock, value => this.emit("media.presentation_timing_deviation", null, null, value));
    this.firstAckDeadlineMs = options.firstAckDeadlineMs ?? 700;
    this.progressDeadlineMs = options.progressDeadlineMs ?? 1_500;
    this.maxPendingChunks = options.maxPendingChunks ?? 50;
    this.maxAuditEvents = options.maxAuditEvents ?? 256;
    this.maxDirectivesPerCall = options.maxDirectivesPerCall ?? 256;
    this.latencyWatchdog = new LatencyWatchdog({
      acknowledgementAtMs: this.firstAckDeadlineMs,
      progressAtMs: this.progressDeadlineMs,
      ...(options.progressIntervalMs === undefined ? {} : { progressIntervalMs: options.progressIntervalMs }),
      ...(options.operationTimeoutMs === undefined ? {} : { timeoutAtMs: options.operationTimeoutMs }),
    });
    assertPositiveInteger(this.firstAckDeadlineMs, "first_ack_deadline");
    assertPositiveInteger(this.progressDeadlineMs, "progress_deadline");
    assertPositiveInteger(this.maxPendingChunks, "max_pending_chunks");
    assertPositiveInteger(this.maxAuditEvents, "max_audit_events");
    assertPositiveInteger(this.maxDirectivesPerCall, "max_directives_per_call");
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  get auditEvents(): readonly VoiceRuntimeEvent[] { return Object.freeze([...this.events]); }
  get eventSinkFailureCount(): number { return this.sinkFailures; }
  /** Returns a mark only after all audio was sent and the provider mark was armed. */
  armedMarkFor(outputDirectiveId: string): string | null {
    const output = this.outputs.get(outputDirectiveId);
    return output?.status === "playing" ? output.markId : null;
  }
  get stateSnapshot(): Readonly<{
    active: boolean;
    turnCount: number;
    outputCount: number;
    clearedMarkCount: number;
    pendingChunks: number;
  }> {
    return Object.freeze({
      active: this.call?.status === "active",
      turnCount: this.turns.size,
      outputCount: this.outputs.size,
      clearedMarkCount: this.clearedMarks.size,
      pendingChunks: this.pendingChunks,
    });
  }

  async openCall(binding: VoiceCallBinding): Promise<void> {
    if (this.call !== null) throw new Error("voice_call_already_open");
    if (!Number.isSafeInteger(binding.stateVersion) || binding.stateVersion < 0) throw new Error("voice_call_invalid_state_version");
    if (
      binding.callId.length < 3
      || binding.lifecycleId.length < 3
      || binding.traceId.length < 3
      || binding.caseId.length < 3
      || binding.activeGoalId.length < 3
    ) {
      throw new Error("voice_call_invalid_binding");
    }
    const call: ActiveCall = {
      ...binding,
      status: "opening",
      sessionId: null,
      abortController: new AbortController(),
    };
    this.call = call;
    try {
      call.sessionId = await this.runProviderOperation(
        () => this.realtime.openSession({ callId: call.callId }, call.abortController.signal),
        call.abortController.signal,
      );
      call.status = "active";
      this.emit("call.opened", null, null, { stateVersion: call.stateVersion });
    } catch (error) {
      await this.failCall("realtime_open_failed");
      if (isVoiceAuditFailure(error)) throw error;
      throw new Error("voice_realtime_open_failed");
    }
  }

  startTurn(turnId: string): void {
    this.requireActiveCall();
    if (turnId.length < 3) throw new Error("voice_turn_invalid_id");
    if (this.turns.has(turnId)) throw new Error("voice_turn_already_started");
    this.turns.set(turnId, {
      state: "listening",
      startedAtMs: this.clock.now(),
      firstAcknowledgedAtMs: null,
      progressedAtMs: null,
      timingBreaches: new Set(),
      vad: new VadNormalizer(),
      transcripts: new TranscriptStabilizer(),
    });
    this.latencyWatchdog.startTurn(turnId);
    this.emit("turn.started", turnId, null, {});
  }

  /** Captures only already accepted input operations; later media cannot move this barrier. */
  captureInputAppendBarrier(): Promise<void> { return this.appendTail; }

  async observeTelephonyControlSequence(input: { callId: string; streamId: string; providerSequenceNumber: number }): Promise<void> {
    this.requireActiveCall(input.callId);
    try { this.mediaContinuity.observeControl(input); }
    catch (error) { await this.failCall("media_control_discontinuity"); throw error; }
  }

  async ingestTelephonyMedia(frame: TelephonyMediaFrame): Promise<void> {
    const call = this.requireActiveCall(frame.callId);
    let chunks: readonly NormalizedAudioChunk[];
    try {
      chunks = normalizeTelephonyMedia(frame);
      if (this.pendingChunks + chunks.length > this.maxPendingChunks) {
        const error = new Error("voice_media_backpressure_overflow");
        this.emit("media.backpressure_overflow", null, null, {
          maxPendingChunks: this.maxPendingChunks,
          pendingChunks: this.pendingChunks,
          incomingChunks: chunks.length,
        });
        await this.failCall("media_backpressure_overflow");
        throw error;
      }
      this.mediaContinuity.accept(frame, chunks.length);
    } catch (error) {
      if (error instanceof TelephonyMediaContinuityError && this.call?.status === "active") {
        this.emit("media.discontinuity", null, null, {
          domain: error.domain,
          reason: error.issue,
          expected: error.expected,
          received: error.received,
        });
        await this.failCall("media_discontinuity");
      } else if (this.call?.status === "active") {
        await this.failCall("media_normalization_failed");
      }
      throw asError(error);
    }

    this.pendingChunks += chunks.length;
    const append = this.appendTail.then(async () => {
      if (call.status !== "active") throw new Error("voice_provider_operation_aborted");
      const sessionId = this.requireSession(call);
      for (const chunk of chunks) {
        await this.runProviderOperation(
          () => this.realtime.appendAudio(sessionId, chunk, call.abortController.signal),
          call.abortController.signal,
        );
      }
    });
    this.appendTail = append;
    try {
      await append;
    } catch (error) {
      if (this.call?.status === "active") await this.failCall("realtime_append_failed");
      throw new Error("voice_realtime_append_failed");
    } finally {
      this.pendingChunks = Math.max(0, this.pendingChunks - chunks.length);
    }
  }

  async receiveVad(signal: VoiceActivitySignal, turnId: string): Promise<void> {
    this.requireActiveCall();
    const turn = this.requireTurn(turnId);
    let normalized;
    try {
      normalized = turn.vad.normalize(signal);
    } catch {
      await this.failCall("vad_normalization_failed");
      throw new Error("voice_vad_normalization_failed");
    }
    if (normalized === null) return;
    this.emit("vad.normalized", turnId, null, { state: normalized.state, source: normalized.sources.join(",") });
    if (normalized.state === "speech_started") {
      await this.clearProcessingCue("caller_speech");
      await this.interruptForBargeIn(turnId);
    }
    else this.latencyWatchdog.speechEnded(turnId, this.clock.now());
  }

  async receiveTranscript(transcript: RealtimeTranscript): Promise<{ text: string; isFinal: boolean; sequenceNumber: number } | null> {
    this.requireActiveCall();
    const turn = this.requireTurn(transcript.turnId);
    let stabilized;
    try {
      stabilized = turn.transcripts.stabilize(transcript);
    } catch {
      await this.failCall("transcript_normalization_failed");
      throw new Error("voice_transcript_normalization_failed");
    }
    if (stabilized === null) return null;
    this.emit("transcript.stabilized", transcript.turnId, null, {
      sequenceNumber: stabilized.sequenceNumber,
      isFinal: stabilized.isFinal,
      characterCount: stabilized.text.length,
    });
    return { text: stabilized.text, isFinal: stabilized.isFinal, sequenceNumber: stabilized.sequenceNumber };
  }

  /** Sends an authorized context to the language-only provider; the result remains untrusted. */
  async propose(context: DecisionContext): Promise<unknown> {
    const call = this.requireActiveCall(context.callId);
    if (context.practiceId !== call.practiceId || context.caseId !== call.caseId
      || context.goal.id !== call.activeGoalId || context.callStateVersion !== call.stateVersion) {
      throw new Error("voice_decision_context_binding_mismatch");
    }
    const decisionProvider = this.realtime;
    if (!supportsDecisions(decisionProvider)) throw new Error("voice_realtime_decision_unavailable");
    const startedAt = this.clock.now();
    try {
      const proposal = await this.runProviderOperation(
        () => decisionProvider.requestNextMove(this.requireSession(call), context, call.abortController.signal),
        call.abortController.signal,
      );
      this.emit("decision.proposed", null, null, { durationMs: Math.max(0, this.clock.now() - startedAt), contextId: context.contextId });
      return proposal;
    } catch {
      this.emit("decision.failed", null, null, { durationMs: Math.max(0, this.clock.now() - startedAt), contextId: context.contextId });
      throw new Error("voice_realtime_decision_failed");
    }
  }

  /** Renders and queues only a control-plane-authorized directive on the bound Realtime session. */
  async renderAndQueueAuthorizedSpeech(directive: ControlPlaneSpokenDirective): Promise<ControlPlaneSpokenDirective> {
    const prepared = await this.prepareOutput(directive);
    const speechProvider = this.realtime;
    if (supportsStreamingSpeech(speechProvider)) {
      let iterator: AsyncIterator<TelephonyMediaFrame>;
      try { iterator = speechProvider.streamAuthorizedSpeech(this.requireSession(prepared.call), prepared.directive,
        prepared.signal)[Symbol.asyncIterator](); }
      catch { await this.failCall("realtime_speech_failed"); throw new Error("voice_realtime_speech_failed"); }
      let frameCount = 0;
      while (true) {
        let next: IteratorResult<TelephonyMediaFrame>;
        try { next = await this.runProviderOperation(() => iterator.next(), prepared.signal, prepared.output); }
        catch {
          if (isClearing(prepared.output) || this.call?.status === "terminating") throw new Error("voice_output_interrupted");
          await this.failCall("realtime_speech_failed"); throw new Error("voice_realtime_speech_failed");
        }
        if (next.done) break;
        frameCount += 1;
        await this.sendPreparedFrame(prepared, next.value, "realtime_speech");
      }
      if (frameCount === 0) { await this.failCall("realtime_speech_failed"); throw new Error("voice_realtime_speech_failed"); }
      return this.finishPreparedOutput(prepared);
    }
    if (!supportsAuthorizedSpeech(speechProvider)) {
      await this.failCall("realtime_speech_unavailable"); throw new Error("voice_realtime_speech_unavailable");
    }
    let audio: TelephonyMediaFrame;
    try { audio = await this.runProviderOperation(
      () => speechProvider.renderAuthorizedSpeech(this.requireSession(prepared.call), prepared.directive, prepared.signal),
      prepared.signal, prepared.output); }
    catch {
      if (isClearing(prepared.output) || this.call?.status === "terminating") throw new Error("voice_output_interrupted");
      await this.failCall("realtime_speech_failed"); throw new Error("voice_realtime_speech_failed");
    }
    await this.sendPreparedFrame(prepared, audio, "realtime_speech");
    return this.finishPreparedOutput(prepared);
  }

  nextLatencyTreatment(turnId: string): LatencyTreatment {
    this.requireActiveCall();
    this.requireTurn(turnId);
    return this.latencyWatchdog.evaluate(turnId, this.clock.now());
  }

  predictLatency(turnId: string, prediction: LatencyPrediction): void {
    this.requireActiveCall();
    this.requireTurn(turnId);
    this.latencyWatchdog.predict(turnId, prediction);
    this.emit("latency.predicted", turnId, null, { class: prediction.class, source: prediction.source,
      expectedP95Ms: prediction.expectedP95Ms, operationEvidenceId: prediction.operationEvidenceId });
  }

  async playProcessingCue(turnId: string, treatment: Extract<LatencyTreatment, { kind: "processing_cue" }>): Promise<void> {
    const call = this.requireActiveCall();
    this.requireTurn(turnId);
    if (this.activeOutputId !== null || this.activeProcessingCue !== null) return;
    const asset = processingCueAsset(treatment.assetId);
    const cue: ActiveProcessingCue = { turnId, treatmentId: treatment.treatmentId,
      processingEventId: treatment.processingEventId, abortController: new AbortController() };
    this.activeProcessingCue = cue;
    this.emit("generic_processing_started", turnId, null, { treatmentId: treatment.treatmentId,
      processingEventId: treatment.processingEventId, assetId: asset.id, durationMs: asset.durationMs, peakDbfs: asset.peakDbfs });
    const signal = AbortSignal.any([call.abortController.signal, cue.abortController.signal]);
    try {
      for (let offset = 0, chunk = 0; offset < asset.bytes.length; offset += 160, chunk += 1) {
        const bytes = asset.bytes.slice(offset, offset + 160);
        await this.runProviderOperation(() => this.telephony.sendAudio(call.callId, {
          callId: call.callId, streamId: `processing:${call.lifecycleId}`, providerMessageSequenceNumber: chunk + 1,
          mediaChunkNumber: chunk + 1, startedAtMs: chunk * 20, durationMs: 20, encoding: "audio/pcmu",
          sampleRateHz: 8_000, bytes,
        }, `processing:${treatment.treatmentId}`, signal), signal);
      }
    } catch (error) {
      if (signal.aborted) return;
      await this.failCall("telephony_output_failed");
      throw new Error("voice_processing_cue_failed");
    }
  }

  recordActiveOperation(turnId: string, operationEvidenceId: string): void {
    this.requireActiveCall();
    this.requireTurn(turnId);
    this.latencyWatchdog.operationStarted(turnId, operationEvidenceId);
  }

  /** Reopens a completed turn only when the control plane returned a post-playback continuation. */
  resumeAfterPlayback(turnId: string): void {
    this.requireActiveCall();
    const turn = this.requireTurn(turnId);
    if (turn.state !== "completed" || this.activeOutputId !== null) throw new Error("voice_turn_not_resumable");
    turn.state = "listening";
  }

  checkTiming(turnId: string): { firstAckOnTime: boolean; progressOnTime: boolean } {
    this.requireActiveCall();
    const turn = this.requireTurn(turnId);
    const now = this.clock.now();
    const firstAckOnTime = turn.firstAcknowledgedAtMs !== null
      && turn.firstAcknowledgedAtMs - turn.startedAtMs <= this.firstAckDeadlineMs;
    const progressOnTime = turn.progressedAtMs !== null
      && turn.progressedAtMs - turn.startedAtMs <= this.progressDeadlineMs;
    if (turn.firstAcknowledgedAtMs === null && now - turn.startedAtMs > this.firstAckDeadlineMs) {
      this.emitTimingBreach(turnId, turn, "first_ack", now - turn.startedAtMs);
    }
    if (turn.progressedAtMs === null && now - turn.startedAtMs > this.progressDeadlineMs) {
      this.emitTimingBreach(turnId, turn, "progress", now - turn.startedAtMs);
    }
    return { firstAckOnTime, progressOnTime };
  }

  async queueOutput(input: {
    readonly directive: ControlPlaneSpokenDirective;
    readonly audio: TelephonyMediaFrame;
  }): Promise<ControlPlaneSpokenDirective> {
    const call = this.requireActiveCall();
    let chunks: readonly NormalizedAudioChunk[];
    try {
      if (input.audio.callId !== call.callId) throw new Error("spoken_directive_audio_call_mismatch");
      chunks = normalizeTelephonyMedia(input.audio);
    } catch (error) {
      await this.failCall("spoken_directive_rejected");
      throw asError(error);
    }
    const prepared = await this.prepareOutput(input.directive);
    await this.sendPreparedChunks(prepared, chunks);
    return this.finishPreparedOutput(prepared);
  }

  private async prepareOutput(candidate: ControlPlaneSpokenDirective): Promise<PreparedOutput> {
    const call = this.requireActiveCall(candidate.callId);
    if (this.activeProcessingCue !== null) await this.clearProcessingCue("response_ready");
    if (this.activeOutputId !== null) {
      const active = this.outputs.get(this.activeOutputId);
      if (active?.directive.purpose !== "acknowledgement" || candidate.purpose === "acknowledgement"
        || active.directive.turnId !== candidate.turnId) throw new Error("voice_call_output_pending");
      await this.interruptOutput(active.directive.turnId, "replacement");
      this.emit("latency.acknowledgement_cancelled", active.directive.turnId, active.directive.id,
        { replacementDirectiveId: candidate.id });
    }
    const turn = this.requireTurn(candidate.turnId);
    if (turn.state !== "listening") throw new Error("voice_turn_not_outputtable");
    let directive: ControlPlaneSpokenDirective;
    try {
      directive = snapshotSpokenDirective(candidate, call, candidate.turnId);
      if (this.usedDirectiveIds.has(directive.id)) throw new Error("spoken_directive_duplicate_id");
      if (this.usedDirectiveIds.size >= this.maxDirectivesPerCall) throw new Error("voice_call_directive_limit_reached");
    } catch (error) {
      await this.failCall("spoken_directive_rejected"); throw asError(error);
    }
    const output: PendingOutput = {
      directive,
      markId: `heard:${directive.id}`,
      abortController: new AbortController(),
      inFlightOperations: new Set(),
      status: "registered",
    };
    this.outputs.set(directive.id, output);
    this.usedDirectiveIds.add(directive.id);
    this.activeOutputId = directive.id;
    turn.state = "responding";

    try {
      const authorized = await this.trackOperation(
        this.directiveAuthority.verifyAndConsume({ directive, call, nowMs: this.clock.now() }),
        output,
      );
      if (!authorized) {
        throw new Error("spoken_directive_authority_rejected");
      }
    } catch (error) {
      await this.failCall("spoken_directive_rejected");
      if (error instanceof Error && error.message === "spoken_directive_authority_rejected") throw error;
      throw new Error("spoken_directive_authority_failed");
    }
    if (isClearing(output) || call.status !== "active") throw new Error("voice_output_interrupted");

    this.emit("output.registered", directive.turnId, directive.id, {
      purpose: directive.purpose,
      callStateVersion: directive.callStateVersion,
    });
    const signal = AbortSignal.any([call.abortController.signal, output.abortController.signal]);
    return { call, directive, output, signal, audioStarted: false };
  }

  private async sendPreparedFrame(prepared: PreparedOutput, frame: TelephonyMediaFrame,
    source: "realtime_speech" | "provided_audio"): Promise<void> {
    let chunks: readonly NormalizedAudioChunk[];
    try {
      if (frame.callId !== prepared.call.callId) throw new Error("spoken_directive_audio_call_mismatch");
      chunks = normalizeTelephonyMedia(frame);
    } catch {
      await this.failCall(source === "realtime_speech" ? "realtime_speech_failed" : "spoken_directive_rejected");
      throw new Error(source === "realtime_speech" ? "voice_realtime_speech_failed" : "spoken_directive_audio_rejected");
    }
    await this.sendPreparedChunks(prepared, chunks);
  }

  private async sendPreparedChunks(prepared: PreparedOutput, chunks: readonly NormalizedAudioChunk[]): Promise<void> {
    if (!prepared.audioStarted && prepared.directive.purpose !== "acknowledgement") {
      this.latencyWatchdog.responseAudioStarted(prepared.directive.turnId, this.clock.now()); prepared.audioStarted = true;
    }
    try {
      for (const chunk of chunks) {
        await this.runProviderOperation(
          () => this.telephony.sendAudio(prepared.call.callId, chunk, prepared.directive.id, prepared.signal),
          prepared.signal, prepared.output,
        );
      }
    } catch (error) {
      if (isVoiceAuditFailure(error)) throw error;
      if (isClearing(prepared.output) || this.call?.status === "terminating") throw new Error("voice_output_interrupted");
      await this.failCall("telephony_output_failed");
      throw new Error("voice_telephony_output_failed");
    }
  }

  private async finishPreparedOutput(prepared: PreparedOutput): Promise<ControlPlaneSpokenDirective> {
    try {
      await this.runProviderOperation(() => this.telephony.sendMark(prepared.call.callId, prepared.output.markId,
        prepared.signal), prepared.signal, prepared.output);
      if (!isClearing(prepared.output)) {
        prepared.output.status = "playing";
        this.emit("output.mark_armed", prepared.directive.turnId, prepared.directive.id, { markId: prepared.output.markId });
      }
      return prepared.directive;
    } catch (error) {
      if (isVoiceAuditFailure(error)) throw error;
      if (isClearing(prepared.output) || this.call?.status === "terminating") throw new Error("voice_output_interrupted");
      await this.failCall("telephony_output_failed"); throw new Error("voice_telephony_output_failed");
    }
  }

  /** A mark establishes playback truth only after its provider event is authenticated and consumed once. */
  async receiveTelephonyMark(input: AuthenticatedTelephonyMark): Promise<"heard" | "discarded" | "ignored"> {
    const call = this.call;
    if (call === null || call.status !== "active" || call.callId !== input.callId) return "ignored";
    const initialCleared = this.clearedMarks.get(input.markId);
    const initialOutput = this.outputs.get(input.outputDirectiveId);
    const expectedOutputDirectiveId = initialCleared?.outputDirectiveId ?? initialOutput?.directive.id;
    const expectedMarkId = initialCleared === undefined ? initialOutput?.markId : input.markId;
    if (expectedOutputDirectiveId === undefined || expectedMarkId === undefined || expectedMarkId !== input.markId) return "ignored";

    let mark: AuthenticatedTelephonyMark;
    try {
      mark = snapshotTelephonyMark(input);
    } catch {
      return "ignored";
    }
    let authorized: boolean;
    try {
      authorized = await this.markAuthority.verifyAndConsume({
        mark,
        call,
        expectedProviderName: this.telephony.name,
        expectedOutputDirectiveId,
        expectedMarkId,
        nowMs: this.clock.now(),
      });
    } catch {
      await this.failCall("telephony_mark_authority_failed");
      throw new Error("voice_telephony_mark_authority_failed");
    }
    if (!authorized) return "ignored";
    this.requireActiveCall(mark.callId);

    const cleared = this.clearedMarks.get(mark.markId);
    if (cleared !== undefined && cleared.outputDirectiveId === mark.outputDirectiveId) {
      this.clearedMarks.delete(mark.markId);
      this.emit("output.cleared_mark_discarded", cleared.turnId, cleared.outputDirectiveId, {
        markId: mark.markId,
        providerEventId: mark.providerEventId,
      });
      return "discarded";
    }
    const output = this.outputs.get(mark.outputDirectiveId);
    if (output === undefined || output.markId !== mark.markId || output.status !== "playing") return "ignored";
    this.outputs.delete(output.directive.id);
    if (this.activeOutputId === output.directive.id) this.activeOutputId = null;
    const turn = this.requireTurn(output.directive.turnId);
    if (output.directive.purpose === "acknowledgement") {
      turn.state = "listening";
      this.recordFirstAcknowledgement(output.directive.turnId);
      this.latencyWatchdog.acknowledgementHeard(output.directive.turnId);
    } else {
      turn.state = output.directive.purpose === "response" ? "completed" : "listening";
      this.recordProgress(output.directive.turnId);
    }
    this.emit("output.heard", output.directive.turnId, output.directive.id, {
      markId: mark.markId,
      providerEventId: mark.providerEventId,
    });
    return "heard";
  }

  /** Trusted transport failure/cancellation; never creates a successful terminal outcome or playback receipt. */
  async failTransportCall(reason: string): Promise<void> { await this.failCall(reason); }

  async endCall(input: TrustedTerminalOutcomeReceipt): Promise<void> {
    const call = this.requireActiveCall();
    let receipt: TrustedTerminalOutcomeReceipt;
    try {
      receipt = snapshotTerminalReceipt(input);
    } catch {
      throw new Error("voice_terminal_outcome_authority_rejected");
    }
    let authorized: boolean;
    try {
      authorized = await this.terminalOutcomeAuthority.verifyAndConsume({ receipt, call, nowMs: this.clock.now() });
    } catch {
      throw new Error("voice_terminal_outcome_authority_failed");
    }
    if (!authorized) throw new Error("voice_terminal_outcome_authority_rejected");
    this.requireActiveCall(receipt.callId);
    const cleanupFailures = await this.terminate("ended", receipt.outcome);
    if (cleanupFailures > 0) throw new Error("voice_provider_cleanup_failed");
  }

  private async interruptForBargeIn(turnId: string): Promise<void> {
    return this.interruptOutput(turnId, "barge_in");
  }

  private async clearProcessingCue(reason: "caller_speech" | "response_ready" | "call_end"): Promise<void> {
    const cue = this.activeProcessingCue;
    if (cue === null) return;
    this.activeProcessingCue = null;
    cue.abortController.abort();
    const call = this.call;
    if (call !== null && call.status === "active") {
      try { await this.telephony.clearAudio(call.callId, call.abortController.signal); }
      catch { await this.failCall("telephony_clear_failed"); throw new Error("voice_telephony_clear_failed"); }
    }
    this.emit("processing.cleared", cue.turnId, null, { treatmentId: cue.treatmentId,
      processingEventId: cue.processingEventId, reason });
  }

  private async interruptOutput(turnId: string, reason: "barge_in" | "replacement"): Promise<void> {
    const call = this.requireActiveCall();
    const outputDirectiveId = this.activeOutputId;
    if (outputDirectiveId === null) return;
    const output = this.outputs.get(outputDirectiveId);
    if (output === undefined) return;
    if (output.directive.turnId !== turnId) return;

    output.status = "clearing";
    output.abortController.abort();
    this.activeOutputId = null;
    if (this.clearedMarks.size === this.maxAuditEvents) {
      const oldestMarkId = this.clearedMarks.keys().next().value as string | undefined;
      if (oldestMarkId !== undefined) this.clearedMarks.delete(oldestMarkId);
    }
    this.clearedMarks.set(output.markId, {
      turnId: output.directive.turnId,
      outputDirectiveId: output.directive.id,
    });
    this.outputs.delete(output.directive.id);
    this.requireTurn(output.directive.turnId).state = reason === "barge_in" ? "interrupted" : "listening";
    this.emit("output.interrupted", output.directive.turnId, output.directive.id, {
      markId: output.markId,
      committed: false,
      reason,
    });

    try {
      await this.waitForFence(output.inFlightOperations);
      await this.runProviderOperation(
        () => this.telephony.clearAudio(call.callId, call.abortController.signal),
        call.abortController.signal,
      );
      await this.runProviderOperation(
        () => this.realtime.cancelOutput(this.requireSession(call), output.directive.id, call.abortController.signal),
        call.abortController.signal,
      );
    } catch (error) {
      await this.failCall("barge_in_cleanup_failed");
      throw new Error("voice_barge_in_cleanup_failed");
    }
  }

  private recordFirstAcknowledgement(turnId: string): void {
    const turn = this.requireTurn(turnId);
    if (turn.firstAcknowledgedAtMs !== null) return;
    turn.firstAcknowledgedAtMs = this.clock.now();
    const elapsedMs = turn.firstAcknowledgedAtMs - turn.startedAtMs;
    this.emit("turn.first_acknowledged", turnId, null, { elapsedMs, source: "telephony_mark_heard" });
    if (elapsedMs > this.firstAckDeadlineMs) this.emitTimingBreach(turnId, turn, "first_ack", elapsedMs);
  }

  private recordProgress(turnId: string): void {
    const turn = this.requireTurn(turnId);
    if (turn.progressedAtMs !== null) return;
    turn.progressedAtMs = this.clock.now();
    const elapsedMs = turn.progressedAtMs - turn.startedAtMs;
    this.emit("turn.progressed", turnId, null, { elapsedMs, source: "telephony_mark_heard" });
    if (elapsedMs > this.progressDeadlineMs) this.emitTimingBreach(turnId, turn, "progress", elapsedMs);
  }

  private emitTimingBreach(turnId: string, turn: Turn, checkpoint: TimingCheckpoint, elapsedMs: number): void {
    if (turn.timingBreaches.has(checkpoint)) return;
    turn.timingBreaches.add(checkpoint);
    this.emit("turn.timing_breached", turnId, null, { checkpoint, elapsedMs });
  }

  private async failCall(reason: string): Promise<void> {
    await this.terminate("failed", reason);
  }

  private async terminate(outcome: "ended" | "failed", reason: string): Promise<number> {
    if (this.termination !== null) return this.termination;
    const call = this.call;
    if (call === null) return 0;
    this.termination = (async () => {
      call.status = "terminating";
      let auditFailure: VoiceAuditFailure | null = null;
      if (outcome === "failed") {
        try {
          this.emit("call.failed", null, null, { reason });
        } catch (error) {
          if (!isVoiceAuditFailure(error)) throw error;
          auditFailure = error;
        }
      }
      this.abortCall(call);
      await this.waitForFence(this.inFlightOperations);
      const cleanupFailures = await this.closeProviders(call);
      if (outcome === "ended") {
        try {
          if (cleanupFailures === 0) this.emit("call.ended", null, null, { terminalOutcome: reason });
          else this.emit("call.failed", null, null, { reason: "provider_cleanup_failed", terminalOutcome: reason });
        } catch (error) {
          if (!isVoiceAuditFailure(error)) throw error;
          auditFailure = error;
        }
      }
      this.resetCall(call);
      if (auditFailure !== null) throw auditFailure;
      return cleanupFailures;
    })();
    try {
      return await this.termination;
    } finally {
      this.termination = null;
    }
  }

  private emit(
    type: VoiceRuntimeEventType,
    turnId: string | null,
    outputDirectiveId: string | null,
    details: VoiceRuntimeEvent["details"],
  ): void {
    const call = this.call;
    if (call === null) return;
    if (this.events.length >= this.maxAuditEvents) {
      this.beginAuditFailureTermination(call);
      throw new VoiceAuditFailure("voice_audit_capacity_exhausted");
    }
    const event: VoiceRuntimeEvent = Object.freeze({
      schemaVersion: 1,
      type,
      practiceId: call.practiceId,
      callId: call.callId,
      lifecycleId: call.lifecycleId,
      traceId: call.traceId,
      caseId: call.caseId,
      goalId: call.activeGoalId,
      callStateVersion: call.stateVersion,
      turnId,
      outputDirectiveId,
      atMs: this.clock.now(),
      redaction: Object.freeze({
        policy: "phi_safe_metadata_only",
        transcriptExcluded: true,
        mediaExcluded: true,
        providerPayloadExcluded: true,
      }),
      providers: Object.freeze({
        telephony: Object.freeze({ name: this.telephony.name }),
        realtime: Object.freeze({ name: this.realtime.name }),
      }),
      details: Object.freeze({ ...details }),
    });
    this.events.push(event);
    try {
      this.onEvent(event);
    } catch {
      this.sinkFailures += 1;
      this.beginAuditFailureTermination(call);
      throw new VoiceAuditFailure("voice_audit_sink_failed");
    }
  }

  private beginAuditFailureTermination(call: ActiveCall): void {
    const alreadyTerminating = call.status === "terminating";
    this.abortCall(call);
    if (alreadyTerminating || this.termination !== null) return;
    const emergency = (async (): Promise<number> => {
      await this.waitForFence(this.inFlightOperations);
      const cleanupFailures = await this.closeProviders(call);
      this.resetCall(call);
      return cleanupFailures;
    })();
    this.termination = emergency;
    void emergency.finally(() => {
      if (this.termination === emergency) this.termination = null;
    });
  }

  private abortCall(call: ActiveCall): void {
    call.status = "terminating";
    call.abortController.abort();
    for (const output of this.outputs.values()) output.abortController.abort();
    this.activeProcessingCue?.abortController.abort();
    this.activeProcessingCue = null;
    this.pendingChunks = 0;
    this.activeOutputId = null;
    this.outputs.clear();
  }

  private async closeProviders(call: ActiveCall): Promise<number> {
    const cleanup = await Promise.allSettled([
      this.telephony.closeCall(call.callId),
      ...(call.sessionId === null ? [] : [this.realtime.closeSession(call.sessionId)]),
    ]);
    return cleanup.filter((result) => result.status === "rejected").length;
  }

  private resetCall(call: ActiveCall): void {
    if (this.call !== call) return;
    for (const turnId of this.turns.keys()) this.latencyWatchdog.endTurn(turnId);
    this.turns.clear();
    this.usedDirectiveIds.clear();
    this.clearedMarks.clear();
    this.activeProcessingCue = null;
    this.mediaContinuity.reset();
    this.appendTail = Promise.resolve();
    this.call = null;
  }

  private runProviderOperation<T>(
    factory: () => Promise<T>,
    signal: AbortSignal,
    output?: PendingOutput,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(new Error("voice_provider_operation_aborted"));
    const rawOperation = this.trackOperation(factory(), output);
    return abortable(rawOperation, signal);
  }

  private trackOperation<T>(operation: Promise<T>, output?: PendingOutput): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => {
      this.inFlightOperations.delete(tracked);
      output?.inFlightOperations.delete(tracked);
    });
    this.inFlightOperations.add(tracked);
    output?.inFlightOperations.add(tracked);
    return tracked;
  }

  private async waitForFence(operations: Set<Promise<unknown>>): Promise<void> {
    while (operations.size > 0) {
      await Promise.allSettled([...operations]);
    }
  }

  private requireActiveCall(expectedCallId?: string): ActiveCall {
    const call = this.call;
    if (call === null || call.status !== "active") throw new Error("voice_call_not_active");
    if (expectedCallId !== undefined && call.callId !== expectedCallId) throw new Error("voice_call_mismatch");
    return call;
  }

  private requireSession(call: ActiveCall): string {
    if (call.sessionId === null) throw new Error("voice_session_not_open");
    return call.sessionId;
  }

  private requireTurn(turnId: string): Turn {
    const turn = this.turns.get(turnId);
    if (turn === undefined) throw new Error("voice_turn_not_found");
    return turn;
  }
}
