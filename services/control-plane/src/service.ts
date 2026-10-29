import { createHash, randomUUID } from "node:crypto";

import {
  actionPermitSchema,
  actionRequestSchema,
  assertCaseCanResolve,
  assertTransition,
  caseSchema,
  caseTransitions,
  eventEnvelopeSchema,
  policyDecisionSchema,
  type ActionPermit,
  type ActionRequest,
  type Case,
  type EventEnvelope,
  type PolicyDecision,
} from "@salven/contracts";

import { redactMetadata } from "./metadata.js";
import { CurrentStatePolicyEngine, type CurrentStatePolicyInput } from "./policy.js";
import type { AsyncControlPlaneRepository } from "./postgres/pooled.js";
import {
  type ControlPlaneRepository,
  type OutboxMessage,
  type PermitConsumeResult,
} from "./repository.js";

export interface Clock {
  now(): Date;
}

export interface IdSource {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => new Date() };
export const uuidIdSource: IdSource = { next: (prefix) => `${prefix}-${randomUUID()}` };

export interface EventContext {
  traceId: string;
  callId: string | null;
  caseId: string | null;
  actorType: EventEnvelope["actorType"];
  actorId: string | null;
}

export interface PolicyAuthorityDependencies {
  repository: ControlPlaneRepository;
  policy: CurrentStatePolicyEngine;
  clock?: Clock;
  ids?: IdSource;
  permitTtlMs?: number;
  rulesetVersion?: string;
}

export type PolicyAuthorityResult =
  | { kind: "permit"; decision: PolicyDecision; permit: ActionPermit }
  | { kind: "deny"; decision: PolicyDecision }
  | { kind: "human_review"; decision: PolicyDecision };

export class PolicyAuthorityService {
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly permitTtlMs: number;
  private readonly rulesetVersion: string;

  constructor(private readonly dependencies: PolicyAuthorityDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidIdSource;
    this.permitTtlMs = dependencies.permitTtlMs ?? 5 * 60_000;
    this.rulesetVersion = dependencies.rulesetVersion ?? "s1-current-state-v1";
  }

  evaluateAndIssue(
    input: Omit<CurrentStatePolicyInput, "currentStateVersion" | "now"> & { eventContext: EventContext },
  ): PolicyAuthorityResult {
    const request = actionRequestSchema.parse(input.request);
    assertEventContextMatchesRequest(input.eventContext, request);
    const now = this.clock.now();
    const currentCase = this.dependencies.repository.findCase(request.practiceId, request.caseId);
    const result = currentCase === null
      ? {
          disposition: "deny" as const,
          requiredVerification: "strong" as const,
          reasonCodes: ["current_state_missing"],
          obligations: [],
        }
      : currentCase.practiceId !== request.practiceId
        ? {
            disposition: "deny" as const,
            requiredVerification: "strong" as const,
            reasonCodes: ["current_state_tenant_mismatch"],
            obligations: [],
          }
        : this.dependencies.policy.evaluate({
            request,
            currentStateVersion: currentCase.version,
            verification: input.verification,
            now,
          });
    const decision = policyDecisionSchema.parse({
      id: this.ids.next("decision"),
      practiceId: request.practiceId,
      actionRequestId: request.id,
      decision: result.disposition,
      rulesetVersion: this.rulesetVersion,
      reasonCodes: result.reasonCodes,
      obligations: result.obligations,
      factsHash: hashValue({
        capability: request.capability,
        requiredVerification: result.requiredVerification,
        requestStateVersion: request.requestedStateVersion,
        currentStateVersion: currentCase?.version ?? null,
        verificationState: input.verification?.state ?? "missing",
      }),
      decidedAt: now.toISOString(),
    });
    const permit = result.disposition === "permit" ? this.makePermit(request, decision, now) : null;
    const event = makeEvent({
      ids: this.ids,
      occurredAt: now.toISOString(),
      practiceId: request.practiceId,
      context: input.eventContext,
      eventType: `policy.${result.disposition}`,
      objectType: "action_request",
      objectId: request.id,
      objectVersion: request.requestedStateVersion,
      outcome: result.disposition === "permit" ? "success" : result.disposition === "deny" ? "denied" : "noop",
      policyDecisionId: decision.id,
      actionId: request.id,
      metadata: {
        capability: request.capability,
        decision: result.disposition,
        reasonCode: result.reasonCodes[0] ?? "policy_result_missing",
        rulesetVersion: this.rulesetVersion,
        stateVersion: request.requestedStateVersion,
      },
    });
    this.dependencies.repository.commitPolicyDecision({
      request,
      decision,
      permit,
      event,
      outbox: makeOutbox(this.ids, event),
    });

    if (permit !== null) return { kind: "permit", decision, permit };
    return result.disposition === "deny"
      ? { kind: "deny", decision }
      : { kind: "human_review", decision };
  }

