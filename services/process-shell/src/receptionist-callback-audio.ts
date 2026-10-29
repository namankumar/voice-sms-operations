import { CALLBACK_VAD, CALLBACK_INPUT_CLOCK } from "./receptionist-voice-config.js";
import { RECEPTIONIST_TRANSCRIPTION_MODEL } from "./receptionist-openai.js";
import { createHash, randomUUID } from "node:crypto";
import { LowLatencyVoiceHarness, type AuthenticatedTelephonyMark, type ControlPlaneSpokenDirective, type OpenAIRealtimeEvent,
  type RealtimeVoiceProvider, type StreamingSpeechProvider, type TelephonyProvider, type TrustedTerminalOutcomeReceipt,
  type TwilioMediaStreamsProvider, type VoiceCallBinding } from "@salven/voice-runtime";
import type { Conversation, ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import type { VoiceAppInstance } from "./receptionist-policy.js";
import { ReceptionistCallbackController, type CallbackSpeechPort, type CallbackSpeechPresentation, type RelayTextInterpreter } from "./receptionist-callback-controller.js";

type InputBarrier = { receivedSamples: number; appended: Promise<void> };
type Output = { presentation: CallbackSpeechPresentation; generation: number; abort: AbortController; directive: ControlPlaneSpokenDirective;
  state: "queued" | "rendering" | "playing" | "played" | "invalid"; bytes: number; markId: string | null;
  receivedMarkBarrier: InputBarrier | null; markVerified: Promise<boolean> | null; resolveMark: ((played: boolean) => void) | null; markTimer: ReturnType<typeof setTimeout> | null; verificationStarted: boolean;
  earlyMark: { sequence: number; streamId: string; barrier: InputBarrier } | null; playedInputBarrierSamples: number | null; waiters: Set<(played: boolean) => void> };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Contiguous exact text chunks. The complete utterance owns one final carrier mark. */
export function callbackSpeechChunks(text: string): readonly string[] {
  if (!text.trim() || text.length > 10_000) throw new Error("callback_speech_text_invalid");
  const result: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + 4_000, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf(" ", end);
      if (boundary > offset + 2_000) end = boundary + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    }
    result.push(text.slice(offset, end)); offset = end;
  }
  if (result.join("") !== text) throw new Error("callback_speech_text_changed");
  return result;
}

/** One authenticated, callback-only stream. No Realtime-generated output or partial ASR is forwarded. */
export class ReceptionistCallbackAudioSession implements CallbackSpeechPort {
  private readonly controller: ReceptionistCallbackController;
  private readonly harness: LowLatencyVoiceHarness;
  private readonly binding: VoiceCallBinding;
  private readonly records = new Map<string, Output>();
  private readonly marks = new Map<string, Output>();
  private readonly issuedMarks = new Map<string, AuthenticatedTelephonyMark>();
  private readonly transcriptIds = new Set<string>();
  private readonly directives = new Set<string>();
  private currentOutput: Output | null = null;
  private generation = 0;
  private tail = Promise.resolve();
  private closed = false;
  private failed = false;
  private terminalIssued = false;
  private lastSequence = 1;
  private effectivePrefixMs: number | null = null;
  private configResolve: ((ready: boolean) => void) | null = null;
  private readonly configured = new Promise<boolean>(resolve => { this.configResolve = resolve; });
  private appendedSamples = 0;
  private receivedSamples = 0;
  private readonly onsets = new Map<string, { raw: number | null; order: number }>();
  private inputOrder = 0;
  private latestInputOrder = 0;
  private latestInputItemId: string | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoverySequence = 0;
  private activeInput: { inputId: string | null; sourceId: string } | null = null;
  private readonly terminalNonce = randomUUID();
  private readonly controllerNonce = randomUUID().replace(/-/g, "");
  private shutdownTask: Promise<void> | null = null;
  private readonly setupAborted = () => this.close();

