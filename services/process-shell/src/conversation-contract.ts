import { createHash } from "node:crypto";
import { z } from "zod";
import { speechReviewSchema } from "./conversation-monitor.js";
import { voiceReadPresentationReceiptSchema } from "./f2-read-monitor.js";
import { conversationEvaluationRecordSchema, CONVERSATION_EVALUATION_VERSION, evaluationId } from "./conversation-evaluation.js";
import { fullRequestProposalSchema } from "./f2-request-policy.js";
import { routeCategorySchema } from "./route-category.js";
import { controlledTransferAttemptSchema } from "./controlled-test-transfer.js";
import { approvedEmergencySmsInstruction } from "./receptionist-emergency-text.js";
import { isReceptionistCallerExit } from "./receptionist-callback-dialogue.js";
import { isClearDecline, isExplicitPendingSlotWithdrawal } from "./f2-dialogue-evidence.js";
import { receptionistPublicFaqReferenceMatches, receptionistPublicFaqTopicSchema, resolveReceptionistPublicFaq, sameSelectedOfficePublicFaqTopic } from "./receptionist-public-faq.js";
export { routeCategorySchema } from "./route-category.js";

export const conversationIdSchema = z.string().min(1).max(200);
const id = conversationIdSchema;
const text = z.string().trim().min(1).max(8000);
const revision = z.number().int().nonnegative();
const inputFragmentsSchema = z.array(z.object({ sourceId: id, body: text }).strict()).min(2).max(8);
const unsupportedMediaCount = z.number().int().min(0).max(10);
const failureReason = z.enum(["sandbox_not_joined"]);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const twilioStreamId = z.string().regex(/^MZ[a-fA-F0-9]{32}$/);
const questionKindSchema = z.enum(["callback_number", "general", "name", "message", "callback_number_entry",
  "patient_status", "identity_dob", "identity_zip", "slot_selection", "appointment_consent", "attendance_consent", "request_clarification"]);
export { approvedEmergencySmsInstruction };
const controlledOutcomeSchema = z.enum(["accepted", "busy", "refused", "no_answer", "failed", "canceled", "late_accept"]);
const controlledAcceptanceSchema = z.object({ recipientId: id, childCallId: id, acceptedAt: z.string().datetime({ offset: true }) }).strict();
const controlledRecordSchema = z.object({ attempt: controlledTransferAttemptSchema,
  dispatch: z.enum(["prepared", "submitting", "submitted", "unknown", "aborted"]), outcome: controlledOutcomeSchema.nullable(),
  acceptance: controlledAcceptanceSchema.nullable(), resumedVoiceEpoch: revision.nullable().default(null) }).strict();
const simulatedRouteOutcomeSchema = z.object({
  id, sourceId: id, requestId: id, requestRevision: revision, ownerEpoch: revision, instanceId: id,
  conversationId: id, category: routeCategorySchema, outcome: z.enum(["staff_answered", "no_answer", "after_hours"]),
  bindingKey: z.string().regex(/^sim-route:[a-f0-9]{64}$/), recordedAt: z.string().datetime(),
  supersedesId: id.nullable().default(null),
}).strict();
export type SimulatedRouteOutcome = z.infer<typeof simulatedRouteOutcomeSchema>;
export function simulatedRouteBindingKey(input: Pick<SimulatedRouteOutcome,
  "instanceId" | "conversationId" | "sourceId" | "requestId" | "requestRevision" | "ownerEpoch" | "category" | "outcome"> & { practiceId: string }): string {
  return `sim-route:${createHash("sha256").update(JSON.stringify([
    input.practiceId, input.instanceId, input.conversationId, input.sourceId, input.requestId,
    input.requestRevision, input.ownerEpoch, input.category, input.outcome,
  ])).digest("hex")}`;
}
export const admissionSchema = z.object({
  practiceId: id, instanceId: id, configVersion: id, mode: z.enum(["receptionist", "full"]),
  accountId: id, provider: z.literal("twilio"), channel: z.enum(["voice", "sms"]),
  messageTransport: z.enum(["sms", "whatsapp"]).default("sms"),
  externalId: id, contact: z.string().regex(/^\+[1-9]\d{7,14}$/), destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
  hours: z.enum(["demo_open", "demo_closed"]),
  voiceRelease: z.discriminatedUnion("stage", [
    z.object({ stage: z.literal("operator_demo"), profileSha256: sha256 }).strict(),
    z.object({ stage: z.literal("rehearsal"), profileSha256: sha256, qualificationSha256: sha256 }).strict(),
  ]).optional(),
  // Pinned at admission. Older snapshots and ordinary calls retain SIP.
  voicePlayback: z.enum(["legacy_sip", "primary_media"]).default("legacy_sip"),
  // Only signed synthetic voice ingress may attach this immutable receipt. It
  // records a per-call test authority without retaining the caller binding.
  controlledHours: z.object({
    fixtureId: id, parentCallId: id, issuedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
    outcome: z.enum(["demo_open", "demo_closed"]),
    candidate: z.object({ version: z.enum(["vvc1", "vvc2"]), purpose: z.literal("receptionist_voice_candidate"),
      profileSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/), nonce: z.string().regex(/^[a-f0-9]{32}$/),
      caseId: z.enum(["closed", "open_unavailable", "open_no_answer", "open_accepted"]), hoursFixture: z.enum(["demo_open", "demo_closed"]) }).strict().optional(),
  }).strict().nullable().default(null),
}).strict();
// Inputs written before transport support remain valid; persisted snapshots are
// parsed through admissionSchema and always carry the default transport.
export type Admission = z.input<typeof admissionSchema>;

const messageSchema = z.object({
  id, sender: z.enum(["ai", "staff"]), actor: id, ownerEpoch: revision, suppressionRevision: revision,
  body: text, state: z.enum(["queued", "submitting", "accepted", "delivered", "undelivered", "unknown", "failed", "canceled"]),
  providerId: id.nullable(), dispatchAttemptId: id.nullable(), failureReason: failureReason.nullable().default(null), sendHoldReleased: z.boolean(),
}).strict();
/**
 * Opaque server proof summaries for terminal F2 work. They deliberately carry
 * no model text, patient data, or mutation parameters: receipt authorities own
 * those values and publish this result only after their own durable readback.
 */
export const aiResolutionResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), receiptId: id, readKind: z.enum(["appointment_details", "referral_status", "billing_balance"]), receiptHash: sha256, resultHash: sha256,
    sourceVersion: revision }).strict(),
  z.object({ kind: z.literal("action"), receiptId: id,
    operation: z.enum(["schedule", "reschedule", "attendance_confirm"]), resultHash: sha256,
    readbackHash: sha256, resultingVersion: revision }).strict(),
  z.object({ kind: z.literal("knowledge"), topic: z.enum(["address", "demo_way_directions", "sample_city_address", "locations", "parking", "hours", "other"]),
    packId: id, packVersion: id, factId: id, factVersion: id, sourceId: id, sourceVersion: id,
    contentHash: sha256 }).strict(),
]);
export type AiResolutionResult = z.infer<typeof aiResolutionResultSchema>;
const receptionistPublicFaqReferenceSchema = z.object({ packId: id, packVersion: id, factId: id, factVersion: id,
  knowledgeSourceId: id, knowledgeSourceVersion: id, contentHash: sha256 }).strict();
