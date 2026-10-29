import { z } from "zod";

const id = z.string().min(3).max(160);
const timestamp = z.string().datetime({ offset: true });

export const actorTypeSchema = z.enum(["system", "model", "staff", "caller", "provider"]);
export const payloadClassSchema = z.enum(["none", "public", "limited", "phi", "secret"]);

export const callStateSchema = z.enum([
  "connecting",
  "active",
  "degraded",
  "transferring",
  "ending",
  "ended",
]);
export type CallState = z.infer<typeof callStateSchema>;

export const goalStateSchema = z.enum(["proposed", "active", "achieved", "blocked", "superseded", "abandoned"]);
export type GoalState = z.infer<typeof goalStateSchema>;

export const caseStateSchema = z.enum([
  "open",
  "gathering",
  "acting",
  "awaiting_external",
  "awaiting_human",
  "resolved",
  "escalated",
  "failed",
  "reopened",
]);
export type CaseState = z.infer<typeof caseStateSchema>;

export const verificationStateSchema = z.enum(["not_required", "pending", "verified", "failed", "locked", "expired"]);
export type VerificationState = z.infer<typeof verificationStateSchema>;

export const actionStateSchema = z.enum([
  "proposed",
  "policy_evaluating",
  "permitted",
  "denied",
  "human_review",
  "expired",
  "queued",
  "executing",
  "verifying",
  "succeeded",
  "uncertain",
  "failed",
  "cancelled",
]);
export type ActionState = z.infer<typeof actionStateSchema>;

export const capabilitySchema = z.enum([
  "knowledge.public.read",
  "knowledge.patient.read",
  "appointment.details.read",
  "appointment.availability.read",
  "appointment.schedule",
  "appointment.move",
  "referral.state.read",
  "referral.state.transition",
]);
export type Capability = z.infer<typeof capabilitySchema>;

export const decisionToolSchema = z.union([
  z.literal("identity.verify"),
  z.literal("lookup_information"),
  capabilitySchema,
]);
export type DecisionTool = z.infer<typeof decisionToolSchema>;

export const transcriptRevisionStabilitySchema = z.enum(["partial", "final"]);
export const turnPurposeSchema = z.enum(["workflow_step", "side_question", "goal_change"]);
export const interruptionDispositionSchema = z.enum(["non_semantic", "additive", "invalidating", "stop_or_handoff", "uncertain"]);
export type InterruptionDisposition = z.infer<typeof interruptionDispositionSchema>;
export const knowledgeClassificationSchema = z.enum(["public", "verified_patient", "staff", "clinical_restricted"]);
export const knowledgeQueryModeSchema = z.enum(["preloaded", "speculative", "on_demand"]);
export const knowledgeQueryStateSchema = z.enum(["created", "retrieving", "ready", "consumed", "superseded", "cancelled", "failed", "stale"]);
export type KnowledgeQueryState = z.infer<typeof knowledgeQueryStateSchema>;

export const transcriptRevisionSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  turnId: id,
  sequence: z.number().int().positive(),
  stability: transcriptRevisionStabilitySchema,
  transcriptHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payloadClass: payloadClassSchema,
  providerEventId: id,
  occurredAt: timestamp,
}).strict();
export type TranscriptRevision = z.infer<typeof transcriptRevisionSchema>;

export const approvedKnowledgeItemSchema = z.object({
  id,
  practiceId: id,
  stableKey: z.string().min(1).max(160),
  version: z.number().int().positive(),
  classification: knowledgeClassificationSchema,
  status: z.enum(["draft", "approved", "active", "retired"]),
  claim: z.string().min(1).max(2_000),
  structuredValue: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]),
  sourceRef: z.string().min(1).max(500),
  answerBoundary: z.string().max(1_000),
  effectiveAt: timestamp,
  freshUntil: timestamp,
}).strict();
export type ApprovedKnowledgeItem = z.infer<typeof approvedKnowledgeItemSchema>;