  constructor(private readonly options: {
    scope: ConversationScope; parentCallId: string; streamId: string; recoveryId: string; attachmentId: string; profileSha256: string;
    telephony: TwilioMediaStreamsProvider; store: Pick<ConversationStore, "get" | "execute" | "getEvent">;
    instance: VoiceAppInstance; model: string; interpreter: RelayTextInterpreter; speech: StreamingSpeechProvider;
    realtimeFactory(onEvent: (event: OpenAIRealtimeEvent) => void): RealtimeVoiceProvider;
    /** Resolves the actual call-bound candidate/profile; null means no authority. */
    currentProfile(state: Conversation): string | null;
    onFailure?(reason: string): void;
    onInputClockDiagnostic?(value: Readonly<Record<string, unknown>>): void;
    now?: () => Date; signal?: AbortSignal;
  }) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.profileSha256)) throw new Error("callback_profile_invalid");
    this.binding = { practiceId: options.scope.practiceId, callId: options.parentCallId,
      lifecycleId: `callback-${digest([options.recoveryId, options.streamId]).slice(0, 40)}`, traceId: this.controllerNonce,
      caseId: options.scope.conversationId, stateVersion: 0, activeGoalId: `callback-${options.scope.conversationId}` };
    const realtime = options.realtimeFactory(event => { queueMicrotask(() => { void this.realtimeEvent(event).catch(() => this.fail("callback_input_failed")); }); });
    // STT has no generated response to cancel. Speech owns its own abortable HTTP stream.
    const rendering: RealtimeVoiceProvider & StreamingSpeechProvider = {
      name: realtime.name, connectionContract: realtime.connectionContract,
      openSession: (input, signal) => realtime.openSession(input, signal), appendAudio: async (session, audio, signal) => {
        // OpenAI audio offsets refer to successfully appended PCMU samples,
        // independently of Twilio presentation timestamp metadata.
        await realtime.appendAudio(session, audio, signal);
        this.appendedSamples += audio.bytes.length;
      },
      cancelOutput: async () => undefined, closeSession: session => realtime.closeSession(session),
      streamAuthorizedSpeech: async function* (session, directive, signal) {
        const record = owner.records.get(directive.id);
        if (!record) throw new Error("callback_directive_missing");
        const combined = AbortSignal.any([signal, record.abort.signal]);
        const chunks = callbackSpeechChunks(directive.text);
        for (let index = 0; index < chunks.length; index += 1) {
          for await (const frame of options.speech.streamAuthorizedSpeech(session, { ...directive, id: `${directive.id}-part-${index}`, text: chunks[index]! }, combined)) {
            if (combined.aborted || record.generation !== owner.generation) throw new Error("callback_speech_interrupted");
            yield frame;
          }
        }
      },
    };
    const owner = this;
    const telephony: TelephonyProvider = {
      name: options.telephony.name, connectionContract: options.telephony.connectionContract,
      sendAudio: async (call, audio, directiveId, signal) => {
        const record = this.records.get(directiveId);
        if (!record || !await this.current(record, false)) throw new Error("callback_audio_stale");
        if (record.bytes + audio.bytes.length > 1_600_000) throw new Error("callback_audio_limit");
        await options.telephony.sendAudio(call, audio, directiveId, signal);
        record.bytes += audio.bytes.length;
      },
      clearAudio: (call, signal) => options.telephony.clearAudio(call, signal),
      sendMark: async (call, markId, signal) => {
        const record = this.currentOutput;
        if (!record || record.bytes === 0 || !await this.current(record, false)) throw new Error("callback_mark_stale");
        // Register before send: a provider echo may arrive in the same microtask.
        record.markId = markId; this.marks.set(markId, record);
        await options.telephony.sendMark(call, markId, signal);
      },
      closeCall: call => options.telephony.closeCall(call),
    };
    this.harness = new LowLatencyVoiceHarness(telephony, rendering, {
      name: "callback-current-utterance",
      verifyAndConsume: async ({ directive }) => {
        const record = this.records.get(directive.id);
        if (!record || this.directives.has(directive.id) || digest(directive) !== digest(record.directive) || !await this.current(record, false)) return false;
        this.directives.add(directive.id); return true;
      },
    }, {
      name: "callback-authenticated-media-mark",
      verifyAndConsume: async ({ mark, expectedMarkId, expectedOutputDirectiveId }) => {
        const issued = this.issuedMarks.get(mark.authorityReceiptId);
        if (!issued || digest(issued) !== digest(mark) || mark.markId !== expectedMarkId || mark.outputDirectiveId !== expectedOutputDirectiveId) return false;
        this.issuedMarks.delete(mark.authorityReceiptId);
        const record = this.records.get(mark.outputDirectiveId);
        // A flushed late mark is still authenticated so the harness can discard it.
        return record !== undefined && mark.callId === options.parentCallId && mark.callLifecycleId === this.binding.lifecycleId;
      },
    }, {
      name: "callback-code-terminal",
      verifyAndConsume: async ({ receipt }) => {
        if (this.terminalIssued || receipt.authorityNonce !== this.terminalNonce || receipt.callId !== options.parentCallId) return false;
        this.terminalIssued = true; return true;
      },
    }, { clock: { now: () => this.now().getTime() }, inputClock: CALLBACK_INPUT_CLOCK,
      onEvent: event => { if (event.type === "media.presentation_timing_deviation") this.options.onInputClockDiagnostic?.(event.details); } });
    this.controller = new ReceptionistCallbackController({ speech: this, scope: options.scope, parentCallId: options.parentCallId,
      recoveryId: options.recoveryId, store: options.store, instance: options.instance, model: options.model, interpreter: options.interpreter,
      voiceProfileHash: options.profileSha256, sessionNonce: this.controllerNonce, ...(options.now === undefined ? {} : { now: options.now }) });
  }

  async start(): Promise<void> {
    if (this.options.signal?.aborted) { this.close(); throw new Error("callback_audio_aborted"); }
    this.options.signal?.addEventListener("abort", this.setupAborted, { once: true });
    const state = await this.options.store.get(this.options.scope);
    if (this.closed) throw new Error("callback_audio_aborted");
    if (!state || !this.authorized(state)) throw new Error("callback_audio_admission_rejected");
    await this.harness.openCall(this.binding);
    if (!this.closed) await this.harness.observeTelephonyControlSequence({ callId: this.options.parentCallId, streamId: this.options.streamId, providerSequenceNumber: 1 });
    if (this.closed) return;
    const ready = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 5_000); timer.unref();
      void this.configured.then(value => { clearTimeout(timer); resolve(value); });
    });
    if (!ready || this.closed) { this.fail("callback_input_configuration_unavailable"); throw new Error("callback_input_configuration_unavailable"); }
    await this.controller.startAttached(this.options.streamId);
  }

  async receive(raw: string): Promise<void> {
    if (this.closed) return;
    const event = this.options.telephony.parseInbound(raw);
    if (event.kind === "connected") return;
    if (event.kind === "media") {
      if (event.frame.callId !== this.options.parentCallId || event.frame.streamId !== this.options.streamId) return this.fail("callback_stream_binding_changed");
      this.receivedSamples += Buffer.from(event.frame.payloadBase64, "base64").length;
      await this.harness.ingestTelephonyMedia(event.frame); return;
    }
    if (event.callId !== this.options.parentCallId || event.streamId !== this.options.streamId) return this.fail("callback_stream_binding_changed");
    // Freeze the received-sample boundary and its pending append tail before
    // any asynchronous authentication/store work. Later Yes media cannot move it.
    const markBarrier: InputBarrier = { receivedSamples: this.receivedSamples, appended: this.harness.captureInputAppendBarrier() };
    if (event.kind === "mark" && event.providerSequenceNumber > this.lastSequence) {
      const pending = this.marks.get(event.markId);
      if (pending && pending === this.currentOutput && pending.generation === this.generation && pending.state !== "invalid" && pending.receivedMarkBarrier === null) {
        pending.receivedMarkBarrier = markBarrier;
        pending.markVerified = new Promise<boolean>(resolve => { pending.resolveMark = resolve; });
        pending.markTimer = setTimeout(() => { if (pending.resolveMark !== null && !this.closed) this.fail("callback_mark_verification_timeout"); }, 5000);
        pending.markTimer.unref();
      }
    }
    if (event.kind === "mark" || event.kind === "dtmf") {
      if (event.providerSequenceNumber <= this.lastSequence) return;
      this.lastSequence = event.providerSequenceNumber;
      await this.harness.observeTelephonyControlSequence({ callId: event.callId, streamId: event.streamId, providerSequenceNumber: event.providerSequenceNumber });
    }
    if (event.kind === "stop") { this.close(); return; }
    if (event.kind === "mark") {
      const record = this.marks.get(event.markId);
      if (!record) return;
      // No receipt is consumed before the harness has armed its mark.
      if (this.harness.armedMarkFor(record.directive.id) === null && record.state !== "invalid") {
        if (record.earlyMark === null) record.earlyMark = { sequence: event.providerSequenceNumber, streamId: event.streamId, barrier: markBarrier };
        return;
      }
      try { await this.acceptMark(record, event.providerSequenceNumber, event.streamId, markBarrier); } catch { this.fail("callback_mark_verification_failed"); }
    }
  }

  private async realtimeEvent(event: OpenAIRealtimeEvent): Promise<void> {
    if (this.closed) return;
    if (event.kind === "input_configured") {
      if (event.transcriptionModel !== RECEPTIONIST_TRANSCRIPTION_MODEL || event.language !== "en" || event.prefixPaddingMs !== CALLBACK_VAD.prefixPaddingMs
        || event.silenceDurationMs !== CALLBACK_VAD.silenceDurationMs || event.threshold !== CALLBACK_VAD.threshold
        || event.createResponse !== false || event.interruptResponse !== false) {
        this.configResolve?.(false); this.fail("callback_effective_input_mismatch"); return;
      }
      this.effectivePrefixMs = event.prefixPaddingMs; this.configResolve?.(true); return;
    }
    if (event.kind === "vad" && event.signal.state === "speech_started") {
      if (event.inputItemId) {
        const prior = this.onsets.get(event.inputItemId), raw = event.rawAudioStartMs ?? null;
        if (prior && prior.order < this.latestInputOrder) return;
        if (prior && prior.raw !== raw) { prior.raw = null; this.controller.interrupt(); this.scheduleUntranscribedRecovery(event.inputItemId); return; }
        const onset = prior ?? { raw, order: ++this.inputOrder };
        this.onsets.set(event.inputItemId, onset); this.latestInputItemId = event.inputItemId; this.latestInputOrder = onset.order;
      } else { this.latestInputItemId = null; this.latestInputOrder = ++this.inputOrder; }
      this.scheduleUntranscribedRecovery(event.inputItemId ?? null);
      const output = this.currentOutput;
      // A known carrier mark may have arrived while its append/auth lookup is
      // pending. Hold post-barrier input for verification rather than cancelling
      // the already played utterance; no receipt or action is granted here.
      if (event.inputItemId && output?.receivedMarkBarrier && output.state !== "played" && this.rawDetectorSamples(event.rawAudioStartMs ?? null) !== null
        && this.rawDetectorSamples(event.rawAudioStartMs ?? null)! > output.receivedMarkBarrier.receivedSamples) {
        const generation = this.generation;
        try { await output.receivedMarkBarrier.appended; } catch { this.fail("callback_input_append_failed"); return; }
        if (this.closed || generation !== this.generation) return;
        const detector = this.detectorBoundarySamples(event.rawAudioStartMs ?? null);
        if (detector !== null && detector > output.receivedMarkBarrier.receivedSamples) return;
      }
      const detector = this.detectorBoundarySamples(event.rawAudioStartMs ?? null);
      const delayedOverlap = output?.state === "played" && ["recap", "invitation"].includes(output.presentation.kind)
        && detector !== null && output.playedInputBarrierSamples !== null && detector <= output.playedInputBarrierSamples;
      if (delayedOverlap) { this.controller.interrupt(); return; }
      if (this.currentOutput !== null && this.currentOutput.state !== "played" && this.currentOutput.state !== "invalid" || this.controller.isWorking()) {
        this.controller.interrupt();
      }
      return;
    }
    if (event.kind === "error") return this.controller.providerFailed("callback_transcription_failed");
    if (event.kind !== "transcript" || !event.transcript.isFinal) return;
    const lastColon = event.transcript.segmentId.lastIndexOf(":");
    const inputId = lastColon < 0 ? event.transcript.segmentId : event.transcript.segmentId.slice(0, lastColon);
    const priorOnset = this.onsets.get(inputId);
    if (priorOnset && priorOnset.order < this.latestInputOrder) return;
    if (this.latestInputItemId !== null && this.latestInputItemId !== inputId) return;
    this.clearUntranscribedRecovery();
    if (!event.transcript.text.trim()) { await this.controller.recoverUntranscribedInput(); return; }
    if (this.transcriptIds.has(event.transcript.segmentId)) return;
    if (this.transcriptIds.size >= 256) return this.fail("callback_turn_limit");
    this.transcriptIds.add(event.transcript.segmentId);
    if (!this.onsets.has(inputId)) { this.latestInputItemId = inputId; this.latestInputOrder = ++this.inputOrder; this.onsets.set(inputId, { raw: null, order: this.latestInputOrder }); }
    const output = this.currentOutput;
    if (output && ["queued", "rendering", "playing"].includes(output.state)) {
      const raw = this.onsets.get(inputId)?.raw ?? null;
      if (output.receivedMarkBarrier && output.markVerified && this.rawDetectorSamples(raw) !== null
        && this.rawDetectorSamples(raw)! > output.receivedMarkBarrier.receivedSamples) {
        const verified = await output.markVerified;
        if (this.closed || this.latestInputItemId !== inputId) return;
        if (output.generation !== this.generation) return;
        if (!verified || this.detectorBoundarySamples(raw) === null) { this.controller.interrupt(); return; }
      } else this.controller.interrupt();
    }
    await this.controller.submitFinal(event.transcript.text, inputId);
  }

  private clearUntranscribedRecovery(): void {
    if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }
  private scheduleUntranscribedRecovery(inputId: string | null): void {
    this.clearUntranscribedRecovery();
    const sequence = ++this.recoverySequence;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (!this.closed && this.recoverySequence === sequence && (inputId === null || this.latestInputItemId === inputId))
        void this.controller.recoverUntranscribedInput().catch(() => this.fail("callback_recovery_failed"));
    }, 12_000);
    this.recoveryTimer.unref();
  }

  issue(presentation: CallbackSpeechPresentation): boolean {
    if (this.closed || presentation.binding.profileSha256 !== this.options.profileSha256 || this.records.size >= 256) return false;
    this.invalidate();
    const immutable = structuredClone(presentation);
    const directive: ControlPlaneSpokenDirective = { id: presentation.id, kind: "speak", purpose: "response", callId: this.binding.callId,
      callLifecycleId: this.binding.lifecycleId, turnId: presentation.id, callStateVersion: this.binding.stateVersion, goalId: this.binding.activeGoalId, text: presentation.text,
      provenance: { authority: "control_plane", issuerId: "callback-current-state", authorityReceiptId: randomUUID(), authorityNonce: randomUUID(),
        authorityExpiresAtMs: this.now().getTime() + 60_000, traceId: this.binding.traceId, issuedAtMs: this.now().getTime(),
        sourceEventIds: presentation.binding.sourceId === null ? [] : [presentation.binding.sourceId] } };
    const record: Output = { presentation: immutable, generation: this.generation, abort: new AbortController(), directive,
      state: "queued", bytes: 0, markId: null, receivedMarkBarrier: null, markVerified: null, resolveMark: null, markTimer: null, verificationStarted: false, earlyMark: null, playedInputBarrierSamples: null, waiters: new Set() };
    this.records.set(presentation.id, record); this.currentOutput = record;
    const work = this.tail.then(async () => {
      if (!await this.current(record, false)) return;
      record.state = "rendering";
      this.harness.startTurn(record.directive.turnId);
      await this.harness.renderAndQueueAuthorizedSpeech(record.directive);
      if (!await this.current(record, false)) return;
      record.state = "playing";
      if (record.earlyMark) await this.acceptMark(record, record.earlyMark.sequence, record.earlyMark.streamId, record.earlyMark.barrier);
    });
    this.tail = work.catch(() => { if (!this.closed && record.generation === this.generation) this.controller.providerFailed("callback_speech_failed"); });
    return true;
  }

  invalidate(): void {
    this.generation += 1;
    const active = this.currentOutput;
    const needsClear = active !== null && (active.state === "rendering" || active.state === "playing");
    for (const record of this.records.values()) {
      record.state = "invalid"; record.abort.abort(); this.settle(record, false);
    }
    if (needsClear && this.harness.stateSnapshot.active) {
      const clearing = this.harness.receiveVad({ source: "server", state: "speech_started", atMs: this.now().getTime(), confidence: null }, active!.directive.turnId);
      this.tail = Promise.allSettled([this.tail, clearing]).then(() => undefined);
    }
    this.currentOutput = null;
  }

  beginInput(input: { inputId: string | null; sourceId: string }): void { this.activeInput = { ...input }; }
  async completed(presentation: CallbackSpeechPresentation): Promise<boolean> {
    const record = this.records.get(presentation.id);
    if (record === undefined || record.state !== "played" || digest(record.presentation) !== digest(presentation) || !await this.current(record, true)) return false;
    if (!["recap", "invitation"].includes(presentation.kind)) return true;
    const input = this.activeInput, onset = input?.inputId ? this.onsets.get(input.inputId) : undefined;
    const detector = this.detectorBoundarySamples(onset?.raw ?? null);
    if (!input || detector === null || record.playedInputBarrierSamples === null || detector <= record.playedInputBarrierSamples) return false;
    const state = await this.options.store.get(this.options.scope);
    return state?.inputs.at(-1)?.id === input.sourceId && await this.current(record, true);
  }
  /** Named detector boundary, not a physical first-syllable/hearing timestamp. Initial clamping is uncertain. */
  private rawDetectorSamples(raw: number | null): number | null {
    if (raw === null || !Number.isFinite(raw) || raw <= 0 || this.effectivePrefixMs === null) return null;
    const samples = (raw + this.effectivePrefixMs) * 8;
    return Number.isSafeInteger(samples) ? samples : null;
  }
  private detectorBoundarySamples(raw: number | null): number | null {
    const detectorSamples = this.rawDetectorSamples(raw);
    return detectorSamples !== null && detectorSamples <= this.appendedSamples ? detectorSamples : null;
  }
  async waitCompleted(presentation: CallbackSpeechPresentation, signal: AbortSignal): Promise<boolean> {
    if (await this.completed(presentation)) return true;
    const record = this.records.get(presentation.id);
    if (!record || signal.aborted || record.state === "invalid") return false;
    return await new Promise<boolean>(resolve => {
      const finish = (played: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); record.waiters.delete(finish); resolve(played); };
      const abort = () => finish(false);
      const timer = setTimeout(() => { finish(false); if (!this.closed) this.fail("callback_playback_unavailable"); }, 30_000);
      timer.unref(); signal.addEventListener("abort", abort, { once: true }); record.waiters.add(finish);
      void this.completed(presentation).then(played => { if (played) finish(true); });
    });
  }

  private async acceptMark(record: Output, sequence: number, streamId: string, barrier: InputBarrier): Promise<void> {
    if (record.verificationStarted) return;
    record.verificationStarted = true;
    barrier = record.receivedMarkBarrier ?? barrier;
    try { await barrier.appended; } catch { this.fail("callback_input_append_failed"); return; }
    if (this.appendedSamples < barrier.receivedSamples || record.state !== "invalid" && !await this.current(record, false)) { this.settle(record, false); return; }
    const mark: AuthenticatedTelephonyMark = { authority: "telephony_adapter", issuerId: "callback-authenticated-stream",
      authorityReceiptId: randomUUID(), authorityNonce: randomUUID(), authorityExpiresAtMs: this.now().getTime() + 30_000,
      providerEventId: `${streamId}:${sequence}`, providerName: this.options.telephony.name, receivedAtMs: this.now().getTime(),
      callId: this.options.parentCallId, callLifecycleId: this.binding.lifecycleId, outputDirectiveId: record.directive.id, markId: record.markId! };
    this.issuedMarks.set(mark.authorityReceiptId, mark);
    const result = await this.harness.receiveTelephonyMark(mark);
    if (result === "heard" || result === "discarded") this.marks.delete(record.markId!);
    if (result !== "heard" || !await this.current(record, false)) { this.settle(record, false); return; }
    record.playedInputBarrierSamples = barrier.receivedSamples; record.state = "played"; this.settle(record, true);
  }
  private settle(record: Output, played: boolean): void { if (record.markTimer !== null) clearTimeout(record.markTimer); record.markTimer = null; record.resolveMark?.(played); record.resolveMark = null; for (const waiter of record.waiters) waiter(played); record.waiters.clear(); }
  private authorized(state: Conversation): boolean {
    const recovery = state.recoveries.find(item => item.id === this.options.recoveryId);
    return state.admission.mode === "receptionist" && state.admission.channel === "voice" && state.admission.externalId === this.options.parentCallId
      && state.phase === "active" && state.owner === "ai" && !state.suppressed && recovery?.failureDomain === "callback_intake"
      && recovery.target === "relay" && recovery.state === "attached" && recovery.attachmentId === this.options.attachmentId && recovery.fromEpoch + 1 === state.voiceEpoch
      && this.options.currentProfile(state) === this.options.profileSha256;
  }
  private async current(record: Output, allowAnswer: boolean): Promise<boolean> {
    if (this.closed || record.state === "invalid" || record.generation !== this.generation || this.currentOutput !== record) return false;
    const generation = this.generation, state = await this.options.store.get(this.options.scope);
    if (!state || this.closed || generation !== this.generation || !this.authorized(state)) return false;
    const b = record.presentation.binding, request = state.requests.find(item => item.id === b.requestId);
    return b.parentCallId === this.options.parentCallId && b.sessionId === this.options.streamId && b.profileSha256 === this.options.profileSha256
      && b.ownerEpoch === state.ownerEpoch && b.voiceEpoch === state.voiceEpoch && b.questionId === (state.pendingQuestion?.id ?? null)
      && b.requestRevision === (request?.revision ?? null) && (allowAnswer || b.sourceId === (state.inputs.at(-1)?.id ?? null));
  }
  end(): void { this.close(); }
  fail(reason: string): void { if (this.failed || this.closed) return; this.failed = true; this.options.onFailure?.(reason); this.close(); }
  close(): void {
    this.clearUntranscribedRecovery();
    if (this.closed) return;
    this.options.signal?.removeEventListener("abort", this.setupAborted);
    this.invalidate(); this.closed = true; this.configResolve?.(false); this.controller.close();
    const receipt: TrustedTerminalOutcomeReceipt = { authority: "call_orchestrator", issuerId: "callback-current-state",
      authorityReceiptId: randomUUID(), authorityNonce: this.terminalNonce, authorityExpiresAtMs: this.now().getTime() + 30_000,
      callId: this.binding.callId, callLifecycleId: this.binding.lifecycleId, callStateVersion: this.binding.stateVersion,
      goalId: this.binding.activeGoalId, outcome: this.controller.endedByCaller() ? "completed" : "provider_ended" };
    this.shutdownTask = (this.controller.endedByCaller() ? this.harness.endCall(receipt) : this.harness.failTransportCall("callback_transport_closed")).catch(() => undefined);
  }
  endedByCaller(): boolean { return this.controller.endedByCaller(); }
  async drain(): Promise<void> { await this.tail; await this.shutdownTask; }
  private now(): Date { return this.options.now?.() ?? new Date(); }
}
