import { createHash, randomUUID } from "node:crypto";

import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import type { ControlledTestTransferPort, ControlledTransferCallback, ControlledTransferTerminalOutcome } from "./controlled-test-transfer.js";

type TransferRecord = Conversation["controlledTransfers"][number];
type FallbackReason = Extract<ControlledTransferTerminalOutcome, { kind: "fallback" }>["reason"];

/** The only effectful operation in this coordinator. It must not create a new caller leg. */
export interface ControlledTransferParentRedirectPort {
  redirectTransfer(input: Readonly<{ scope: ConversationScope; transferId: string; parentCallId: string; callbackToken: string }>): Promise<{ state: "redirected" | "parent_gone" | "unknown" }>;
}

/** Idempotent by transferId: retries close the crash window after a durable terminal outcome. */
export interface ControlledTransferFallbackPort {
  resume(input: Readonly<{ scope: ConversationScope; transferId: string; requestId: string; requestRevision: number; parentCallId: string; reason: FallbackReason }>): Promise<string>;
}

/** HTTP authentication is complete before this is constructed; these fields remain independently bound here. */
export type TrustedControlledTransferCallback = Readonly<{
  scope: ConversationScope; accountId: string; transferId: string; parentCallId: string; childTo: string; callback: ControlledTransferCallback;
  /** Derived by trusted HTTP routing; passive child notifications never resume the parent. */
  parentAction?: boolean;
}>;

export type ControlledTransferStartResult =
  | { kind: "redirected"; transferId: string }
  | { kind: "pending"; transferId: string }
  | { kind: "unknown"; transferId: string }
  | { kind: "unavailable"; reason: string }
  | { kind: "rejected"; reason: string };

export type ControlledTransferCallbackResult =
  | { kind: "pending"; transferId: string }
  | { kind: "screening"; transferId: string; twiml: string }
  | { kind: "recipient_accepted"; transferId: string }
  | { kind: "fallback"; transferId: string; reason: FallbackReason; twiml: string }
  | { kind: "ignored"; reason: string };

/** Durable F3 orchestration. It never considers a connected child leg to be a resolved request. */
export class ControlledTransferCoordinator {
  constructor(private readonly options: {
    store: Pick<ConversationStore, "get" | "execute">;
    transfer: ControlledTestTransferPort;
    parentRedirect: ControlledTransferParentRedirectPort;
    fallback: ControlledTransferFallbackPort;
    now?: () => Date;
  }) {}

  async start(input: { scope: ConversationScope; requestId: string; sourceId: string }): Promise<ControlledTransferStartResult> {
    const current = await this.options.store.get(input.scope);
    if (current === null || !this.currentAuthority(current, input.sourceId)) return { kind: "rejected", reason: "context_unavailable" };
    const request = current.requests.find((item) => item.id === input.requestId);
    if (request?.state !== "draft" || request.category === null || !request.sourceIds.includes(input.sourceId)) return { kind: "rejected", reason: "request_unavailable" };

    const existing = current.controlledTransfers.find((item) => item.outcome === null && item.attempt.requestId === request.id
      && item.attempt.requestRevision === request.revision && item.attempt.ownerEpoch === current.ownerEpoch && item.attempt.voiceEpoch === current.voiceEpoch);
    if (existing !== undefined) return existing.dispatch === "prepared" ? this.dispatchPrepared(current, existing) : existing.dispatch === "unknown"
      ? { kind: "unknown", transferId: existing.attempt.id } : { kind: "pending", transferId: existing.attempt.id };

    const prepared = this.options.transfer.prepare({ mode: current.admission.mode, scope: scopeOf(current), requestId: request.id, requestRevision: request.revision,
      ownerEpoch: current.ownerEpoch, voiceEpoch: current.voiceEpoch + 1, category: request.category, parentCallId: current.admission.externalId,
      sourceNumberE164: current.admission.destination, callerNumberE164: current.admission.contact, issuedAt: (this.options.now ?? (() => new Date()))().toISOString() });
    if (prepared.kind === "fallback") return { kind: "unavailable", reason: prepared.reason };
    const receipt = await this.command(current, `controlled-transfer-prepare-${prepared.attempt.id}`, { type: "controlled_transfer.prepare", attempt: prepared.attempt });
    if (!receipt.accepted) {
      const refreshed = await this.options.store.get(input.scope);
      const duplicate = refreshed?.controlledTransfers.find((item) => item.outcome === null && sameAttemptBinding(item, prepared.attempt));
      if (duplicate !== undefined) return duplicate.dispatch === "unknown" ? { kind: "unknown", transferId: duplicate.attempt.id } : { kind: "pending", transferId: duplicate.attempt.id };
      return { kind: "rejected", reason: receipt.error ?? "prepare_rejected" };
    }
    return this.dispatchPrepared(receipt.state, receipt.state.controlledTransfers.find((item) => item.attempt.id === prepared.attempt.id)!);
  }