  private makePermit(request: ActionRequest, decision: PolicyDecision, now: Date): ActionPermit {
    return actionPermitSchema.parse({
      id: this.ids.next("permit"),
      practiceId: request.practiceId,
      actionRequestId: request.id,
      policyDecisionId: decision.id,
      capability: request.capability,
      subjectId: request.subjectId,
      parameterHash: request.parameterHash,
      stateVersion: request.requestedStateVersion,
      rulesetVersion: this.rulesetVersion,
      nonceHash: hashValue(this.ids.next("nonce")),
      expiresAt: new Date(now.getTime() + this.permitTtlMs).toISOString(),
      consumedAt: null,
      revokedAt: null,
      maxUses: 1,
    });
  }
}

export interface AsyncPolicyAuthorityDependencies {
  repository: AsyncControlPlaneRepository;
  policy: CurrentStatePolicyEngine;
  clock?: Clock;
  ids?: IdSource;
  permitTtlMs?: number;
  rulesetVersion?: string;
}

export class AsyncPolicyAuthorityService {
  private readonly clock: Clock;
  private readonly ids: IdSource;
  private readonly permitTtlMs: number;
  private readonly rulesetVersion: string;

  constructor(private readonly dependencies: AsyncPolicyAuthorityDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidIdSource;
    this.permitTtlMs = dependencies.permitTtlMs ?? 5 * 60_000;
    this.rulesetVersion = dependencies.rulesetVersion ?? "s1-current-state-v1";
  }

  async evaluateAndIssue(
    input: Omit<CurrentStatePolicyInput, "currentStateVersion" | "now"> & { eventContext: EventContext },
  ): Promise<PolicyAuthorityResult> {
    const request = actionRequestSchema.parse(input.request);
    assertEventContextMatchesRequest(input.eventContext, request);
    const now = this.clock.now();
    const currentCase = await this.dependencies.repository.findCase(request.practiceId, request.caseId);
    const result = currentCase === null
      ? {
          disposition: "deny" as const,
          requiredVerification: "strong" as const,
          reasonCodes: ["current_state_missing"],
          obligations: [],
        }
      : currentCase.practiceId !== request.practiceId
        ? {
            disposition: "deny" as const,
            requiredVerification: "strong" as const,
            reasonCodes: ["current_state_tenant_mismatch"],
            obligations: [],
          }
        : this.dependencies.policy.evaluate({
            request,
            currentStateVersion: currentCase.version,
            verification: input.verification,
            now,
          });
    const decision = policyDecisionSchema.parse({
      id: this.ids.next("decision"),
      practiceId: request.practiceId,
      actionRequestId: request.id,
      decision: result.disposition,
      rulesetVersion: this.rulesetVersion,
      reasonCodes: result.reasonCodes,
      obligations: result.obligations,
      factsHash: hashValue({
        capability: request.capability,
        requiredVerification: result.requiredVerification,
        requestStateVersion: request.requestedStateVersion,
        currentStateVersion: currentCase?.version ?? null,
        verificationState: input.verification?.state ?? "missing",
      }),
      decidedAt: now.toISOString(),
    });
    const permit = result.disposition === "permit"
      ? actionPermitSchema.parse({
          id: this.ids.next("permit"),
          practiceId: request.practiceId,
          actionRequestId: request.id,
          policyDecisionId: decision.id,
          capability: request.capability,
          subjectId: request.subjectId,
          parameterHash: request.parameterHash,
          stateVersion: request.requestedStateVersion,
          rulesetVersion: this.rulesetVersion,
          nonceHash: hashValue(this.ids.next("nonce")),
          expiresAt: new Date(now.getTime() + this.permitTtlMs).toISOString(),
          consumedAt: null,
          revokedAt: null,
          maxUses: 1,
        })
      : null;
    const event = makeEvent({
      ids: this.ids,
      occurredAt: now.toISOString(),
      practiceId: request.practiceId,
      context: input.eventContext,
      eventType: `policy.${result.disposition}`,
      objectType: "action_request",
      objectId: request.id,
      objectVersion: request.requestedStateVersion,
      outcome: result.disposition === "permit" ? "success" : result.disposition === "deny" ? "denied" : "noop",
      policyDecisionId: decision.id,
      actionId: request.id,
      metadata: {
        capability: request.capability,
        decision: result.disposition,
        reasonCode: result.reasonCodes[0] ?? "policy_result_missing",
        rulesetVersion: this.rulesetVersion,
        stateVersion: request.requestedStateVersion,
      },
    });
    await this.dependencies.repository.commitPolicyDecision({
      request,
      decision,
      permit,
      event,
      outbox: makeOutbox(this.ids, event),
    });

    if (permit !== null) return { kind: "permit", decision, permit };
    return result.disposition === "deny"
      ? { kind: "deny", decision }
      : { kind: "human_review", decision };
  }
}