export const knowledgeQueryCandidateSchema = z.object({
  itemId: id,
  itemVersion: z.number().int().positive(),
  score: z.number().finite().min(0),
  reasons: z.array(z.enum(["fact_pack", "term", "phrase", "entity", "goal", "workflow_state"])).min(1).max(6),
}).strict();
export type KnowledgeQueryCandidate = z.infer<typeof knowledgeQueryCandidateSchema>;

export const knowledgeQuerySchema = z.object({
  id,
  practiceId: id,
  callId: id,
  turnId: id,
  transcriptRevision: z.number().int().positive(),
  normalizedQueryHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mode: knowledgeQueryModeSchema,
  state: knowledgeQueryStateSchema,
  informationClassHint: knowledgeClassificationSchema.nullable(),
  activeGoalId: id.nullable(),
  candidates: z.array(knowledgeQueryCandidateSchema).max(64),
  latencyMs: z.number().int().nonnegative().nullable(),
  createdAt: timestamp,
}).strict();
export type KnowledgeQuery = z.infer<typeof knowledgeQuerySchema>;

export const knowledgeAccessSchema = z.object({
  id,
  practiceId: id,
  queryId: id,
  permitId: id.nullable(),
  route: z.enum(["practice_fact_pack", "approved_search", "intergy_read"]),
  returnedItemIds: z.array(id).max(64),
  outcome: z.enum(["returned", "empty", "denied", "failed"]),
  latencyMs: z.number().int().nonnegative(),
  occurredAt: timestamp,
}).strict();
export type KnowledgeAccess = z.infer<typeof knowledgeAccessSchema>;

export const knowledgeEnvelopeFactSchema = z.object({
  factId: id,
  itemId: id,
  itemVersion: z.number().int().positive(),
  classification: knowledgeClassificationSchema,
  claim: z.string().min(1).max(2_000),
  structuredValue: z.union([z.string().max(2_000), z.number().finite(), z.boolean(), z.null()]),
  sourceRef: z.string().min(1).max(500),
  freshUntil: timestamp,
  answerBoundary: z.string().max(1_000),
}).strict();
export type KnowledgeEnvelopeFact = z.infer<typeof knowledgeEnvelopeFactSchema>;

export const knowledgeEnvelopeSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  turnId: id,
  transcriptRevision: z.number().int().positive(),
  queryId: id,
  accessIds: z.array(id).max(16),
  facts: z.array(knowledgeEnvelopeFactSchema).max(32),
  prohibitedClaims: z.array(z.string().min(1).max(160)).max(16),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  compiledAt: timestamp,
  expiresAt: timestamp,
}).strict();
export type KnowledgeEnvelope = z.infer<typeof knowledgeEnvelopeSchema>;

export const lookupContextPayloadClassSchema = z.enum(["public", "patient_specific", "protected_internal"]);
export const lookupContextSupersessionReasonSchema = z.enum([
  "none", "additive_mismatch", "invalidating", "stop_or_handoff", "uncertain", "newer_revision",
]);
export const lookupContextRecordSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  callLifecycleId: id,
  patientId: id.nullable(),
  payloadClass: lookupContextPayloadClassSchema,
  queryId: id,
  queryRevision: z.number().int().positive(),
  resultRevision: z.number().int().positive(),
  queryFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  goalId: id,
  purpose: z.string().min(1).max(120),
  itemRefs: z.array(z.object({ itemId: id, version: z.number().int().positive() }).strict()).max(64),
  sourceVersionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  freshUntil: timestamp,
  supersessionReason: lookupContextSupersessionReasonSchema,
  identityEvidenceId: id.nullable(),
  policyDecisionId: id.nullable(),
  authorityStatus: z.enum(["context_only", "admitted", "promoted", "expired"]),
  lastValidationStateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  lastValidationOutcome: z.enum(["not_checked", "admitted", "promoted", "denied", "stale", "failed"]).default("not_checked"),
  retentionPolicyId: id,
  expiresAt: timestamp,
  deletionReceiptId: id.nullable(),
  createdAt: timestamp,
}).strict().superRefine((value, context) => {
  if (value.payloadClass !== "public" && value.patientId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "lookup_context_patient_binding_required", path: ["patientId"] });
  }
});
export type LookupContextRecord = z.infer<typeof lookupContextRecordSchema>;

