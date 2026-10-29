import { createHash } from "node:crypto";
import { scopeOf, type Conversation, type ConversationScope, type RecoveryFailureDomain } from "./conversation-contract.js";
import type { ConversationStore, TransitionReceipt } from "./conversation-store.js";

export type RecoveryTarget = "relay" | "scripted";
export const RECEPTIONIST_RECOVERY_MAX_AGE_MS = 5 * 60_000;
const RECOVERY_CLAIM_MAX_ATTEMPTS = 3;
type RecoveryTrigger = { scope: ConversationScope; callId: string; voiceEpoch: number; ownerEpoch?: number; failureDomain?: RecoveryFailureDomain };
type RecoveryCallback = { scope: ConversationScope; recoveryId: string; parentCallId: string; target: RecoveryTarget };

export type ParentCallPort = {
  read(input: { parentCallId: string }): Promise<{ state: "active" | "disconnected" | "unknown" }>;
  redirect(input: { parentCallId: string; recoveryId: string; target: RecoveryTarget; callbackPath: string }): Promise<{ state: "redirected" | "parent_gone" | "unknown" }>;
};

export type RecoveryOutcome =
  | { kind: "claimed_for_action"; recoveryId: string; callbackPath: string }
  | { kind: "redirected"; recoveryId: string; callbackPath: string }
  | { kind: "prepared"; recoveryId: string; parentCallId: string; childCorrelationId: string; target: RecoveryTarget; createdAt: string; expiresAt: string }
  | { kind: "attached"; recoveryId: string; attachmentId: string; target: RecoveryTarget }
  | { kind: "outcome_unknown"; recoveryId: string }
  | { kind: "parent_gone"; recoveryId?: string }
  | { kind: "ignored" };

/**
 * Server-owned recovery controller. `callId` is the authenticated OpenAI-sideband
 * correlation until a carrier child identifier is independently observed; it is never
 * represented as a known carrier call identifier.
 */
export class ReceptionistRecoveryController {
  private readonly ids: () => string;
  private readonly now: () => string;