export interface PermitConsumptionDependencies {
  repository: ControlPlaneRepository;
  clock?: Clock;
  ids?: IdSource;
}

export interface ConsumeIssuedPermitInput {
  permitId: string;
  request: ActionRequest;
  eventContext: EventContext;
}

export class PermitConsumptionService {
  private readonly clock: Clock;
  private readonly ids: IdSource;

  constructor(private readonly dependencies: PermitConsumptionDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidIdSource;
  }

  consume(input: ConsumeIssuedPermitInput): PermitConsumeResult {
    const request = actionRequestSchema.parse(input.request);
    assertEventContextMatchesRequest(input.eventContext, request);
    const consumedAt = this.clock.now().toISOString();
    const event = makeEvent({
      ids: this.ids,
      occurredAt: consumedAt,
      practiceId: request.practiceId,
      context: input.eventContext,
      eventType: "permit.consumed",
      objectType: "action_permit",
      objectId: input.permitId,
      objectVersion: request.requestedStateVersion,
      outcome: "success",
      policyDecisionId: null,
      actionId: request.id,
      metadata: {
        capability: request.capability,
        stateVersion: request.requestedStateVersion,
      },
    });
    return this.dependencies.repository.consumePermit({
      permitId: input.permitId,
      practiceId: request.practiceId,
      actionRequestId: request.id,
      capability: request.capability,
      subjectId: request.subjectId,
      parameterHash: request.parameterHash,
      stateVersion: request.requestedStateVersion,
      consumedAt,
      event,
      outbox: makeOutbox(this.ids, event),
    });
  }
}

export interface AsyncPermitConsumptionDependencies {
  repository: AsyncControlPlaneRepository;
  clock?: Clock;
  ids?: IdSource;
}

export class AsyncPermitConsumptionService {
  private readonly clock: Clock;
  private readonly ids: IdSource;

  constructor(private readonly dependencies: AsyncPermitConsumptionDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidIdSource;
  }

  async consume(input: ConsumeIssuedPermitInput): Promise<PermitConsumeResult> {
    const request = actionRequestSchema.parse(input.request);
    assertEventContextMatchesRequest(input.eventContext, request);
    const consumedAt = this.clock.now().toISOString();
    const event = makeEvent({
      ids: this.ids,
      occurredAt: consumedAt,
      practiceId: request.practiceId,
      context: input.eventContext,
      eventType: "permit.consumed",
      objectType: "action_permit",
      objectId: input.permitId,
      objectVersion: request.requestedStateVersion,
      outcome: "success",
      policyDecisionId: null,
      actionId: request.id,
      metadata: {
        capability: request.capability,
        stateVersion: request.requestedStateVersion,
      },
    });
    return this.dependencies.repository.consumePermit({
      permitId: input.permitId,
      practiceId: request.practiceId,
      actionRequestId: request.id,
      capability: request.capability,
      subjectId: request.subjectId,
      parameterHash: request.parameterHash,
      stateVersion: request.requestedStateVersion,
      consumedAt,
      event,
      outbox: makeOutbox(this.ids, event),
    });
  }
}

export interface CaseTransitionDependencies {
  repository: ControlPlaneRepository;
  clock?: Clock;
  ids?: IdSource;
}

export interface TransitionCaseInput {
  practiceId: string;
  caseId: string;
  expectedVersion: number;
  to: Case["state"];
  resolutionEvidenceIds: readonly string[];
  eventContext: EventContext;
}