export const decisionPriorLookupRecordSchema = z.object({
  id,
  queryFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  goalId: id,
  purpose: z.string().min(1).max(120),
  payloadClass: lookupContextPayloadClassSchema,
  itemRefs: z.array(z.object({ itemId: id, version: z.number().int().positive() }).strict()).max(64),
  supersessionReason: lookupContextSupersessionReasonSchema,
  freshUntil: timestamp,
}).strict();
export type DecisionPriorLookupRecord = z.infer<typeof decisionPriorLookupRecordSchema>;

export const priorLookupContextSchema = z.object({
  hasPriorLookupWork: z.boolean(),
  omittedCountBucket: z.enum(["0", "1", "2_4", "5_plus"]),
  records: z.array(decisionPriorLookupRecordSchema).max(8),
}).strict();
export type PriorLookupContext = z.infer<typeof priorLookupContextSchema>;

export const decisionKnowledgeEnvelopeSchema = knowledgeEnvelopeSchema.pick({
  id: true,
  transcriptRevision: true,
  facts: true,
  prohibitedClaims: true,
  digest: true,
  expiresAt: true,
});

export const decisionFactAuthoritySchema = z.enum([
  "caller",
  "identity",
  "orchestrator",
  "policy",
  "provider",
  "knowledge",
]);
export type DecisionFactAuthority = z.infer<typeof decisionFactAuthoritySchema>;

export const decisionQuestionClassSchema = z.enum([
  "clarify_goal",
  "date_of_birth",
  "phone_last_four",
  "postal_code",
  "appointment_selection",
  "scheduling_preference",
  "action_confirmation",
]);
export type DecisionQuestionClass = z.infer<typeof decisionQuestionClassSchema>;

export const decisionObligationKindSchema = z.enum([
  "goal_clarification",
  "identity_factor_collection",
  "identity_verification",
  "appointment_selection",
  "scheduling_preference",
  "protected_read",
  "action_confirmation",
  "provider_readback",
]);
export type DecisionObligationKind = z.infer<typeof decisionObligationKindSchema>;

export const validatedDecisionFactSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  authority: decisionFactAuthoritySchema,
  evidenceId: id,
}).strict();
export type ValidatedDecisionFact = z.infer<typeof validatedDecisionFactSchema>;

export const authorizedDecisionResponseSchema = z.object({
  responseClass: z.enum(["progress", "verified_answer"]),
  text: z.string().min(1).max(500),
  evidenceIds: z.array(id).min(1).max(16),
}).strict();
export type AuthorizedDecisionResponse = z.infer<typeof authorizedDecisionResponseSchema>;

export const proposedDecisionFactSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  source: z.literal("caller_utterance"),
  confidence: z.number().min(0).max(1),
}).strict();
export type ProposedDecisionFact = z.infer<typeof proposedDecisionFactSchema>;

export const decisionObligationSchema = z.object({
  id,
  kind: decisionObligationKindSchema,
  questionClass: decisionQuestionClassSchema.nullable(),
  promptHint: z.string().min(1).max(500).nullable(),
  satisfiers: z.array(z.object({
    factKey: z.string().min(1).max(120),
    allowedAuthorities: z.array(decisionFactAuthoritySchema).min(1).max(6),
  }).strict()).max(12),
  attemptCount: z.number().int().nonnegative().max(10),
  repairReason: z.enum(["no_speech", "not_understood", "caller_correction"]).nullable(),
}).strict();
export type DecisionObligation = z.infer<typeof decisionObligationSchema>;