  async callback(input: TrustedControlledTransferCallback): Promise<ControlledTransferCallbackResult> {
    const current = await this.options.store.get(input.scope);
    if (current === null || !this.callbackAuthority(current, input)) return { kind: "ignored", reason: "binding_invalid" };
    const record = current.controlledTransfers.find((item) => item.attempt.id === input.transferId);
    if (record === undefined) return { kind: "ignored", reason: "transfer_unknown" };
    if (!this.callbackRecordBinding(current, record, input)) return { kind: "ignored", reason: "binding_invalid" };
    if (record.outcome !== null) return this.replayTerminal(current, record, input.parentAction === true);
    const result = this.options.transfer.outcome(record.attempt, input.callback);
    if (result.kind === "rejected") return { kind: "ignored", reason: result.reason };
    if (result.kind === "pending") {
      const progressed = await this.persistProgress(current, input.transferId, result.attempt, input.callback);
      if (progressed === null) return { kind: "ignored", reason: "progress_rejected" };
      const durable = progressed.controlledTransfers.find((item) => item.attempt.id === input.transferId)!;
      if (durable.outcome !== null) return this.replayTerminal(progressed, durable, input.parentAction === true);
      return result.attempt.state === "answered"
        ? { kind: "screening", transferId: result.attempt.id, twiml: this.options.transfer.screeningTwiml(result.attempt) }
        : { kind: "pending", transferId: result.attempt.id };
    }
    const completed = await this.persistFinish(current, input.transferId, result, input.callback);
    if (completed === null) return { kind: "ignored", reason: "finish_rejected" };
    const durable = completed.controlledTransfers.find((item) => item.attempt.id === input.transferId)!;
    return this.replayTerminal(completed, durable, input.parentAction === true);
  }

  private async dispatchPrepared(current: Conversation, record: TransferRecord): Promise<ControlledTransferStartResult> {
    let state = current;
    if (record.dispatch === "prepared") {
      // A new event ID makes this a compare-and-swap claim, not a replayable effect authorization.
      const receipt = await this.command(state, `controlled-transfer-submit-${record.attempt.id}-${randomUUID()}`, { type: "controlled_transfer.dispatch", transferId: record.attempt.id, state: "submitting" });
      if (!receipt.accepted) return { kind: "rejected", reason: receipt.error ?? "submit_rejected" };
      state = receipt.state;
      record = state.controlledTransfers.find((item) => item.attempt.id === record.attempt.id)!;
    }
    if (record.dispatch === "unknown") return { kind: "unknown", transferId: record.attempt.id };
    if (record.dispatch === "submitted") return { kind: "pending", transferId: record.attempt.id };
    // Redirect can occur once only. Any non-confirmation is durably ambiguous and never resent.
    let redirected: "redirected" | "parent_gone" | "unknown";
    try { redirected = (await this.options.parentRedirect.redirectTransfer({ scope: scopeOf(state), transferId: record.attempt.id,
      parentCallId: record.attempt.parentCallId, callbackToken: record.attempt.callbackToken })).state; }
    catch { redirected = "unknown"; }
    const dispatchState = redirected === "redirected" ? "submitted" : "unknown";
    // The carrier result is already known. A callback may have advanced the row while the REST call was in flight;
    // retry only this durable status transition against the same current attempt, never the redirect itself.
    const persisted = await this.persistRedirectResult(state, record.attempt.id, dispatchState);
    if (!persisted) return { kind: "unknown", transferId: record.attempt.id };
    return redirected === "redirected" ? { kind: "redirected", transferId: record.attempt.id } : { kind: "unknown", transferId: record.attempt.id };
  }

