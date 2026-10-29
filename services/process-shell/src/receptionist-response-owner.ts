import type { CompiledReceptionistPrompt } from "./receptionist-policy.js";
import type { ProtectedSidebandClose, ProtectedSidebandEvent, ReceptionistSidebandControlPort, SanitizedSidebandError } from "./receptionist-openai.js";
import type { RecoveryFailureDomain } from "./conversation-contract.js";

const PROGRESS_DELAY_MS = 700;

export type ResponseOwnerToken = Readonly<{ conversationId: string; voiceEpoch: number; turnId: string; inputItemId: string; generation: number }>;
export type ResponseOwnerEventOutcome =
  | { kind: "ignored" }
  | { kind: "current_response_created"; responseId: string; token: ResponseOwnerToken }
  | { kind: "stale_response_created"; responseId: string; token: ResponseOwnerToken }
  | { kind: "current_response_done"; responseId: string; token: ResponseOwnerToken }
  | { kind: "stale_response_done"; responseId: string; token: ResponseOwnerToken }
  | { kind: "current_response_failed"; responseId: string; token: ResponseOwnerToken }
  | { kind: "stale_response_failed"; responseId: string; token: ResponseOwnerToken };
export type ResponseOwnerOperationOutcome<T> =
  | { kind: "result"; value: T }
  | { kind: "failed" }
  | { kind: "unknown"; cause: "deadline" | "recovery_started" }
  | { kind: "stale" };

export class ReceptionistResponseOwner {
  private current: CurrentConversation | null = null;
  private pendingCancellation: Promise<void> | null = null;
  private readonly operationTimeoutMs: number;

  constructor(private readonly dependencies: {
    recovery: (input: { conversationId: string; voiceEpoch: number; callId: string; failureDomain: RecoveryFailureDomain }) => Promise<void> | void;
    operationTimeoutMs?: number;
  }) {
    this.operationTimeoutMs = boundedTimeout(dependencies.operationTimeoutMs ?? 5_000);
  }

  activate(input: { conversationId: string; voiceEpoch: number; currentTurn: string; inputItemId: string; callId: string; port: ReceptionistSidebandControlPort }): ResponseOwnerToken {
    if (this.current !== null) throw new Error("response_owner_conversation_active");
    checkedId(input.conversationId, "response_owner_conversation_invalid");
    checkedEpoch(input.voiceEpoch);
    checkedId(input.currentTurn, "response_owner_turn_invalid");
    checkedId(input.inputItemId, "response_owner_input_item_invalid");
    checkedId(input.callId, "response_owner_call_invalid");
    if (input.port.callId !== input.callId) throw new Error("response_owner_call_binding_mismatch");
    this.current = { conversationId: input.conversationId, voiceEpoch: input.voiceEpoch, turnId: input.currentTurn, inputItemId: input.inputItemId, callId: input.callId,
      port: input.port, generation: 1, nextResponseSequence: 1, outstanding: [], operation: null, recoveryStarted: false };
    return this.token(this.current);
  }

  beginTurn(token: ResponseOwnerToken, input: { currentTurn: string; inputItemId: string }): ResponseOwnerToken {
    const state = this.requireCurrent(token);
    checkedId(input.currentTurn, "response_owner_turn_invalid");
    checkedId(input.inputItemId, "response_owner_input_item_invalid");
    this.stopOperation(state, false);
    state.turnId = input.currentTurn;
    state.inputItemId = input.inputItemId;
    state.generation += 1;
    return this.token(state);
  }

  async requestResponse(input: { token: ResponseOwnerToken; prompt: CompiledReceptionistPrompt; beforeUpdate?: () => Promise<void>; beforeCreate?: () => Promise<void> }): Promise<void> {
    const state = this.requireCurrent(input.token);
    if (state.recoveryStarted) throw new Error("response_owner_recovery_active");
    if (state.outstanding.some((response) => sameToken(response.token, input.token))) throw new Error("response_owner_response_pending");
    if (state.outstanding.length >= 64) {
      await this.recover(state);
      throw new Error("response_owner_correlation_capacity");
    }
    const response: OutstandingResponse = { token: input.token, correlation: this.nextCorrelation(state), responseId: null };
    state.outstanding.push(response);
    let createIssued = false;
    try {
      await input.beforeUpdate?.();
      this.requireCurrent(input.token);
      if (input.prompt.responseContext !== "isolated") await state.port.updatePrompt(input.prompt);
      this.requireCurrent(input.token);
      await input.beforeCreate?.();
      this.requireCurrent(input.token);
      createIssued = true;
      await state.port.createResponse({ metadata: { receptionist_response_token: response.correlation },
        ...(input.prompt.toolChoice === "required" ? { outputModalities: ["text"] as const, requiredPrompt: input.prompt } : {}),
        ...(input.prompt.responseContext === "isolated" ? { isolatedPrompt: input.prompt } : {}) });
      this.requireCurrent(input.token);
    } catch (error) {
      if (isTransportUnknown(error)) await this.recover(state);
      else if (!createIssued && response.responseId === null) state.outstanding = state.outstanding.filter((entry) => entry !== response);
      throw error;
    }
  }