const requestSchema = z.object({
  id, revision, category: routeCategorySchema.nullable(), originalRequest: z.string().max(8000),
  name: z.string().max(200), callbackNumber: z.string().max(16), callbackConfirmed: z.boolean(),
  // Optional for older snapshots; server-stamped only by accepted contact writes.
  nameSourceId: id.optional(), callbackNumberSourceId: id.optional(),
  confirmationSourceId: id.nullable(), callbackMessageSourceId: id.nullable().optional(), callbackMessageText: z.string().trim().min(1).max(8000).optional(), owner: id.nullable(), outcome: text.nullable(),
  sourceIds: z.array(id).max(32), proposalRevision: revision,
  fullProposal: fullRequestProposalSchema.optional(),
  /** Server-stamped receptionist-only public FAQ reference; no freeform query or answer is persisted here. */
  receptionistPublicFaq: z.object({ topic: receptionistPublicFaqTopicSchema, sourceId: id, sourceRevision: revision,
    ownerEpoch: revision, voiceEpoch: revision }).merge(receptionistPublicFaqReferenceSchema).optional(),
  pausedCallbackSourceId: id.optional(),
  // A degraded callback request is a new, server-created work item. The full
  // proposal it references remains immutable context, never callback work.
  degradedHandoff: z.object({ recoveryId: id, sourceRequestId: id, sourceRequestRevision: revision }).strict().nullable().optional(),
  // Optional for snapshots written before F2 resolution existed. New requests
  // always persist null and only request.resolve_ai may set a typed result.
  aiResolution: aiResolutionResultSchema.nullable().optional(),
  state: z.enum(["draft", "needs_callback", "in_progress", "completed", "ai_resolved", "abandoned"]),
}).strict().superRefine((request, context) => {
  for (const field of ["nameSourceId", "callbackNumberSourceId"] as const) {
    const sourceId = request[field];
    if (sourceId !== undefined && !request.sourceIds.includes(sourceId)) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: "contact_source_not_in_request" });
  }
  if (request.callbackMessageText !== undefined && (request.callbackMessageSourceId == null || !request.sourceIds.includes(request.callbackMessageSourceId))) context.addIssue({ code: z.ZodIssueCode.custom, path: ["callbackMessageText"], message: "callback_message_value_source_missing" });
  if (request.state === "ai_resolved" && request.aiResolution === null || request.state === "ai_resolved" && request.aiResolution === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["aiResolution"], message: "ai_resolution_proof_required" });
  }
  if (request.state !== "ai_resolved" && request.aiResolution !== null && request.aiResolution !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["aiResolution"], message: "ai_resolution_state_invalid" });
  }
});
export const recoveryFailureDomainSchema = z.enum(["realtime_transport_only", "openai_account_or_quota", "openai_provider_or_scope_unknown", "relay_transport", "callback_intake"]);
export type RecoveryFailureDomain = z.infer<typeof recoveryFailureDomainSchema>;
const recoverySchema = z.object({
  id, fromEpoch: revision, target: z.enum(["relay", "scripted"]),
  // Older event streams did not record scope. Treat absence as unsafe rather
  // than granting a retry on another OpenAI surface.
  failureDomain: recoveryFailureDomainSchema.default("openai_provider_or_scope_unknown"),
  state: z.enum(["claimed", "redirecting", "attached", "outcome_unknown", "parent_gone"]),
  parentCallId: id, childCallId: id, triggerEventId: id, attachmentId: id.nullable(),
  callerEndSourceId: id.optional(), callerEndEventId: id.optional(), documentIssuedAt: z.string().datetime().optional(),
  scriptedEmptyAttempts: z.number().int().min(0).max(3).default(0),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
const primaryMediaSchema = z.object({
  attachmentId: id, purpose: z.literal("primary_media"), parentCallId: id, accountId: id,
  ownerEpoch: revision, voiceEpoch: revision, configVersion: id, profileSha256: sha256,
  capabilityDigest: sha256, expiresAt: z.string().datetime({ offset: true }),
  state: z.enum(["issued", "attached", "model_bound", "closed", "superseded"]),
  streamId: twilioStreamId.nullable(), modelSessionId: id.nullable(), configFingerprint: sha256.nullable(),
  inputPipelineArmed: z.boolean(),
  opening: z.object({ state: z.enum(["unissued", "issued", "playing", "completed", "interrupted", "failed"]),
    presentationId: id.nullable(), markId: id.nullable() }).strict(),
  issuedAt: z.string().datetime({ offset: true }), attachedAt: z.string().datetime({ offset: true }).nullable(),
  closedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const messageContinuationSchema = z.object({
  id, mode: z.enum(["inline", "fresh"]), reason: z.enum(["closed_hours", "route_unavailable", "clarification_exhausted", "no_answer", "busy", "refused", "failed", "canceled", "late_accept"]),
  state: z.enum(["issued", "attached", "closed", "superseded"]),
  fromAttachmentId: id, transferId: id.nullable(), sourceEventId: id, transitionEventId: id,
  parentCallId: id, accountId: id, ownerEpoch: revision, voiceEpoch: revision,
  configVersion: id, profileSha256: sha256, streamId: twilioStreamId.nullable(),
  capabilityDigest: sha256.nullable(), expiresAt: z.string().datetime({ offset: true }).nullable(),
  documentIssuedAt: z.string().datetime({ offset: true }).nullable(),
  attachedAt: z.string().datetime({ offset: true }).nullable(), closedAt: z.string().datetime({ offset: true }).nullable(),
  callerEndSourceId: id.nullable(), callerEndEventId: id.nullable(),
}).strict();
const emergencySchema = z.object({ sourceEventId: id, declaredRevision: revision }).strict();
export const conversationSchema = z.object({
  speechReviews: z.array(speechReviewSchema).max(256).default([]),
  voiceReadPresentations: z.array(voiceReadPresentationReceiptSchema).max(16).default([]),
  controlledTransfers: z.array(controlledRecordSchema).max(8).default([]),
  simulatedRouteOutcomes: z.array(simulatedRouteOutcomeSchema).max(16).default([]),
  evaluations: z.array(conversationEvaluationRecordSchema).max(4).default([]),
  schemaVersion: z.literal(1), id, admission: admissionSchema, revision,
  ownerEpoch: revision, voiceEpoch: revision, owner: z.enum(["ai", "waiting_for_staff", "staff"]),
  staffActor: id.nullable(), phase: z.enum(["active", "disconnected", "closed"]),
  activityLeaseUntil: z.string().datetime().nullable().default(null),
  providerTier: z.enum(["realtime", "relay", "scripted"]), suppressed: z.boolean(), suppressionRevision: revision,
  lastInboundAt: z.string().datetime().nullable().default(null),
  unsupportedMediaCount: z.number().int().nonnegative().default(0),
  unsupportedNonTextCount: z.number().int().nonnegative().default(0),
  emergency: emergencySchema.nullable().default(null),
  pendingQuestion: z.object({ id, kind: questionKindSchema, requestId: id.nullable(), requestRevision: revision.nullable(), callbackNumber: z.string().nullable(), activatedRevision: revision }).strict().nullable(),
  publicFaqChoice: z.object({ requestId: id, sourceId: id, sourceRevision: revision, ownerEpoch: revision, voiceEpoch: revision,
    questionTopic: z.literal("locations"), reference: receptionistPublicFaqReferenceSchema,
    state: z.enum(["asked", "answered"]), answerSourceId: id.optional(), answerTopic: z.enum(["address", "demo_way_directions", "sample_city_address"]).optional(),
    answerReference: receptionistPublicFaqReferenceSchema.optional() }).strict().nullable().default(null),
  questionIds: z.array(id).max(64),
  clarificationCount: z.number().int().min(0).max(1).default(0),
  transfers: z.array(z.object({ id, requestId: id, requestRevision: revision, voiceEpoch: revision,
    category: routeCategorySchema, stubId: id, deadline: z.string().datetime(),
    state: z.enum(["trying", "no_answer", "busy", "failed", "canceled"]) }).strict()).max(16).default([]),
  inputs: z.array(z.object({ id, body: text, sequence: revision, fragments: inputFragmentsSchema.optional(), questionId: id.optional(), questionKind: questionKindSchema.optional() }).strict()).max(64),
  callerContext: z.array(z.object({ sourceId: id, text: z.string().trim().min(1).max(160), historical: z.literal(true), verified: z.literal(false) }).strict()).max(8).default([]),
  requests: z.array(requestSchema).max(16), messages: z.array(messageSchema).max(64), recoveries: z.array(recoverySchema).max(3),
  primaryMedia: primaryMediaSchema.nullable().default(null),
  messageContinuation: messageContinuationSchema.nullable().default(null),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
}).strict();
export type Conversation = z.infer<typeof conversationSchema>;
export const conversationScopeSchema = z.object({ practiceId: id, instanceId: id, conversationId: id }).strict();
export type ConversationScope = z.infer<typeof conversationScopeSchema>;
export function scopeOf(c: Conversation): ConversationScope { return { practiceId: c.admission.practiceId, instanceId: c.admission.instanceId, conversationId: c.id }; }

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("monitor.review"), review: speechReviewSchema }).strict(),
  z.object({ type: z.literal("voice.read_presented"), presentation: voiceReadPresentationReceiptSchema }).strict(),
  z.object({ type: z.literal("controlled_transfer.prepare"), attempt: controlledTransferAttemptSchema }).strict(),
  z.object({ type: z.literal("controlled_transfer.dispatch"), transferId: id, state: z.enum(["submitting", "submitted", "unknown"]) }).strict(),
  z.object({ type: z.literal("controlled_transfer.update"), attempt: controlledTransferAttemptSchema }).strict(),
  z.object({ type: z.literal("controlled_transfer.finish"), transferId: id, outcome: controlledOutcomeSchema,
    acceptance: controlledAcceptanceSchema.optional() }).strict(),
  z.object({ type: z.literal("controlled_transfer.abort"), transferId: id }).strict(),
  z.object({ type: z.literal("controlled_transfer.resume"), transferId: id }).strict(),
  z.object({ type: z.literal("simulated_route.record"), outcome: simulatedRouteOutcomeSchema }).strict(),
  z.object({ type: z.literal("monitor.correction_claim"), reviewId: id }).strict(),
  z.object({ type: z.literal("monitor.resolve"), reviewId: id, outcome: text }).strict(),
  z.object({ type: z.literal("request.callback_attempt"), requestId: id, outcome: z.enum(["no_answer", "left_message", "reached", "failed"]), note: text }).strict(),
  z.object({ type: z.literal("evaluation.record"), result: conversationEvaluationRecordSchema }).strict(),
  z.object({ type: z.literal("evaluation.schedule"), version: z.literal(CONVERSATION_EVALUATION_VERSION) }).strict(),
  z.object({ type: z.literal("input.record"), sourceId: id, body: text, fragments: inputFragmentsSchema.optional(), questionId: id.optional() }).strict(),
  z.object({ type: z.literal("question.activate"), questionId: id, kind: questionKindSchema, requestId: id.optional() }).strict(),
  z.object({ type: z.literal("question.clear_verified_identity"), questionId: id, requestId: id }).strict(),
  z.object({ type: z.literal("question.pause_callback"), questionId: id, requestId: id, sourceEventId: id }).strict(),
  z.object({ type: z.literal("clarification.ask") }).strict(),
  z.object({ type: z.literal("public_faq.choice_ask"), requestId: id, sourceEventId: id,
    reference: receptionistPublicFaqReferenceSchema }).strict(),
  z.object({ type: z.literal("public_faq.choice_answer"), requestId: id, sourceEventId: id,
    topic: z.enum(["address", "demo_way_directions", "sample_city_address"]),
    reference: receptionistPublicFaqReferenceSchema }).strict(),
  z.object({ type: z.literal("emergency.assess"), sourceEventId: id,
    classification: z.enum(["caller_emergency", "urgent_unclear"]) }).strict(),
  z.object({ type: z.literal("transfer.start"), transferId: id, requestId: id, requestRevision: revision,
    category: routeCategorySchema, stubId: id, timeoutSeconds: z.number().int().min(1).max(120) }).strict(),
  z.object({ type: z.literal("transfer.finish"), transferId: id, state: z.enum(["no_answer", "busy", "failed", "canceled"]) }).strict(),
  z.object({ type: z.literal("request.draft"), requestId: id, category: routeCategorySchema.optional(),
    fullProposal: fullRequestProposalSchema.optional(), preserveMessageQuestion: z.literal(true).optional(),
    receptionistPublicFaqTopic: receptionistPublicFaqTopicSchema.optional(),
    receptionistPublicFaqReference: receptionistPublicFaqReferenceSchema.optional(),
    sourceEventId: id.optional(), originalSourceEventId: id.optional(), sourceEventIds: z.array(id).min(1).max(8).optional(),
    originalRequest: text.optional(), callbackMessage: z.string().trim().min(1).max(8000).optional(),
    callbackMessageAction: z.enum(["record", "replace"]).optional(), name: z.string().trim().min(1).max(200).optional(),
    callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), clearCallbackNumber: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("request.abandon"), requestId: id, questionId: id, sourceEventId: id }).strict(),
  z.object({ type: z.literal("request.abandon_callback"), requestId: id, resumeRequestId: id, questionId: id, sourceEventId: id }).strict(),
  z.object({ type: z.literal("request.capture_callback_message"), requestId: id, sourceEventId: id, messageSourceEventId: id.optional(), message: z.string().trim().min(1).max(8000).optional(), name: z.string().trim().min(1).max(200).optional(), callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), clearCallbackNumber: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("request.begin_callback_message_replacement"), requestId: id, sourceEventId: id, name: z.string().trim().min(1).max(200).optional(), callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), clearCallbackNumber: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("request.confirm_callback"), requestId: id, callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/), sourceEventId: id }).strict(),
  z.object({ type: z.literal("request.confirm_and_capture_callback"), requestId: id, callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/), sourceEventId: id }).strict(),
  z.object({ type: z.literal("request.capture"), requestId: id }).strict(),
  z.object({ type: z.literal("request.degraded_callback_handoff"), recoveryId: id, sourceRequestId: id, sourceRequestRevision: revision, callbackRequestId: id }).strict(),
  z.object({ type: z.literal("request.supplement"), requestId: id, sourceEventId: id }).strict(),
  z.object({ type: z.literal("request.correct_contact"), requestId: id, sourceEventId: id,
    name: z.string().trim().min(1).max(200).optional(), callbackNumber: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), clearCallbackNumber: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal("request.claim"), requestId: id }).strict(),
  z.object({ type: z.literal("request.complete"), requestId: id, outcome: text }).strict(),
  z.object({ type: z.literal("request.resolve_ai"), requestId: id, requestRevision: revision,
    sourceEventId: id, result: aiResolutionResultSchema }).strict(),
  z.object({ type: z.literal("staff.note"), note: text }).strict(),
  z.object({ type: z.literal("owner.change"), owner: z.enum(["ai", "waiting_for_staff", "staff"]) }).strict(),
  z.object({ type: z.literal("sms.suppression"), suppressed: z.boolean() }).strict(),
  z.object({ type: z.literal("sms.inbound_activity") }).strict(),
  z.object({ type: z.literal("sms.unsupported_media"), sourceId: id, kind: z.enum(["media", "non_text"]).default("media"), mediaCount: unsupportedMediaCount }).strict(),
  z.object({ type: z.literal("sms.queue"), messageId: id, body: text }).strict(),
  z.object({ type: z.literal("emergency.sms_instruction"), messageId: id, sourceEventId: id }).strict(),
  z.object({ type: z.literal("sms.dispatch"), messageId: id, dispatchAttemptId: id, expectedSuppressionRevision: revision }).strict(),
  z.object({ type: z.literal("sms.window_expire"), messageId: id, expectedSuppressionRevision: revision }).strict(),
  z.object({ type: z.literal("sms.receipt"), messageId: id, state: z.enum(["accepted", "delivered", "undelivered", "unknown", "failed"]), providerId: id.optional(), failureReason: failureReason.optional() }).strict(),
  z.object({ type: z.literal("sms.release_hold"), messageId: id, note: text }).strict(),
  z.object({ type: z.literal("voice.recover"), recoveryId: id, fromEpoch: revision, parentCallId: id, childCallId: id,
    failureDomain: recoveryFailureDomainSchema.optional() }).strict(),
  z.object({ type: z.literal("voice.recovery_state"), recoveryId: id, state: z.enum(["redirecting", "attached", "outcome_unknown"]), attachmentId: id.optional() }).strict(),
  z.object({ type: z.literal("voice.recovery_document_issue"), recoveryId: id }).strict(),
  z.object({ type: z.literal("voice.scripted_no_input"), recoveryId: id, expectedAttempts: z.number().int().min(0).max(2) }).strict(),
  z.object({ type: z.literal("voice.relay_end"), recoveryId: id, sourceEventId: id, semanticIntent: z.enum(["explicit_exit", "final_decline"]).optional(), invitationCompleted: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("voice.late_evidence"), recoveryId: id, providerEventId: id, observedState: z.enum(["attached", "failed", "disconnected"]) }).strict(),
  z.object({ type: z.literal("voice.message_continue"), continuationId: id, fromAttachmentId: id,
    sourceEventId: id, mode: z.enum(["inline", "fresh"]), reason: z.enum(["closed_hours", "route_unavailable", "clarification_exhausted"]).optional(),
    streamId: twilioStreamId.optional(), transferId: id.optional(),
    capabilityDigest: sha256.optional(), expiresAt: z.string().datetime({ offset: true }).optional() }).strict(),
  z.object({ type: z.literal("voice.message_attach"), continuationId: id, streamId: twilioStreamId,
    parentCallId: id, accountId: id, capabilityDigest: sha256, profileSha256: sha256 }).strict(),
  z.object({ type: z.literal("voice.message_document_issue"), continuationId: id }).strict(),
  z.object({ type: z.literal("voice.message_end"), continuationId: id, sourceEventId: id,
    semanticIntent: z.enum(["explicit_exit", "final_decline"]), invitationCompleted: z.boolean() }).strict(),
  z.object({ type: z.literal("voice.primary_media.issue"), attachmentId: id, parentCallId: id, accountId: id,
    capabilityDigest: sha256, expiresAt: z.string().datetime({ offset: true }), profileSha256: sha256, configVersion: id }).strict(),
  z.object({ type: z.literal("voice.primary_media.attach"), attachmentId: id, parentCallId: id, accountId: id,
    streamId: twilioStreamId, capabilityDigest: sha256, profileSha256: sha256, configVersion: id }).strict(),
  z.object({ type: z.literal("voice.primary_media.bind_session"), attachmentId: id, streamId: twilioStreamId,
    modelSessionId: id, configFingerprint: sha256, inputPipelineArmed: z.literal(true) }).strict(),
  z.object({ type: z.literal("voice.primary_media.opening"), attachmentId: id, streamId: twilioStreamId, modelSessionId: id,
    presentationId: id, state: z.enum(["issued", "playing", "completed", "interrupted", "failed"]), markId: id.optional() }).strict(),
  z.object({ type: z.literal("voice.primary_media.close"), attachmentId: id, streamId: twilioStreamId.optional(),
    reason: z.enum(["carrier_transition", "carrier_terminal", "model_failure", "superseded"]) }).strict(),
  z.object({ type: z.literal("conversation.heartbeat"), voiceEpoch: revision, leaseUntil: z.string().datetime() }).strict(),
  z.object({ type: z.literal("conversation.disconnect") }).strict(),
]);
export type ConversationCommand = z.infer<typeof commandSchema>;
export const commandEnvelopeSchema = z.object({
  scope: conversationScopeSchema, eventId: id, expectedRevision: revision, expectedOwnerEpoch: revision,
  actor: z.object({ kind: z.enum(["ai", "staff", "system", "provider"]), id }).strict(),
  proposal: z.object({ invocationId: id, tool: id, sourceId: id, model: id, provider: z.literal("openai"), promptVersion: id,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/), arguments: z.record(z.union([z.string().max(8000), z.boolean(), z.number().finite(), z.null()])) }).strict().optional(),
  command: commandSchema,
}).strict();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
/** Non-ending dialogue which may create an otherwise empty receptionist clarification draft. */
export const EMPTY_RECEPTIONIST_CLARIFICATION_SCAFFOLD_DIALOGUE_KINDS = [
  "clarify_request", "explain_purpose", "clarify_message", "repeat", "repair", "retry",
] as const;
export function isEmptyReceptionistClarificationScaffoldDialogue(proposal: CommandEnvelope["proposal"] | undefined): boolean {
  return proposal?.tool === "propose_receptionist_dialogue"
    && typeof proposal.arguments === "object" && proposal.arguments !== null
    && "kind" in proposal.arguments
    && typeof proposal.arguments.kind === "string"
    && (EMPTY_RECEPTIONIST_CLARIFICATION_SCAFFOLD_DIALOGUE_KINDS as readonly string[]).includes(proposal.arguments.kind);
}
export type ConversationEvent = { id: string; conversationId: string; revision: number; actor: CommandEnvelope["actor"]; command: ConversationCommand; occurredAt: string };
export class ConversationConflict extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ConversationConflict"; }
}
function requireCondition(ok: unknown, code: string): asserts ok {
  if (!ok) throw new ConversationConflict(code);
}

export function newConversation(admission: Admission, conversationId: string, now: string): Conversation {
  return conversationSchema.parse({ schemaVersion: 1, id: conversationId, admission: admissionSchema.parse(admission),
    revision: 0, ownerEpoch: 0, voiceEpoch: 0, owner: "ai", staffActor: null, phase: "active", activityLeaseUntil: null,
    providerTier: "realtime", suppressed: false, suppressionRevision: 0, lastInboundAt: null, unsupportedMediaCount: 0, unsupportedNonTextCount: 0, emergency: null, pendingQuestion: null, questionIds: [], inputs: [], requests: [], messages: [], recoveries: [], primaryMedia: null, createdAt: now, updatedAt: now });
}

export const unsupportedMediaNotice = "This demo supports text messages only. Please type how I can help.";
export function unsupportedMediaNoticeId(sourceId: string): string { return `media-notice-${sourceId}`; }

// Actor and scope come from authenticated transport/session context, never model arguments.
/** Current draft information is source-bound, not restricted to a contact-question kind. */
function currentReceptionistAtomSource(current: Conversation, request: Conversation["requests"][number] | undefined,
  source: Conversation["inputs"][number] | undefined): boolean {
  if (current.admission.mode !== "receptionist" || current.admission.channel !== "voice"
    || current.phase !== "active" || current.owner !== "ai" || current.suppressed || current.emergency !== null
    || request?.state !== "draft" || request.callbackConfirmed || source === undefined
    || source.id !== current.inputs.at(-1)?.id || source.sequence < request.proposalRevision
    || current.requests.filter(item => item.state === "draft" && item.fullProposal === undefined).length !== 1) return false;
  const question = current.pendingQuestion;
  return question === null ? source.questionId === undefined
    : question.requestId === request.id && question.requestRevision === request.revision
      && source.questionId === question.id && source.sequence > question.activatedRevision;
}

