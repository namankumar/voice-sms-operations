import { createHash } from "node:crypto";

import { assertCaseCanResolve, type ActionRequest, type Call, type CallGoal, type Case, type VerificationSession } from "@salven/contracts";
import type { ConsumeIssuedPermitInput, Clock, EventContext, IdSource, PolicyAuthorityResult } from "@salven/control-plane";
import type { PermitConsumeResult } from "@salven/control-plane";
import { hashIntergyParameters, type AppointmentDetailsParameters, type AppointmentReadback, type IntergySuccess } from "@salven/intergy-simulator";

import { DeterministicIdentityService, hashIdentitySubject, type IdentityFactor, type IdentityVerifier } from "./identity.js";
import type {
  ActionMemory, CallTurn, CallWorkflowRepository, HandoffBrief, HandoffMemory, SpokenDirective, WorkflowCommit,
  WorkflowEvidence, WorkflowEvidenceKind, WorkflowEvent, WorkflowOutbox, WorkflowScope, WorkflowSnapshot,
} from "./repository.js";

export interface AppointmentDetailsGateway {
  readAppointment(input: {
    authorization: unknown; idempotencyKey: string; parameters: AppointmentDetailsParameters;
    deadlineAt: string; signal: AbortSignal;
  }): Promise<IntergySuccess<AppointmentReadback>>;
}
export interface ConsumedPermitAuthorizationIssuer {
  issueFromConsumedPermit(input: {
    permit: import("@salven/contracts").ActionPermit; request: ActionRequest; caseId: string;
    validationEvidenceId: string; validatedAt: string; executionExpiresAt: string;
  }): unknown | Promise<unknown>;
}
export interface AppointmentPolicyAuthority {
  evaluateAndIssue(input: Parameters<import("@salven/control-plane").AsyncPolicyAuthorityService["evaluateAndIssue"]>[0]):
    PolicyAuthorityResult | Promise<PolicyAuthorityResult>;
}
export interface AppointmentPermitAuthority {
  consume(input: ConsumeIssuedPermitInput): PermitConsumeResult | Promise<PermitConsumeResult>;
}

export interface ProtectedEvidencePort {
  protect(input: { scope: WorkflowScope; kind: WorkflowEvidenceKind; value: unknown }): Promise<{ protectedEvidenceId: string; immutableHash: string }>;
}
export interface ProtectedDirectiveContentPort {
  store(input: { scope: WorkflowScope; directiveId: string; content: string }): Promise<{ protectedContentRef: string; contentHash: string }>;
  retrieve(input: { scope: WorkflowScope; directiveId: string; protectedContentRef: string }): Promise<string>;
}
export interface SpokenDirectiveAuthority {
  issue(input: { scope: WorkflowScope; actionId: string; readback: AppointmentReadback; now: string }): Promise<SpokenDirective>;
}
export interface ProviderReconciliationPort {
  reconcile(input: {
    scope: WorkflowScope; actionId: string; idempotencyKey: string; subjectHash: string;
    parameterHash: string; protectedRequestEvidenceId: string;
  }): Promise<
    | { kind: "verified"; receipt: unknown; readback: AppointmentReadback }
    | { kind: "pending" }
    | { kind: "unverified"; reason: string }
  >;
}

export interface TelephonyHeardReceipt {
  protectedEvidenceId: string;
  immutableHash: string;
  practiceId: string;
  callId: string;
  goalId: string;
  directiveId: string;
  markId: string;
  heardAt: string;
}
export interface TelephonyHeardReceiptAuthority {
  /** Implementations must atomically authenticate and consume a single-use receipt. */
  verifyAndConsume(candidate: unknown, expected: {
    practiceId: string; callId: string; goalId: string; directiveId: string;
  }): Promise<TelephonyHeardReceipt | null>;
}

export interface AcceptedHandoff {
  handoffId: string; practiceId: string; callId: string; caseId: string; goalId: string;
  ownerId: string; providerReceiptId: string; acceptedAt: string;
}
export interface HandoffAcceptanceAuthority { verify(candidate: unknown): AcceptedHandoff | null; }
export type HandoffRequestReason = "explicit_human_request" | "human_requested" | "clinical" | "repeated_failure"
  | "provider_unavailable" | "policy_required" | "latency_timeout" | "repeated_misunderstanding";