  constructor(private readonly options: {
    store: Pick<ConversationStore, "get" | "execute" | "getEvent">;
    parent: ParentCallPort;
    ids?: () => string;
    now?: () => string;
  }) {
    this.ids = options.ids ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Parent Dial action already retained the caller; persist its winner but do not redirect again. */
  async recoverFromAction(input: RecoveryTrigger): Promise<RecoveryOutcome> {
    const claimed = await this.claim(input, "action");
    if (claimed === null) return { kind: "ignored" };
    if (claimed.state === "parent_gone") return { kind: "parent_gone", recoveryId: claimed.id };
    if (claimed.state === "outcome_unknown") return { kind: "outcome_unknown", recoveryId: claimed.id };
    if (claimed.state === "attached") return this.attached(claimed);
    if (this.expired(claimed)) return await this.markUnknown(input.scope, claimed);
    if (!await this.claimedByAction(input.scope, claimed)) return { kind: "outcome_unknown", recoveryId: claimed.id };
    return { kind: "claimed_for_action", recoveryId: claimed.id, callbackPath: callbackPath(claimed) };
  }

  /** Watchdog path. It redirects only after the durable winner has been claimed. */
  async recover(input: RecoveryTrigger): Promise<RecoveryOutcome> {
    const claimed = await this.claim(input, "watchdog");
    if (claimed === null) return { kind: "ignored" };
    if (claimed.state === "parent_gone") return { kind: "parent_gone", recoveryId: claimed.id };
    if (claimed.state === "outcome_unknown") return { kind: "outcome_unknown", recoveryId: claimed.id };
    if (claimed.state === "attached") return this.attached(claimed);
    if (this.expired(claimed)) return await this.markUnknown(input.scope, claimed);
    if (claimed.state === "claimed" && await this.claimedByAction(input.scope, claimed)) {
      return { kind: "claimed_for_action", recoveryId: claimed.id, callbackPath: callbackPath(claimed) };
    }
    if (claimed.state === "redirecting") return { kind: "outcome_unknown", recoveryId: claimed.id };

    let parent: Awaited<ReturnType<ParentCallPort["read"]>>;
    try {
      parent = await this.options.parent.read({ parentCallId: claimed.parentCallId });
    } catch {
      return await this.markUnknown(input.scope, claimed);
    }
    if (parent.state === "disconnected") {
      await this.disconnect(input.scope, claimed);
      return { kind: "parent_gone", recoveryId: claimed.id };
    }
    if (parent.state !== "active") return await this.markUnknown(input.scope, claimed);
    if (!await this.claimRedirect(input.scope, claimed, input.ownerEpoch)) return await this.unknownOrCurrent(input.scope, claimed);
    let redirected: Awaited<ReturnType<ParentCallPort["redirect"]>>;
    try {
      redirected = await this.options.parent.redirect({ parentCallId: claimed.parentCallId, recoveryId: claimed.id,
        target: claimed.target, callbackPath: callbackPath(claimed) });
    } catch {
      return await this.markUnknown(input.scope, claimed);
    }
    if (redirected.state === "redirected") return { kind: "redirected", recoveryId: claimed.id, callbackPath: callbackPath(claimed) };
    if (redirected.state === "parent_gone") {
      await this.disconnect(input.scope, claimed);
      return { kind: "parent_gone", recoveryId: claimed.id };
    }
    return await this.markUnknown(input.scope, claimed);
  }

  /** A signed Connect continuation can say goodbye only from the exact durable caller-end command. */
  async relayCompletion(input: { scope: ConversationScope; recoveryId: string; parentCallId: string }): Promise<{ childCorrelationId: string; voiceEpoch: number; callerEnded: boolean } | null> {
    const state = await this.options.store.get(input.scope);
    const recovery = state?.recoveries.find((item) => item.id === input.recoveryId);
    if (state === null || recovery?.target !== "relay" || recovery.failureDomain !== "callback_intake" || recovery.parentCallId !== input.parentCallId) return null;
    const end = recovery.callerEndSourceId === undefined ? null : await this.options.store.getEvent(input.scope, recovery.callerEndEventId ?? relayCallerEndEventId(recovery.id));
    const callerEnded = state.phase === "active" && state.owner === "ai" && !state.suppressed && state.providerTier === "relay"
      && recovery.state === "attached" && state.voiceEpoch === recovery.fromEpoch + 1
      && recovery.callerEndSourceId === state.inputs.at(-1)?.id && end?.receipt.accepted === true
      && end.input.command.type === "voice.relay_end" && end.input.command.recoveryId === recovery.id
      && end.input.command.sourceEventId === recovery.callerEndSourceId
      && end.receipt.state.ownerEpoch === state.ownerEpoch && end.receipt.state.voiceEpoch === state.voiceEpoch;
    return { childCorrelationId: recovery.childCallId, voiceEpoch: recovery.fromEpoch + 1, callerEnded };
  }

  /** Exact opaque callback binding. Rendering this recovery is not attachment evidence. */
  async prepareRecovery(input: RecoveryCallback): Promise<RecoveryOutcome> {
    if (!validId(input.recoveryId) || !validId(input.parentCallId)) return { kind: "ignored" };
    const state = await this.options.store.get(input.scope);
    const recovery = state?.recoveries.find((item) => item.id === input.recoveryId);
    if (state === null || recovery === undefined || recovery.parentCallId !== input.parentCallId || recovery.target !== input.target || state.phase !== "active") return { kind: "ignored" };
    if (recovery.state === "attached") return this.attached(recovery);
    if (recovery.state === "parent_gone") return { kind: "parent_gone", recoveryId: recovery.id };
    if (recovery.state === "outcome_unknown") return { kind: "outcome_unknown", recoveryId: recovery.id };
    if (this.expired(recovery)) return await this.markUnknown(input.scope, recovery);
    if (recovery.state === "claimed" && !await this.transition(input.scope, recovery, "redirecting")) return await this.unknownOrCurrent(input.scope, recovery);

    const current = await this.options.store.get(input.scope);
    const active = current?.recoveries.find((item) => item.id === input.recoveryId);
    if (current === null || active === undefined || active.state !== "redirecting") return await this.unknownOrCurrent(input.scope, recovery);
    return { kind: "prepared", recoveryId: active.id, parentCallId: active.parentCallId, childCorrelationId: active.childCallId,
      target: active.target, createdAt: active.createdAt, expiresAt: this.expiresAt(active) };
  }

  /** Only an authenticated Relay setup or Gather submission can establish the new attachment. */
  async recordAttachmentEvidence(input: RecoveryCallback & { target: RecoveryTarget; attachmentId: string; signal?: AbortSignal }): Promise<RecoveryOutcome> {
    if (input.signal?.aborted || !validId(input.recoveryId) || !validId(input.parentCallId) || !validId(input.attachmentId)) return { kind: "ignored" };
    const state = await this.options.store.get(input.scope);
    const recovery = state?.recoveries.find((item) => item.id === input.recoveryId);
    if (input.signal?.aborted || state === null || recovery === undefined || state.phase !== "active" || recovery.parentCallId !== input.parentCallId || recovery.target !== input.target) return { kind: "ignored" };
    if (state.owner !== "ai" || state.suppressed || state.voiceEpoch !== recovery.fromEpoch + 1) return { kind: "ignored" };
    const trigger = await this.options.store.getEvent(input.scope, recovery.triggerEventId);
    if (input.signal?.aborted || trigger?.receipt.accepted !== true || trigger.receipt.state.ownerEpoch !== state.ownerEpoch) return { kind: "ignored" };
    if (recovery.state === "attached") return this.attached(recovery);
    if (recovery.state === "parent_gone") return { kind: "parent_gone", recoveryId: recovery.id };
    if (this.expired(recovery)) return await this.markUnknown(input.scope, recovery);
    if (recovery.state !== "redirecting" && recovery.state !== "outcome_unknown") return await this.unknownOrCurrent(input.scope, recovery);
    if (!await this.transition(input.scope, recovery, "attached", input.attachmentId, input.signal)) return await this.unknownOrCurrent(input.scope, recovery);
    return await this.attachedCurrent(input.scope, recovery);
  }

  /** A candidate media attachment is one-use; another authenticated connection cannot replay it. */
  async recordMediaAttachmentEvidence(input: RecoveryCallback & { attachmentId: string; signal?: AbortSignal }): Promise<RecoveryOutcome> {
    if (!validId(input.attachmentId) || input.signal?.aborted) return { kind: "ignored" };
    let initial: Conversation | null = null;
    const boundary = (state: Conversation) => JSON.stringify({ owner: state.owner, ownerEpoch: state.ownerEpoch, voiceEpoch: state.voiceEpoch,
      phase: state.phase, suppressed: state.suppressed, recovery: state.recoveries.find(item => item.id === input.recoveryId) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.options.store.get(input.scope);
      const recovery = state?.recoveries.find(item => item.id === input.recoveryId);
      if (input.signal?.aborted || state === null || state.phase !== "active" || state.owner !== "ai" || state.suppressed
        || recovery?.target !== "relay" || recovery.failureDomain !== "callback_intake" || recovery.parentCallId !== input.parentCallId
        || !["redirecting", "outcome_unknown"].includes(recovery.state) || state.voiceEpoch !== recovery.fromEpoch + 1) return { kind: "ignored" };
      if (initial !== null && boundary(state) !== boundary(initial)) return { kind: "ignored" };
      initial ??= state;
      const trigger = await this.options.store.getEvent(input.scope, recovery.triggerEventId);
      if (input.signal?.aborted || trigger?.receipt.accepted !== true || trigger.receipt.state.ownerEpoch !== state.ownerEpoch) return { kind: "ignored" };
      const receipt = await this.options.store.execute({ scope: input.scope, eventId: `media-attachment-${digest([input.recoveryId, input.attachmentId])}-r${state.revision}`,
        expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "system", id: "receptionist-media-admission" },
        command: { type: "voice.recovery_state", recoveryId: recovery.id, state: "attached", attachmentId: input.attachmentId } });
      if (receipt.accepted) return { kind: "attached", target: "relay", recoveryId: recovery.id, attachmentId: input.attachmentId };
      if (receipt.error !== "stale_revision") return { kind: "ignored" };
    }
    return { kind: "ignored" };
  }

  /**
   * A closed relay cannot undo an attachment that may already have committed.
   * Preserve that evidence, then use the ordinary next-epoch recovery fence.
   */
  async reconcileRelayClosed(input: { scope: ConversationScope; recoveryId: string; connectionId: string }): Promise<RecoveryOutcome> {
    if (!validId(input.recoveryId) || !validId(input.connectionId)) return { kind: "ignored" };
    const state = await this.options.store.get(input.scope);
    const recovery = state?.recoveries.find((item) => item.id === input.recoveryId);
    if (state === null || state.phase !== "active" || state.providerTier !== "relay" || recovery?.target !== "relay"
      || recovery.state !== "attached" || state.voiceEpoch !== recovery.fromEpoch + 1) return { kind: "ignored" };
    const eventId = `relay-close-${digest([input.recoveryId, input.connectionId])}`;
    const evidence = await this.options.store.execute({ scope: scopeOf(state), eventId, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
      actor: { kind: "system", id: "receptionist-relay" }, command: { type: "voice.late_evidence", recoveryId: recovery.id,
        providerEventId: input.connectionId, observedState: "disconnected" } });
    if (!evidence.accepted) return { kind: "outcome_unknown", recoveryId: recovery.id };
    return await this.recover({ scope: input.scope, callId: input.connectionId, voiceEpoch: evidence.state.voiceEpoch, failureDomain: "relay_transport" });
  }

  private async claim(input: RecoveryTrigger, trigger: "action" | "watchdog"): Promise<Conversation["recoveries"][number] | null> {
    if (!validId(input.callId) || !Number.isSafeInteger(input.voiceEpoch) || input.voiceEpoch < 0) return null;
    const initial = await this.options.store.get(input.scope);
    if (initial === null || initial.admission.channel !== "voice" || initial.phase !== "active" || initial.owner !== "ai"
      || initial.providerTier === "scripted") return null;
    const initialWinner = await this.exactChildWinner(input.scope, initial, input);
    if (initialWinner !== null) return initialWinner;
    if (initial.voiceEpoch !== input.voiceEpoch || input.ownerEpoch !== undefined && initial.ownerEpoch !== input.ownerEpoch) return null;
    // Always capture the pre-claim owner epoch. An omitted input epoch must not
    // allow a staff-to-AI ownership roundtrip to reuse this recovery authority.
    const initialOwnerEpoch = initial.ownerEpoch;
    for (let attempt = 0; attempt < RECOVERY_CLAIM_MAX_ATTEMPTS; attempt += 1) {
      const state = attempt === 0 ? initial : await this.options.store.get(input.scope);
      if (state === null || state.admission.channel !== "voice" || state.phase !== "active" || state.owner !== "ai"
        || state.providerTier === "scripted") return null;
      const existing = await this.exactChildWinner(input.scope, state, { ...input, ownerEpoch: initialOwnerEpoch });
      if (existing !== null) return existing;
      if (state.ownerEpoch !== initialOwnerEpoch || state.voiceEpoch !== input.voiceEpoch) return null;
      const recoveryId = `recovery-${this.opaqueId()}`;
      // Rejected receipts are cached by event id, so every optimistic retry needs
      // a distinct id rather than replaying a stale rejection.
      const eventId = `voice-recover-${recoveryId}`;
      const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
        actor: { kind: "system", id: `receptionist-recovery-${trigger}` }, command: { type: "voice.recover", recoveryId, fromEpoch: input.voiceEpoch,
          parentCallId: state.admission.externalId, childCallId: input.callId,
          ...(input.failureDomain === undefined ? {} : { failureDomain: input.failureDomain }) } });
      if (receipt.accepted) return receipt.state.recoveries.find((item) => item.id === recoveryId) ?? null;
      const afterRace = await this.options.store.get(input.scope);
      if (afterRace === null || afterRace.admission.channel !== "voice" || afterRace.phase !== "active" || afterRace.owner !== "ai"
        || afterRace.providerTier === "scripted") return null;
      const winner = await this.exactChildWinner(input.scope, afterRace, { ...input, ownerEpoch: initialOwnerEpoch });
      if (winner !== null) return winner;
      if (afterRace.ownerEpoch !== initialOwnerEpoch) return null;
    }
    return null;
  }

  private async exactChildWinner(scope: ConversationScope, state: Conversation, input: RecoveryTrigger): Promise<Conversation["recoveries"][number] | null> {
    const winner = state.recoveries.find((item) => item.fromEpoch === input.voiceEpoch);
    if (winner === undefined || winner.childCallId !== input.callId || state.voiceEpoch !== input.voiceEpoch + 1) return null;
    const trigger = await this.options.store.getEvent(scope, winner.triggerEventId);
    if (trigger?.receipt.accepted !== true || trigger.receipt.state.ownerEpoch !== state.ownerEpoch) return null;
    return input.ownerEpoch === undefined || state.ownerEpoch === input.ownerEpoch + 1 ? winner : null;
  }

  private async claimedByAction(scope: ConversationScope, recovery: Conversation["recoveries"][number]): Promise<boolean> {
    const event = await this.options.store.getEvent(scope, recovery.triggerEventId);
    return event?.input.actor.id === "receptionist-recovery-action";
  }

  /** Only the invocation that durably creates redirecting may perform the provider redirect. */
  private async claimRedirect(scope: ConversationScope, recovery: Conversation["recoveries"][number], ownerEpoch?: number): Promise<boolean> {
    const current = await this.options.store.get(scope);
    // Claiming recovery advances the owner epoch once. Compare against that
    // post-claim epoch, not the pre-claim epoch supplied by the voice session.
    if (current === null || current.phase !== "active" || current.owner !== "ai"
      || (ownerEpoch !== undefined && current.ownerEpoch !== ownerEpoch + 1)) return false;
    const active = current.recoveries.find((item) => item.id === recovery.id);
    if (active?.state !== "claimed") return false;
    // A shared event id would replay one accepted transition to concurrent
    // callers, letting each believe it owns the provider redirect.
    const eventId = `voice-recovery-state-${recovery.id}-redirecting-${this.opaqueId()}`;
    const receipt = await this.options.store.execute({ scope: scopeOf(current), eventId, expectedRevision: current.revision,
      expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "system", id: "receptionist-recovery" },
      command: { type: "voice.recovery_state", recoveryId: recovery.id, state: "redirecting" } });
    return receipt.accepted && receipt.eventId === eventId && receipt.state.revision === current.revision + 1
      && receipt.state.recoveries.some((item) => item.id === recovery.id && item.state === "redirecting");
  }

  private async transition(scope: ConversationScope, recovery: Conversation["recoveries"][number], state: "redirecting" | "attached" | "outcome_unknown", attachmentId?: string, signal?: AbortSignal): Promise<boolean> {
    const current = await this.options.store.get(scope);
    if (signal?.aborted || current === null || current.phase !== "active") return false;
    const active = current.recoveries.find((item) => item.id === recovery.id);
    if (active === undefined || active.state === "parent_gone" || active.state === "attached") return active?.state === state;
    const eventId = `voice-recovery-state-${recovery.id}-${state}`;
    const prior = await this.options.store.getEvent(scope, eventId);
    if (signal?.aborted) return false;
    if (prior !== null) return prior.receipt.accepted;
    const receipt = await this.options.store.execute({ scope: scopeOf(current), eventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
      actor: { kind: "system", id: "receptionist-recovery" }, command: { type: "voice.recovery_state", recoveryId: recovery.id, state,
        ...(attachmentId === undefined ? {} : { attachmentId }) } });
    return receipt.accepted;
  }

  private async disconnect(scope: ConversationScope, recovery: Conversation["recoveries"][number]): Promise<void> {
    const state = await this.findState(scope);
    if (state === null || state.phase !== "active") return;
    await this.options.store.execute({ scope: scopeOf(state), eventId: `voice-parent-gone-${recovery.id}`, expectedRevision: state.revision,
      expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "provider", id: "parent-call" }, command: { type: "conversation.disconnect" } });
  }

  private async unknownOrCurrent(scope: ConversationScope, recovery: Conversation["recoveries"][number]): Promise<RecoveryOutcome> {
    const state = await this.findState(scope);
    const current = state?.recoveries.find((item) => item.id === recovery.id);
    if (current?.state === "attached") return this.attached(current);
    if (current?.state === "parent_gone" || state?.phase === "disconnected") return { kind: "parent_gone", recoveryId: recovery.id };
    return { kind: "outcome_unknown", recoveryId: recovery.id };
  }

  /** A transport exception is evidence we cannot safely replay the provider operation. */
  private async markUnknown(scope: ConversationScope, recovery: Conversation["recoveries"][number]): Promise<RecoveryOutcome> {
    const current = await this.findState(scope);
    const active = current?.recoveries.find((item) => item.id === recovery.id);
    if (active?.state === "claimed") await this.transition(scope, active, "redirecting");
    await this.transition(scope, recovery, "outcome_unknown");
    return await this.unknownOrCurrent(scope, recovery);
  }

  private async attachedCurrent(scope: ConversationScope, recovery: Conversation["recoveries"][number]): Promise<RecoveryOutcome> {
    const state = await this.findState(scope);
    const current = state?.recoveries.find((item) => item.id === recovery.id);
    return current === undefined ? { kind: "outcome_unknown", recoveryId: recovery.id } : this.attached(current);
  }

  private async findState(scope: ConversationScope): Promise<Conversation | null> {
    return await this.options.store.get(scope);
  }

  private attached(recovery: Conversation["recoveries"][number]): RecoveryOutcome {
    return recovery.attachmentId === null ? { kind: "outcome_unknown", recoveryId: recovery.id }
      : { kind: "attached", recoveryId: recovery.id, attachmentId: recovery.attachmentId, target: recovery.target };
  }

  private expiresAt(recovery: Conversation["recoveries"][number]): string {
    return new Date(Date.parse(recovery.createdAt) + RECEPTIONIST_RECOVERY_MAX_AGE_MS).toISOString();
  }

  private expired(recovery: Conversation["recoveries"][number]): boolean {
    const createdAt = Date.parse(recovery.createdAt), now = Date.parse(this.now());
    return !Number.isFinite(createdAt) || !Number.isFinite(now) || now < createdAt || now >= createdAt + RECEPTIONIST_RECOVERY_MAX_AGE_MS;
  }

  private opaqueId(): string {
    const value = this.ids();
    if (!validId(value)) throw new Error("recovery_id_invalid");
    return value;
  }
}

function callbackPath(recovery: Conversation["recoveries"][number]): string { return `/voice/recovery/${recovery.target}/${recovery.id}/serve`; }
function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48); }


export function relayCallerEndEventId(recoveryId: string): string { return `relay-caller-end-${digest([recoveryId])}`; }