export function applyConversationCommand(current: Conversation, raw: CommandEnvelope, now: string): Conversation {
  const input = commandEnvelopeSchema.parse(raw);
  const { command: cmd, actor } = input;
  requireCondition(input.scope.practiceId === current.admission.practiceId && input.scope.instanceId === current.admission.instanceId && input.scope.conversationId === current.id, "scope_mismatch");
  requireCondition(current.revision === input.expectedRevision, "stale_revision");
  requireCondition(current.ownerEpoch === input.expectedOwnerEpoch, "stale_owner_epoch");
  const next = structuredClone(current);
  const isSystem = actor.kind === "system";
  const isProvider = actor.kind === "provider";
  const isStaff = actor.kind === "staff";
  if ("clearCallbackNumber" in cmd && cmd.clearCallbackNumber === true) {
    requireCondition(cmd.callbackNumber === undefined, "callback_number_clear_conflicts_with_set");
    const request = current.requests.find(item => item.id === cmd.requestId);
    const source = current.inputs.find(item => item.id === cmd.sourceEventId);
    const question = current.pendingQuestion;
    requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && request !== undefined && source !== undefined && source.id === current.inputs.at(-1)?.id && question !== null
      && question.requestId === request.id && question.requestRevision === request.revision
      && ["message", "name", "callback_number_entry", "callback_number"].includes(question.kind)
      && source.questionId === question.id && source.sequence > question.activatedRevision,
    "callback_number_invalidation_unavailable");
  }
  if (actor.kind === "ai") {
    requireCondition(current.owner === "ai" && current.phase === "active" && !current.suppressed, "ai_not_owner");
    requireCondition(["request.draft", "request.capture", "request.capture_callback_message", "request.begin_callback_message_replacement", "request.supplement", "request.correct_contact", "sms.queue", "emergency.assess"].includes(cmd.type), "ai_command_denied");
  }
  if (current.emergency !== null && ["question.activate", "clarification.ask", "public_faq.choice_ask", "public_faq.choice_answer", "transfer.start", "request.draft", "request.capture", "request.capture_callback_message", "request.supplement", "request.correct_contact", "request.confirm_callback", "request.confirm_and_capture_callback", "sms.queue"].includes(cmd.type)) requireCondition(false, "emergency_active");
  if (cmd.type === "evaluation.schedule") {
    requireCondition(isSystem && current.phase !== "active" && current.admission.channel === "voice", "evaluation_schedule_unavailable");
    const id = evaluationId(scopeOf(current), cmd.version);
    requireCondition(!next.evaluations.some((item) => item.id === id), "evaluation_already_scheduled");
    next.evaluations.push({ id, version: cmd.version, scope: scopeOf(current), createdFromRevision: current.revision + 1,
      state: "pending", verdict: null, reasons: [], checks: null, incompleteRequestCount: null });
  } else if (cmd.type === "evaluation.record") {
    requireCondition(isSystem && current.phase !== "active", "evaluation_unavailable");
    const result = cmd.result;
    const index = next.evaluations.findIndex((item) => item.id === result.id);
    const existing = index < 0 ? undefined : next.evaluations[index]!;
    const idempotentCompletedReplay = existing?.state === "completed" && JSON.stringify(existing) === JSON.stringify(result);
    requireCondition(result.scope.practiceId === current.admission.practiceId && result.scope.instanceId === current.admission.instanceId && result.scope.conversationId === current.id
      && result.id === evaluationId(scopeOf(current), result.version) && (result.createdFromRevision === current.revision || idempotentCompletedReplay), "evaluation_binding_invalid");
    requireCondition(index >= 0 && result.state !== "pending", "evaluation_not_scheduled");
    requireCondition(existing!.state !== "completed" || idempotentCompletedReplay, "evaluation_already_completed");
    next.evaluations[index] = result;
  } else if (cmd.type === "request.callback_attempt") {
    requireCondition(isStaff, "staff_required");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    requireCondition(request?.state === "in_progress" && request.owner === actor.id, "callback_attempt_owner_required");
    // The append-only command is the evidence; reaching someone does not itself complete their request.
  } else if (cmd.type === "simulated_route.record") {
    const outcome = cmd.outcome;
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.admission.channel === "voice" && current.phase === "active"
      && current.owner === "ai" && current.emergency === null && !current.suppressed, "simulated_route_unavailable");
    requireCondition(outcome.instanceId === current.admission.instanceId && outcome.conversationId === current.id
      && outcome.ownerEpoch === current.ownerEpoch, "simulated_route_binding_invalid");
    const request = next.requests.find((item) => item.id === outcome.requestId);
    requireCondition(request?.state === "draft" && request.revision === outcome.requestRevision
      && request.category === outcome.category, "simulated_route_request_stale");
    requireCondition(request!.sourceIds.includes(outcome.sourceId), "simulated_route_source_invalid");
    const expectedBinding = simulatedRouteBindingKey({ practiceId: current.admission.practiceId, ...outcome });
    requireCondition(outcome.bindingKey === expectedBinding, "simulated_route_binding_invalid");
    const prior = next.simulatedRouteOutcomes.find((item) => item.bindingKey === outcome.bindingKey);
    requireCondition(prior === undefined || JSON.stringify(prior) === JSON.stringify(outcome), "simulated_route_conflict");
    if (prior === undefined) {
      const supersededIds = new Set(next.simulatedRouteOutcomes.flatMap((item) => item.supersedesId === null ? [] : [item.supersedesId]));
      const currentRoute = next.simulatedRouteOutcomes.find((item) => item.requestId === outcome.requestId && !supersededIds.has(item.id));
      requireCondition((currentRoute === undefined && outcome.supersedesId === null)
        || (currentRoute !== undefined && outcome.supersedesId === currentRoute.id), "simulated_route_supersession_invalid");
      requireCondition(next.simulatedRouteOutcomes.length < 16, "conversation_capacity_reached");
      next.simulatedRouteOutcomes.push(outcome);
    }
    // A simulated route is evidence about the synthetic route only. It cannot claim
    // a saved message, caller contact, staff ownership, reach, or resolution.
  } else if (cmd.type === "controlled_transfer.prepare") {
    const a = cmd.attempt;
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null
      && current.admission.hours === "demo_open", "controlled_transfer_unavailable");
    requireCondition(a.scope.practiceId === current.admission.practiceId && a.scope.instanceId === current.admission.instanceId
      && a.scope.conversationId === current.id && a.ownerEpoch === current.ownerEpoch && a.voiceEpoch === current.voiceEpoch + 1
      && a.parentCallId === current.admission.externalId && a.sourceSnapshot.configuredSourceE164 === current.admission.destination
      && a.sourceSnapshot.callerE164 === current.admission.contact && a.destinationE164 !== current.admission.destination
      && a.destinationE164 !== current.admission.contact && a.state === "prepared" && a.childCallId === null
      && Date.parse(a.issuedAt) <= Date.parse(now) && Date.parse(a.deadlineAt) > Date.parse(now), "controlled_transfer_binding_invalid");
    const request = current.requests.find((item) => item.id === a.requestId);
    requireCondition(request?.state === "draft" && request.revision === a.requestRevision && request.category === a.category, "controlled_transfer_request_invalid");
    requireCondition(!current.controlledTransfers.some((item) => item.outcome === null && item.dispatch !== "aborted" || item.attempt.id === a.id)
      && !current.transfers.some((item) => item.state === "trying") && current.controlledTransfers.length < 8, "controlled_transfer_busy");
    next.controlledTransfers.push({ attempt: a, dispatch: "prepared", outcome: null, acceptance: null, resumedVoiceEpoch: null });
    next.voiceEpoch += 1;
    next.activityLeaseUntil = null;
    next.pendingQuestion = null;
  } else if (cmd.type === "controlled_transfer.abort") {
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && current.admission.voicePlayback === "primary_media" && current.phase === "active" && current.owner === "ai"
      && !current.suppressed && current.emergency === null, "controlled_transfer_abort_denied");
    const record = next.controlledTransfers.find(item => item.attempt.id === cmd.transferId);
    const media = next.primaryMedia;
    requireCondition(record !== undefined && record.outcome === null && ["prepared", "submitting"].includes(record.dispatch)
      && record.attempt.ownerEpoch === current.ownerEpoch && record.attempt.voiceEpoch === current.voiceEpoch
      && media?.state === "model_bound" && media.ownerEpoch === current.ownerEpoch
      && media.voiceEpoch + 1 === current.voiceEpoch && media.streamId !== null && media.modelSessionId !== null
      && media.inputPipelineArmed, "controlled_transfer_abort_stale");
    record!.dispatch = "aborted";
    media!.voiceEpoch = current.voiceEpoch;
  } else if (cmd.type === "controlled_transfer.resume") {
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.phase === "active" && current.owner === "ai"
      && current.emergency === null && !current.suppressed, "controlled_transfer_unavailable");
    const record = next.controlledTransfers.find((item) => item.attempt.id === cmd.transferId);
    requireCondition(record !== undefined && record.outcome !== null && record.outcome !== "accepted"
      && record.attempt.ownerEpoch === current.ownerEpoch, "controlled_transfer_resume_invalid");
    const active = record!;
    if (active.resumedVoiceEpoch !== null) requireCondition(active.resumedVoiceEpoch === current.voiceEpoch, "controlled_transfer_stale");
    else {
      requireCondition(active.attempt.voiceEpoch === current.voiceEpoch, "controlled_transfer_stale");
      const request = current.requests.find((item) => item.id === active.attempt.requestId);
      requireCondition(request?.state === "draft" && request.revision === active.attempt.requestRevision, "controlled_transfer_request_invalid");
      const continuation = current.messageContinuation;
      // An inline callback attachment is superseded when this transfer epoch
      // starts. Retire only that prior attachment; live or fresh attachments
      // remain authority boundaries and must reject the resume.
      requireCondition(continuation === null || continuation.ownerEpoch === current.ownerEpoch
        && continuation.mode === "inline" && continuation.state === "superseded"
        && continuation.voiceEpoch < current.voiceEpoch, "controlled_transfer_resume_continuation_invalid");
      next.messageContinuation = null;
      next.voiceEpoch += 1;
      next.providerTier = "realtime";
      next.activityLeaseUntil = null;
      active.resumedVoiceEpoch = next.voiceEpoch;
      const hasMessage = typeof request!.callbackMessageSourceId === "string"
        && request!.sourceIds.includes(request!.callbackMessageSourceId)
        && next.inputs.some((input) => input.id === request!.callbackMessageSourceId);
      const missingKind = !hasMessage ? "message" : !request!.name ? "name"
        : !request!.callbackNumber ? "callback_number_entry" : !request!.callbackConfirmed ? "callback_number" : null;
      if (missingKind === null) next.pendingQuestion = null;
      else {
        const questionId = "transfer-callback-" + active.attempt.id;
        requireCondition(!next.questionIds.includes(questionId) && next.questionIds.length < 64, "conversation_capacity_reached");
        next.questionIds.push(questionId);
        next.pendingQuestion = { id: questionId, kind: missingKind,
          requestId: request!.id, requestRevision: request!.revision, callbackNumber: request!.callbackNumber || null, activatedRevision: current.revision + 1 };
      }
    }
  } else if (cmd.type === "controlled_transfer.dispatch" || cmd.type === "controlled_transfer.update" || cmd.type === "controlled_transfer.finish") {
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.phase === "active" && current.owner === "ai"
      && !current.suppressed && current.emergency === null, "controlled_transfer_unavailable");
    const record = next.controlledTransfers.find((item) => item.attempt.id === (cmd.type === "controlled_transfer.update" ? cmd.attempt.id : cmd.transferId));
    requireCondition(record !== undefined && record.outcome === null && record.attempt.ownerEpoch === current.ownerEpoch
      && record.attempt.voiceEpoch === current.voiceEpoch, "controlled_transfer_stale");
    const active = record!;
    const request = current.requests.find((item) => item.id === active.attempt.requestId);
    requireCondition(request?.state === "draft" && request.revision === active.attempt.requestRevision, "controlled_transfer_request_invalid");
    if (cmd.type === "controlled_transfer.dispatch") {
      requireCondition(cmd.state === "submitting" ? active.dispatch === "prepared" : active.dispatch === "submitting", "controlled_transfer_dispatch_invalid");
      active.dispatch = cmd.state;
    } else if (cmd.type === "controlled_transfer.update") {
      const { childCallId: oldChild, state: oldState, ...oldBinding } = active.attempt;
      const { childCallId: newChild, state: newState, ...newBinding } = cmd.attempt;
      requireCondition(JSON.stringify(oldBinding) === JSON.stringify(newBinding) && newChild !== null
        && newChild !== active.attempt.parentCallId && (oldChild === null || oldChild === newChild)
        && ["submitting", "submitted", "unknown"].includes(active.dispatch)
        && (oldState === "prepared" ? newState !== "prepared" : oldState === "ringing" ? newState !== "prepared" : newState === "answered"), "controlled_transfer_evidence_invalid");
      active.attempt = cmd.attempt;
    } else {
      requireCondition(active.dispatch !== "prepared", "controlled_transfer_not_dispatched");
      if (cmd.outcome === "accepted") {
        const proof = cmd.acceptance;
        requireCondition(active.attempt.state === "answered" && proof !== undefined && proof.recipientId === active.attempt.recipientId
          && proof.childCallId === active.attempt.childCallId && Date.parse(proof.acceptedAt) >= Date.parse(active.attempt.issuedAt)
          && Date.parse(proof.acceptedAt) <= Date.parse(active.attempt.deadlineAt) && Date.parse(proof.acceptedAt) <= Date.parse(now), "controlled_transfer_acceptance_invalid");
        active.acceptance = proof!;
      } else requireCondition(cmd.acceptance === undefined, "controlled_transfer_acceptance_invalid");
      active.outcome = cmd.outcome;
    }
  } else if (cmd.type === "voice.read_presented") {
    const p = cmd.presentation;
    requireCondition(isSystem && current.admission.mode === "full" && current.admission.channel === "voice"
      && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null, "voice_read_presentation_unavailable");
    requireCondition(p.ownerEpoch === current.ownerEpoch && p.voiceEpoch === current.voiceEpoch, "voice_read_presentation_stale");
    const request = current.requests.find((item) => item.id === p.requestId);
    const review = current.speechReviews.find((item) => item.id === p.reviewId);
    const check = review?.protectedReadCheck;
    requireCondition(request?.state === "draft" && request.revision === p.requestRevision && review?.verdict === "clear"
      && review.responseId === p.responseId && review.outputItemId === p.outputItemId && review.voiceEpoch === p.voiceEpoch
      && check?.status === "matched" && check.directiveId === p.directiveId && check.receiptId === p.receiptId
      && check.requestId === p.requestId && check.requestRevision === p.requestRevision, "voice_read_presentation_unverified");
    const existing = current.voiceReadPresentations.find((item) => item.id === p.id);
    requireCondition(existing === undefined || JSON.stringify(existing) === JSON.stringify(p), "voice_read_presentation_conflict");
    if (!existing) {
      requireCondition(next.voiceReadPresentations.length < 16, "conversation_capacity_reached");
      next.voiceReadPresentations.push(p);
    }
  } else if (cmd.type === "monitor.review") {
    requireCondition(isSystem, "system_required");
    requireCondition(cmd.review.scope.practiceId === current.admission.practiceId && cmd.review.scope.instanceId === current.admission.instanceId && cmd.review.scope.conversationId === current.id, "monitor_scope_mismatch");
    requireCondition(current.admission.channel === "voice" && cmd.review.authorityRevision <= current.revision && cmd.review.voiceEpoch <= current.voiceEpoch, "monitor_authority_invalid");
    const existing = next.speechReviews.find((review) => review.id === cmd.review.id);
    if (existing === undefined) {
      requireCondition(next.speechReviews.length < 256 && ["pending", "not_required"].includes(cmd.review.correction), "monitor_initial_state_invalid");
      next.speechReviews.push(cmd.review);
    } else {
      const { correction: oldCorrection, ...original } = existing;
      const { correction, ...proposed } = cmd.review;
      requireCondition(JSON.stringify(original) === JSON.stringify(proposed), "monitor_payload_conflict");
      requireCondition(oldCorrection === correction || oldCorrection === "attempting" && ["generated", "unheard"].includes(correction), "monitor_correction_transition_invalid");
      existing.correction = correction;
    }
  } else if (cmd.type === "monitor.correction_claim") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && current.emergency === null, "monitor_correction_unavailable");
    const review = next.speechReviews.find((item) => item.id === cmd.reviewId);
    requireCondition(review?.correction === "pending" && review.verdict === "confirmed" && review.voiceEpoch === current.voiceEpoch, "monitor_correction_stale");
    requireCondition(!next.speechReviews.some((item) => item.correction === "attempting"), "monitor_correction_busy");
    review.correction = "attempting";
  } else if (cmd.type === "monitor.resolve") {
    requireCondition(isStaff, "staff_required");
    const review = next.speechReviews.find((item) => item.id === cmd.reviewId);
    requireCondition(review && review.verdict !== "clear" && review.correction !== "staff_resolved", "monitor_review_missing");
    review.correction = "staff_resolved";
  } else if (cmd.type === "input.record") {
    requireCondition(isProvider || isSystem, "provider_input_required");
    if (isProvider && current.admission.channel === "sms") next.lastInboundAt = now;
    const existing = next.inputs.find((i) => i.id === cmd.sourceId);
    requireCondition(existing === undefined || (existing.body === cmd.body && existing.questionId === cmd.questionId && JSON.stringify(existing.fragments) === JSON.stringify(cmd.fragments)), "input_id_conflict");
    if (cmd.fragments !== undefined) {
      requireCondition(cmd.fragments.map((fragment) => fragment.body).join(" ") === cmd.body
        && new Set(cmd.fragments.map((fragment) => fragment.sourceId)).size === cmd.fragments.length
        && cmd.fragments.every((fragment) => !current.inputs.some((input) => input.id === fragment.sourceId
          || input.id !== cmd.sourceId && input.fragments?.some((prior) => prior.sourceId === fragment.sourceId))), "input_fragments_invalid");
    }
    if (existing === undefined) {
      requireCondition(next.inputs.length < 64, "conversation_capacity_reached");
      next.inputs.push({ id: cmd.sourceId, body: cmd.body, sequence: current.revision + 1,
        ...(cmd.fragments === undefined ? {} : { fragments: structuredClone(cmd.fragments) }),
        ...(cmd.questionId ? { questionId: cmd.questionId } : {}),
        ...(cmd.questionId !== undefined && cmd.questionId === current.pendingQuestion?.id ? { questionKind: current.pendingQuestion.kind } : {}) });
      if (current.admission.channel === "voice") {
        next.callerContext = next.inputs
          .filter((item) => !item.questionId || item.questionKind === "patient_status"
            || item.questionKind === "request_clarification" || item.questionKind === "slot_selection")
          .slice(-8)
          .map((item) => ({ sourceId: item.id, text: item.body.trim().slice(0, 160), historical: true as const, verified: false as const }))
          .filter((item) => item.text.length > 0);
      }
      if (current.providerTier === "scripted") {
        const recovery = next.recoveries.find((item) => item.target === "scripted" && item.state === "attached" && item.fromEpoch + 1 === current.voiceEpoch);
        if (recovery !== undefined) recovery.scriptedEmptyAttempts = 0;
      }
    }
    const question = current.pendingQuestion;
    if ((current.admission.mode === "full" || current.admission.mode === "receptionist" && question?.kind === "request_clarification")
      && current.phase === "active" && current.owner === "ai"
      && cmd.questionId !== undefined && question?.id === cmd.questionId && question.requestId !== null && question.requestRevision !== null) {
      const request = next.requests.find((item) => item.id === question.requestId);
      requireCondition(request?.state === "draft" && request.revision === question.requestRevision, "pending_question_request_invalid");
      // Verification and selection replies are provenance, not a request edit.
      if (!request.sourceIds.includes(cmd.sourceId)) {
        requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached");
        request.sourceIds.push(cmd.sourceId);
      }
    }
  } else if (cmd.type === "clarification.ask") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai", "system_active_required");
    requireCondition(current.clarificationCount === 0, "clarification_limit_reached");
    next.clarificationCount = 1;
  } else if (cmd.type === "public_faq.choice_ask") {
    const request = current.requests.find(item => item.id === cmd.requestId);
    const faq = request?.receptionistPublicFaq;
    const locationsReferenceCurrent = faq?.topic === "locations"
      && faq.packId === cmd.reference.packId && faq.packVersion === cmd.reference.packVersion
      && faq.factId === cmd.reference.factId && faq.factVersion === cmd.reference.factVersion
      && faq.knowledgeSourceId === cmd.reference.knowledgeSourceId
      && faq.knowledgeSourceVersion === cmd.reference.knowledgeSourceVersion
      && faq.contentHash === cmd.reference.contentHash
      && faq.ownerEpoch === current.ownerEpoch && faq.voiceEpoch === current.voiceEpoch;
    const draftLocationsQuestion = request?.state === "draft" && locationsReferenceCurrent
      && faq?.sourceId === cmd.sourceEventId && faq?.sourceRevision <= current.revision;
    const savedLocationsQuestion = request?.state === "needs_callback" && request.confirmationSourceId === cmd.sourceEventId;
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && current.phase === "active" && current.owner === "ai" && !current.suppressed
      && current.publicFaqChoice === null && current.clarificationCount === 0
      && current.inputs.at(-1)?.id === cmd.sourceEventId && (draftLocationsQuestion || savedLocationsQuestion), "public_faq_choice_unavailable");
    next.publicFaqChoice = { requestId: cmd.requestId, sourceId: cmd.sourceEventId, sourceRevision: current.revision,
      ownerEpoch: current.ownerEpoch, voiceEpoch: current.voiceEpoch, questionTopic: "locations",
      reference: cmd.reference, state: "asked" };
    next.clarificationCount = 1;
  } else if (cmd.type === "public_faq.choice_answer") {
    const choice = current.publicFaqChoice;
    const request = current.requests.find(item => item.id === cmd.requestId);
    const source = current.inputs.at(-1);
    const activeDraft = request?.state === "draft";
    const savedCallback = request?.state === "needs_callback" && request.confirmationSourceId === choice?.sourceId;
    requireCondition(isSystem && current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && current.phase === "active" && current.owner === "ai" && !current.suppressed
      && choice?.state === "asked" && choice.requestId === cmd.requestId && choice.ownerEpoch === current.ownerEpoch
      && choice.voiceEpoch === current.voiceEpoch && choice.sourceId !== cmd.sourceEventId
      && source?.id === cmd.sourceEventId && source.sequence > choice.sourceRevision
      && (activeDraft || savedCallback), "public_faq_choice_stale");
    next.publicFaqChoice = { ...choice, state: "answered", answerSourceId: cmd.sourceEventId,
      answerTopic: cmd.topic, answerReference: cmd.reference };
  } else if (cmd.type === "emergency.assess") {
    requireCondition(actor.kind === "ai" && current.phase === "active" && current.owner === "ai" && !current.suppressed, "emergency_assessment_denied");
    const source = next.inputs.at(-1);
    requireCondition(source?.id === cmd.sourceEventId, "emergency_source_not_current");
    requireCondition(current.emergency === null, "emergency_already_active");
    if (cmd.classification === "caller_emergency") {
      next.emergency = { sourceEventId: source.id, declaredRevision: current.revision + 1 };
      next.pendingQuestion = null;
      for (const transfer of next.transfers) if (transfer.state === "trying") transfer.state = "canceled";
      for (const message of next.messages) if (message.state === "queued") message.state = "canceled";
    } else {
      requireCondition(current.clarificationCount === 0, "clarification_limit_reached");
      next.clarificationCount = 1;
    }
  } else if (cmd.type === "transfer.start") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai", "system_active_required");
    requireCondition(current.admission.channel === "voice" && current.admission.hours === "demo_open", "stub_transfer_unavailable");
    const request = next.requests.find((r) => r.id === cmd.requestId);
    requireCondition(request?.state === "draft" && request.revision === cmd.requestRevision && request.category === cmd.category, "transfer_request_mismatch");
    requireCondition(!next.transfers.some((t) => t.id === cmd.transferId || t.state === "trying"), "transfer_already_started");
    requireCondition(next.transfers.length < 16, "conversation_capacity_reached");
    next.transfers.push({ id: cmd.transferId, requestId: cmd.requestId, requestRevision: cmd.requestRevision, voiceEpoch: current.voiceEpoch,
      category: cmd.category, stubId: cmd.stubId, deadline: new Date(Date.parse(now) + cmd.timeoutSeconds * 1000).toISOString(), state: "trying" });
    next.pendingQuestion = null;
  } else if (cmd.type === "transfer.finish") {
    requireCondition(isSystem && current.phase === "active", "system_active_required");
    const transfer = next.transfers.find((t) => t.id === cmd.transferId);
    requireCondition(transfer?.state === "trying" && transfer.voiceEpoch === current.voiceEpoch, "transfer_missing_or_stale");
    if (cmd.state === "no_answer") requireCondition(Date.parse(now) >= Date.parse(transfer.deadline), "transfer_timeout_not_due");
    transfer.state = cmd.state;
  } else if (cmd.type === "question.activate") {
    requireCondition(isSystem && current.phase === "active", "system_active_required");
    if (cmd.kind === "request_clarification" && current.admission.mode === "receptionist") {
      requireCondition(current.clarificationCount === 0, "clarification_limit_reached");
      next.clarificationCount = 1;
    }
    requireCondition(!next.questionIds.includes(cmd.questionId), "question_id_reused");
    requireCondition(next.questionIds.length < 64, "conversation_capacity_reached");
    next.questionIds.push(cmd.questionId);
    const request = next.requests.find((r) => r.id === cmd.requestId);
    if (cmd.requestId !== undefined) requireCondition(request, "question_request_missing");
    if (["patient_status", "identity_dob", "identity_zip", "slot_selection", "appointment_consent", "attendance_consent"].includes(cmd.kind)
      || cmd.kind === "request_clarification" && current.admission.mode !== "receptionist") {
      requireCondition(current.admission.mode === "full", "full_capability_unavailable");
    }
    if (cmd.kind !== "general") requireCondition(request?.state === "draft", "question_request_incomplete");
    if (cmd.kind === "callback_number") requireCondition(request!.callbackNumber, "callback_question_incomplete");
    next.pendingQuestion = { id: cmd.questionId, kind: cmd.kind, requestId: request?.id ?? null, requestRevision: request?.revision ?? null,
      callbackNumber: cmd.kind === "callback_number" ? request!.callbackNumber : null, activatedRevision: current.revision + 1 };
  } else if (cmd.type === "question.clear_verified_identity") {
    requireCondition(isSystem && current.phase === "active", "system_active_required");
    requireCondition(current.pendingQuestion?.id === cmd.questionId && current.pendingQuestion.requestId === cmd.requestId
      && ["identity_dob", "identity_zip"].includes(current.pendingQuestion.kind), "identity_question_mismatch");
    next.pendingQuestion = null;
  } else if (cmd.type === "question.pause_callback") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai"
      && current.admission.mode === "full" && current.admission.channel === "voice" && current.providerTier === "realtime"
      && !current.suppressed && current.emergency === null, "callback_pause_unavailable");
    const question = current.pendingQuestion;
    const request = current.requests.find((item) => item.id === cmd.requestId);
    const source = current.inputs.at(-1);
    requireCondition(question?.id === cmd.questionId && question.requestId === cmd.requestId
      && ["name", "message", "callback_number_entry", "callback_number"].includes(question.kind)
      && request?.state === "draft" && question.requestRevision === request.revision
      && source?.id === cmd.sourceEventId && source.questionId === question.id
      && source.sequence > question.activatedRevision && request.sourceIds.includes(source.id), "callback_pause_question_mismatch");
    next.requests.find((item) => item.id === request.id)!.pausedCallbackSourceId = source.id;
    next.pendingQuestion = null;
  } else if (cmd.type === "request.degraded_callback_handoff") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null,
      "degraded_handoff_owner_denied");
    const recovery = current.recoveries.find((item) => item.id === cmd.recoveryId);
    requireCondition(recovery?.target === "scripted" && recovery.state === "attached" && recovery.fromEpoch + 1 === current.voiceEpoch
      && current.providerTier === "scripted", "degraded_handoff_recovery_invalid");
    const source = current.requests.find((item) => item.id === cmd.sourceRequestId);
    requireCondition(source?.state === "draft" && source.revision === cmd.sourceRequestRevision && source.fullProposal !== undefined
      && (source.aiResolution === null || source.aiResolution === undefined), "degraded_handoff_source_invalid");
    requireCondition(source.owner === null && source.outcome === null && !current.transfers.some((item) => item.requestId === source.id),
      "degraded_handoff_source_executed");
    requireCondition(source.sourceIds.length > 0 && source.sourceIds.every((sourceId) => current.inputs.some((input) => input.id === sourceId)),
      "degraded_handoff_provenance_invalid");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.recoveryId === recovery.id || item.degradedHandoff?.sourceRequestId === source.id)
      && !current.requests.some((item) => item.id === cmd.callbackRequestId), "degraded_handoff_duplicate");
    requireCondition(next.requests.length < 16, "conversation_capacity_reached");
    const messageSourceId = source.callbackMessageSourceId ?? null;
    const hasSourceBackedMessage = messageSourceId !== null
      && source.sourceIds.includes(messageSourceId)
      && current.inputs.some((input) => input.id === messageSourceId);
    const hasCapturedCallbackNumber = /^\+[1-9]\d{7,14}$/.test(source.callbackNumber);
    if (source.callbackConfirmed) {
      requireCondition(/^\+[1-9]\d{7,14}$/.test(source.callbackNumber) && source.confirmationSourceId !== null
        && source.sourceIds.includes(source.confirmationSourceId)
        && current.inputs.some((input) => input.id === source.confirmationSourceId), "degraded_handoff_contact_invalid");
    }
    next.requests.push({ id: cmd.callbackRequestId, revision: 0, category: null, originalRequest: source.originalRequest,
      name: source.name, callbackNumber: hasCapturedCallbackNumber ? source.callbackNumber : "", callbackConfirmed: source.callbackConfirmed,
      ...(source.nameSourceId === undefined ? {} : { nameSourceId: source.nameSourceId }),
      ...(hasCapturedCallbackNumber && source.callbackNumberSourceId !== undefined ? { callbackNumberSourceId: source.callbackNumberSourceId } : {}),
      confirmationSourceId: source.callbackConfirmed ? source.confirmationSourceId : null,
      callbackMessageSourceId: hasSourceBackedMessage ? messageSourceId : null,
      ...(hasSourceBackedMessage && source.callbackMessageText !== undefined ? { callbackMessageText: source.callbackMessageText } : {}), owner: null, outcome: null,
      aiResolution: null, sourceIds: [...source.sourceIds], proposalRevision: current.revision + 1,
      degradedHandoff: { recoveryId: recovery.id, sourceRequestId: source.id, sourceRequestRevision: source.revision }, state: "draft" });
  } else if (cmd.type === "request.begin_callback_message_replacement") {
    requireCondition(actor.kind === "ai" && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null,
      "callback_message_owner_denied");
    const request = next.requests.find(item => item.id === cmd.requestId);
    const source = next.inputs.find(item => item.id === cmd.sourceEventId);
    requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice" && request !== undefined && source !== undefined,
      "callback_message_replacement_unavailable");
    requireCondition(request.callbackMessageSourceId != null && currentReceptionistAtomSource(current, request, source),
      "callback_message_question_mismatch");
    if (!request.sourceIds.includes(source.id)) request.sourceIds.push(source.id);
    if (cmd.name !== undefined) {
      if (request.name !== cmd.name || request.nameSourceId === undefined) request.nameSourceId = source!.id;
      request.name = cmd.name;
    }
    if (cmd.callbackNumber !== undefined) {
      if (request.callbackNumber !== cmd.callbackNumber || request.callbackNumberSourceId === undefined) request.callbackNumberSourceId = source!.id;
      request.callbackNumber = cmd.callbackNumber;
    }
    if (cmd.clearCallbackNumber === true) {
      request.callbackNumber = ""; delete request.callbackNumberSourceId; request.callbackConfirmed = false; request.confirmationSourceId = null;
    }
    request.callbackMessageSourceId = null; delete request.callbackMessageText; request.callbackConfirmed = false; request.confirmationSourceId = null;
    request.proposalRevision = current.revision + 1; request.revision += 1; next.pendingQuestion = null;
  } else if (cmd.type === "request.capture_callback_message") {
    requireCondition(actor.kind === "ai" && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null,
      "callback_message_owner_denied");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    const source = next.inputs.find((item) => item.id === cmd.sourceEventId);
    const question = next.pendingQuestion;
    if (request === undefined) throw new ConversationConflict("request_not_editable");
    if (source === undefined) throw new ConversationConflict("callback_message_question_mismatch");
    requireCondition(request.state === "draft", "request_not_editable");
    requireCondition(cmd.message === undefined || current.admission.mode === "receptionist" && current.admission.channel === "voice", "callback_message_value_unavailable");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id), "degraded_handoff_source_immutable");
    const correctingMessage = current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && request.callbackMessageSourceId != null && question !== null && ["name", "callback_number_entry", "callback_number"].includes(question.kind);
    // A caller can volunteer a message while the native route is still settling.
    // The current, unbound source may populate the draft before any callback question exists.
    const messageSource = cmd.messageSourceEventId === undefined ? source : current.inputs.find((item) => item.id === cmd.messageSourceEventId);
    const soleDraft = current.requests.filter((item) => item.state === "draft" && item.fullProposal === undefined);
    const preQuestionMessage = current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && question === null && request.callbackMessageSourceId === null && soleDraft.length === 1 && soleDraft[0]?.id === request.id
      && source.id === current.inputs.at(-1)?.id && source.questionId === undefined && source.sequence > request.proposalRevision
      && messageSource !== undefined && messageSource.questionId === undefined && messageSource.sequence > request.proposalRevision
      && messageSource.sequence <= source.sequence && !current.requests.some((item) => item.id !== request.id && item.sourceIds.includes(messageSource!.id));
    const bootstrapOriginalSource = current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && question?.kind === "message" && question.requestId === request.id && question.requestRevision === request.revision
      && request.state === "draft" && request.callbackMessageSourceId === null && source?.id === request.sourceIds[0] && source?.id === current.inputs.at(-1)?.id
      && source.questionId === undefined && request.sourceIds.includes(source.id) && source.body === request.originalRequest;
    // A split message can be supplied in an earlier turn of the same active
    // message question while the latest turn supplies only contact details.
    const sameQuestionMessage = current.admission.mode === "receptionist" && current.admission.channel === "voice"
      && question !== null && (question.kind === "message" && request.callbackMessageSourceId === null || correctingMessage)
      && question.requestId === request.id && question.requestRevision === request.revision
      && soleDraft.length === 1 && soleDraft[0]?.id === request.id
      && source.id === current.inputs.at(-1)?.id && source.questionId === question.id
      && messageSource !== undefined && messageSource.questionId === question.id
      && messageSource.sequence > question.activatedRevision && messageSource.sequence <= source.sequence
      && !current.requests.some((item) => item.id !== request.id && item.sourceIds.includes(messageSource!.id));
    requireCondition(cmd.messageSourceEventId === undefined || preQuestionMessage || sameQuestionMessage
      || bootstrapOriginalSource && messageSource?.id === source.id, "callback_message_source_mismatch");
    requireCondition(preQuestionMessage || bootstrapOriginalSource || source?.id === current.inputs.at(-1)?.id && question !== null && (question.kind === "message" || correctingMessage) && question.id === source.questionId
      && question.requestId === request.id && question.requestRevision === request.revision && source.sequence > question.activatedRevision,
    "callback_message_question_mismatch");
    requireCondition(request.callbackMessageSourceId !== source.id && (bootstrapOriginalSource || source.sequence > request.proposalRevision), "callback_message_source_stale");
    if (!request.sourceIds.includes(source.id)) {
      requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached");
      request.sourceIds.push(source.id);
    }
    if (cmd.name !== undefined) {
      if (request.name !== cmd.name || request.nameSourceId === undefined) request.nameSourceId = source!.id;
      request.name = cmd.name;
    }
    if (cmd.callbackNumber !== undefined && (request.callbackNumber !== cmd.callbackNumber || request.callbackNumberSourceId === undefined)) request.callbackNumberSourceId = source!.id;
    if (cmd.callbackNumber !== undefined && cmd.callbackNumber !== request.callbackNumber) {
      request.callbackNumber = cmd.callbackNumber;
      request.callbackConfirmed = false;
      request.confirmationSourceId = null;
    }
    if (cmd.clearCallbackNumber === true) {
      request.callbackNumber = ""; delete request.callbackNumberSourceId; request.callbackConfirmed = false; request.confirmationSourceId = null;
    }
    if (correctingMessage) { request.callbackConfirmed = false; request.confirmationSourceId = null; }
    request.callbackMessageSourceId = messageSource!.id;
    if (messageSource!.id !== source.id && !request.sourceIds.includes(messageSource!.id)) {
      requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached");
      request.sourceIds.push(messageSource!.id);
    }
    if (cmd.message === undefined) delete request.callbackMessageText;
    else request.callbackMessageText = cmd.message;
    request.proposalRevision = current.revision + 1;
    request.revision += 1;
    // Consume the message challenge before the coordinator activates the next field.
    if (next.pendingQuestion?.requestId === request.id) next.pendingQuestion = null;
  } else if (cmd.type === "request.abandon") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && current.admission.mode === "full"
      && current.admission.channel === "voice" && current.providerTier === "realtime" && !current.suppressed && current.emergency === null,
    "request_abandon_unavailable");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    const source = next.inputs.find((item) => item.id === cmd.sourceEventId);
    const question = next.pendingQuestion;
    requireCondition(request !== undefined && source !== undefined, "request_abandon_request_missing");
    requireCondition(request.state === "draft" && (request.fullProposal?.capability === "appointment_schedule"
      || request.fullProposal?.capability === "appointment_reschedule") && request.owner === null && request.outcome === null
      && (request.aiResolution === null || request.aiResolution === undefined) && !request.callbackConfirmed
      && request.confirmationSourceId === null && request.callbackMessageSourceId === null && request.name.length === 0
      && request.callbackNumber.length === 0 && !current.transfers.some((transfer) => transfer.state === "trying"),
    "request_abandon_not_pending");
    requireCondition(question?.id === cmd.questionId && question.kind === "slot_selection" && question.requestId === request.id
      && question.requestRevision === request.revision && source.id === current.inputs.at(-1)?.id && source.questionId === question.id
      && source.sequence > question.activatedRevision && request.sourceIds.includes(source.id), "request_abandon_question_mismatch");
    requireCondition(isExplicitPendingSlotWithdrawal(source.body), "request_abandon_semantic_invalid");
    request.state = "abandoned";
    request.proposalRevision = current.revision + 1;
    request.revision += 1;
    next.pendingQuestion = null;
  } else if (cmd.type === "request.abandon_callback") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && current.admission.mode === "full"
      && current.admission.channel === "voice" && current.providerTier === "realtime" && !current.suppressed && current.emergency === null,
    "callback_abandon_unavailable");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    const resume = next.requests.find((item) => item.id === cmd.resumeRequestId);
    const source = next.inputs.find((item) => item.id === cmd.sourceEventId);
    const question = next.pendingQuestion;
    requireCondition(request !== undefined && resume !== undefined && request.id !== resume.id, "callback_abandon_request_missing");
    if (source === undefined) throw new ConversationConflict("callback_abandon_question_mismatch");
    requireCondition(request.state === "draft" && request.callbackMessageSourceId === null && request.name.length === 0 && request.callbackNumber.length === 0
      && !request.callbackConfirmed && request.confirmationSourceId === null, "callback_abandon_not_empty");
    requireCondition(resume.state === "draft" && (resume.fullProposal?.capability === "appointment_schedule"
      || resume.fullProposal?.capability === "appointment_reschedule"), "callback_abandon_resume_invalid");
    requireCondition(question?.id === cmd.questionId && question.kind === "message" && question.requestId === request.id
      && question.requestRevision === request.revision && source.id === current.inputs.at(-1)?.id && source.questionId === question.id
      && source.sequence > question.activatedRevision && request.sourceIds.includes(source.id), "callback_abandon_question_mismatch");
    request.state = "abandoned";
    request.revision += 1;
    next.pendingQuestion = null;
  } else if (cmd.type === "request.draft" || cmd.type === "request.capture") {
    requireCondition(actor.kind === "ai" || isStaff || isSystem, "request_actor_denied");
    requireCondition(current.phase === "active", "conversation_not_active");
    let request = next.requests.find((r) => r.id === cmd.requestId);
    const creating = request === undefined;
    const source = cmd.type === "request.draft" ? next.inputs.find((i) => i.id === cmd.sourceEventId) : undefined;
    if (cmd.type === "request.draft") requireCondition(source, "request_source_missing");
    if (request === undefined) {
      requireCondition(cmd.type === "request.draft", "request_missing");
      const emptyReceptionistClarificationScaffold = isSystem && current.admission.mode === "receptionist"
        && current.admission.channel === "voice" && cmd.category === undefined && cmd.fullProposal === undefined
        && cmd.callbackMessage === undefined && cmd.callbackMessageAction === undefined && cmd.name === undefined
        && cmd.callbackNumber === undefined && cmd.clearCallbackNumber === undefined && cmd.originalRequest === undefined;
      if (emptyReceptionistClarificationScaffold) {
        const unclearIntentOrigin = input.proposal?.tool === "propose_receptionist_intent"
          && input.proposal.arguments.requestMeaning === "unclear";
        requireCondition(isEmptyReceptionistClarificationScaffoldDialogue(input.proposal) || unclearIntentOrigin,
          "empty_receptionist_clarification_scaffold_origin");
      }
      requireCondition(next.requests.length < 16, "conversation_capacity_reached");
      const sourceIds = cmd.sourceEventIds ?? [source!.id];
      const originalId = cmd.originalSourceEventId ?? source!.id;
      requireCondition(new Set(sourceIds).size === sourceIds.length && sourceIds.includes(source!.id) && sourceIds.includes(originalId), "request_source_bundle_invalid");
      const bundled = sourceIds.map((sourceId) => next.inputs.find((input) => input.id === sourceId));
      requireCondition(bundled.every((input) => input !== undefined), "request_source_missing");
      const original = next.inputs.find((input) => input.id === originalId)!;
      request = { id: cmd.requestId, revision: 0, category: null, originalRequest: original.body, name: "", callbackNumber: "", callbackConfirmed: false, confirmationSourceId: null, callbackMessageSourceId: null, owner: null, outcome: null, aiResolution: null, sourceIds, proposalRevision: current.revision + 1, degradedHandoff: null, state: "draft" };
      next.requests.push(request);
    }
    if (cmd.type === "request.draft") {
      if (cmd.preserveMessageQuestion === true) requireCondition((isSystem || actor.kind === "ai" && ["propose_receptionist_intent", "propose_receptionist_public_faq", "propose_receptionist_capture"].includes(input.proposal?.tool ?? "")) && !creating && current.admission.mode === "receptionist" && current.admission.channel === "voice"
        && current.owner === "ai" && !current.suppressed && current.emergency === null && !request.callbackConfirmed
        && current.pendingQuestion?.kind === "message" && current.pendingQuestion.requestId === request.id
        && current.pendingQuestion.requestRevision === request.revision && source!.questionId === current.pendingQuestion.id
        && source!.id === current.inputs.at(-1)?.id && source!.sequence > current.pendingQuestion.activatedRevision
        && (cmd.name !== undefined || cmd.callbackNumber !== undefined) && cmd.category === undefined && cmd.callbackMessage === undefined && cmd.fullProposal === undefined
        && cmd.originalRequest === undefined && cmd.originalSourceEventId === undefined && cmd.sourceEventIds === undefined
        && (cmd.receptionistPublicFaqTopic === undefined || input.proposal?.tool === "propose_receptionist_public_faq"), "contact_projection_unavailable");
      if (cmd.fullProposal !== undefined) requireCondition(current.admission.mode === "full", "full_capability_unavailable");
      if (cmd.callbackMessageAction !== undefined) requireCondition(cmd.callbackMessage !== undefined, "callback_message_action_without_message");
      const initialAtomicMessage = creating && cmd.callbackMessageAction === "record" && actor.kind === "ai"
        && input.proposal?.tool === "propose_receptionist_intent" && current.admission.mode === "receptionist" && current.admission.channel === "voice"
        && current.owner === "ai" && !current.suppressed && current.emergency === null && request.callbackMessageSourceId === null
        && source!.id === current.inputs.at(-1)?.id && source!.questionId === undefined && request.sourceIds.includes(source!.id);
      const existingAtomicMessage = !creating && currentReceptionistAtomSource(current, request, source)
        && cmd.callbackMessageAction === (request.callbackMessageSourceId === null ? "record" : "replace");
      const messageProposalAllowed = ["propose_receptionist_intent", "propose_receptionist_public_faq"].includes(input.proposal?.tool ?? "")
        || input.proposal?.tool === "propose_receptionist_capture" && input.proposal.arguments.messageClarity === "clear"
          && cmd.category === undefined;
      if (cmd.callbackMessage !== undefined) requireCondition(actor.kind === "ai" && messageProposalAllowed
        && (initialAtomicMessage || existingAtomicMessage), "callback_message_question_mismatch");
      if (cmd.receptionistPublicFaqTopic !== undefined) requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice" && cmd.fullProposal === undefined && cmd.receptionistPublicFaqReference !== undefined,
        "receptionist_public_faq_unavailable");
      if (!creating) requireCondition(cmd.originalSourceEventId === undefined && cmd.sourceEventIds === undefined, "request_source_bundle_existing");
      if (!creating) requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request!.id), "degraded_handoff_source_immutable");
      if (next.pendingQuestion?.requestId === request.id) next.pendingQuestion = null;
      requireCondition(request.state === "draft", "request_not_editable");
      requireCondition(cmd.originalRequest === undefined || cmd.originalRequest === request.originalRequest, "original_request_immutable");
      requireCondition(creating || source!.sequence >= request.proposalRevision, "stale_request_source");
      if (!request.sourceIds.includes(source!.id)) { requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached"); request.sourceIds.push(source!.id); }
      if (cmd.preserveMessageQuestion !== true) request.proposalRevision = current.revision + 1;
      if (cmd.category !== undefined) request.category = cmd.category;
      if (cmd.callbackMessage !== undefined) {
        request.callbackMessageSourceId = source!.id;
        request.callbackMessageText = cmd.callbackMessage;
        request.callbackConfirmed = false;
        request.confirmationSourceId = null;
      }
      if (cmd.fullProposal !== undefined) request.fullProposal = cmd.fullProposal;
      if (cmd.receptionistPublicFaqTopic !== undefined) {
        const choice = current.publicFaqChoice;
        const answerReference = choice?.answerReference;
        const selectedAnswer = choice?.answerTopic === undefined ? null : resolveReceptionistPublicFaq({ practiceId: current.admission.practiceId,
          topic: choice.answerTopic, asOf: now });
        const requestedAnswer = resolveReceptionistPublicFaq({ practiceId: current.admission.practiceId,
          topic: cmd.receptionistPublicFaqTopic, asOf: now });
        const selectedOfficeFollowUp = request.receptionistPublicFaq?.topic === "locations"
          && choice?.state === "answered" && choice.requestId === request.id
          && choice.ownerEpoch === current.ownerEpoch && choice.voiceEpoch === current.voiceEpoch
          && choice.answerSourceId !== undefined && sameSelectedOfficePublicFaqTopic(choice.answerTopic, cmd.receptionistPublicFaqTopic)
          && answerReference !== undefined && selectedAnswer !== null && receptionistPublicFaqReferenceMatches(answerReference, selectedAnswer)
          && requestedAnswer !== null && receptionistPublicFaqReferenceMatches(cmd.receptionistPublicFaqReference!, requestedAnswer)
          && current.pendingQuestion?.requestId === request.id && current.pendingQuestion.requestRevision === request.revision
          && source!.id === current.inputs.at(-1)?.id && source!.questionId === current.pendingQuestion.id
          && source!.sequence > current.pendingQuestion.activatedRevision;
        requireCondition(request.receptionistPublicFaq === undefined || request.receptionistPublicFaq.topic === cmd.receptionistPublicFaqTopic
          || selectedOfficeFollowUp, "receptionist_public_faq_immutable");
        if (!selectedOfficeFollowUp) request.receptionistPublicFaq = { topic: cmd.receptionistPublicFaqTopic, sourceId: source!.id,
          sourceRevision: current.revision, ownerEpoch: current.ownerEpoch, voiceEpoch: current.voiceEpoch,
          ...cmd.receptionistPublicFaqReference! };
      }
      request.pausedCallbackSourceId = undefined;
      if (cmd.name !== undefined) {
        if (request.name !== cmd.name || request.nameSourceId === undefined) request.nameSourceId = source!.id;
        request.name = cmd.name;
      }
      if (cmd.callbackNumber !== undefined && (request.callbackNumber !== cmd.callbackNumber || request.callbackNumberSourceId === undefined)) request.callbackNumberSourceId = source!.id;
      if (cmd.callbackNumber !== undefined && cmd.callbackNumber !== request.callbackNumber) {
        request.callbackNumber = cmd.callbackNumber; request.callbackConfirmed = false; request.confirmationSourceId = null;
      }
      if (cmd.clearCallbackNumber === true) {
        requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice"
          && current.pendingQuestion?.requestId === request.id && current.pendingQuestion.requestRevision === request.revision
          && ["message", "name", "callback_number_entry", "callback_number"].includes(current.pendingQuestion.kind)
          && source!.id === current.inputs.at(-1)?.id && source!.questionId === current.pendingQuestion.id
          && source!.sequence > current.pendingQuestion.activatedRevision, "callback_number_invalidation_unavailable");
        request.callbackNumber = ""; delete request.callbackNumberSourceId; request.callbackConfirmed = false; request.confirmationSourceId = null;
      }
      request.state = "draft";
    } else {
      requireCondition(request.state === "draft", "request_not_editable");
      requireCondition(request.name && request.originalRequest && request.callbackConfirmed && /^\+[1-9]\d{7,14}$/.test(request.callbackNumber), "capture_incomplete");
      request.state = "needs_callback";
    }
    request.revision += 1;
    if (cmd.type === "request.draft" && cmd.preserveMessageQuestion === true) next.pendingQuestion = { ...current.pendingQuestion!, requestRevision: request.revision };
  } else if (cmd.type === "request.supplement" || cmd.type === "request.correct_contact") {
    requireCondition(actor.kind === "ai" || isStaff || isSystem, "request_actor_denied");
    requireCondition(current.phase === "active", "conversation_not_active");
    const request = next.requests.find((r) => r.id === cmd.requestId);
    requireCondition(request && ["draft", "needs_callback"].includes(request.state), "request_not_editable");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id), "degraded_handoff_source_immutable");
    const source = next.inputs.find((i) => i.id === cmd.sourceEventId);
    const question = current.pendingQuestion;
    const originalMessage = typeof request.callbackMessageSourceId === "string"
      ? next.inputs.find((item) => item.id === request.callbackMessageSourceId) : undefined;
    const currentBoundMessageCorrection = cmd.type === "request.supplement" && isSystem
      && current.admission.mode === "full" && current.admission.channel === "voice" && current.providerTier === "realtime"
      && current.owner === "ai" && !current.suppressed && current.emergency === null && request.state === "draft"
      && originalMessage !== undefined && request.sourceIds.includes(originalMessage.id)
      && source !== undefined && request.sourceIds.includes(source.id) && question !== null
      && source.id === current.inputs.at(-1)?.id && source.questionId === question.id
      && question.requestId === request.id && question.requestRevision === request.revision
      && ["name", "callback_number_entry", "callback_number"].includes(question.kind)
      && source.sequence > question.activatedRevision && source.sequence > request.proposalRevision;
    requireCondition(source && source.sequence > request.proposalRevision
      && (!request.sourceIds.includes(source.id) || currentBoundMessageCorrection), "stale_request_source");
    if (currentBoundMessageCorrection) {
      // The current question already linked this raw correction; record the amendment without duplicating it.
      request.proposalRevision = current.revision + 1;
      next.pendingQuestion = null;
    } else {
      requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached");
      request.sourceIds.push(source.id);
    }
    if (cmd.type === "request.correct_contact") {
      if (next.pendingQuestion?.requestId === request.id) next.pendingQuestion = null;
      requireCondition(cmd.name !== undefined || cmd.callbackNumber !== undefined || cmd.clearCallbackNumber === true, "empty_contact_correction");
      if (cmd.name !== undefined) {
        if (request.name !== cmd.name || request.nameSourceId === undefined) request.nameSourceId = source!.id;
        request.name = cmd.name;
      }
      if (cmd.callbackNumber !== undefined && (request.callbackNumber !== cmd.callbackNumber || request.callbackNumberSourceId === undefined)) request.callbackNumberSourceId = source!.id;
      if (cmd.callbackNumber !== undefined && cmd.callbackNumber !== request.callbackNumber) {
        request.callbackNumber = cmd.callbackNumber;
        request.callbackConfirmed = false; request.confirmationSourceId = null; request.state = "draft";
        request.proposalRevision = current.revision + 1;
      }
      if (cmd.clearCallbackNumber === true) {
        requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice"
          && question?.requestId === request.id && question.requestRevision === request.revision
          && ["message", "name", "callback_number_entry", "callback_number"].includes(question.kind)
          && source!.id === current.inputs.at(-1)?.id && source!.questionId === question.id
          && source!.sequence > question.activatedRevision, "callback_number_invalidation_unavailable");
        request.callbackNumber = ""; delete request.callbackNumberSourceId; request.callbackConfirmed = false; request.confirmationSourceId = null;
        request.state = "draft"; request.proposalRevision = current.revision + 1;
      }
    }
    request.revision += 1;
  } else if (cmd.type === "request.confirm_callback") {
    requireCondition(isSystem, "system_required");
    requireCondition(current.phase === "active", "conversation_not_active");
    const request = next.requests.find((r) => r.id === cmd.requestId);
    requireCondition(request && request.state === "draft" && request.callbackNumber === cmd.callbackNumber, "callback_confirmation_mismatch");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id), "degraded_handoff_source_immutable");
    const source = next.inputs.find((i) => i.id === cmd.sourceEventId);
    requireCondition(source && source.sequence > request.proposalRevision, "confirmation_source_missing_or_stale");
    const question = next.pendingQuestion;
    requireCondition(question?.kind === "callback_number" && question.id === source.questionId && question.requestId === request.id
      && question.requestRevision === request.revision && question.callbackNumber === cmd.callbackNumber && source.sequence > question.activatedRevision, "confirmation_question_mismatch");
    requireCondition(!next.requests.some((r) => r.confirmationSourceId === cmd.sourceEventId), "confirmation_source_already_used");
    request.callbackConfirmed = true; request.confirmationSourceId = cmd.sourceEventId;
    if (!request.sourceIds.includes(cmd.sourceEventId)) {
      requireCondition(request.sourceIds.length < 32, "conversation_capacity_reached");
      request.sourceIds.push(cmd.sourceEventId);
    }
    request.revision += 1;
    next.pendingQuestion = null;
  } else if (cmd.type === "request.confirm_and_capture_callback") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null,
      "callback_capture_owner_denied");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    requireCondition(request && request.state === "draft" && request.callbackNumber === cmd.callbackNumber && request.name.length > 0,
      "callback_capture_incomplete");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id), "degraded_handoff_source_immutable");
    const message = request.callbackMessageSourceId === null || request.callbackMessageSourceId === undefined
      ? undefined : next.inputs.find((input) => input.id === request.callbackMessageSourceId);
    requireCondition(message !== undefined && request.sourceIds.includes(message.id), "callback_message_missing");
    const source = next.inputs.find((item) => item.id === cmd.sourceEventId);
    const question = next.pendingQuestion;
    requireCondition(source && source.id === current.inputs.at(-1)?.id && source.sequence > request.proposalRevision, "confirmation_source_missing_or_stale");
    requireCondition(question?.kind === "callback_number" && question.id === source.questionId && question.requestId === request.id
      && question.requestRevision === request.revision && question.callbackNumber === cmd.callbackNumber && source.sequence > question.activatedRevision, "confirmation_question_mismatch");
    requireCondition(!next.requests.some((item) => item.confirmationSourceId === cmd.sourceEventId), "confirmation_source_already_used");
    request.callbackConfirmed = true;
    request.confirmationSourceId = cmd.sourceEventId;
    request.state = "needs_callback";
    request.revision += 1;
    next.pendingQuestion = null;
  } else if (cmd.type === "request.resolve_ai") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null,
      "ai_resolution_owner_denied");
    const request = next.requests.find((item) => item.id === cmd.requestId);
    requireCondition(request?.state === "draft" && request.revision === cmd.requestRevision,
      "ai_resolution_stale_request");
    requireCondition(!current.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id), "degraded_handoff_source_immutable");
    requireCondition(request.sourceIds.includes(cmd.sourceEventId) && next.inputs.some((input) => input.id === cmd.sourceEventId),
      "ai_resolution_source_invalid");
    if (request.fullProposal !== undefined) {
      requireCondition(current.admission.mode === "full", "full_resolution_unavailable");
      requireResolutionMatchesProposal(request.fullProposal, cmd.result);
    } else if (request.receptionistPublicFaq !== undefined) {
      requireCondition(current.admission.mode === "receptionist" && current.admission.channel === "voice" && request.receptionistPublicFaq !== undefined && cmd.result.kind === "knowledge"
        && request.receptionistPublicFaq.topic === cmd.result.topic && request.receptionistPublicFaq.sourceId === cmd.sourceEventId
        && current.inputs.at(-1)?.id === cmd.sourceEventId
        && request.receptionistPublicFaq.sourceRevision < current.revision && request.receptionistPublicFaq.ownerEpoch === current.ownerEpoch
        && request.receptionistPublicFaq.voiceEpoch === current.voiceEpoch
        && request.receptionistPublicFaq.packId === cmd.result.packId && request.receptionistPublicFaq.packVersion === cmd.result.packVersion
        && request.receptionistPublicFaq.factId === cmd.result.factId && request.receptionistPublicFaq.factVersion === cmd.result.factVersion
        && request.receptionistPublicFaq.knowledgeSourceId === cmd.result.sourceId && request.receptionistPublicFaq.knowledgeSourceVersion === cmd.result.sourceVersion
        && request.receptionistPublicFaq.contentHash === cmd.result.contentHash, "receptionist_public_faq_resolution_invalid");
    } else {
      requireCondition(false, "full_resolution_unavailable");
    }
    request.aiResolution = cmd.result;
    request.state = "ai_resolved";
    request.revision += 1;
    if (next.pendingQuestion?.requestId === request.id) next.pendingQuestion = null;
  } else if (cmd.type === "request.claim" || cmd.type === "request.complete") {
    requireCondition(isStaff, "staff_required");
    const request = next.requests.find((r) => r.id === cmd.requestId);
    requireCondition(request, "request_missing");
    if (cmd.type === "request.claim") {
      requireCondition(request.state === "needs_callback", "request_not_claimable");
      request.owner = actor.id; request.state = "in_progress";
    } else {
      requireCondition(request.state === "in_progress" && request.owner === actor.id, "request_not_owned");
      request.state = "completed"; request.outcome = cmd.outcome;
    }
    request.revision += 1;
  } else if (cmd.type === "staff.note") {
    requireCondition(isStaff, "staff_required");
  } else if (cmd.type === "owner.change") {
    requireCondition(isStaff, "staff_required");
    const deliveryReview = cmd.owner === "staff" && current.admission.channel === "sms" && current.messages.some((message) => message.state === "unknown" && !message.sendHoldReleased);
    requireCondition(current.phase === "active" || deliveryReview, "conversation_not_active");
    if (current.owner === "staff") requireCondition(current.staffActor === actor.id, "different_staff_owner");
    next.owner = cmd.owner; next.staffActor = cmd.owner === "staff" ? actor.id : null; next.ownerEpoch += 1;
    next.pendingQuestion = null;
    for (const m of next.messages) if (m.state === "queued") m.state = "canceled";
  } else if (cmd.type === "sms.suppression") {
    requireCondition(isProvider && current.admission.channel === "sms", "provider_sms_required");
    next.lastInboundAt = now;
    next.suppressed = cmd.suppressed; next.suppressionRevision += 1;
    if (cmd.suppressed) {
      next.pendingQuestion = null;
      next.ownerEpoch += 1;
      for (const m of next.messages) if (m.state === "queued") m.state = "canceled";
    }
  } else if (cmd.type === "sms.inbound_activity") {
    requireCondition(isProvider && current.admission.channel === "sms", "provider_sms_required");
    next.lastInboundAt = now;
  } else if (cmd.type === "sms.unsupported_media") {
    requireCondition(isProvider && current.admission.channel === "sms", "provider_sms_required");
    next.lastInboundAt = now;
    if (cmd.kind === "media") { requireCondition(cmd.mediaCount > 0, "media_count_required"); next.unsupportedMediaCount += cmd.mediaCount; }
    else { requireCondition(cmd.mediaCount === 0, "non_text_media_count_invalid"); next.unsupportedNonTextCount += 1; }
    // Unsupported media/non-text content is neither fetched nor represented as caller text. The fixed
    // notice can only be sent while AI still owns an otherwise sendable conversation.
    if (current.phase === "active" && !current.suppressed && current.owner === "ai" && current.emergency === null && next.messages.length < 64) {
      const messageId = unsupportedMediaNoticeId(cmd.sourceId);
      if (!next.messages.some((message) => message.id === messageId)) {
        next.messages.push({ id: messageId, body: unsupportedMediaNotice, actor: cmd.kind === "media" ? "unsupported-media-notice" : "unsupported-non-text-notice", sender: "ai", ownerEpoch: current.ownerEpoch,
          suppressionRevision: current.suppressionRevision, state: "queued", providerId: null, dispatchAttemptId: null, failureReason: null, sendHoldReleased: false });
      }
    }
  } else if (cmd.type === "sms.queue") {
    requireCondition(current.admission.channel === "sms" && current.phase === "active" && !current.suppressed && current.emergency === null, "sms_unavailable");
    requireCondition(actor.kind === "ai" || (isStaff && current.owner === "staff" && current.staffActor === actor.id), "sender_not_owner");
    requireCondition(!next.messages.some((m) => m.id === cmd.messageId), "message_id_conflict");
    requireCondition(next.messages.length < 64, "conversation_capacity_reached");
    next.messages.push({ id: cmd.messageId, body: cmd.body, actor: actor.id, sender: actor.kind as "ai" | "staff", ownerEpoch: current.ownerEpoch, suppressionRevision: current.suppressionRevision, state: "queued", providerId: null, dispatchAttemptId: null, failureReason: null, sendHoldReleased: false });
  } else if (cmd.type === "emergency.sms_instruction") {
    requireCondition(isSystem && current.admission.channel === "sms" && current.phase === "active" && !current.suppressed, "emergency_sms_denied");
    requireCondition(current.emergency?.sourceEventId === cmd.sourceEventId, "emergency_source_not_current");
    requireCondition(!next.messages.some((message) => message.id === cmd.messageId), "message_id_conflict");
    requireCondition(next.messages.length < 64, "conversation_capacity_reached");
    next.messages.push({ id: cmd.messageId, body: approvedEmergencySmsInstruction, actor: actor.id, sender: "ai", ownerEpoch: current.ownerEpoch, suppressionRevision: current.suppressionRevision, state: "queued", providerId: null, dispatchAttemptId: null, failureReason: null, sendHoldReleased: false });
  } else if (cmd.type === "sms.dispatch" || cmd.type === "sms.window_expire" || cmd.type === "sms.receipt" || cmd.type === "sms.release_hold") {
    requireCondition(current.admission.channel === "sms", "sms_required");
    const m = next.messages.find((v) => v.id === cmd.messageId);
    requireCondition(m, "message_missing");
    if (cmd.type === "sms.dispatch") {
      requireCondition(isSystem, "system_required");
      requireCondition(current.phase === "active" && !current.suppressed, "sms_unavailable");
      requireCondition(cmd.expectedSuppressionRevision === current.suppressionRevision && m.suppressionRevision === current.suppressionRevision, "stale_suppression_revision");
      requireCondition(m.state === "queued" && m.ownerEpoch === current.ownerEpoch && m.sender === current.owner && (m.sender !== "staff" || m.actor === current.staffActor), "stale_send");
      requireCondition(current.admission.messageTransport !== "whatsapp" || (current.lastInboundAt !== null
        && Date.parse(now) - Date.parse(current.lastInboundAt) < 86_400_000), "whatsapp_window_expired");
      requireCondition(!next.messages.some((other) => other.state === "submitting" || (other.state === "unknown" && !other.sendHoldReleased)), "send_reconciliation_required");
      requireCondition(next.messages.find((other) => other.state === "queued")?.id === m.id, "send_order_conflict");
      requireCondition(!next.messages.some((other) => other.dispatchAttemptId === cmd.dispatchAttemptId), "dispatch_attempt_conflict");
      m.state = "submitting"; m.dispatchAttemptId = cmd.dispatchAttemptId;
    } else if (cmd.type === "sms.window_expire") {
      requireCondition(isSystem && current.admission.messageTransport === "whatsapp", "whatsapp_window_required");
      requireCondition(cmd.expectedSuppressionRevision === current.suppressionRevision && m.suppressionRevision === current.suppressionRevision, "stale_suppression_revision");
      // A missing activity timestamp is not permission to send. It can only occur
      // in an incomplete legacy snapshot, so terminally fail instead of retrying it.
      requireCondition(["queued", "submitting"].includes(m.state) && (current.lastInboundAt === null
        || Date.parse(now) - Date.parse(current.lastInboundAt) >= 86_400_000), "whatsapp_window_open");
      m.state = "failed";
    } else if (cmd.type === "sms.release_hold") {
      requireCondition(isStaff && current.owner === "staff" && current.staffActor === actor.id && m.state === "unknown", "hold_release_denied");
      m.sendHoldReleased = true;
    } else {
      requireCondition(isProvider || isSystem, "provider_receipt_required");
      requireCondition(["submitting", "unknown", "accepted", "delivered", "undelivered", "failed"].includes(m.state), "send_not_submitted");
      if (cmd.providerId !== undefined) {
        requireCondition(m.providerId === null || m.providerId === cmd.providerId, "provider_id_conflict");
        requireCondition(!next.messages.some((other) => other.id !== m.id && other.providerId === cmd.providerId), "provider_id_conflict");
        m.providerId = cmd.providerId;
      }
      if (cmd.failureReason !== undefined) {
        requireCondition(cmd.state === "failed" || cmd.state === "undelivered", "failure_reason_state_invalid");
        requireCondition(current.admission.messageTransport === "whatsapp", "failure_reason_transport_invalid");
        requireCondition(m.failureReason === null || m.failureReason === cmd.failureReason, "failure_reason_conflict");
        m.failureReason = cmd.failureReason;
      }
      requireCondition(!["accepted", "delivered", "undelivered"].includes(cmd.state) || m.providerId !== null, "provider_id_required");
      const terminal = ["delivered", "undelivered", "failed"].includes(m.state);
      if (terminal) requireCondition(cmd.state === m.state || cmd.state === "accepted", "contradictory_terminal_receipt");
      else if (!(m.state === "accepted" && cmd.state === "unknown")) m.state = cmd.state;
    }
  } else if (cmd.type === "voice.message_continue") {
    requireCondition(isSystem && current.admission.channel === "voice" && current.admission.mode === "receptionist"
      && current.admission.voicePlayback === "primary_media" && current.phase === "active" && current.owner === "ai"
      && current.emergency === null && !current.suppressed && current.messageContinuation === null,
      "message_continue_denied");
    const media = current.primaryMedia;
    const source = current.inputs.at(-1), draft = current.requests.filter(request => request.state === "draft" && request.fullProposal === undefined);
    requireCondition(media?.attachmentId === cmd.fromAttachmentId && source?.id === cmd.sourceEventId && draft.length === 1
      && !current.transfers.some(transfer => transfer.state === "trying"), "message_continue_source_invalid");
    if (cmd.mode === "inline") {
      requireCondition(cmd.transferId === undefined && cmd.capabilityDigest === undefined && cmd.expiresAt === undefined
        && cmd.streamId === media.streamId && media.state === "model_bound" && media.inputPipelineArmed
        && (cmd.reason === undefined || cmd.reason === "closed_hours" ? current.admission.hours === "demo_closed"
          : cmd.reason === "route_unavailable" && current.admission.hours === "demo_open"
            || cmd.reason === "clarification_exhausted")
        && current.controlledTransfers.every(transfer => transfer.outcome !== null),
        "message_continue_inline_invalid");
      next.voiceEpoch += 1; next.providerTier = "relay"; next.activityLeaseUntil = null;
    } else {
      const transfer = current.controlledTransfers.find(item => item.attempt.id === cmd.transferId);
      requireCondition(cmd.streamId === undefined && cmd.reason === undefined && cmd.transferId !== undefined && transfer?.outcome !== null
        && transfer?.outcome !== "accepted" && transfer?.resumedVoiceEpoch === current.voiceEpoch
        && media.state === "superseded" && cmd.capabilityDigest !== undefined && cmd.expiresAt !== undefined
        && Date.parse(cmd.expiresAt) > Date.parse(now) && Date.parse(cmd.expiresAt) <= Date.parse(now) + 120_000,
        "message_continue_fresh_invalid");
    }
    const continuationReason = cmd.mode === "inline" ? cmd.reason ?? "closed_hours" : (() => {
      const outcome = current.controlledTransfers.find(item => item.attempt.id === cmd.transferId)?.outcome;
      requireCondition(outcome !== null && outcome !== undefined && outcome !== "accepted", "message_continue_fresh_invalid");
      return outcome;
    })();
    next.messageContinuation = { id: cmd.continuationId, mode: cmd.mode, reason: continuationReason,
      state: cmd.mode === "inline" ? "attached" : "issued", fromAttachmentId: cmd.fromAttachmentId,
      transferId: cmd.transferId ?? null, sourceEventId: cmd.sourceEventId, transitionEventId: input.eventId,
      parentCallId: current.admission.externalId, accountId: current.admission.accountId,
      ownerEpoch: current.ownerEpoch, voiceEpoch: next.voiceEpoch, configVersion: current.admission.configVersion,
      profileSha256: media.profileSha256, streamId: cmd.mode === "inline" ? media.streamId : null,
      capabilityDigest: cmd.capabilityDigest ?? null, expiresAt: cmd.expiresAt ?? null, documentIssuedAt: null,
      attachedAt: cmd.mode === "inline" ? now : null, closedAt: null,
      callerEndSourceId: null, callerEndEventId: null };
  } else if (cmd.type === "voice.message_document_issue") {
    const continuation = next.messageContinuation;
    requireCondition(isSystem && continuation?.id === cmd.continuationId && continuation.mode === "fresh"
      && continuation.state === "issued" && continuation.documentIssuedAt === null
      && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null
      && continuation.ownerEpoch === current.ownerEpoch && continuation.voiceEpoch === current.voiceEpoch,
      "message_document_stale");
    continuation.documentIssuedAt = now;
  } else if (cmd.type === "voice.message_attach") {
    const continuation = next.messageContinuation;
    requireCondition(isProvider && actor.id === "twilio-primary-media" && continuation?.id === cmd.continuationId
      && continuation.mode === "fresh" && continuation.state === "issued" && continuation.documentIssuedAt !== null
      && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null
      && continuation.ownerEpoch === current.ownerEpoch && continuation.voiceEpoch === current.voiceEpoch
      && cmd.parentCallId === continuation.parentCallId && cmd.accountId === continuation.accountId
      && cmd.capabilityDigest === continuation.capabilityDigest && cmd.profileSha256 === continuation.profileSha256
      && cmd.streamId !== current.primaryMedia?.streamId
      && continuation.expiresAt !== null && Date.parse(now) < Date.parse(continuation.expiresAt), "message_attach_stale");
    continuation.streamId = cmd.streamId; continuation.state = "attached"; continuation.attachedAt = now;
    next.providerTier = "relay";
  } else if (cmd.type === "voice.message_end") {
    const continuation = next.messageContinuation, source = current.inputs.at(-1);
    requireCondition(isSystem && continuation?.id === cmd.continuationId && continuation.state === "attached"
      && continuation.ownerEpoch === current.ownerEpoch && continuation.voiceEpoch === current.voiceEpoch
      && current.phase === "active" && current.owner === "ai" && !current.suppressed && current.emergency === null
      && source?.id === cmd.sourceEventId && (cmd.semanticIntent === "explicit_exit"
        || cmd.invitationCompleted && !current.requests.some(request => request.state === "draft")), "message_end_stale");
    continuation.callerEndSourceId = source.id; continuation.callerEndEventId = input.eventId;
  } else if (cmd.type === "voice.primary_media.issue") {
    requireCondition(isSystem && current.admission.channel === "voice" && current.admission.mode === "receptionist"
      && current.admission.voicePlayback === "primary_media" && current.phase === "active" && current.owner === "ai"
      && current.emergency === null && !current.suppressed, "primary_media_issue_denied");
    requireCondition(cmd.parentCallId === current.admission.externalId && cmd.accountId === current.admission.accountId
      && cmd.configVersion === current.admission.configVersion && cmd.profileSha256 === (current.admission.voiceRelease?.profileSha256 ?? current.admission.controlledHours?.candidate?.profileSha256),
    "primary_media_binding_invalid");
    requireCondition(current.primaryMedia === null || ["closed", "superseded"].includes(current.primaryMedia.state), "primary_media_already_issued");
    requireCondition(current.primaryMedia?.attachmentId !== cmd.attachmentId, "primary_media_replay");
    const expires = Date.parse(cmd.expiresAt), issued = Date.parse(now);
    requireCondition(Number.isFinite(expires) && expires > issued && expires <= issued + 120_000, "primary_media_expiry_invalid");
    next.primaryMedia = { attachmentId: cmd.attachmentId, purpose: "primary_media", parentCallId: cmd.parentCallId,
      accountId: cmd.accountId, ownerEpoch: current.ownerEpoch, voiceEpoch: current.voiceEpoch,
      configVersion: cmd.configVersion, profileSha256: cmd.profileSha256, capabilityDigest: cmd.capabilityDigest,
      expiresAt: cmd.expiresAt, state: "issued", streamId: null, modelSessionId: null,
      configFingerprint: null, inputPipelineArmed: false,
      opening: current.primaryMedia?.opening ?? { state: "unissued", presentationId: null, markId: null },
      issuedAt: now, attachedAt: null, closedAt: null };
  } else if (cmd.type === "voice.primary_media.attach") {
    requireCondition(isProvider && actor.id === "twilio-primary-media", "primary_media_attach_denied");
    const media = next.primaryMedia;
    requireCondition(media?.attachmentId === cmd.attachmentId && current.phase === "active" && current.owner === "ai"
      && !current.suppressed && current.emergency === null && media.ownerEpoch === current.ownerEpoch
      && media.voiceEpoch === current.voiceEpoch, "primary_media_stale");
    requireCondition(cmd.parentCallId === current.admission.externalId && cmd.accountId === current.admission.accountId
      && cmd.parentCallId === media.parentCallId && cmd.accountId === media.accountId
      && cmd.configVersion === media.configVersion && cmd.profileSha256 === media.profileSha256
      && current.admission.voicePlayback === "primary_media", "primary_media_binding_invalid");
    requireCondition(Date.parse(now) < Date.parse(media.expiresAt), "primary_media_expired");
    requireCondition(cmd.capabilityDigest === media.capabilityDigest, "primary_media_capability_invalid");
    requireCondition(media.state === "issued" || (["attached", "model_bound"].includes(media.state) && media.streamId === cmd.streamId), "primary_media_replay");
    if (media.state === "issued") {
      media.streamId = cmd.streamId; media.state = "attached"; media.attachedAt = now;
    }
  } else if (cmd.type === "voice.primary_media.bind_session") {
    requireCondition(isSystem, "primary_media_bind_denied");
    const media = next.primaryMedia;
    requireCondition(media?.attachmentId === cmd.attachmentId && media.streamId === cmd.streamId
      && media.ownerEpoch === current.ownerEpoch && media.voiceEpoch === current.voiceEpoch
      && current.phase === "active" && current.owner === "ai" && !current.suppressed
      && current.emergency === null, "primary_media_stale");
    requireCondition(/^sess_[A-Za-z0-9_-]{3,}$/.test(cmd.modelSessionId)
      && cmd.modelSessionId !== media.parentCallId && cmd.modelSessionId !== media.streamId, "primary_media_model_session_invalid");
    requireCondition(media.state === "attached" || media.state === "model_bound"
      && media.modelSessionId === cmd.modelSessionId && media.configFingerprint === cmd.configFingerprint,
    "primary_media_session_conflict");
    media.modelSessionId = cmd.modelSessionId; media.configFingerprint = cmd.configFingerprint;
    media.inputPipelineArmed = true; media.state = "model_bound";
  } else if (cmd.type === "voice.primary_media.opening") {
    const media = next.primaryMedia;
    requireCondition(media?.attachmentId === cmd.attachmentId && media.streamId === cmd.streamId
      && media.modelSessionId === cmd.modelSessionId && media.ownerEpoch === current.ownerEpoch
      && media.voiceEpoch === current.voiceEpoch && media.state === "model_bound"
      && media.inputPipelineArmed && current.phase === "active" && current.owner === "ai"
      && !current.suppressed && current.emergency === null, "primary_media_opening_stale");
    const opening = media.opening;
    requireCondition(opening.presentationId === null || opening.presentationId === cmd.presentationId, "primary_media_opening_stale");
    const allowed: Record<typeof opening.state, readonly string[]> = {
      unissued: ["issued"], issued: ["playing", "interrupted", "failed"], playing: ["completed", "interrupted", "failed"],
      completed: [], interrupted: [], failed: [],
    };
    requireCondition(allowed[opening.state].includes(cmd.state), "primary_media_opening_stale");
    requireCondition(cmd.state === "completed" ? isProvider && actor.id === "twilio-primary-media" && cmd.markId !== undefined && cmd.markId === opening.markId
      : cmd.state === "playing" ? isSystem && cmd.markId !== undefined
      : isSystem, "primary_media_opening_actor_denied");
    opening.state = cmd.state; opening.presentationId = cmd.presentationId;
    if (cmd.state === "playing") opening.markId = cmd.markId!;
  } else if (cmd.type === "voice.primary_media.close") {
    requireCondition(isSystem || isProvider, "primary_media_close_denied");
    const media = next.primaryMedia;
    requireCondition(media?.attachmentId === cmd.attachmentId && (cmd.streamId === undefined || cmd.streamId === media.streamId), "primary_media_stale");
    requireCondition(!["closed", "superseded"].includes(media.state) || media.closedAt !== null, "primary_media_stale");
    media.state = cmd.reason === "superseded" ? "superseded" : "closed";
    media.closedAt ??= now;
  } else if (cmd.type === "voice.recover") {
    requireCondition(isSystem || isProvider, "recovery_actor_denied");
    requireCondition(current.admission.channel === "voice" && current.phase === "active", "voice_not_active");
    requireCondition(current.owner === "ai", "recovery_owner_denied");
    requireCondition(cmd.parentCallId === current.admission.externalId, "parent_call_mismatch");
    requireCondition(current.voiceEpoch === cmd.fromEpoch && current.providerTier !== "scripted", "stale_recovery");
    requireCondition(!next.recoveries.some((r) => r.id === cmd.recoveryId || r.fromEpoch === cmd.fromEpoch), "recovery_already_claimed");
    requireCondition(!next.recoveries.some((r) => r.state !== "attached" && r.state !== "parent_gone"), "recovery_pending");
    const failureDomain = cmd.failureDomain ?? "openai_provider_or_scope_unknown";
    // Intentional application-controlled speech handoff, not a provider outage.
    if (failureDomain === "callback_intake") {
      requireCondition(isSystem && current.admission.mode === "receptionist" && current.providerTier === "realtime"
        && !current.suppressed && current.emergency === null
        && current.requests.filter((request) => request.state === "draft" && request.fullProposal === undefined).length === 1
        && !current.transfers.some((transfer) => transfer.state === "trying")
        && !current.controlledTransfers.some((transfer) => transfer.outcome === null), "callback_handoff_denied");
    }
    const candidateMediaRetry = current.admission.voiceRelease !== undefined && current.admission.mode === "receptionist" && current.providerTier === "relay"
      && failureDomain === "relay_transport" && current.recoveries.some((item) => item.failureDomain === "callback_intake" && item.state === "attached")
      && !current.recoveries.some((item) => item.failureDomain === "relay_transport");
    const candidateRetryExhausted = current.admission.voiceRelease !== undefined && current.admission.mode === "receptionist"
      && current.providerTier === "relay" && failureDomain === "relay_transport" && current.recoveries.length === 2
      && current.recoveries[0]?.failureDomain === "callback_intake" && current.recoveries[0].state === "attached"
      && current.recoveries[1]?.failureDomain === "relay_transport" && current.recoveries[1].state === "attached";
    requireCondition(current.recoveries.length < 2 || candidateRetryExhausted, "recovery_capacity_reached");
    const target = current.providerTier === "realtime" && (failureDomain === "realtime_transport_only" || failureDomain === "callback_intake") || candidateMediaRetry ? "relay" : "scripted";
    next.voiceEpoch += 1; next.ownerEpoch += 1; next.pendingQuestion = null; next.activityLeaseUntil = null;
    next.recoveries.push({ id: cmd.recoveryId, fromEpoch: cmd.fromEpoch, target, failureDomain, state: "claimed", parentCallId: cmd.parentCallId, childCallId: cmd.childCallId, triggerEventId: input.eventId, attachmentId: null, scriptedEmptyAttempts: 0, createdAt: now, updatedAt: now });
  } else if (cmd.type === "voice.recovery_state") {
    requireCondition(isSystem || isProvider, "recovery_actor_denied");
    requireCondition(current.phase === "active", "voice_not_active");
    const recovery = next.recoveries.find((r) => r.id === cmd.recoveryId);
    requireCondition(recovery && recovery.fromEpoch + 1 === current.voiceEpoch, "recovery_missing_or_stale");
    const transitions: Record<z.infer<typeof recoverySchema>["state"], readonly string[]> = { claimed: ["redirecting", "attached"], redirecting: ["attached", "outcome_unknown"], outcome_unknown: ["attached"], attached: ["attached"], parent_gone: [] };
    requireCondition(transitions[recovery.state].includes(cmd.state), "invalid_recovery_transition");
    if (cmd.state === "attached") {
      requireCondition(cmd.attachmentId && (recovery.attachmentId === null || recovery.attachmentId === cmd.attachmentId), "attachment_identity_required");
      recovery.attachmentId = cmd.attachmentId;
    }
    recovery.state = cmd.state; recovery.updatedAt = now;
    if (cmd.state === "attached") next.providerTier = recovery.target;
  } else if (cmd.type === "voice.recovery_document_issue") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && !current.suppressed, "recovery_document_authority_denied");
    const recovery = next.recoveries.find((item) => item.id === cmd.recoveryId);
    requireCondition(recovery?.state === "redirecting" && recovery.fromEpoch + 1 === current.voiceEpoch
      && recovery.documentIssuedAt === undefined, "recovery_document_already_issued");
    recovery.documentIssuedAt = now; recovery.updatedAt = now;
  } else if (cmd.type === "voice.scripted_no_input") {
    requireCondition(isProvider && current.phase === "active" && current.admission.channel === "voice" && current.owner === "ai"
      && current.providerTier === "scripted", "scripted_no_input_denied");
    const recovery = next.recoveries.find((item) => item.id === cmd.recoveryId);
    requireCondition(recovery?.target === "scripted" && recovery.state === "attached" && recovery.fromEpoch + 1 === current.voiceEpoch
      && recovery.scriptedEmptyAttempts === cmd.expectedAttempts, "scripted_no_input_stale");
    recovery.scriptedEmptyAttempts += 1;
    recovery.updatedAt = now;
  } else if (cmd.type === "voice.relay_end") {
    requireCondition(isSystem && current.phase === "active" && current.owner === "ai" && !current.suppressed
      && current.admission.mode === "receptionist" && current.admission.channel === "voice" && current.providerTier === "relay", "relay_end_unavailable");
    const recovery = next.recoveries.find((item) => item.id === cmd.recoveryId);
    const source = current.inputs.at(-1);
    requireCondition(recovery?.target === "relay" && ["callback_intake", "relay_transport"].includes(recovery.failureDomain) && recovery.state === "attached"
      && recovery.fromEpoch + 1 === current.voiceEpoch && source?.id === cmd.sourceEventId, "relay_end_stale");
    const terminalDecline = current.pendingQuestion === null && !current.requests.some((request) => request.state === "draft")
      && current.requests.some((request) => request.state === "needs_callback") && isClearDecline(source.body);
    requireCondition(cmd.semanticIntent === "explicit_exit" || cmd.semanticIntent === "final_decline" && cmd.invitationCompleted === true && !current.requests.some(request => request.state === "draft")
      || cmd.semanticIntent === undefined && (isReceptionistCallerExit(source.body) || terminalDecline), "relay_end_not_requested");
    recovery.callerEndSourceId = source.id; recovery.callerEndEventId = input.eventId;
  } else if (cmd.type === "voice.late_evidence") {
    requireCondition(isProvider || isSystem, "provider_receipt_required");
    requireCondition(next.recoveries.some((r) => r.id === cmd.recoveryId), "recovery_missing_or_stale");
  } else if (cmd.type === "conversation.heartbeat") {
    requireCondition(isSystem && current.admission.channel === "voice" && current.phase === "active" && current.voiceEpoch === cmd.voiceEpoch, "voice_heartbeat_stale");
    const leaseUntil = Date.parse(cmd.leaseUntil), nowMs = Date.parse(now);
    requireCondition(Number.isFinite(leaseUntil) && leaseUntil > nowMs && leaseUntil <= nowMs + 60_000, "voice_heartbeat_lease_invalid");
    next.activityLeaseUntil = cmd.leaseUntil;
  } else if (cmd.type === "conversation.disconnect") {
    requireCondition(isSystem || isProvider, "disconnect_actor_denied");
    next.phase = "disconnected"; next.ownerEpoch += 1;
    next.activityLeaseUntil = null;
    next.pendingQuestion = null;
    for (const m of next.messages) if (m.state === "queued") m.state = "canceled";
    for (const r of next.recoveries) if (r.state !== "attached") r.state = "parent_gone";
    const id = evaluationId(scopeOf(current));
    if (!next.evaluations.some((item) => item.id === id)) next.evaluations.push({ id, version: CONVERSATION_EVALUATION_VERSION, scope: scopeOf(current),
      createdFromRevision: current.revision + 1, state: "pending", verdict: null, reasons: [], checks: null, incompleteRequestCount: null });
  }
  // A prepared primary transfer temporarily owns the next voice epoch. Keep the
  // authenticated live stream available for a known pre-dispatch abort, while
  // activePrimary still fences decisions until that abort rebinds the epoch.
  const primaryTransferInFlight = next.primaryMedia !== null && next.primaryMedia.state === "model_bound"
    && next.ownerEpoch === next.primaryMedia.ownerEpoch && next.primaryMedia.voiceEpoch + 1 === next.voiceEpoch
    && next.controlledTransfers.some(item => item.outcome === null && ["prepared", "submitting"].includes(item.dispatch)
      && item.attempt.ownerEpoch === next.ownerEpoch && item.attempt.voiceEpoch === next.voiceEpoch);
  if (next.primaryMedia !== null && !["closed", "superseded"].includes(next.primaryMedia.state)
    && ((next.voiceEpoch !== next.primaryMedia.voiceEpoch && !primaryTransferInFlight)
      || next.ownerEpoch !== next.primaryMedia.ownerEpoch || next.phase !== "active" || next.emergency !== null || next.suppressed)) {
    next.primaryMedia.state = "superseded"; next.primaryMedia.closedAt = now;
  }
  if (next.messageContinuation !== null && next.messageContinuation.state !== "closed" && next.messageContinuation.state !== "superseded"
    && (next.voiceEpoch !== next.messageContinuation.voiceEpoch || next.ownerEpoch !== next.messageContinuation.ownerEpoch
      || next.phase !== "active" || next.emergency !== null || next.suppressed)) {
    next.messageContinuation.state = "superseded"; next.messageContinuation.closedAt = now;
  }
  for (const transfer of next.transfers) {
    if (transfer.state !== "trying") continue;
    const request = next.requests.find((r) => r.id === transfer.requestId);
    if (next.phase !== "active" || next.owner !== "ai" || next.emergency !== null || next.voiceEpoch !== transfer.voiceEpoch || request?.category !== transfer.category || request.state === "completed") transfer.state = "canceled";
  }
  for (const transfer of next.controlledTransfers) {
    const request = next.requests.find((item) => item.id === transfer.attempt.requestId);
    if (transfer.outcome === null && (next.phase !== "active" || next.owner !== "ai" || next.emergency !== null
      || next.ownerEpoch !== transfer.attempt.ownerEpoch || next.voiceEpoch !== transfer.attempt.voiceEpoch
      || request?.state !== "draft" || request.revision !== transfer.attempt.requestRevision)) transfer.outcome = "canceled";
  }
  next.revision += 1; next.updatedAt = now;
  // Keep room for the mandatory disconnect evaluation record on a full active thread.
  requireCondition(Buffer.byteLength(JSON.stringify(next), "utf8") <= 64_000, "conversation_capacity_reached");
  return conversationSchema.parse(next);
}

function requireResolutionMatchesProposal(proposal: z.infer<typeof fullRequestProposalSchema>, result: AiResolutionResult): void {
  if (result.kind === "read") {
    requireCondition(proposal.capability === result.readKind, "ai_resolution_proof_mismatch");
    return;
  }
  if (result.kind === "action") {
    const expected = result.operation === "schedule" ? "appointment_schedule"
      : result.operation === "reschedule" ? "appointment_reschedule" : "appointment_attendance_confirm";
    requireCondition(proposal.capability === expected, "ai_resolution_proof_mismatch");
    return;
  }
  requireCondition((proposal.capability === "office_address" || proposal.capability === "approved_practice_information")
    && proposal.knowledgeTopic === result.topic, "ai_resolution_proof_mismatch");
}
