import { randomUUID } from "node:crypto";
import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";

export type SmsProviderState = "accepted" | "delivered" | "undelivered" | "unknown" | "failed";
export type SmsFailureReason = "sandbox_not_joined";
export type SmsProviderReadResult = SmsProviderState | { state: "failed" | "undelivered"; failureReason: SmsFailureReason };

/** The production adapter belongs to the integrator; this port deliberately has no provider credentials. */
export interface SmsProvider {
  submit(input: { transport: "sms" | "whatsapp"; from: string; to: string; body: string; attemptId: string; signal?: AbortSignal }): Promise<{ providerId: string; accepted: boolean; failureReason?: SmsFailureReason }>;
  read(input: { transport: "sms" | "whatsapp"; providerId: string; signal?: AbortSignal }): Promise<SmsProviderReadResult>;
}

export type SmsProviderEvidence = { attemptId: string; providerId: string; state: SmsProviderState };
export type SmsDispatchResult =
  | { status: "not_found" | "not_claimed" }
  | { status: "submitted" | "provider_rejected" | "outcome_unknown"; attemptId: string; receiptRecorded: boolean; providerEvidence?: SmsProviderEvidence };

/** Durable boundary between the worker's effect gate and the one-shot provider call. */
export type SmsDispatchClaim = { scope: ConversationScope; messageId: string; attemptId: string };

/** No provider effect has started, so the leased worker must retry this durable contention. */
export class SmsDispatchRetryableError extends Error {
  constructor() { super("sms_dispatch_claim_contention"); this.name = "SmsDispatchRetryableError"; }
}

export type SmsDeliveryReceiptDisposition = "recorded" | "duplicate" | "stale_terminal" | "not_recorded";
export type SmsDeliveryReceiptResult = { recorded: boolean; state: SmsProviderState; disposition: SmsDeliveryReceiptDisposition };