export type AppointmentOutcome =
  | { kind: "directive_pending"; directive: SpokenDirective }
  | { kind: "answered"; directiveId: string }
  | { kind: "handoff_pending"; handoffId: string; reason: string }
  | { kind: "handoff_accepted"; handoffId: string; ownerId: string }
  | { kind: "callback_owned"; handoffId: string; ownerId: string; deadlineAt: string; transferOutcome: "failed" | "no_answer" }
  | { kind: "continue"; reason: "misunderstanding_recorded"; remainingBeforeHandoff: number }
  | { kind: "owned_pending"; actionId: string; state: "pending" | "uncertain" }
  | { kind: "blocked"; reason: string };

export interface AppointmentConfirmationPresentation {
  timeZone?: string;
  locationLabel?: (locationId: string) => string | null;
}

export class DeterministicSpokenDirectiveAuthority implements SpokenDirectiveAuthority {
  constructor(
    private readonly ids: IdSource,
    private readonly content: ProtectedDirectiveContentPort,
    private readonly presentation: AppointmentConfirmationPresentation = {},
  ) {}
  async issue(input: { scope: WorkflowScope; actionId: string; readback: AppointmentReadback; now: string }): Promise<SpokenDirective> {
    const id = this.ids.next("directive");
    const appointment = input.readback.appointment;
    const protectedContent = await this.content.store({ scope: input.scope, directiveId: id,
      content: `Your appointment is scheduled for ${formatSpokenStart(appointment.startsAt, this.presentation.timeZone ?? "UTC")}. It will be at ${this.locationLabel(appointment.locationId)}.` });
    return { id, ...input.scope, actionId: input.actionId, ...protectedContent, state: "pending", heardMarkEvidenceId: null, createdAt: input.now };
  }

  private locationLabel(locationId: string): string {
    const configured = this.presentation.locationLabel?.(locationId)?.trim();
    if (configured !== undefined && configured !== null && configured.length > 0 && configured !== locationId) return configured;
    const descriptor = locationId.split("-").at(-1)?.toLowerCase();
    return descriptor !== undefined && /^(main|north|south|east|west|central)$/.test(descriptor)
      ? `the ${descriptor} location`
      : "the practice location";
  }
}

export class AppointmentDetailsOrchestrator {
  constructor(private readonly dependencies: {
    repository: CallWorkflowRepository; policy: AppointmentPolicyAuthority; permits: AppointmentPermitAuthority;
    authorizationIssuer: ConsumedPermitAuthorizationIssuer; intergy: AppointmentDetailsGateway;
    reconciliation: ProviderReconciliationPort;
    identity: DeterministicIdentityService; identityVerifier: IdentityVerifier;
    evidence: ProtectedEvidencePort; directiveAuthority: SpokenDirectiveAuthority;
    heardReceipts: TelephonyHeardReceiptAuthority; handoffAcceptance: HandoffAcceptanceAuthority;
    clock: Clock; ids: IdSource; providerReadDeadlineMs?: number; misunderstandingThreshold?: number;
  }) {}

  async start(input: { call: Call; case: Case; goal: CallGoal; ownerId: string }): Promise<void> {
    if (input.goal.kind !== "appointment-details" || input.goal.state !== "active") throw new Error("appointment_details_goal_required");
    const scope = this.scopeFrom(input.call, input.case, input.goal);
    const now = this.dependencies.clock.now();
    const verification = this.dependencies.identity.createPending({ practiceId: scope.practiceId, callId: scope.callId,
      capability: "appointment.details.read", expiresAt: new Date(now.getTime() + 5 * 60_000) });
    await this.dependencies.repository.create({ ...input, verification, turns: [], directives: [], actions: [], handoffs: [], evidence: [], events: [], outbox: [] });
  }