export const decisionContextSchema = z.object({
  schemaVersion: z.literal("decision-context/v1"),
  contextId: id,
  practiceId: id,
  callId: id,
  caseId: id,
  goal: z.object({ id, kind: z.string().min(1).max(120), version: z.number().int().nonnegative() }).strict(),
  callStateVersion: z.number().int().nonnegative(),
  mode: z.enum(["active", "human_requested", "clinical_escalation"]),
  validatedFacts: z.array(validatedDecisionFactSchema).max(64),
  allowedFactKeys: z.array(z.string().min(1).max(120)).max(32),
  unresolvedObligations: z.array(decisionObligationSchema).max(32),
  allowedTools: z.array(decisionToolSchema).max(16),
  allowedQuestionClasses: z.array(decisionQuestionClassSchema).max(16),
  allowedResponseClasses: z.array(z.enum(["acknowledgement", "clarification", "public_answer", "progress", "verified_answer"])).max(8),
  permittedKnowledgeItemIds: z.array(id).max(64),
  speakableEvidenceIds: z.array(id).max(64),
  activeOperationEvidenceIds: z.array(id).max(16),
  terminalEvidenceIds: z.array(id).max(16),
  authorizedResponses: z.array(authorizedDecisionResponseSchema).max(16),
  transcriptRevision: z.number().int().positive().optional(),
  turnPurpose: turnPurposeSchema.optional(),
  resumeGoalId: id.nullable().optional(),
  knowledgeEnvelope: decisionKnowledgeEnvelopeSchema.nullable().optional(),
  knowledgeSufficient: z.boolean().optional(),
  priorLookupContext: priorLookupContextSchema.optional(),
  interruptionDisposition: interruptionDispositionSchema.optional(),
  latestCallerUtterance: z.string().max(2_000),
  recentSummary: z.string().max(2_000),
  prohibitedClaims: z.array(z.enum(["patient_association", "identity_verified", "action_authorized", "operation_active", "action_succeeded"])).max(8),
  proposalDenials: z.array(z.string().min(1).max(120)).max(2),
  humanHandoffAvailable: z.boolean(),
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict();
export type DecisionContext = z.infer<typeof decisionContextSchema>;

const nextMoveBindingSchema = z.object({
  contextId: id,
  goalId: id,
  callStateVersion: z.number().int().nonnegative(),
  proposedFacts: z.array(proposedDecisionFactSchema).max(16).default([]),
});
const nextMoveTextSchema = z.string().min(1).max(500);
const nextMoveArgumentSchema = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);

export const nextMoveSchema = z.discriminatedUnion("kind", [
  nextMoveBindingSchema.extend({
    kind: z.literal("ask"),
    obligationId: id,
    questionClass: decisionQuestionClassSchema,
    text: nextMoveTextSchema,
  }).strict(),
  nextMoveBindingSchema.extend({
    kind: z.literal("tool"),
    obligationId: id,
    capability: decisionToolSchema,
    arguments: z.record(z.string().min(1).max(120), nextMoveArgumentSchema),
  }).strict(),
  nextMoveBindingSchema.extend({
    kind: z.literal("respond"),
    responseClass: z.enum(["acknowledgement", "clarification", "public_answer", "progress", "verified_answer"]),
    text: nextMoveTextSchema,
    evidenceIds: z.array(id).max(16),
    envelopeId: id.nullable().optional(),
    supportedFactIds: z.array(id).max(32).optional(),
    unsupportedQuestions: z.array(z.string().min(1).max(500)).max(8).optional(),
    resumeGoalId: id.nullable().optional(),
    renderingMode: z.enum(["model_paraphrase", "answer_card", "non_factual"]).optional(),
  }).strict(),
  nextMoveBindingSchema.extend({
    kind: z.literal("handoff"),
    reason: z.enum(["human_requested", "clinical", "repeated_failure", "provider_unavailable", "policy_required"]),
    text: nextMoveTextSchema,
  }).strict(),
  nextMoveBindingSchema.extend({
    kind: z.literal("propose_complete"),
    outcomeSummary: nextMoveTextSchema,
    evidenceIds: z.array(id).max(16),
  }).strict(),
]);
export type NextMove = z.infer<typeof nextMoveSchema>;

export const callSchema = z.object({
  id,
  practiceId: id,
  caseId: id,
  activeGoalId: id.nullable(),
  telephonyCallId: id,
  traceId: id,
  state: callStateSchema,
  version: z.number().int().nonnegative(),
  connectedAt: timestamp.nullable(),
  endedAt: timestamp.nullable(),
});
export type Call = z.infer<typeof callSchema>;

export const callGoalSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  caseId: id,
  kind: z.string().min(1).max(120),
  state: goalStateSchema,
  requiredFields: z.array(z.string().min(1)).max(32),
  collectedFields: z.record(z.string(), z.unknown()),
  blockerCode: z.string().max(120).nullable(),
  version: z.number().int().nonnegative(),
});
export type CallGoal = z.infer<typeof callGoalSchema>;