export type CaseTransitionResult =
  | { kind: "committed"; value: Case }
  | {
      kind: "rejected";
      reason:
        | "case_not_found"
        | "tenant_mismatch"
        | "version_conflict"
        | "illegal_transition"
        | "case_resolution_requires_evidence";
    };

export class CaseTransitionService {
  private readonly clock: Clock;
  private readonly ids: IdSource;

  constructor(private readonly dependencies: CaseTransitionDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.ids = dependencies.ids ?? uuidIdSource;
  }

  transition(input: TransitionCaseInput): CaseTransitionResult {
    const current = this.dependencies.repository.findCase(input.practiceId, input.caseId);
    if (current === null) return { kind: "rejected", reason: "case_not_found" };
    if (current.practiceId !== input.practiceId) return { kind: "rejected", reason: "tenant_mismatch" };
    if (current.version !== input.expectedVersion) return { kind: "rejected", reason: "version_conflict" };
    try {
      assertTransition(caseTransitions, current.state, input.to);
    } catch {
      return { kind: "rejected", reason: "illegal_transition" };
    }

    const resolutionEvidenceIds = [...new Set([...current.resolutionEvidenceIds, ...input.resolutionEvidenceIds])];
    const next = caseSchema.parse({
      ...current,
      state: input.to,
      resolutionEvidenceIds,
      version: current.version + 1,
    });
    if (next.state === "resolved") {
      try {
        assertCaseCanResolve(next);
      } catch {
        return { kind: "rejected", reason: "case_resolution_requires_evidence" };
      }
    }
    const event = makeEvent({
      ids: this.ids,
      occurredAt: this.clock.now().toISOString(),
      practiceId: input.practiceId,
      context: input.eventContext,
      eventType: "case.transitioned",
      objectType: "case",
      objectId: next.id,
      objectVersion: next.version,
      outcome: "success",
      policyDecisionId: null,
      actionId: null,
      metadata: {
        fromState: current.state,
        toState: next.state,
        expectedVersion: input.expectedVersion,
        resolutionEvidenceCount: resolutionEvidenceIds.length,
        nextStateHash: hashValue(next),
      },
    });
    return this.dependencies.repository.transitionCase({
      practiceId: input.practiceId,
      caseId: input.caseId,
      expectedVersion: input.expectedVersion,
      next,
      event,
      outbox: makeOutbox(this.ids, event),
    });
  }
}

function makeEvent(input: {
  ids: IdSource;
  occurredAt: string;
  practiceId: string;
  context: EventContext;
  eventType: string;
  objectType: string;
  objectId: string;
  objectVersion: number;
  outcome: EventEnvelope["outcome"];
  policyDecisionId: string | null;
  actionId: string | null;
  metadata: Record<string, unknown>;
}): EventEnvelope {
  return eventEnvelopeSchema.parse({
    eventId: input.ids.next("event"),
    occurredAt: input.occurredAt,
    practiceId: input.practiceId,
    traceId: input.context.traceId,
    callId: input.context.callId,
    caseId: input.context.caseId,
    goalId: null,
    turnId: null,
    actorType: input.context.actorType,
    actorId: input.context.actorId,
    eventType: input.eventType,
    objectType: input.objectType,
    objectId: input.objectId,
    objectVersion: input.objectVersion,
    outcome: input.outcome,
    latencyMs: null,
    policyDecisionId: input.policyDecisionId,
    actionId: input.actionId,
    providerRequestId: null,
    errorCode: null,
    payloadClass: "limited",
    metadata: redactMetadata(input.metadata, [
      "capability",
      "decision",
      "reasonCode",
      "rulesetVersion",
      "stateVersion",
      "fromState",
      "toState",
      "expectedVersion",
      "resolutionEvidenceCount",
      "nextStateHash",
    ]),
  });
}

function makeOutbox(ids: IdSource, event: EventEnvelope): OutboxMessage {
  return {
    id: ids.next("outbox"),
    practiceId: event.practiceId,
    eventId: event.eventId,
    topic: event.eventType,
    availableAt: event.occurredAt,
    publishedAt: null,
    attemptCount: 0,
    lastErrorCode: null,
  };
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertEventContextMatchesRequest(context: EventContext, request: ActionRequest): void {
  if (context.callId !== request.callId || context.caseId !== request.caseId) {
    throw new Error("event_context_scope_mismatch");
  }
}