  async submitIdentity(input: { scope: WorkflowScope; patientId: string; factors: Readonly<Record<IdentityFactor, string | undefined>> }): Promise<"verified" | "failed" | "human_review" | "stale"> {
    const snapshot = await this.require(input.scope);
    if (snapshot.goal.state !== "active") return "failed";
    const now = this.dependencies.clock.now();
    const result = await this.dependencies.identity.verify({ session: snapshot.verification, patientId: input.patientId,
      factors: input.factors, verifier: this.dependencies.identityVerifier, now, verifiedUntil: new Date(now.getTime() + 5 * 60_000) });
    const identityEvidence = result.results.flatMap((factor) => factor.protectedEvidenceId === null ? [] : [this.evidenceReference(
      input.scope, null, null, "identity_factor", factor.protectedEvidenceId,
      hash({ factor: factor.factor, outcome: factor.outcome, protectedEvidenceId: factor.protectedEvidenceId }),
    )]);
    const session = { ...result.session, identityEvidenceIds: identityEvidence.map((item) => item.id) };
    const turn = this.turn(snapshot, "identity", [result.kind === "human_review" ? result.reason : `identity.${result.kind}`]);
    const next = this.bump(snapshot, { verification: session, evidence: [...snapshot.evidence, ...identityEvidence], turns: [...snapshot.turns, turn] });
    if ((await this.commit(snapshot, next)).kind !== "committed") return "stale";
    if (result.kind === "human_review") {
      await this.requestHandoff(input.scope, result.reason);
      return "human_review";
    }
    return result.kind;
  }