export const caseSchema = z.object({
  id,
  practiceId: id,
  ownerId: id.nullable(),
  state: caseStateSchema,
  requestKind: z.string().min(1).max(120),
  serviceLevelDueAt: timestamp,
  resolutionEvidenceIds: z.array(id),
  version: z.number().int().nonnegative(),
});
export type Case = z.infer<typeof caseSchema>;

export const verificationSessionSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  patientId: id.nullable(),
  capability: capabilitySchema,
  requiredAssurance: z.enum(["none", "basic", "strong", "human"]),
  state: verificationStateSchema,
  attemptCount: z.number().int().nonnegative(),
  evidenceIds: z.array(id),
  expiresAt: timestamp.nullable(),
  version: z.number().int().nonnegative(),
});
export type VerificationSession = z.infer<typeof verificationSessionSchema>;

export const actionRequestSchema = z.object({
  id,
  practiceId: id,
  callId: id,
  caseId: id,
  capability: capabilitySchema,
  subjectId: id.nullable(),
  parameters: z.record(z.string(), z.unknown()),
  parameterHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestedStateVersion: z.number().int().nonnegative(),
  requestedAt: timestamp,
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const policyDecisionSchema = z.object({
  id,
  practiceId: id,
  actionRequestId: id,
  decision: z.enum(["permit", "deny", "human_review"]),
  rulesetVersion: z.string().min(1).max(120),
  reasonCodes: z.array(z.string().min(1).max(120)).min(1),
  obligations: z.array(z.string().min(1).max(120)),
  factsHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  decidedAt: timestamp,
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const actionPermitSchema = z.object({
  id,
  practiceId: id,
  actionRequestId: id,
  policyDecisionId: id,
  capability: capabilitySchema,
  subjectId: id.nullable(),
  parameterHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  stateVersion: z.number().int().nonnegative(),
  rulesetVersion: z.string().min(1).max(120),
  nonceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expiresAt: timestamp,
  consumedAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  maxUses: z.literal(1),
});
export type ActionPermit = z.infer<typeof actionPermitSchema>;

export const eventEnvelopeSchema = z.object({
  eventId: id,
  occurredAt: timestamp,
  practiceId: id,
  traceId: id,
  callId: id.nullable(),
  caseId: id.nullable(),
  goalId: id.nullable(),
  turnId: id.nullable(),
  transcriptRevision: z.number().int().positive().nullable().optional(),
  knowledgeQueryId: id.nullable().optional(),
  knowledgeEnvelopeId: id.nullable().optional(),
  retrievalMode: knowledgeQueryModeSchema.nullable().optional(),
  actorType: actorTypeSchema,
  actorId: id.nullable(),
  eventType: z.string().min(1).max(160),
  objectType: z.string().min(1).max(120),
  objectId: id,
  objectVersion: z.number().int().nonnegative(),
  outcome: z.enum(["success", "failure", "denied", "uncertain", "noop"]),
  latencyMs: z.number().int().nonnegative().nullable(),
  policyDecisionId: id.nullable(),
  actionId: id.nullable(),
  providerRequestId: z.string().max(200).nullable(),
  errorCode: z.string().max(120).nullable(),
  payloadClass: payloadClassSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

type TransitionTable<T extends string> = Readonly<Record<T, readonly T[]>>;

export const callTransitions: TransitionTable<CallState> = {
  connecting: ["active", "degraded", "ending"],
  active: ["degraded", "transferring", "ending"],
  degraded: ["active", "transferring", "ending"],
  transferring: ["ending"],
  ending: ["ended"],
  ended: [],
};

export const goalTransitions: TransitionTable<GoalState> = {
  proposed: ["active", "abandoned"],
  active: ["achieved", "blocked", "superseded", "abandoned"],
  achieved: [],
  blocked: ["active", "superseded", "abandoned"],
  superseded: [],
  abandoned: [],
};

export const caseTransitions: TransitionTable<CaseState> = {
  open: ["gathering", "awaiting_human", "failed"],
  gathering: ["acting", "awaiting_external", "awaiting_human", "failed"],
  acting: ["resolved", "awaiting_external", "awaiting_human", "failed"],
  awaiting_external: ["acting", "resolved", "awaiting_human", "failed"],
  awaiting_human: ["escalated", "resolved", "failed"],
  resolved: ["reopened"],
  escalated: ["resolved", "reopened"],
  failed: ["reopened"],
  reopened: ["gathering", "acting", "awaiting_external", "awaiting_human", "failed"],
};

export const verificationTransitions: TransitionTable<VerificationState> = {
  not_required: [],
  pending: ["verified", "failed", "locked", "expired"],
  verified: ["expired"],
  failed: ["pending", "locked", "expired"],
  locked: [],
  expired: [],
};

export const actionTransitions: TransitionTable<ActionState> = {
  proposed: ["policy_evaluating", "cancelled"],
  policy_evaluating: ["permitted", "denied", "human_review", "expired"],
  permitted: ["queued", "expired", "cancelled"],
  denied: [],
  human_review: ["permitted", "denied", "cancelled"],
  expired: [],
  queued: ["executing", "cancelled"],
  executing: ["verifying", "uncertain", "failed"],
  verifying: ["succeeded", "uncertain", "failed"],
  succeeded: [],
  uncertain: ["verifying", "failed"],
  failed: [],
  cancelled: [],
};

export const knowledgeQueryTransitions: TransitionTable<KnowledgeQueryState> = {
  created: ["retrieving", "cancelled", "superseded"],
  retrieving: ["ready", "failed", "cancelled", "superseded"],
  ready: ["consumed", "stale", "superseded"],
  consumed: [],
  superseded: [],
  cancelled: [],
  failed: [],
  stale: [],
};

export function assertTransition<T extends string>(
  table: TransitionTable<T>,
  from: T,
  to: T,
): void {
  if (!table[from].includes(to)) {
    throw new Error(`illegal_transition:${from}:${to}`);
  }
}

export function assertCaseCanResolve(value: Case): void {
  if (value.resolutionEvidenceIds.length === 0) {
    throw new Error("case_resolution_requires_evidence");
  }
}

export function assertPermitUsable(
  permit: ActionPermit,
  request: ActionRequest,
  now: Date,
): void {
  if (permit.practiceId !== request.practiceId || permit.actionRequestId !== request.id) {
    throw new Error("permit_request_mismatch");
  }
  if (permit.capability !== request.capability || permit.subjectId !== request.subjectId) {
    throw new Error("permit_scope_mismatch");
  }
  if (permit.parameterHash !== request.parameterHash || permit.stateVersion !== request.requestedStateVersion) {
    throw new Error("permit_state_or_parameter_mismatch");
  }
  if (permit.consumedAt !== null || permit.revokedAt !== null || new Date(permit.expiresAt) <= now) {
    throw new Error("permit_not_usable");
  }
}