  async bargeIn(token: ResponseOwnerToken, onFenced?: (token: ResponseOwnerToken) => void): Promise<ResponseOwnerToken> {
    const state = this.requireCurrent(token);
    this.stopOperation(state, false);
    state.generation += 1;
    // Publish the invalidation before asynchronous transport work can admit
    // another speech-start event using the caller's old token.
    onFenced?.(this.token(state));
    const cancel = () => state.port.cancelResponse();
    const cancellation = this.pendingCancellation === null ? cancel() : this.pendingCancellation.then(cancel);
    this.pendingCancellation = cancellation;
    try { await cancellation; }
    catch (error) {
      if (isTransportUnknown(error)) await this.recover(state);
      throw error;
    }
    finally { if (this.pendingCancellation === cancellation) this.pendingCancellation = null; }
    return this.token(state);
  }

  onSidebandEvent(event: ProtectedSidebandEvent): ResponseOwnerEventOutcome {
    const state = this.current;
    if (state === null || event.callId !== state.callId) return { kind: "ignored" };
    if (event.type === "response.created") {
      const responseId = responseIdOf(event);
      const correlation = responseCorrelationOf(event);
      if (responseId === null || correlation === null) return { kind: "ignored" };
      const response = state.outstanding.find((entry) => entry.correlation === correlation && entry.responseId === null);
      if (response === undefined) return { kind: "ignored" };
      response.responseId = responseId;
      return sameToken(response.token, this.token(state))
        ? { kind: "current_response_created", responseId, token: response.token }
        : { kind: "stale_response_created", responseId, token: response.token };
    }
    if (event.type === "response.done") {
      const responseId = responseIdOf(event);
      const correlation = responseCorrelationOf(event);
      if (responseId === null || correlation === null) return { kind: "ignored" };
      const index = state.outstanding.findIndex((entry) => entry.responseId === responseId && entry.correlation === correlation);
      if (index < 0) return { kind: "ignored" };
      const [response] = state.outstanding.splice(index, 1);
      if (response === undefined) return { kind: "ignored" };
      const current = sameToken(response.token, this.token(state));
      if (responseTerminalFailed(event)) return current
        ? { kind: "current_response_failed", responseId, token: response.token }
        : { kind: "stale_response_failed", responseId, token: response.token };
      return current
        ? { kind: "current_response_done", responseId, token: response.token }
        : { kind: "stale_response_done", responseId, token: response.token };
    }
    return { kind: "ignored" };
  }

  async onSidebandError(error: SanitizedSidebandError): Promise<void> {
    const state = this.current;
    if (state === null || error.callId !== state.callId || !isTransportUnknown(error)) return;
    await this.recover(state, error.code === "sideband_payload_too_large" ? "realtime_transport_only" : "openai_provider_or_scope_unknown");
  }

  async onSidebandClose(event: ProtectedSidebandClose): Promise<void> {
    const state = this.current;
    if (state === null || event.callId !== state.callId) return;
    await this.recover(state);
  }

  /** Provider errors are actionable only while this owner has live work to strand. */
  async onProviderError(event: ProtectedSidebandEvent, onActionable?: () => void): Promise<boolean> {
    const state = this.current;
    const error = providerError(event);
    // OpenAI may report this after our VAD cancellation races a newly-created
    // response. It means no active response remained to cancel, not that the
    // current response failed.
    if (state === null || event.callId !== state.callId || error === null || error.code === "response_cancel_not_active") return false;
    const token = this.token(state);
    if (state.operation === null && !state.outstanding.some((response) => sameToken(response.token, token))) return false;
    onActionable?.();
    await this.recover(state);
    return true;
  }

