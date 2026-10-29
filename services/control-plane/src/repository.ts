import { createHash } from "node:crypto";

import type {
  ActionPermit,
  ActionRequest,
  Case,
  EventEnvelope,
  PolicyDecision,
} from "@salven/contracts";

export interface OutboxMessage {
  id: string;
  practiceId: string;
  eventId: string;
  topic: string;
  availableAt: string;
  publishedAt: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
}

export interface PermitConsumeCommand {
  permitId: string;
  practiceId: string;
  actionRequestId: string;
  capability: ActionPermit["capability"];
  subjectId: string | null;
  parameterHash: string;
  stateVersion: number;
  consumedAt: string;
  event: EventEnvelope;
  outbox: OutboxMessage;
}

export type PermitConsumeRejection =
  | "permit_not_found"
  | "tenant_mismatch"
  | "action_request_mismatch"
  | "capability_mismatch"
  | "subject_mismatch"
  | "parameter_mismatch"
  | "stale_state"
  | "permit_revoked"
  | "permit_expired"
  | "permit_replayed";

export type PermitConsumeResult =
  | { kind: "consumed"; permit: ActionPermit }
  | { kind: "rejected"; reason: PermitConsumeRejection };

export interface CaseTransitionCommit {
  practiceId: string;
  caseId: string;
  expectedVersion: number;
  next: Case;
  event: EventEnvelope;
  outbox: OutboxMessage;
}

export type CaseTransitionCommitResult =
  | { kind: "committed"; value: Case }
  | { kind: "rejected"; reason: "case_not_found" | "tenant_mismatch" | "version_conflict" };

/**
 * Implementations must make each mutating method one durable transaction. The
 * state mutation, event log insertion, and outbox insertion may not be split.
 */
export interface ControlPlaneRepository {
  commitPolicyDecision(input: {
    request: ActionRequest;
    decision: PolicyDecision;
    permit: ActionPermit | null;
    event: EventEnvelope;
    outbox: OutboxMessage;
  }): void;
  consumePermit(command: PermitConsumeCommand): PermitConsumeResult;
  findCase(practiceId: string, caseId: string): Case | null;
  transitionCase(command: CaseTransitionCommit): CaseTransitionCommitResult;
}

/**
 * Deterministic test adapter only. Process memory is never production truth;
 * production adapters must enforce these operations in durable storage.
 */