  async resolve(input: { scope: WorkflowScope; patientId: string; appointmentId: string }): Promise<AppointmentOutcome> {
    let snapshot = await this.require(input.scope);
    if (snapshot.goal.state !== "active" || snapshot.goal.kind !== "appointment-details") return { kind: "blocked", reason: "active_appointment_goal_required" };
    const prior = snapshot.actions[0];
    if (prior !== undefined) return this.existingOutcome(snapshot, prior, input.patientId);
    const verification = snapshot.verification;
    if (!this.identityIsCurrent(verification, hashIdentitySubject(input.patientId))) {
      return this.requestHandoff(input.scope, "identity_not_current");
    }

    const parameters = { appointmentId: input.appointmentId };
    const protectedRequest = await this.dependencies.evidence.protect({ scope: input.scope, kind: "action_request", value: { patientId: input.patientId, appointmentId: input.appointmentId } });
    const actionId = this.dependencies.ids.next("action");
    const actionRequestEvidence = this.evidenceReference(input.scope, actionId, null, "action_request", protectedRequest.protectedEvidenceId, protectedRequest.immutableHash);
    const action: ActionMemory = {
      id: actionId, ...input.scope, capability: "appointment.details.read", subjectHash: hashIdentitySubject(input.patientId),
      parameterHash: hashIntergyParameters(parameters), protectedRequestEvidenceId: actionRequestEvidence.id,
      idempotencyKey: this.dependencies.ids.next("idempotency"), state: "pending", receiptEvidenceId: null,
      readbackEvidenceId: null, directiveId: null, createdAt: this.now(), updatedAt: this.now(),
    };
    const actionEvent = this.event(input.scope, "action.persisted", action.id);
    snapshot = this.bump(snapshot, { actions: [action], evidence: [...snapshot.evidence, actionRequestEvidence], events: [...snapshot.events, actionEvent], outbox: [...snapshot.outbox, this.outbox(actionEvent)] });
    const current = await this.require(input.scope);
    if ((await this.commit(current, snapshot)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };

    const request = this.actionRequest(snapshot, action, input.patientId, parameters);
    const transientVerification = this.verificationForPolicy(snapshot, input.patientId);
    const context = this.context(snapshot);
    const policy = await this.dependencies.policy.evaluateAndIssue({ request, verification: transientVerification, eventContext: context });
    if (policy.kind !== "permit") return this.requestHandoff(input.scope, `policy_${policy.kind}`, action.id, "handoff_pending");
    const consumed = await this.dependencies.permits.consume({ permitId: policy.permit.id, request, eventContext: context });
    if (consumed.kind !== "consumed") return this.requestHandoff(input.scope, `permit_${consumed.reason}`, action.id, "handoff_pending");

    try {
      const now = this.dependencies.clock.now();
      const authorization = await this.dependencies.authorizationIssuer.issueFromConsumedPermit({ permit: consumed.permit, request,
        caseId: snapshot.case.id, validationEvidenceId: transientVerification.evidenceIds[0]!, validatedAt: now.toISOString(),
        executionExpiresAt: new Date(now.getTime() + 30_000).toISOString() });
      const provider = await this.readProviderWithDeadline({ authorization, idempotencyKey: action.idempotencyKey, parameters });
      if (!this.readbackMatches(action, provider.readback)) return this.markUncertainAndHandoff(input.scope, action.id, "minimum_necessary_read_mismatch");
      return this.persistVerifiedRead(input.scope, action.id, provider.receipt, provider.readback);
    } catch (error) {
      return this.markUncertainAndHandoff(input.scope, action.id,
        error instanceof ProviderReadDeadlineError ? "intergy_read_deadline_exceeded" : "intergy_read_unverified");
    }
  }

  async requestHumanSupport(scope: WorkflowScope, reason: HandoffRequestReason = "explicit_human_request"): Promise<AppointmentOutcome> {
    return this.requestHandoff(scope, reason);
  }

  async recordMisunderstanding(scope: WorkflowScope): Promise<AppointmentOutcome> {
    const snapshot = await this.require(scope);
    const threshold = Math.max(2, this.dependencies.misunderstandingThreshold ?? 2);
    const priorCount = snapshot.turns.filter((turn) => turn.kind === "misunderstanding").length;
    const next = this.bump(snapshot, { turns: [...snapshot.turns, this.turn(snapshot, "misunderstanding", ["conversation.misunderstanding"])] });
    if ((await this.commit(snapshot, next)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };
    const count = priorCount + 1;
    if (count < threshold) return { kind: "continue", reason: "misunderstanding_recorded", remainingBeforeHandoff: threshold - count };
    return this.requestHandoff(scope, "repeated_misunderstanding");
  }

  async recordTransferFallback(input: {
    scope: WorkflowScope; handoffId: string; outcome: "failed" | "no_answer";
    callbackOwnerId: string; callbackDeadlineAt: string;
  }): Promise<AppointmentOutcome> {
    const snapshot = await this.require(input.scope);
    const handoff = snapshot.handoffs.find((item) => item.id === input.handoffId && item.state === "pending");
    if (handoff === undefined) return { kind: "blocked", reason: "pending_handoff_not_found" };
    if (input.callbackOwnerId.length < 3 || new Date(input.callbackDeadlineAt) <= this.dependencies.clock.now()) return { kind: "blocked", reason: "callback_owner_and_future_deadline_required" };
    const brief: HandoffBrief = { ...handoff.brief, destination: "callback_queue", ownerId: input.callbackOwnerId, deadlineAt: input.callbackDeadlineAt };
    const event = this.event(input.scope, `handoff.transfer.${input.outcome}`, handoff.id);
    const next = this.bump(snapshot, {
      call: { ...snapshot.call, state: "ending", activeGoalId: null },
      goal: { ...snapshot.goal, state: "blocked", blockerCode: `transfer_${input.outcome}`, version: snapshot.goal.version + 1 },
      case: { ...snapshot.case, state: "awaiting_human", ownerId: input.callbackOwnerId, version: snapshot.case.version + 1 },
      handoffs: snapshot.handoffs.map((item) => item.id === handoff.id ? { ...item, state: "callback_owned", ownerId: input.callbackOwnerId, transferOutcome: input.outcome, brief } : item),
      events: [...snapshot.events, event], outbox: [...snapshot.outbox, this.outbox(event)],
      turns: [...snapshot.turns, this.turn(snapshot, "handoff", [`handoff.transfer.${input.outcome}`, "handoff.callback_owned"])],
    });
    if ((await this.commit(snapshot, next)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };
    return { kind: "callback_owned", handoffId: handoff.id, ownerId: input.callbackOwnerId, deadlineAt: input.callbackDeadlineAt, transferOutcome: input.outcome };
  }

  async recoverAction(input: { scope: WorkflowScope; actionId: string }): Promise<AppointmentOutcome> {
    const snapshot = await this.require(input.scope);
    const action = snapshot.actions.find((item) => item.id === input.actionId);
    if (action === undefined || (action.state !== "pending" && action.state !== "uncertain")) return { kind: "blocked", reason: "recoverable_action_not_found" };
    const result = await this.dependencies.reconciliation.reconcile({ scope: input.scope, actionId: action.id,
      idempotencyKey: action.idempotencyKey, subjectHash: action.subjectHash, parameterHash: action.parameterHash,
      protectedRequestEvidenceId: action.protectedRequestEvidenceId });
    if (result.kind === "verified") {
      if (!this.readbackMatches(action, result.readback)) return this.markUncertainAndHandoff(input.scope, action.id, "reconciliation_readback_mismatch");
      return this.persistVerifiedRead(input.scope, action.id, result.receipt, result.readback);
    }
    if (result.kind === "unverified") return this.markUncertainAndHandoff(input.scope, action.id, `reconciliation_${result.reason}`);
    return { kind: "owned_pending", actionId: action.id, state: action.state };
  }

  async acknowledgeTrustedHeardReceipt(input: { scope: WorkflowScope; directiveId: string; receipt: unknown }): Promise<AppointmentOutcome> {
    const snapshot = await this.require(input.scope);
    const directive = snapshot.directives.find((item) => item.id === input.directiveId);
    const action = snapshot.actions.find((item) => item.directiveId === input.directiveId);
    if (directive === undefined || action === undefined || directive.state !== "pending" || action.state !== "directive_pending") return { kind: "blocked", reason: "pending_directive_not_found" };
    const receipt = await this.dependencies.heardReceipts.verifyAndConsume(input.receipt, {
      practiceId: input.scope.practiceId, callId: input.scope.callId, goalId: input.scope.goalId, directiveId: input.directiveId,
    });
    if (receipt === null || !this.heardReceiptMatches(receipt, input.scope, directive.id)) return { kind: "blocked", reason: "trusted_heard_receipt_required" };
    const heard = this.evidenceReference(input.scope, action.id, directive.id, "directive_heard", receipt.protectedEvidenceId, receipt.immutableHash);
    const evidenceIds = [action.receiptEvidenceId, action.readbackEvidenceId, heard.id].filter((id): id is string => id !== null);
    const resolvedCase = { ...snapshot.case, state: "resolved" as const, resolutionEvidenceIds: [...new Set([...snapshot.case.resolutionEvidenceIds, ...evidenceIds])], version: snapshot.case.version + 1 };
    assertCaseCanResolve(resolvedCase);
    const next = this.bump(snapshot, {
      call: { ...snapshot.call, state: "ending", activeGoalId: null }, case: resolvedCase,
      goal: { ...snapshot.goal, state: "achieved", version: snapshot.goal.version + 1 },
      actions: snapshot.actions.map((item) => item.id === action.id ? { ...item, state: "heard", updatedAt: this.now() } : item),
      directives: snapshot.directives.map((item) => item.id === directive.id ? { ...item, state: "heard", heardMarkEvidenceId: heard.id } : item),
      evidence: [...snapshot.evidence, heard], turns: [...snapshot.turns, this.turn(snapshot, "heard_mark", ["directive.heard"])],
    });
    if ((await this.commit(snapshot, next)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };
    return { kind: "answered", directiveId: directive.id };
  }

  async acceptHandoff(input: { scope: WorkflowScope; candidate: unknown }): Promise<AppointmentOutcome> {
    const snapshot = await this.require(input.scope);
    const accepted = this.dependencies.handoffAcceptance.verify(input.candidate);
    const handoff = snapshot.handoffs.find((item) => item.id === accepted?.handoffId);
    if (handoff?.state === "accepted" && accepted !== null && this.acceptanceMatches(accepted, input.scope, handoff.id)) {
      return { kind: "handoff_accepted", handoffId: handoff.id, ownerId: handoff.ownerId! };
    }
    const pending = snapshot.handoffs.find((item) => item.state === "pending");
    if (pending === undefined) return { kind: "blocked", reason: "pending_handoff_not_found" };
    if (accepted === null || !this.acceptanceMatches(accepted, input.scope, pending.id)) return { kind: "handoff_pending", handoffId: pending.id, reason: pending.reason };
    const protectedReceipt = await this.dependencies.evidence.protect({ scope: input.scope, kind: "handoff_acceptance", value: accepted });
    const evidence = this.evidenceReference(input.scope, null, null, "handoff_acceptance", protectedReceipt.protectedEvidenceId, protectedReceipt.immutableHash);
    const next = this.bump(snapshot, { call: { ...snapshot.call, state: "ending", activeGoalId: null },
      goal: { ...snapshot.goal, state: "blocked", blockerCode: pending.reason, version: snapshot.goal.version + 1 },
      case: { ...snapshot.case, state: "awaiting_human", ownerId: accepted.ownerId, version: snapshot.case.version + 1 },
      handoffs: snapshot.handoffs.map((item) => item.id === pending.id ? { ...item, state: "accepted", ownerId: accepted.ownerId,
        acceptanceEvidenceId: evidence.id, brief: { ...item.brief, ownerId: accepted.ownerId } } : item),
      evidence: [...snapshot.evidence, evidence], turns: [...snapshot.turns, this.turn(snapshot, "handoff", ["handoff.accepted"])],
    });
    if ((await this.commit(snapshot, next)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };
    return { kind: "handoff_accepted", handoffId: pending.id, ownerId: accepted.ownerId };
  }

  async endCall(scope: WorkflowScope): Promise<"ended" | "blocked"> {
    const snapshot = await this.require(scope);
    if (snapshot.call.state !== "ending" || snapshot.goal.state === "active") return "blocked";
    const next = this.bump(snapshot, { call: { ...snapshot.call, state: "ended", endedAt: this.now() } });
    return (await this.commit(snapshot, next)).kind === "committed" ? "ended" : "blocked";
  }

  private async persistVerifiedRead(scope: WorkflowScope, actionId: string, receiptValue: unknown, readbackValue: AppointmentReadback): Promise<AppointmentOutcome> {
    const current = await this.require(scope);
    const action = current.actions.find((item) => item.id === actionId);
    if (action === undefined || (action.state !== "pending" && action.state !== "uncertain")) return { kind: "blocked", reason: "recoverable_action_not_found" };
    if (!this.identityIsCurrent(current.verification, action.subjectHash)) return this.requestHandoff(scope, "identity_not_current", action.id, "handoff_pending");
    const [protectedReceipt, protectedReadback] = await Promise.all([
      this.dependencies.evidence.protect({ scope, kind: "provider_receipt", value: receiptValue }),
      this.dependencies.evidence.protect({ scope, kind: "provider_readback", value: readbackValue }),
    ]);
    const receipt = this.evidenceReference(scope, action.id, null, "provider_receipt", protectedReceipt.protectedEvidenceId, protectedReceipt.immutableHash);
    const readback = this.evidenceReference(scope, action.id, null, "provider_readback", protectedReadback.protectedEvidenceId, protectedReadback.immutableHash);
    const directive = await this.dependencies.directiveAuthority.issue({ scope, actionId: action.id, readback: readbackValue, now: this.now() });
    const completedAction: ActionMemory = { ...action, state: "directive_pending", receiptEvidenceId: receipt.id, readbackEvidenceId: readback.id, directiveId: directive.id, updatedAt: this.now() };
    const providerEvent = this.event(scope, "provider.read.verified", action.id);
    const actingCase = current.case.state === "gathering" ? { ...current.case, state: "acting" as const, version: current.case.version + 1 } : current.case;
    const next = this.bump(current, { case: actingCase, actions: [completedAction], directives: [...current.directives, directive],
      evidence: [...current.evidence, receipt, readback], events: [...current.events, providerEvent], outbox: [...current.outbox, this.outbox(providerEvent)] });
    if ((await this.commit(current, next)).kind !== "committed") return { kind: "owned_pending", actionId: action.id, state: "uncertain" };
    return { kind: "directive_pending", directive };
  }

  private async existingOutcome(snapshot: WorkflowSnapshot, action: ActionMemory, patientId: string): Promise<AppointmentOutcome> {
    if (action.state === "pending" || action.state === "uncertain") return { kind: "owned_pending", actionId: action.id, state: action.state };
    if (action.state === "handoff_pending") {
      const handoff = snapshot.handoffs.find((item) => item.state === "pending");
      return handoff === undefined ? { kind: "blocked", reason: "handoff_state_inconsistent" } : { kind: "handoff_pending", handoffId: handoff.id, reason: handoff.reason };
    }
    const directive = snapshot.directives.find((item) => item.id === action.directiveId);
    if (action.state !== "directive_pending" || directive === undefined) return { kind: "blocked", reason: "action_already_completed" };
    if (!this.identityIsCurrent(snapshot.verification, hashIdentitySubject(patientId)) || snapshot.verification.subjectHash !== action.subjectHash) {
      return this.requestHandoff(this.scope(snapshot), "identity_not_current", action.id, "handoff_pending");
    }
    return { kind: "directive_pending", directive };
  }

  private async requestHandoff(scope: WorkflowScope, reason: string, actionId?: string, actionState?: "uncertain" | "handoff_pending"): Promise<AppointmentOutcome> {
    const snapshot = await this.require(scope);
    const prior = snapshot.handoffs.find((item) => item.state === "pending");
    if (prior !== undefined) return { kind: "handoff_pending", handoffId: prior.id, reason: prior.reason };
    const actions = actionId === undefined ? snapshot.actions : snapshot.actions.map((item) => item.id === actionId ? { ...item, state: actionState ?? "handoff_pending", updatedAt: this.now() } : item);
    const handoff: HandoffMemory = { id: this.dependencies.ids.next("handoff"), ...scope, reason, state: "pending", ownerId: null,
      acceptanceEvidenceId: null, transferOutcome: null, brief: this.handoffBrief({ ...snapshot, actions }, reason), createdAt: this.now() };
    const event = this.event(scope, "handoff.requested", handoff.id);
    const next = this.bump(snapshot, { actions, handoffs: [...snapshot.handoffs, handoff], events: [...snapshot.events, event], outbox: [...snapshot.outbox, this.outbox(event)] });
    if ((await this.commit(snapshot, next)).kind !== "committed") return { kind: "blocked", reason: "stale_state" };
    return { kind: "handoff_pending", handoffId: handoff.id, reason };
  }

  private async markUncertainAndHandoff(scope: WorkflowScope, actionId: string, reason: string): Promise<AppointmentOutcome> {
    return this.requestHandoff(scope, reason, actionId, "uncertain");
  }

  private async readProviderWithDeadline(input: {
    authorization: unknown; idempotencyKey: string; parameters: AppointmentDetailsParameters;
  }): Promise<IntergySuccess<AppointmentReadback>> {
    const timeoutMs = Math.max(1, this.dependencies.providerReadDeadlineMs ?? 5_000);
    const controller = new AbortController();
    const deadlineAt = new Date(this.dependencies.clock.now().getTime() + timeoutMs).toISOString();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProviderReadDeadlineError());
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.dependencies.intergy.readAppointment({ ...input, deadlineAt, signal: controller.signal }), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private actionRequest(snapshot: WorkflowSnapshot, action: ActionMemory, patientId: string, parameters: AppointmentDetailsParameters): ActionRequest {
    return { id: action.id, practiceId: action.practiceId, callId: action.callId, caseId: action.caseId, capability: action.capability,
      subjectId: patientId, parameters, parameterHash: action.parameterHash, requestedStateVersion: snapshot.case.version, requestedAt: action.createdAt };
  }
  private verificationForPolicy(snapshot: WorkflowSnapshot, patientId: string): VerificationSession {
    return { id: snapshot.verification.id, practiceId: snapshot.verification.practiceId, callId: snapshot.verification.callId,
      patientId, capability: snapshot.verification.capability, requiredAssurance: snapshot.verification.requiredAssurance,
      state: snapshot.verification.state, attemptCount: snapshot.verification.attemptCount,
      evidenceIds: [...snapshot.verification.identityEvidenceIds], expiresAt: snapshot.verification.expiresAt, version: snapshot.verification.version };
  }
  private identityIsCurrent(verification: WorkflowSnapshot["verification"], subjectHash: string): boolean {
    return verification.state === "verified" && verification.subjectHash === subjectHash && verification.identityEvidenceIds.length > 0 &&
      verification.expiresAt !== null && new Date(verification.expiresAt) > this.dependencies.clock.now();
  }
  private handoffBrief(snapshot: WorkflowSnapshot, reason: string): HandoffBrief {
    const deadline = new Date(snapshot.case.serviceLevelDueAt);
    const current = snapshot.verification.subjectHash !== null && this.identityIsCurrent(snapshot.verification, snapshot.verification.subjectHash);
    const safeKeys = Object.keys(snapshot.goal.collectedFields)
      .filter((key) => snapshot.goal.requiredFields.includes(key) && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))
      .sort();
    return {
      verificationState: snapshot.verification.state,
      verificationFreshness: current && reason !== "identity_not_current" ? "current" : "stale",
      goalKind: snapshot.goal.kind,
      goalState: snapshot.goal.state,
      safeCollectedFactKeys: safeKeys,
      attemptedActions: snapshot.actions.map((action) => ({ actionId: action.id, outcome: action.state })),
      urgency: deadline.getTime() - this.dependencies.clock.now().getTime() <= 30 * 60_000 ? "urgent" : "routine",
      destination: /^(intergy_|reconciliation_|minimum_necessary_)/.test(reason) ? "reconciliation_queue" : "practice_staff",
      ownerId: snapshot.case.ownerId ?? snapshot.ownerId,
      deadlineAt: snapshot.case.serviceLevelDueAt,
    };
  }
  private readbackMatches(action: ActionMemory, readback: AppointmentReadback): boolean {
    return hashIdentitySubject(readback.appointment.patientId) === action.subjectHash &&
      hashIntergyParameters({ appointmentId: readback.appointment.id }) === action.parameterHash;
  }
  private heardReceiptMatches(value: TelephonyHeardReceipt, scope: WorkflowScope, directiveId: string): boolean {
    return value.practiceId === scope.practiceId && value.callId === scope.callId && value.goalId === scope.goalId &&
      value.directiveId === directiveId && value.markId.length >= 3 && value.protectedEvidenceId.length >= 3 && value.immutableHash.startsWith("sha256:");
  }
  private bump(snapshot: WorkflowSnapshot, changes: Partial<WorkflowSnapshot>): WorkflowSnapshot { const call = changes.call ?? snapshot.call; return { ...snapshot, ...changes, call: { ...call, version: snapshot.call.version + 1 } }; }
  private async commit(before: WorkflowSnapshot, next: WorkflowSnapshot) { const command: WorkflowCommit = { scope: this.scope(before), expectedCallVersion: before.call.version, expectedOwnerId: before.ownerId, next }; return this.dependencies.repository.commit(command); }
  private async require(scope: WorkflowScope): Promise<WorkflowSnapshot> { const value = await this.dependencies.repository.load(scope); if (value === null) throw new Error("call_not_found"); return value; }
  private scope(value: WorkflowSnapshot): WorkflowScope { return { practiceId: value.call.practiceId, callId: value.call.id, caseId: value.case.id, goalId: value.goal.id }; }
  private scopeFrom(call: Call, caseValue: Case, goal: CallGoal): WorkflowScope { const scope = { practiceId: call.practiceId, callId: call.id, caseId: caseValue.id, goalId: goal.id };
    if (caseValue.practiceId !== scope.practiceId || goal.practiceId !== scope.practiceId || goal.callId !== scope.callId || goal.caseId !== scope.caseId || call.caseId !== scope.caseId || call.activeGoalId !== scope.goalId) throw new Error("workflow_scope_mismatch"); return scope; }
  private context(snapshot: WorkflowSnapshot): EventContext { return { traceId: snapshot.call.traceId, callId: snapshot.call.id, caseId: snapshot.case.id, actorType: "system", actorId: null }; }
  private turn(snapshot: WorkflowSnapshot, kind: CallTurn["kind"], factKeys: readonly string[]): CallTurn { return { id: this.dependencies.ids.next("turn"), ...this.scope(snapshot), sequence: snapshot.turns.length + 1, actor: "system", kind, factKeys, createdAt: this.now() }; }
  private evidenceReference(scope: WorkflowScope, actionId: string | null, directiveId: string | null, kind: WorkflowEvidenceKind, protectedEvidenceId: string, immutableHash: string): WorkflowEvidence {
    return { id: this.dependencies.ids.next("evidence"), ...scope, actionId, directiveId, kind, immutableHash, protectedEvidenceId, createdAt: this.now() };
  }
  private event(scope: WorkflowScope, type: string, objectId: string): WorkflowEvent { return { id: this.dependencies.ids.next("event"), ...scope, type, objectId, createdAt: this.now() }; }
  private outbox(event: WorkflowEvent): WorkflowOutbox { return { id: this.dependencies.ids.next("outbox"), practiceId: event.practiceId, callId: event.callId, eventId: event.id, topic: event.type, state: "pending", createdAt: event.createdAt }; }
  private acceptanceMatches(value: AcceptedHandoff, scope: WorkflowScope, handoffId: string): boolean { return value.handoffId === handoffId && value.practiceId === scope.practiceId && value.callId === scope.callId && value.caseId === scope.caseId && value.goalId === scope.goalId && value.ownerId.length >= 3 && value.providerReceiptId.length >= 3; }
  private now(): string { return this.dependencies.clock.now().toISOString(); }
}

class ProviderReadDeadlineError extends Error {
  constructor() { super("provider_read_deadline_exceeded"); }
}

function formatSpokenStart(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    hour12: true, timeZoneName: "short",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("weekday")}, ${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
}

function hash(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