export class BoundedSmsDispatcher {
  private readonly evidenceWrites = new Set<Promise<void>>();
  private readonly timedOutAttempts = new Map<string, Promise<void>>();
  private readonly submittedClaims = new Set<string>();
  private evidenceWriteFailed = false;
  private readonly ids: () => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly submitTimeoutMs: number;
  private readonly reconcileDelayMs: number;
  private readonly shutdownGraceMs: number;
  private whatsappNextSendAt = 0;
  private whatsappPacing: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: {
    store: Pick<ConversationStore, "get" | "execute">;
    provider: SmsProvider;
    ids?: () => string;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    submitTimeoutMs?: number;
    reconcileDelayMs?: number;
    shutdownGraceMs?: number;
    lateEvidence?: (input: { scope: ConversationScope; messageId: string; evidence: SmsProviderEvidence }) => Promise<void>;
    unresolvedTimedOutAttempts?: (input: { attemptIds: readonly string[] }) => Promise<void>;
  }) {
    this.ids = dependencies.ids ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? (async (ms) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.submitTimeoutMs = positiveInteger(dependencies.submitTimeoutMs ?? 5_000, "submit_timeout_invalid");
    this.reconcileDelayMs = nonnegativeInteger(dependencies.reconcileDelayMs ?? 0, "reconcile_delay_invalid");
    this.shutdownGraceMs = nonnegativeInteger(dependencies.shutdownGraceMs ?? 1_000, "shutdown_grace_invalid");
  }

  async dispatch(input: { scope: ConversationScope; messageId: string }): Promise<SmsDispatchResult> {
    const existing = await this.dependencies.store.get(input.scope);
    if (existing === null || !existing.messages.some((message) => message.id === input.messageId)) return { status: "not_found" };
    const claim = await this.claim({ ...input, attemptId: this.opaque("attempt") });
    if (claim === null) return { status: "not_claimed" };
    return await this.submitClaim(claim);
  }

  /**
   * Persists the `submitting` fence but performs no network I/O. Repeating the same
   * attempt is safe so a worker can recover between this fence and effect-started.
   */
  async claim(input: SmsDispatchClaim): Promise<SmsDispatchClaim | null> {
    if (!validAttemptId(input.attemptId)) return null;
    // An inbound WhatsApp message can refresh the window between the read and its
    // expiry CAS. A bounded reread prevents that conflict from stranding the queue head.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.dependencies.store.get(input.scope);
      const message = current?.messages.find((value) => value.id === input.messageId);
      if (current === null || message === undefined) return null;
      if (message.state !== "queued" && !(message.state === "submitting" && message.dispatchAttemptId === input.attemptId)) return null;
      if (this.whatsappWindowExpired(current)) {
        if (await this.expireWhatsappWindow(current, input.messageId)) return null;
        continue;
      }
      if (message.state === "submitting" && message.dispatchAttemptId === input.attemptId) return input;
      const dispatchEventId = this.eventId("dispatch", current.revision);
      const claim = await this.dependencies.store.execute({
        scope: scopeOf(current), eventId: dispatchEventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
        actor: { kind: "system", id: "sms-dispatcher" },
        command: { type: "sms.dispatch", messageId: input.messageId, dispatchAttemptId: input.attemptId, expectedSuppressionRevision: current.suppressionRevision },
      });
      const claimedMessage = claim.state.messages.find((value) => value.id === input.messageId);
      if (claim.accepted && claim.eventId === dispatchEventId && claimedMessage?.state === "submitting" && claimedMessage.dispatchAttemptId === input.attemptId) return input;
      if (!claim.accepted && claim.error === "stale_revision" && claimedMessage?.state === "queued") continue;
      return null;
    }
    throw new SmsDispatchRetryableError();
  }

  /**
   * Performs the provider call for an already durable claim. The worker must call this
   * only after it durably marks the same attempt effect-started; this method never claims.
   */
  async submitClaim(input: SmsDispatchClaim, signal?: AbortSignal): Promise<SmsDispatchResult> {
    if (!validAttemptId(input.attemptId)) return { status: "not_claimed" };
    const claimKey = JSON.stringify([input.scope.practiceId, input.scope.instanceId, input.scope.conversationId, input.messageId, input.attemptId]);
    if (this.submittedClaims.has(claimKey)) return { status: "not_claimed" };
    let current = await this.dependencies.store.get(input.scope);
    let claimedMessage = current?.messages.find((value) => value.id === input.messageId);
    if (current === null || claimedMessage === undefined || claimedMessage.state !== "submitting" || claimedMessage.dispatchAttemptId !== input.attemptId) return { status: "not_claimed" };
    if (signal?.aborted) return await this.failStaleClaim(input);
    if (!this.currentClaimCanSubmit(current, claimedMessage)) return await this.failStaleClaim(input);
    const initialWindow = await this.resolveWhatsappWindow(input, current);
    if ("status" in initialWindow) return initialWindow;
    current = initialWindow.current;
    claimedMessage = current.messages.find((value) => value.id === input.messageId);
    if (claimedMessage === undefined || claimedMessage.state !== "submitting" || claimedMessage.dispatchAttemptId !== input.attemptId || !this.currentClaimCanSubmit(current, claimedMessage)) return await this.failStaleClaim(input);
    const releaseWhatsappSlot = current.admission.messageTransport === "whatsapp" ? await this.acquireWhatsappSlot(signal) : undefined;
    if (current.admission.messageTransport === "whatsapp" && releaseWhatsappSlot === undefined) return await this.failStaleClaim(input);
    let providerStarted = false;
    try {
      const beforeSubmit = await this.dependencies.store.get(input.scope);
      const beforeMessage = beforeSubmit?.messages.find((value) => value.id === input.messageId);
      if (beforeSubmit === null || beforeMessage === undefined || beforeMessage.state !== "submitting" || beforeMessage.dispatchAttemptId !== input.attemptId) return { status: "not_claimed" };
      // STOP, ownership changes, and disconnects may occur while WhatsApp pacing waits.
      // Revalidate every durable send authority before the one irreversible provider call.
      if (!this.currentClaimCanSubmit(beforeSubmit, beforeMessage)) return await this.failStaleClaim(input);
      const postPacingWindow = await this.resolveWhatsappWindow(input, beforeSubmit);
      if ("status" in postPacingWindow) return postPacingWindow;
      const dispatchState = postPacingWindow.current;
      const dispatchMessage = dispatchState.messages.find((value) => value.id === input.messageId);
      if (dispatchMessage === undefined || dispatchMessage.state !== "submitting" || dispatchMessage.dispatchAttemptId !== input.attemptId || !this.currentClaimCanSubmit(dispatchState, dispatchMessage)) return await this.failStaleClaim(input);
      // Reads above can yield to another invocation or to worker cancellation.
      // Keep this final duplicate/cancellation fence adjacent to the provider effect.
      if (this.submittedClaims.has(claimKey)) return { status: "not_claimed" };
      if (signal?.aborted) return await this.failStaleClaim(input);
      this.submittedClaims.add(claimKey);
      providerStarted = true;

      let result: { providerId: string; accepted: boolean; failureReason?: SmsFailureReason };
      try {
        result = await this.withProviderTimeout((providerSignal) => this.dependencies.provider.submit({
          transport: dispatchState.admission.messageTransport, from: dispatchState.admission.destination, to: dispatchState.admission.contact, body: dispatchMessage.body, attemptId: input.attemptId,
          signal: signal === undefined ? providerSignal : AbortSignal.any([signal, providerSignal]),
        }), this.submitTimeoutMs, (late) => {
          if (!late.accepted || !validProviderId(late.providerId)) return;
          this.trackEvidence(async () => {
            const receipt = await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "accepted", late.providerId);
            if (!receipt.recorded) {
              if (!this.dependencies.lateEvidence) throw new Error("sms_late_evidence_sink_required");
              await this.dependencies.lateEvidence({ ...input, evidence: { attemptId: input.attemptId, providerId: late.providerId, state: "accepted" } });
            }
          });
        }, (pending) => this.trackTimedOutAttempt(input.attemptId, pending));
      } catch {
        const receiptRecorded = (await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "unknown")).recorded;
        return { status: "outcome_unknown", attemptId: input.attemptId, receiptRecorded };
      }

      if (result.accepted && validProviderId(result.providerId)) {
        const receiptRecorded = (await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "accepted", result.providerId)).recorded;
        return { status: "submitted", attemptId: input.attemptId, receiptRecorded, providerEvidence: { attemptId: input.attemptId, providerId: result.providerId, state: "accepted" } };
      }
      if (result.accepted) {
        const receiptRecorded = (await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "unknown")).recorded;
        return { status: "outcome_unknown", attemptId: input.attemptId, receiptRecorded };
      }
      const receiptRecorded = (await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "failed", undefined, result.failureReason)).recorded;
      return { status: "provider_rejected", attemptId: input.attemptId, receiptRecorded };
    } finally {
      releaseWhatsappSlot?.(providerStarted);
    }
  }

  /** Shutdown waits a bounded grace period for timed-out sends and hands unresolved IDs to the durable owner. */
  async drainEvidence(): Promise<boolean> {
    while (this.evidenceWrites.size > 0) await Promise.all([...this.evidenceWrites]);
    if (this.timedOutAttempts.size > 0) {
      const settled = await Promise.race([
        Promise.all([...this.timedOutAttempts.values()]).then(() => true),
        this.sleep(this.shutdownGraceMs).then(() => false),
      ]);
      if (!settled && this.timedOutAttempts.size > 0) {
        this.evidenceWriteFailed = true;
        await this.dependencies.unresolvedTimedOutAttempts?.({ attemptIds: [...this.timedOutAttempts.keys()] });
      }
    }
    while (this.evidenceWrites.size > 0) await Promise.all([...this.evidenceWrites]);
    return !this.evidenceWriteFailed && this.timedOutAttempts.size === 0;
  }

  private trackTimedOutAttempt(attemptId: string, pending: Promise<unknown>): void {
    const settled = pending.then(() => undefined, () => undefined);
    this.timedOutAttempts.set(attemptId, settled);
    void settled.finally(() => this.timedOutAttempts.delete(attemptId));
  }

  private trackEvidence(write: () => Promise<void>): void {
    const work = write().catch(() => { this.evidenceWriteFailed = true; });
    this.evidenceWrites.add(work);
    void work.finally(() => this.evidenceWrites.delete(work));
  }

  /** Provider callbacks have no request-completion authority and may arrive after a staff takeover. */
  async recordDeliveryReceipt(input: { scope: ConversationScope; messageId: string; providerId: string; state: SmsProviderState; failureReason?: SmsFailureReason }): Promise<SmsDeliveryReceiptResult> {
    if (!validProviderId(input.providerId)) return { recorded: false, state: input.state, disposition: "not_recorded" };
    return await this.tryRecordReceipt(input.scope, input.messageId, input.state, input.providerId, undefined, input.failureReason);
  }

  /** Read only the durable provider identity; no body, number, or timestamp matching is permitted. */
  async reconcile(input: { scope: ConversationScope; messageId: string }): Promise<SmsDeliveryReceiptResult> {
    const startedAt = this.now();
    let observed: SmsProviderState = "unknown";
    for (let readAttempt = 0; readAttempt < 3; readAttempt += 1) {
      if (readAttempt > 0 && this.now() - startedAt >= 30_000) break;
      const current = await this.dependencies.store.get(input.scope);
      const message = current?.messages.find((value) => value.id === input.messageId);
      if (current === null || message === undefined || !validProviderId(message.providerId)) return { recorded: false, state: observed, disposition: "not_recorded" };
      const providerId = message.providerId;
      let failureReason: SmsFailureReason | undefined;
      try {
        const result = await this.withProviderTimeout((signal) => this.dependencies.provider.read({ transport: current.admission.messageTransport, providerId, signal }), Math.min(this.submitTimeoutMs, Math.max(1, 30_000 - (this.now() - startedAt))));
        observed = this.providerState(typeof result === "string" ? result : result.state);
        if (typeof result !== "string") failureReason = result.failureReason;
      } catch {
        observed = "unknown";
      }
      if (observed !== "unknown") {
        return await this.tryRecordReceipt(input.scope, input.messageId, observed, providerId, undefined, failureReason);
      }
      const remaining = 30_000 - (this.now() - startedAt);
      if (readAttempt < 2 && remaining > 0) await this.sleep(Math.min(this.reconcileDelayMs, remaining));
    }
    return { recorded: false, state: "unknown", disposition: "not_recorded" };
  }

  private async recordSubmissionReceipt(scope: ConversationScope, messageId: string, attemptId: string, state: SmsProviderState, providerId?: string, failureReason?: SmsFailureReason): Promise<SmsDeliveryReceiptResult> {
    return this.tryRecordReceipt(scope, messageId, state, providerId, attemptId, failureReason);
  }

  private async tryRecordReceipt(scope: ConversationScope, messageId: string, state: SmsProviderState, providerId?: string, attemptId?: string, failureReason?: SmsFailureReason): Promise<SmsDeliveryReceiptResult> {
    try { return await this.recordReceipt(scope, messageId, state, providerId, attemptId, failureReason); }
    catch { return { recorded: false, state, disposition: "not_recorded" }; }
  }

  /** Re-read before each write so takeover or STOP cannot turn a receipt into a stale authority claim. */
  private async recordReceipt(scope: ConversationScope, messageId: string, state: SmsProviderState, providerId?: string, attemptId?: string, failureReason?: SmsFailureReason): Promise<SmsDeliveryReceiptResult> {
    for (let writeAttempt = 0; writeAttempt < 3; writeAttempt += 1) {
      const current = await this.dependencies.store.get(scope);
      const message = current?.messages.find((value) => value.id === messageId);
      if (current === null || message === undefined) return { recorded: false, state, disposition: "not_recorded" };
      if (attemptId !== undefined && message.dispatchAttemptId !== attemptId) return { recorded: false, state, disposition: "not_recorded" };
      if (providerId !== undefined && message.providerId !== null && message.providerId !== providerId) return { recorded: false, state, disposition: "not_recorded" };
      if (message.state === state && (providerId === undefined || message.providerId === providerId)
        && (failureReason === undefined || message.failureReason === failureReason)) return { recorded: true, state, disposition: "duplicate" };
      if (isTerminal(message.state)) {
        const eventId = this.eventId("receipt", current.revision);
        const receipt = await this.dependencies.store.execute({
          scope: scopeOf(current), eventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
          actor: { kind: "provider", id: "sms-provider" },
          command: { type: "sms.receipt", messageId, state, ...(providerId === undefined ? {} : { providerId }), ...(failureReason === undefined ? {} : { failureReason }) },
        });
        return receipt.accepted
          ? { recorded: true, state, disposition: "duplicate" }
          : { recorded: false, state, disposition: "stale_terminal" };
      }
      const eventId = this.eventId("receipt", current.revision);
      const receipt = await this.dependencies.store.execute({
        scope: scopeOf(current), eventId, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
        actor: { kind: "provider", id: "sms-provider" },
        command: { type: "sms.receipt", messageId, state, ...(providerId === undefined ? {} : { providerId }), ...(failureReason === undefined ? {} : { failureReason }) },
      });
      const recorded = receipt.state.messages.find((value) => value.id === messageId);
      if (receipt.accepted && receipt.eventId === eventId && recorded?.state === state && (providerId === undefined || recorded.providerId === providerId)) return { recorded: true, state, disposition: "recorded" };
    }
    return { recorded: false, state, disposition: "not_recorded" };
  }

  private providerState(value: unknown): SmsProviderState {
    return value === "accepted" || value === "delivered" || value === "undelivered" || value === "failed" ? value : "unknown";
  }
  private whatsappWindowExpired(conversation: Conversation): boolean {
    return conversation.admission.messageTransport === "whatsapp"
      && (conversation.lastInboundAt === null || this.now() - Date.parse(conversation.lastInboundAt) >= 86_400_000);
  }
  private currentClaimCanSubmit(conversation: Conversation, message: Conversation["messages"][number]): boolean {
    return conversation.phase === "active" && !conversation.suppressed
      && message.suppressionRevision === conversation.suppressionRevision
      && message.ownerEpoch === conversation.ownerEpoch && message.sender === conversation.owner
      && (message.sender !== "staff" || message.actor === conversation.staffActor);
  }
  private async failStaleClaim(input: SmsDispatchClaim): Promise<SmsDispatchResult> {
    const receipt = await this.recordSubmissionReceipt(input.scope, input.messageId, input.attemptId, "failed");
    return receipt.recorded
      ? { status: "not_claimed" }
      : { status: "outcome_unknown", attemptId: input.attemptId, receiptRecorded: false };
  }
  private async resolveWhatsappWindow(input: SmsDispatchClaim, initial: Conversation): Promise<{ current: Conversation } | SmsDispatchResult> {
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.whatsappWindowExpired(current)) return { current };
      if (await this.expireWhatsappWindow(current, input.messageId)) {
        return { status: "provider_rejected", attemptId: input.attemptId, receiptRecorded: true };
      }
      const refreshed = await this.dependencies.store.get(input.scope);
      const message = refreshed?.messages.find((value) => value.id === input.messageId);
      if (refreshed === null || message === undefined || message.state !== "submitting" || message.dispatchAttemptId !== input.attemptId) return { status: "not_claimed" };
      current = refreshed;
    }
    // A repeated conflict while still expired must not leave the effect-started head queued.
    return await this.failStaleClaim(input);
  }
  private async expireWhatsappWindow(conversation: Conversation, messageId: string): Promise<boolean> {
    const receipt = await this.dependencies.store.execute({ scope: scopeOf(conversation), eventId: this.eventId("receipt", conversation.revision),
      expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch, actor: { kind: "system", id: "sms-dispatcher" },
      command: { type: "sms.window_expire", messageId, expectedSuppressionRevision: conversation.suppressionRevision } });
    return receipt.accepted;
  }
  private async acquireWhatsappSlot(signal?: AbortSignal): Promise<((submitted: boolean) => void) | undefined> {
    let release!: () => void;
    const held = new Promise<void>((done) => { release = done; });
    const previous = this.whatsappPacing.catch(() => undefined);
    this.whatsappPacing = previous.then(() => held);
    await previous;
    const delay = Math.max(0, this.whatsappNextSendAt - this.now());
    if (delay > 0 && !await this.wait(delay, signal) || signal?.aborted) {
      release();
      return undefined;
    }
    let released = false;
    return (submitted) => {
      if (released) return;
      released = true;
      if (submitted) this.whatsappNextSendAt = this.now() + 3_000;
      release();
    };
  }
  private async wait(delay: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    if (signal === undefined) { await this.sleep(delay); return true; }
    return await Promise.race([this.sleep(delay).then(() => true), new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true }))]);
  }

  private eventId(kind: "dispatch" | "receipt", revision: number): string { return `sms.${kind}:${revision}:${this.opaque("event")}`; }
  private opaque(prefix: string): string {
    const value = this.ids();
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw new Error("sms_dispatch_id_invalid");
    return `${prefix}-${value}`;
  }
  private async withProviderTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = this.submitTimeoutMs, lateResult?: (value: T) => void, onTimeout?: (pending: Promise<T>) => void): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const work = operation(controller.signal).then((value) => { if (timedOut) lateResult?.(value); return value; });
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); onTimeout?.(work); reject(new Error("sms_provider_timeout")); }, timeoutMs); })]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}

function validProviderId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value; }
function validAttemptId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value); }
function isTerminal(state: Conversation["messages"][number]["state"]): boolean { return state === "delivered" || state === "undelivered" || state === "failed"; }
function positiveInteger(value: number, code: string): number { if (!Number.isInteger(value) || value <= 0) throw new Error(code); return value; }
function nonnegativeInteger(value: number, code: string): number { if (!Number.isInteger(value) || value < 0) throw new Error(code); return value; }