  private async persistRedirectResult(initial: Conversation, transferId: string, state: "submitted" | "unknown"): Promise<boolean> {
    let current = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const record = current.controlledTransfers.find((item) => item.attempt.id === transferId);
      if (record === undefined || record.outcome !== null || current.phase !== "active" || current.owner !== "ai" || current.suppressed || current.emergency !== null
        || record.attempt.ownerEpoch !== current.ownerEpoch || record.attempt.voiceEpoch !== current.voiceEpoch) return false;
      if (record.dispatch === state) return true;
      if (record.dispatch !== "submitting") return false;
      const receipt = await this.command(current, `controlled-transfer-dispatch-${transferId}-${state}-${randomUUID()}`, { type: "controlled_transfer.dispatch", transferId, state });
      if (receipt.accepted) return true;
      const fresh = await this.options.store.get(scopeOf(current));
      if (fresh === null) return false;
      current = fresh;
    }
    return false;
  }

  private async persistProgress(initial: Conversation, transferId: string, nextAttempt: TransferRecord["attempt"], callback: ControlledTransferCallback): Promise<Conversation | null> {
    let current = initial;
    for (let retry = 0; retry < 2; retry += 1) {
      const record = current.controlledTransfers.find((item) => item.attempt.id === transferId);
      if (record === undefined || current.phase !== "active" || current.owner !== "ai" || current.suppressed || current.emergency !== null
        || record.attempt.ownerEpoch !== current.ownerEpoch || record.attempt.voiceEpoch !== current.voiceEpoch) return null;
      if (record.outcome !== null || sameAttempt(record.attempt, nextAttempt)) return current;
      if (record.dispatch !== "submitting" && record.dispatch !== "submitted" && record.dispatch !== "unknown") return null;
      const receipt = await this.command(current, `${eventId("update", transferId, callback)}-${randomUUID()}`, { type: "controlled_transfer.update", attempt: nextAttempt });
      if (receipt.accepted) return receipt.state;
      const fresh = await this.options.store.get(scopeOf(current));
      if (fresh === null) return null;
      current = fresh;
    }
    return null;
  }

  private async persistFinish(initial: Conversation, transferId: string, result: Exclude<ReturnType<ControlledTestTransferPort["outcome"]>, { kind: "pending" | "rejected" }>, callback: ControlledTransferCallback): Promise<Conversation | null> {
    let current = initial;
    for (let retry = 0; retry < 2; retry += 1) {
      const record = current.controlledTransfers.find((item) => item.attempt.id === transferId);
      if (record === undefined || current.phase !== "active" || current.owner !== "ai" || current.suppressed || current.emergency !== null
        || record.attempt.ownerEpoch !== current.ownerEpoch) return null;
      if (record.outcome !== null && (record.attempt.voiceEpoch === current.voiceEpoch || record.resumedVoiceEpoch === current.voiceEpoch)) return current;
      if (record.attempt.voiceEpoch !== current.voiceEpoch) return null;
      const receipt = await this.command(current, `${eventId("finish", transferId, callback)}-${randomUUID()}`, {
        type: "controlled_transfer.finish", transferId, outcome: result.kind === "recipient_accepted" ? "accepted" : result.reason,
        ...(result.kind === "recipient_accepted" ? { acceptance: result.acceptance } : {}),
      });
      if (receipt.accepted) return receipt.state;
      const fresh = await this.options.store.get(scopeOf(current));
      if (fresh === null) return null;
      current = fresh;
    }
    return null;
  }

  private async replayTerminal(current: Conversation, record: TransferRecord, parentAction: boolean): Promise<ControlledTransferCallbackResult> {
    if (record.outcome === null) return { kind: "ignored", reason: "terminal_missing" };
    if (record.outcome === "accepted") return { kind: "recipient_accepted", transferId: record.attempt.id };
    if (!parentAction) return { kind: "fallback", transferId: record.attempt.id, reason: record.outcome, twiml: "<Response><Hangup/></Response>" };
    const twiml = await this.resumeFallback(current, record.attempt.id, record.outcome);
    if (twiml === null) return { kind: "ignored", reason: "resume_rejected" };
    return { kind: "fallback", transferId: record.attempt.id, reason: record.outcome, twiml };
  }

  private async resumeFallback(current: Conversation, transferId: string, reason: FallbackReason): Promise<string | null> {
    let record = current.controlledTransfers.find((item) => item.attempt.id === transferId);
    if (record === undefined) throw new Error("controlled_transfer_record_missing");
    if (record.resumedVoiceEpoch !== current.voiceEpoch) {
      const receipt = await this.command(current, `controlled-transfer-resume-${transferId}`, { type: "controlled_transfer.resume", transferId });
      if (!receipt.accepted) return null;
      current = receipt.state;
      record = current.controlledTransfers.find((item) => item.attempt.id === transferId)!;
    }
    const request = current.requests.find((item) => item.id === record!.attempt.requestId);
    if (request?.state === "draft" && request.name && request.callbackNumber && request.callbackConfirmed
      && typeof request.callbackMessageSourceId === "string" && request.sourceIds.includes(request.callbackMessageSourceId)
      && current.inputs.some((input) => input.id === request.callbackMessageSourceId)) {
      const captured = await this.command(current, "controlled-transfer-capture-" + transferId, { type: "request.capture", requestId: request.id });
      if (!captured.accepted) return null;
      current = captured.state;
    }
    return this.options.fallback.resume({ scope: scopeOf(current), transferId, requestId: record.attempt.requestId,
      requestRevision: current.requests.find((item) => item.id === record!.attempt.requestId)?.revision ?? record.attempt.requestRevision,
      parentCallId: record.attempt.parentCallId, reason });
  }

  private async command(current: Conversation, eventId: string, command: Parameters<ConversationStore["execute"]>[0]["command"]) {
    return this.options.store.execute({ scope: scopeOf(current), eventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
      actor: { kind: "system", id: "controlled-transfer-coordinator" }, command });
  }

  private currentAuthority(current: Conversation, sourceId: string): boolean {
    return current.admission.mode === "receptionist" && current.admission.channel === "voice" && current.admission.hours === "demo_open" && current.phase === "active"
      && current.owner === "ai" && !current.suppressed && current.emergency === null && current.inputs.at(-1)?.id === sourceId;
  }

  private callbackAuthority(current: Conversation, input: TrustedControlledTransferCallback): boolean {
    const event = input.callback;
    return current.admission.mode === "receptionist" && current.admission.channel === "voice" && current.phase === "active" && current.owner === "ai"
      && !current.suppressed && current.emergency === null && current.admission.accountId === input.accountId && current.admission.externalId === input.parentCallId
      && event.parentCallId === input.parentCallId && scopeOf(current).practiceId === input.scope.practiceId && scopeOf(current).instanceId === input.scope.instanceId && scopeOf(current).conversationId === input.scope.conversationId;
  }

  private callbackRecordBinding(current: Conversation, record: TransferRecord, input: TrustedControlledTransferCallback): boolean {
    const request = current.requests.find((item) => item.id === record.attempt.requestId);
    const childBinding = input.callback.kind === "parent_dial_result"
      ? record.attempt.childCallId === null
      : record.attempt.childCallId === null || record.attempt.childCallId === input.callback.childCallId;
    return record.attempt.callbackToken === input.callback.token && record.attempt.destinationE164 === input.childTo
      && record.attempt.parentCallId === input.parentCallId && record.attempt.scope.conversationId === current.id
      && record.attempt.ownerEpoch === current.ownerEpoch
      && (record.attempt.voiceEpoch === current.voiceEpoch || record.resumedVoiceEpoch === current.voiceEpoch)
      && ((request?.state === "draft" && request.revision === record.attempt.requestRevision)
        || (input.parentAction === true && record.outcome !== null && record.outcome !== "accepted"
          && record.resumedVoiceEpoch === current.voiceEpoch && request?.state === "needs_callback"
          && request.revision === record.attempt.requestRevision + 1))
      && childBinding;
  }
}

function sameAttemptBinding(record: TransferRecord, attempt: TransferRecord["attempt"]): boolean {
  return record.attempt.requestId === attempt.requestId && record.attempt.requestRevision === attempt.requestRevision
    && record.attempt.ownerEpoch === attempt.ownerEpoch && record.attempt.voiceEpoch === attempt.voiceEpoch;
}
function sameAttempt(left: TransferRecord["attempt"], right: TransferRecord["attempt"]): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function eventId(kind: string, transferId: string, callback: ControlledTransferCallback): string {
  return `controlled-transfer-${kind}-${transferId}-${createHash("sha256").update(JSON.stringify(callback)).digest("hex")}`;
}