  /** Never retries a failed turn; recovery only releases the bound sideband. */
  async recoverCurrent(token: ResponseOwnerToken): Promise<boolean> {
    const state = this.current;
    if (state === null || !sameToken(this.token(state), token) || state.recoveryStarted) return false;
    await this.recover(state);
    return true;
  }

  disconnect(token: ResponseOwnerToken): void {
    const state = this.requireCurrent(token);
    this.stopOperation(state, true);
    state.port.close();
    this.current = null;
  }

  async runOperation<T>(input: {
    token: ResponseOwnerToken;
    operationId: string;
    execute: (signal: AbortSignal) => Promise<T>;
    progressPrompt?: (input: { operationId: string; token: ResponseOwnerToken }) => Promise<CompiledReceptionistPrompt | null>;
  }): Promise<ResponseOwnerOperationOutcome<T>> {
    const state = this.requireCurrent(input.token);
    if (state.recoveryStarted) throw new Error("response_owner_recovery_active");
    if (state.operation !== null) throw new Error("response_owner_operation_pending");
    checkedId(input.operationId, "response_owner_operation_invalid");
    let endOperation!: () => void;
    const stopped = new Promise<{ kind: "stopped" }>((resolve) => { endOperation = () => resolve({ kind: "stopped" }); });
    const operation: PendingOperation = { token: input.token, operationId: input.operationId, controller: new AbortController(), active: true,
      progressIssued: false, progressTimer: null, timeoutTimer: null, stopped, endOperation };
    state.operation = operation;
    operation.progressTimer = setTimeout(() => { void this.progressIfPending(state, operation, input.progressPrompt); }, PROGRESS_DELAY_MS);
    const completion = Promise.resolve().then(() => input.execute(operation.controller.signal)).then(
      (value) => ({ kind: "result" as const, value }),
      () => ({ kind: "failed" as const }),
    );
    void completion.then(() => this.clearHardDeadline(operation));
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      operation.timeoutTimer = setTimeout(() => {
        operation.timeoutTimer = null;
        operation.controller.abort();
        resolve({ kind: "timeout" });
      }, this.operationTimeoutMs);
    });
    const result = await Promise.race([completion, timeout, operation.stopped]);
    if (result.kind !== "stopped") this.clearTimers(operation);
    if (state.operation === operation) state.operation = null;
    operation.active = false;
    if (result.kind === "stopped") return state.recoveryStarted ? { kind: "unknown", cause: "recovery_started" } : { kind: "stale" };
    if (!this.isCurrent(input.token)) return { kind: "stale" };
    if (result.kind === "timeout") return { kind: "unknown", cause: "deadline" };
    if (result.kind === "failed") return { kind: "failed" };
    return { kind: "result", value: result.value };
  }

  private async progressIfPending(state: CurrentConversation, operation: PendingOperation,
    progressPrompt: ((input: { operationId: string; token: ResponseOwnerToken }) => Promise<CompiledReceptionistPrompt | null>) | undefined): Promise<void> {
    if (!operation.active || state.operation !== operation || !this.isCurrent(operation.token) || operation.progressIssued) return;
    operation.progressIssued = true;
    if (progressPrompt === undefined) return;
    try {
      const prompt = await progressPrompt({ operationId: operation.operationId, token: operation.token });
      if (prompt !== null && operation.active && state.operation === operation && this.isCurrent(operation.token)) {
        await this.requestResponse({ token: operation.token, prompt });
      }
    } catch {
      // Progress is optional and never substitutes for a tool result or recovery.
    }
  }

  private async recover(state: CurrentConversation, failureDomain: RecoveryFailureDomain = "openai_provider_or_scope_unknown"): Promise<void> {
    if (state.recoveryStarted) return;
    state.recoveryStarted = true;
    this.stopOperation(state, true);
    state.port.close();
    await this.dependencies.recovery({ conversationId: state.conversationId, voiceEpoch: state.voiceEpoch, callId: state.callId, failureDomain });
  }

  private stopOperation(state: CurrentConversation, abort: boolean): void {
    const operation = state.operation;
    if (operation === null) return;
    state.operation = null;
    operation.active = false;
    this.clearProgressTimer(operation);
    if (abort) operation.controller.abort();
    operation.endOperation();
  }

  private clearTimers(operation: PendingOperation): void {
    this.clearProgressTimer(operation);
    this.clearHardDeadline(operation);
  }

  private clearHardDeadline(operation: PendingOperation): void {
    if (operation.timeoutTimer !== null) clearTimeout(operation.timeoutTimer);
    operation.timeoutTimer = null;
  }

  private clearProgressTimer(operation: PendingOperation): void {
    if (operation.progressTimer !== null) clearTimeout(operation.progressTimer);
    operation.progressTimer = null;
  }

  private requireCurrent(token: ResponseOwnerToken): CurrentConversation {
    if (!this.isCurrent(token)) throw new Error("response_owner_stale_token");
    return this.current!;
  }

  private isCurrent(token: ResponseOwnerToken): boolean {
    return this.current !== null && sameToken(this.token(this.current), token);
  }

  private token(state: CurrentConversation): ResponseOwnerToken {
    return { conversationId: state.conversationId, voiceEpoch: state.voiceEpoch, turnId: state.turnId, inputItemId: state.inputItemId, generation: state.generation };
  }

  private nextCorrelation(state: CurrentConversation): string {
    const sequence = state.nextResponseSequence;
    state.nextResponseSequence += 1;
    return `r1-${sequence}`;
  }
}