export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  private readonly permits = new Map<string, ActionPermit>();
  private readonly requests = new Map<string, ActionRequest>();
  private readonly cases = new Map<string, Case>();
  private readonly decisions = new Map<string, PolicyDecision>();
  private readonly events = new Map<string, EventEnvelope>();
  private readonly outbox = new Map<string, OutboxMessage>();
  private readonly policyCommits = new Map<string, Parameters<ControlPlaneRepository["commitPolicyDecision"]>[0]>();
  private readonly permitConsumptions = new Map<string, PermitConsumeCommand>();
  private readonly caseTransitionCommits = new Map<string, CaseTransitionCommit>();

  seedPermit(value: ActionPermit): void {
    this.permits.set(value.id, clone(value));
  }

  seedCase(value: Case): void {
    this.cases.set(value.id, clone(value));
  }

  commitPolicyDecision(input: {
    request: ActionRequest;
    decision: PolicyDecision;
    permit: ActionPermit | null;
    event: EventEnvelope;
    outbox: OutboxMessage;
  }): void {
    const prior = this.policyCommits.get(input.request.id);
    if (prior !== undefined) {
      if (sameValue(prior, input)) return;
      throw new Error(`duplicate_action_request:${input.request.id}`);
    }
    this.assertUnique(input.request.id, this.requests, "action_request");
    this.assertUnique(input.decision.id, this.decisions, "decision");
    if (input.permit !== null) {
      this.assertUnique(input.permit.id, this.permits, "permit");
    }
    this.assertEventAndOutbox(input.event, input.outbox);
    if (
      input.decision.practiceId !== input.request.practiceId ||
      input.decision.actionRequestId !== input.request.id ||
      input.event.practiceId !== input.request.practiceId ||
      input.event.callId !== input.request.callId ||
      input.event.caseId !== input.request.caseId ||
      input.event.actionId !== input.request.id
    ) {
      throw new Error("policy_transaction_scope_mismatch");
    }
    if (
      input.permit !== null &&
      (input.permit.practiceId !== input.request.practiceId ||
        input.permit.actionRequestId !== input.request.id ||
        input.permit.policyDecisionId !== input.decision.id)
    ) {
      throw new Error("permit_transaction_scope_mismatch");
    }

    this.requests.set(input.request.id, clone(input.request));
    this.decisions.set(input.decision.id, clone(input.decision));
    if (input.permit !== null) {
      this.permits.set(input.permit.id, clone(input.permit));
    }
    this.events.set(input.event.eventId, clone(input.event));
    this.outbox.set(input.outbox.id, clone(input.outbox));
    this.policyCommits.set(input.request.id, clone(input));
  }

  consumePermit(command: PermitConsumeCommand): PermitConsumeResult {
    const permit = this.permits.get(command.permitId);
    if (permit === undefined) return { kind: "rejected", reason: "permit_not_found" };
    if (permit.practiceId !== command.practiceId) return { kind: "rejected", reason: "tenant_mismatch" };
    if (permit.actionRequestId !== command.actionRequestId) {
      return { kind: "rejected", reason: "action_request_mismatch" };
    }
    if (permit.capability !== command.capability) return { kind: "rejected", reason: "capability_mismatch" };
    if (permit.subjectId !== command.subjectId) return { kind: "rejected", reason: "subject_mismatch" };
    if (permit.parameterHash !== command.parameterHash) return { kind: "rejected", reason: "parameter_mismatch" };
    if (permit.stateVersion !== command.stateVersion) return { kind: "rejected", reason: "stale_state" };
    const actionRequest = this.requests.get(command.actionRequestId);
    if (
      actionRequest === undefined ||
      command.event.callId !== actionRequest.callId ||
      command.event.caseId !== actionRequest.caseId ||
      command.event.actionId !== actionRequest.id
    ) {
      throw new Error("permit_event_scope_mismatch");
    }
    const priorConsumption = this.permitConsumptions.get(command.permitId);
    if (priorConsumption !== undefined) {
      return sameValue(priorConsumption, command)
        ? { kind: "consumed", permit: clone(permit) }
        : { kind: "rejected", reason: "permit_replayed" };
    }
    if (permit.revokedAt !== null) return { kind: "rejected", reason: "permit_revoked" };
    if (new Date(permit.expiresAt) <= new Date(command.consumedAt)) {
      return { kind: "rejected", reason: "permit_expired" };
    }
    if (permit.consumedAt !== null) return { kind: "rejected", reason: "permit_replayed" };
    this.assertEventAndOutbox(command.event, command.outbox);

    const consumed = { ...permit, consumedAt: command.consumedAt };
    this.permits.set(consumed.id, consumed);
    this.events.set(command.event.eventId, clone(command.event));
    this.outbox.set(command.outbox.id, clone(command.outbox));
    this.permitConsumptions.set(command.permitId, clone(command));
    return { kind: "consumed", permit: clone(consumed) };
  }

  findCase(practiceId: string, caseId: string): Case | null {
    const value = this.cases.get(caseId);
    return value === undefined || value.practiceId !== practiceId ? null : clone(value);
  }

  transitionCase(command: CaseTransitionCommit): CaseTransitionCommitResult {
    const prior = this.caseTransitionCommits.get(command.event.eventId);
    if (prior !== undefined) {
      return sameValue(prior, command)
        ? { kind: "committed", value: clone(prior.next) }
        : { kind: "rejected", reason: "version_conflict" };
    }
    const current = this.cases.get(command.caseId);
    if (current === undefined) return { kind: "rejected", reason: "case_not_found" };
    if (current.practiceId !== command.practiceId) return { kind: "rejected", reason: "tenant_mismatch" };
    if (current.version !== command.expectedVersion) {
      return { kind: "rejected", reason: "version_conflict" };
    }
    if (
      command.event.caseId !== command.caseId ||
      command.event.objectVersion !== command.next.version ||
      command.event.metadata.nextStateHash !== hashValue(command.next)
    ) {
      throw new Error("case_event_scope_mismatch");
    }
    this.assertEventAndOutbox(command.event, command.outbox);

    this.cases.set(command.next.id, clone(command.next));
    this.events.set(command.event.eventId, clone(command.event));
    this.outbox.set(command.outbox.id, clone(command.outbox));
    this.caseTransitionCommits.set(command.event.eventId, clone(command));
    return { kind: "committed", value: clone(command.next) };
  }

  listEvents(): readonly EventEnvelope[] {
    return [...this.events.values()].map(clone);
  }

  listActionRequests(): readonly ActionRequest[] {
    return [...this.requests.values()].map(clone);
  }

  listOutbox(): readonly OutboxMessage[] {
    return [...this.outbox.values()].map(clone);
  }

  private assertUnique<T>(id: string, values: ReadonlyMap<string, T>, kind: string): void {
    if (values.has(id)) throw new Error(`duplicate_${kind}:${id}`);
  }

  private assertEventAndOutbox(event: EventEnvelope, outbox: OutboxMessage): void {
    this.assertUnique(event.eventId, this.events, "event");
    this.assertUnique(outbox.id, this.outbox, "outbox");
    if (
      outbox.practiceId !== event.practiceId ||
      outbox.eventId !== event.eventId ||
      outbox.topic !== event.eventType
    ) {
      throw new Error("outbox_event_scope_mismatch");
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
