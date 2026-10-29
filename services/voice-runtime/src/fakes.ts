import type {
  AuthenticatedTelephonyMark,
  ControlPlaneSpokenDirective,
  NormalizedAudioChunk,
  ProviderConnectionContract,
  RealtimeVoiceProvider,
  SpokenDirectiveAuthority,
  TelephonyMarkAuthority,
  TelephonyProvider,
  TerminalOutcomeAuthority,
  TrustedTerminalOutcomeReceipt,
  VoiceCallBinding,
} from "./ports.js";

export const FAKE_PROVIDER_CONNECTION_CONTRACT: ProviderConnectionContract = Object.freeze({
  authentication: Object.freeze({ owner: "adapter", credentialsExposedToRuntime: false }),
  reconnect: Object.freeze({ owner: "adapter", policy: "fail_closed", maxAttempts: 0 }),
  resume: Object.freeze({ owner: "adapter", supported: false, continuityTokenExposedToRuntime: false }),
});

async function waitForGate(gate: Promise<void> | null, signal: AbortSignal, ignoreAbortSignal = false): Promise<void> {
  if (signal.aborted) throw new Error("voice_provider_operation_aborted");
  if (gate === null) return;
  if (ignoreAbortSignal) {
    await gate;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("voice_provider_operation_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    gate.then(
      () => { signal.removeEventListener("abort", onAbort); resolve(); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export type FakeTelephonyOperation =
  | { readonly kind: "audio"; readonly callId: string; readonly outputDirectiveId: string; readonly mediaChunkNumber: number }
  | { readonly kind: "clear"; readonly callId: string }
  | { readonly kind: "mark"; readonly callId: string; readonly markId: string }
  | { readonly kind: "close"; readonly callId: string };

export interface FakeTelephonyFailures {
  sendAudio?: Error;
  clearAudio?: Error;
  sendMark?: Error;
  closeCall?: Error;
}

/** Deterministic adapter that stores routing metadata only, never audio bytes or spoken text. */
export class FakeTelephonyProvider implements TelephonyProvider {
  readonly name = "fake-telephony";
  readonly connectionContract = FAKE_PROVIDER_CONNECTION_CONTRACT;
  readonly operations: FakeTelephonyOperation[] = [];
  readonly failures: FakeTelephonyFailures = {};
  sendAudioGate: Promise<void> | null = null;
  ignoreAbortSignal = false;
  onSendAudio: (() => void) | null = null;
  onClear: (() => void) | null = null;

  async sendAudio(callId: string, audio: NormalizedAudioChunk, outputDirectiveId: string, signal: AbortSignal): Promise<void> {
    this.operations.push({ kind: "audio", callId, outputDirectiveId, mediaChunkNumber: audio.mediaChunkNumber });
    this.onSendAudio?.();
    if (this.failures.sendAudio !== undefined) throw this.failures.sendAudio;
    await waitForGate(this.sendAudioGate, signal, this.ignoreAbortSignal);
  }

  async clearAudio(callId: string, signal: AbortSignal): Promise<void> {
    this.operations.push({ kind: "clear", callId });
    this.onClear?.();
    if (this.failures.clearAudio !== undefined) throw this.failures.clearAudio;
    await waitForGate(null, signal);
  }

  async sendMark(callId: string, markId: string, signal: AbortSignal): Promise<void> {
    this.operations.push({ kind: "mark", callId, markId });
    if (this.failures.sendMark !== undefined) throw this.failures.sendMark;
    await waitForGate(null, signal);
  }

  async closeCall(callId: string): Promise<void> {
    this.operations.push({ kind: "close", callId });
    if (this.failures.closeCall !== undefined) throw this.failures.closeCall;
  }
}

export interface FakeRealtimeFailures {
  openSession?: Error;
  appendAudio?: Error;
  cancelOutput?: Error;
  closeSession?: Error;
}

export class FakeRealtimeVoiceProvider implements RealtimeVoiceProvider {
  readonly name = "fake-realtime";
  readonly connectionContract = FAKE_PROVIDER_CONNECTION_CONTRACT;
  readonly sessions = new Map<string, string>();
  readonly appended: Array<{ sessionId: string; providerMessageSequenceNumber: number; mediaChunkNumber: number }> = [];
  readonly cancelled: Array<{ sessionId: string; outputDirectiveId: string }> = [];
  readonly closed: string[] = [];
  readonly failures: FakeRealtimeFailures = {};
  appendGate: Promise<void> | null = null;
  ignoreAbortSignal = false;

  async openSession(input: { callId: string }, signal: AbortSignal): Promise<string> {
    if (this.failures.openSession !== undefined) throw this.failures.openSession;
    await waitForGate(null, signal);
    const sessionId = `fake-session-${input.callId}`;
    this.sessions.set(sessionId, input.callId);
    return sessionId;
  }

  async appendAudio(sessionId: string, audio: NormalizedAudioChunk, signal: AbortSignal): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error("fake_realtime_unknown_session");
    this.appended.push({
      sessionId,
      providerMessageSequenceNumber: audio.providerMessageSequenceNumber,
      mediaChunkNumber: audio.mediaChunkNumber,
    });
    if (this.failures.appendAudio !== undefined) throw this.failures.appendAudio;
    await waitForGate(this.appendGate, signal, this.ignoreAbortSignal);
  }

  async cancelOutput(sessionId: string, outputDirectiveId: string, signal: AbortSignal): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error("fake_realtime_unknown_session");
    this.cancelled.push({ sessionId, outputDirectiveId });
    if (this.failures.cancelOutput !== undefined) throw this.failures.cancelOutput;
    await waitForGate(null, signal);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
    this.sessions.delete(sessionId);
    if (this.failures.closeSession !== undefined) throw this.failures.closeSession;
  }
}

export class FakeSpokenDirectiveAuthority implements SpokenDirectiveAuthority {
  readonly name = "fake-control-plane-directive-authority";
  readonly verifiedDirectiveIds: string[] = [];
  private readonly consumedReceiptIds = new Set<string>();
  rejectAll = false;

  async verifyAndConsume(input: {
    readonly directive: ControlPlaneSpokenDirective;
    readonly call: import("./ports.js").VoiceCallBinding;
    readonly nowMs: number;
  }): Promise<boolean> {
    const { directive, call, nowMs } = input;
    this.verifiedDirectiveIds.push(directive.id);
    const receiptKey = `${directive.provenance.authorityReceiptId}:${directive.provenance.authorityNonce}`;
    const accepted = !this.rejectAll
      && directive.provenance.authority === "control_plane"
      && directive.provenance.authorityReceiptId.startsWith("receipt-")
      && directive.provenance.authorityNonce.startsWith("nonce-")
      && directive.provenance.authorityExpiresAtMs >= nowMs
      && directive.callId === call.callId
      && directive.callLifecycleId === call.lifecycleId
      && directive.callStateVersion === call.stateVersion
      && directive.goalId === call.activeGoalId
      && !this.consumedReceiptIds.has(receiptKey);
    if (accepted) this.consumedReceiptIds.add(receiptKey);
    return accepted;
  }
}

export class FakeTelephonyMarkAuthority implements TelephonyMarkAuthority {
  readonly name = "fake-telephony-mark-authority";
  readonly verifiedProviderEventIds: string[] = [];
  private readonly consumedProviderEventIds = new Set<string>();
  private readonly consumedReceiptIds = new Set<string>();
  rejectAll = false;
  failure: Error | null = null;

  async verifyAndConsume(input: {
    readonly mark: AuthenticatedTelephonyMark;
    readonly call: VoiceCallBinding;
    readonly expectedProviderName: string;
    readonly expectedOutputDirectiveId: string;
    readonly expectedMarkId: string;
    readonly nowMs: number;
  }): Promise<boolean> {
    if (this.failure !== null) throw this.failure;
    const { mark, call, expectedProviderName, expectedOutputDirectiveId, expectedMarkId, nowMs } = input;
    this.verifiedProviderEventIds.push(mark.providerEventId);
    const receiptKey = `${mark.authorityReceiptId}:${mark.authorityNonce}`;
    const accepted = !this.rejectAll
      && mark.authority === "telephony_adapter"
      && mark.issuerId.startsWith("telephony-adapter-")
      && mark.authorityReceiptId.startsWith("mark-receipt-")
      && mark.authorityNonce.startsWith("mark-nonce-")
      && mark.providerEventId.startsWith("provider-event-")
      && mark.authorityExpiresAtMs >= nowMs
      && mark.receivedAtMs <= nowMs
      && mark.callId === call.callId
      && mark.callLifecycleId === call.lifecycleId
      && mark.providerName === expectedProviderName
      && mark.outputDirectiveId === expectedOutputDirectiveId
      && mark.markId === expectedMarkId
      && !this.consumedProviderEventIds.has(mark.providerEventId)
      && !this.consumedReceiptIds.has(receiptKey);
    if (accepted) {
      this.consumedProviderEventIds.add(mark.providerEventId);
      this.consumedReceiptIds.add(receiptKey);
    }
    return accepted;
  }
}

export class FakeTerminalOutcomeAuthority implements TerminalOutcomeAuthority {
  readonly name = "fake-terminal-outcome-authority";
  readonly verifiedReceiptIds: string[] = [];
  private readonly consumedReceiptIds = new Set<string>();
  rejectAll = false;
  failure: Error | null = null;

  async verifyAndConsume(input: {
    readonly receipt: TrustedTerminalOutcomeReceipt;
    readonly call: VoiceCallBinding;
    readonly nowMs: number;
  }): Promise<boolean> {
    if (this.failure !== null) throw this.failure;
    const { receipt, call, nowMs } = input;
    this.verifiedReceiptIds.push(receipt.authorityReceiptId);
    const receiptKey = `${receipt.authorityReceiptId}:${receipt.authorityNonce}`;
    const accepted = !this.rejectAll
      && receipt.authority === "call_orchestrator"
      && receipt.issuerId.startsWith("call-orchestrator-")
      && receipt.authorityReceiptId.startsWith("terminal-receipt-")
      && receipt.authorityNonce.startsWith("terminal-nonce-")
      && receipt.authorityExpiresAtMs >= nowMs
      && receipt.callId === call.callId
      && receipt.callLifecycleId === call.lifecycleId
      && receipt.callStateVersion === call.stateVersion
      && receipt.goalId === call.activeGoalId
      && !this.consumedReceiptIds.has(receiptKey);
    if (accepted) this.consumedReceiptIds.add(receiptKey);
    return accepted;
  }
}