type OutstandingResponse = { token: ResponseOwnerToken; correlation: string; responseId: string | null };
type PendingOperation = { token: ResponseOwnerToken; operationId: string; controller: AbortController; active: boolean; progressIssued: boolean;
  progressTimer: NodeJS.Timeout | null; timeoutTimer: NodeJS.Timeout | null; stopped: Promise<{ kind: "stopped" }>; endOperation: () => void };
type CurrentConversation = { conversationId: string; voiceEpoch: number; turnId: string; inputItemId: string; callId: string; port: ReceptionistSidebandControlPort;
  generation: number; nextResponseSequence: number; outstanding: OutstandingResponse[]; operation: PendingOperation | null; recoveryStarted: boolean };

function sameToken(left: ResponseOwnerToken, right: ResponseOwnerToken): boolean {
  return left.conversationId === right.conversationId && left.voiceEpoch === right.voiceEpoch && left.turnId === right.turnId
    && left.inputItemId === right.inputItemId && left.generation === right.generation;
}
function responseIdOf(event: ProtectedSidebandEvent): string | null {
  const response = event.payload.response;
  return isRecord(response) && typeof response.id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(response.id) ? response.id : null;
}
function responseCorrelationOf(event: ProtectedSidebandEvent): string | null {
  const response = event.payload.response;
  if (!isRecord(response) || !isRecord(response.metadata)) return null;
  const correlation = response.metadata.receptionist_response_token;
  return typeof correlation === "string" && /^r1-[1-9][0-9]{0,9}$/.test(correlation) ? correlation : null;
}
function responseTerminalFailed(event: ProtectedSidebandEvent): boolean {
  const response = event.payload.response;
  if (!isRecord(response) || !("status" in response)) return false;
  // A cancelled response is intentional only after barge-in advances the token;
  // a cancellation on the current token otherwise leaves the caller unsatisfied.
  return response.status !== "completed";
}
function providerError(event: ProtectedSidebandEvent): { code: string | null } | null {
  const error = event.payload.error;
  if (!isRecord(error) || ![error.type, error.code, error.message].some((value) => typeof value === "string" && value.length > 0 && value.length <= 500)) return null;
  return { code: typeof error.code === "string" && error.code.length > 0 && error.code.length <= 500 ? error.code : null };
}
function isTransportUnknown(value: unknown): boolean {
  if (typeof value === "object" && value !== null && "code" in value) {
    const code = (value as { code?: unknown }).code;
    return code === "sideband_closed" || code === "sideband_send_unknown" || code === "sideband_send_timeout" || code === "sideband_send_failed"
      || code === "sideband_transport_error" || code === "sideband_connect_failed" || code === "sideband_connect_timeout" || code === "sideband_payload_too_large";
  }
  return value instanceof Error && (value.message === "openai_sideband_send_unknown" || value.message === "openai_sideband_send_timeout"
    || value.message === "openai_sideband_send_failed" || value.message === "openai_sideband_closed");
}
function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 250 || value > 30_000) throw new Error("response_owner_operation_timeout_invalid");
  return value;
}
function checkedEpoch(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error("response_owner_epoch_invalid"); }
function checkedId(value: string, error: string): void { if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error(error); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
