import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConversationJob, ConversationJobResult } from "./conversation-jobs.js";
import type { Conversation, ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { callbackNumberReadbackQuestion } from "./receptionist-callback-number.js";

const id = z.string().trim().min(1).max(200);
const checkSchema = z.enum(["passed", "failed", "unassessable", "not_applicable"]);
const verdictSchema = z.enum(["passed", "failed", "unassessable"]);
const reasonSchema = z.enum(["source_not_preserved", "callback_captured_unconfirmed", "emergency_transfer_active", "emergency_intake_active", "stub_connection_claim", "stub_followup_transcript_missing", "stub_followup_transcript_unavailable", "monitor_missing", "monitor_critical", "partial_request", "history_unavailable", "no_heard_audio_artifact"]);
const dialogueQualityReasonSchema = z.enum(["role_confusion", "repeated_intake_question", "semantic_evidence_missing"]);

export const conversationEvaluationVersions = ["eval-r1", "eval-r2"] as const;
export const evaluationVersionSchema = z.enum(conversationEvaluationVersions);
export type ConversationEvaluationVersion = z.infer<typeof evaluationVersionSchema>;
/** Latest semantics. Stored eval-r1 records remain readable and retain r1 behavior. */
export const CONVERSATION_EVALUATION_VERSION = "eval-r2" as const;
export const conversationEvaluationPayloadSchema = z.object({ evaluationId: id }).strict();
export type ConversationEvaluationPayload = z.infer<typeof conversationEvaluationPayloadSchema>;

const evaluationChecksSchema = z.object({
  sourcePreservation: checkSchema,
  callbackBeforeCapture: checkSchema,
  emergencyCancelsStub: checkSchema,
  noRealStubConnection: checkSchema,
  // Optional so historical eval-r1 records remain readable.
  stubFollowupSpeech: checkSchema.optional(),
  // This is a negative detector, never a certification of fluent dialogue.
  dialogueQuality: checkSchema.optional(),
  monitor: checkSchema,
  partialRequests: checkSchema,
  voiceAudioQuality: z.enum(["unassessable", "not_applicable"]),
}).strict();

const evaluationBaseSchema = z.object({
  id, version: evaluationVersionSchema,
  scope: z.object({ practiceId: id, instanceId: id, conversationId: id }).strict(),
  createdFromRevision: z.number().int().nonnegative(),
}).strict();
export const conversationEvaluationRecordSchema = z.discriminatedUnion("state", [
  evaluationBaseSchema.extend({ state: z.literal("pending"), verdict: z.null(), reasons: z.array(reasonSchema).max(16), dialogueQualityReasons: z.array(dialogueQualityReasonSchema).max(4).optional(), checks: evaluationChecksSchema.nullable(), incompleteRequestCount: z.number().int().nonnegative().nullable().optional(), unresolvedRequestCount: z.number().int().nonnegative().nullable().optional(), partialDraftCount: z.number().int().nonnegative().nullable().optional() }).strict(),
  evaluationBaseSchema.extend({ state: z.literal("completed"), verdict: verdictSchema, reasons: z.array(reasonSchema).max(16), dialogueQualityReasons: z.array(dialogueQualityReasonSchema).max(4).optional(), checks: evaluationChecksSchema, unresolvedRequestCount: z.number().int().nonnegative(), partialDraftCount: z.number().int().nonnegative() }).strict(),
  evaluationBaseSchema.extend({ state: z.literal("failed"), verdict: z.null(), reasons: z.array(reasonSchema).max(16), dialogueQualityReasons: z.array(dialogueQualityReasonSchema).max(4).optional(), checks: evaluationChecksSchema.nullable(), incompleteRequestCount: z.number().int().nonnegative().nullable().optional(), unresolvedRequestCount: z.number().int().nonnegative().nullable().optional(), partialDraftCount: z.number().int().nonnegative().nullable().optional(), failureCode: z.enum(["history_read_failed", "result_write_failed"]) }).strict(),
]);
export type ConversationEvaluationRecord = z.infer<typeof conversationEvaluationRecordSchema>;
export type EvaluationHistoryEntry = { input: { command: { type: string; [key: string]: unknown } }; receipt: { accepted: boolean; state: Conversation } };

export function evaluationId(scope: ConversationScope, version: ConversationEvaluationVersion = CONVERSATION_EVALUATION_VERSION): string {
  return `eval-${createHash("sha256").update(JSON.stringify([scope.practiceId, scope.instanceId, scope.conversationId, version])).digest("hex")}`;
}

/** Deterministic post-conversation review. It never infers audio quality without a heard artifact. */
export function evaluateConversation(input: { conversation: Conversation; history: readonly EvaluationHistoryEntry[] | null; id?: string; version?: ConversationEvaluationVersion }): Extract<ConversationEvaluationRecord, { state: "completed" }> {
  const version = input.version ?? CONVERSATION_EVALUATION_VERSION;
  const scope: ConversationScope = { practiceId: input.conversation.admission.practiceId, instanceId: input.conversation.admission.instanceId, conversationId: input.conversation.id };
  const unresolvedRequestCount = input.conversation.requests.filter((request) => !isTerminalRequest(request)).length;
  // A current, bound synthetic staff-answer route preserves an open request for staff;
  // it is received, not resolved, and therefore does not make the evaluation a partial-draft failure.
  const partialDraftCount = input.conversation.requests.filter((request) => request.state === "draft"
    && !(version === "eval-r2" && isCurrentStaffAnsweredRouteDraft(input.conversation, request))).length;
  const sourcePreservation = input.conversation.requests.every((request) => request.sourceIds.some((sourceId) => input.conversation.inputs.some((source) => source.id === sourceId && source.body === request.originalRequest))) ? "passed" : "failed";
  const captures = input.history?.filter((entry) => entry.receipt.accepted
    && (entry.input.command.type === "request.capture" || entry.input.command.type === "request.confirm_and_capture_callback")) ?? [];
  const callbackBeforeCapture = input.history === null ? "unassessable" : captures.length === 0 ? "not_applicable" : captures.every((entry) => {
    const requestId = entry.input.command.requestId;
    return typeof requestId === "string" && entry.receipt.state.requests.some((request) => request.id === requestId && request.state !== "draft" && request.callbackConfirmed && request.confirmationSourceId !== null);
  }) ? "passed" : "failed";
  const emergencyCancelsStub = input.conversation.emergency === null
    ? "not_applicable" : input.conversation.transfers.every((transfer) => transfer.state !== "trying") && input.conversation.pendingQuestion === null ? "passed" : "failed";
  const noRealStubConnection = input.history === null ? "unassessable" : input.conversation.transfers.every((transfer) => transfer.state !== ("connected" as never))
    && input.history.every((entry) => !(entry.receipt.accepted && entry.input.command.type === "transfer.finish" && entry.input.command.state === "connected")) ? "passed" : "failed";
  const stubFollowupSpeech = assessStubFollowupSpeech(input.history);
  const dialogueQuality = assessDialogueQuality(input.conversation.admission.channel, input.history);
  const monitor = input.conversation.admission.channel === "sms" ? "not_applicable"
    : input.conversation.speechReviews.some((review) => review.verdict === "confirmed") ? "failed"
      : input.conversation.speechReviews.length === 0 || input.conversation.speechReviews.some((review) => review.verdict === "suspected" || review.verdict === "unassessable") ? "unassessable" : "passed";
  const partialRequests = partialDraftCount === 0 ? "passed" : "failed";
  const voiceAudioQuality = input.conversation.admission.channel === "voice" ? "unassessable" as const : "not_applicable" as const;
  const checks = { sourcePreservation, callbackBeforeCapture, emergencyCancelsStub, noRealStubConnection, stubFollowupSpeech, dialogueQuality: dialogueQuality.check, monitor, partialRequests, voiceAudioQuality };
  const reasons: z.infer<typeof reasonSchema>[] = input.conversation.admission.channel === "voice" ? ["no_heard_audio_artifact"] : [];
  if (input.history === null) reasons.push("history_unavailable");
  if (sourcePreservation === "failed") reasons.push("source_not_preserved");
  if (callbackBeforeCapture === "failed") reasons.push("callback_captured_unconfirmed");
  if (emergencyCancelsStub === "failed") reasons.push(input.conversation.transfers.some((transfer) => transfer.state === "trying") ? "emergency_transfer_active" : "emergency_intake_active");
  if (noRealStubConnection === "failed") reasons.push("stub_connection_claim");
  if (stubFollowupSpeech === "failed") reasons.push("stub_followup_transcript_missing");
  if (stubFollowupSpeech === "unassessable") reasons.push("stub_followup_transcript_unavailable");
  if (monitor === "failed") reasons.push("monitor_critical");
  if (monitor === "unassessable") reasons.push("monitor_missing");
  if (partialRequests === "failed") reasons.push("partial_request");
  const failed = Object.values(checks).some((value) => value === "failed");
  const unassessable = input.history === null || Object.values(checks).some((value) => value === "unassessable");
  const verdict = failed ? "failed" : unassessable ? "unassessable" : "passed";
  return conversationEvaluationRecordSchema.parse({ id: input.id ?? evaluationId(scope, version), version, scope, createdFromRevision: input.conversation.revision,
    state: "completed", verdict, reasons: [...new Set(reasons)], dialogueQualityReasons: dialogueQuality.reasons, checks, unresolvedRequestCount, partialDraftCount }) as Extract<ConversationEvaluationRecord, { state: "completed" }>;
}

type DialogueQualityAssessment = { check: z.infer<typeof checkSchema>; reasons: z.infer<typeof dialogueQualityReasonSchema>[] };

/**
 * Reviews preserve transcript evidence, not audio playback or a general semantic
 * quality assessment. This therefore records only narrowly observed failures and
 * never treats a clear monitor result as evidence of fluent dialogue.
 */
function assessDialogueQuality(channel: Conversation["admission"]["channel"], history: readonly EvaluationHistoryEntry[] | null): DialogueQualityAssessment {
  if (channel !== "voice") return { check: "not_applicable", reasons: [] };
  if (history === null) return { check: "unassessable", reasons: ["semantic_evidence_missing"] };
  const responses = observedAssistantResponses(history);
  if (responses.length === 0) return { check: "unassessable", reasons: ["semantic_evidence_missing"] };
  if (responses.some((response) => hasInternalRoleConfusion(response.transcript))) {
    return { check: "failed", reasons: ["role_confusion"] };
  }
  if (hasRepeatedIntakeQuestion(responses, history)) {
    return { check: "failed", reasons: ["repeated_intake_question"] };
  }
  return { check: "unassessable", reasons: [] };
}

type ObservedAssistantResponse = { responseId: string; transcript: string; historyIndex: number };

function observedAssistantResponses(history: readonly EvaluationHistoryEntry[]): ObservedAssistantResponse[] {
  const byResponseId = new Map<string, ObservedAssistantResponse>();
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]!;
    if (!entry.receipt.accepted || entry.input.command.type !== "monitor.review") continue;
    const review = entry.input.command.review;
    if (typeof review !== "object" || review === null) continue;
    const responseId = (review as { responseId?: unknown }).responseId;
    const transcript = (review as { transcript?: unknown }).transcript;
    if (typeof responseId !== "string" || typeof transcript !== "string") continue;
    // Multiple monitor items can describe one response; they are not audible repeats.
    const existing = byResponseId.get(responseId);
    if (existing === undefined) byResponseId.set(responseId, { responseId, transcript, historyIndex: index });
    else existing.transcript += ` ${transcript}`;
  }
  return [...byResponseId.values()].sort((left, right) => left.historyIndex - right.historyIndex);
}

function hasInternalRoleConfusion(transcript: string): boolean {
  return transcript.split(/[.!?]+/).some((sentence) => /\bi\s+can(?:not|'?t)\s+take\s+on\s+(?:the\s+)?server\s+handoff\s+directly\b/i
    .test(sentence.replace(/\u2019/g, "'")));
}

const intakeQuestionByKind = {
  name: "what is your name",
  callback_number_entry: "what number should the team call back",
  identity_dob: "what is your date of birth",
  identity_zip: "what is your five digit zip code",
} as const;

function hasRepeatedIntakeQuestion(responses: readonly ObservedAssistantResponse[], history: readonly EvaluationHistoryEntry[]): boolean {
  for (let first = 0; first < responses.length; first += 1) {
    const firstResponse = responses[first]!;
    const firstObligation = intakeObligationFor(firstResponse, history);
    if (firstObligation === null) continue;
    for (const secondResponse of responses.slice(first + 1)) {
      const secondObligation = intakeObligationFor(secondResponse, history);
      if (secondObligation === null || secondObligation.questionId !== firstObligation.questionId
        || secondObligation.question !== firstObligation.question) continue;
      const callerInputs: string[] = [];
      for (const entry of history.slice(firstResponse.historyIndex + 1, secondResponse.historyIndex)) {
        if (!entry.receipt.accepted || entry.input.command.type !== "input.record") continue;
        if (entry.input.command.questionId !== firstObligation.questionId) continue;
        const body = entry.input.command.body;
        if (typeof body === "string") callerInputs.push(body);
      }
      if (callerInputs.length === 0 || callerInputs.some((body) => explicitlyRequestsRepeat(body))) continue;
      return true;
    }
  }
  return false;
}

function intakeObligationFor(response: ObservedAssistantResponse, history: readonly EvaluationHistoryEntry[]): { questionId: string; question: string } | null {
  const questions = normalizedSentences(response.transcript);
  for (let index = response.historyIndex - 1; index >= 0; index -= 1) {
    const entry = history[index]!;
    if (!entry.receipt.accepted || entry.input.command.type !== "question.activate") continue;
    const question = intakeQuestionByKind[entry.input.command.kind as keyof typeof intakeQuestionByKind];
    const questionId = entry.input.command.questionId;
    if (question === undefined || typeof questionId !== "string" || !questions.has(question)) return null;
    return { questionId, question };
  }
  return null;
}

function normalizedSentences(transcript: string): Set<string> {
  return new Set(transcript.split(/[.!?]+/).map((sentence) => sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim()).filter(Boolean));
}

function explicitlyRequestsRepeat(body: string): boolean {
  return /\b(?:repeat|again|say that|what was that|did not catch|didn't catch|could not hear|couldn't hear|cannot hear|can't hear|pardon|excuse me)\b/i.test(body.replace(/\u2019/g, "'"));
}

function assessStubFollowupSpeech(history: readonly EvaluationHistoryEntry[] | null): z.infer<typeof checkSchema> {
  if (history === null) return "unassessable";
  let sawFollowup = false;
  let missingEvidence = false;
  let mismatch = false;
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]!;
    if (!entry.receipt.accepted || entry.input.command.type !== "transfer.finish") continue;
    const transferId = entry.input.command.transferId;
    const transfer = entry.receipt.state.transfers.find((item) => item.id === transferId);
    if (transfer === undefined || transfer.state === "canceled") continue;
    let activated: EvaluationHistoryEntry | undefined;
    for (const next of history.slice(index + 1)) {
      if (next.input.command.type === "input.record" || next.input.command.type === "conversation.disconnect") break;
      if (next.receipt.accepted && next.input.command.type === "question.activate"
        && next.input.command.requestId === transfer.requestId) { activated = next; break; }
    }
    if (activated === undefined) { missingEvidence = true; continue; }
    const question = activated.input.command.kind;
    const activatedQuestion = activated.receipt.state.pendingQuestion;
    const activatedRequest = activatedQuestion === null ? null
      : activated.receipt.state.requests.find((request) => request.id === activatedQuestion.requestId) ?? null;
    const expected = question === "name" ? "what is your name?"
      : question === "callback_number_entry" ? "what number should the team call back?"
        : question === "callback_number" ? callbackNumberReadbackQuestion(activatedQuestion?.callbackNumber, activatedRequest?.name).toLowerCase() : null;
    if (expected === null) continue;
    sawFollowup = true;
    const start = history.indexOf(activated) + 1;
    const reviews: string[] = [];
    for (const next of history.slice(start)) {
      if (next.input.command.type === "input.record" || next.input.command.type === "conversation.disconnect") break;
      if (next.receipt.accepted && next.input.command.type === "monitor.review") {
        const review = next.input.command.review;
        if (typeof review === "object" && review !== null && typeof (review as { transcript?: unknown }).transcript === "string"
          && (review as { authorityRevision?: unknown }).authorityRevision === activated.receipt.state.revision) {
          reviews.push((review as { transcript: string }).transcript);
        }
      }
    }
    if (reviews.length === 0) missingEvidence = true;
    else if (!reviews.some((text) => text.trim().replace(/\s+/g, " ").toLowerCase() === expected)) mismatch = true;
  }
  return mismatch ? "failed" : missingEvidence ? "unassessable" : sawFollowup ? "passed" : "not_applicable";
}

function isCurrentStaffAnsweredRouteDraft(conversation: Conversation, request: Conversation["requests"][number]): boolean {
  if (request.state !== "draft") return false;
  const superseded = new Set(conversation.simulatedRouteOutcomes.flatMap((outcome) => outcome.supersedesId === null ? [] : [outcome.supersedesId]));
  return conversation.simulatedRouteOutcomes.some((outcome) => outcome.outcome === "staff_answered" && !superseded.has(outcome.id)
    && outcome.requestId === request.id && outcome.requestRevision === request.revision
    // Closing a valid caller-exit handoff advances ownerEpoch exactly once. A disconnected
    // conversation can therefore retain that same active-route binding at prior epoch only.
    && (conversation.phase === "active" && outcome.ownerEpoch === conversation.ownerEpoch
      || conversation.phase === "disconnected" && conversation.owner === "ai" && outcome.ownerEpoch + 1 === conversation.ownerEpoch)
    && outcome.instanceId === conversation.admission.instanceId && outcome.conversationId === conversation.id);
}

function isTerminalRequest(request: Conversation["requests"][number]): boolean {
  // Preserve established human completion semantics. AI terminality additionally
  // requires the opaque server proof persisted by request.resolve_ai.
  return request.state === "completed" || request.state === "abandoned" || request.state === "ai_resolved"
    && request.aiResolution !== null && request.aiResolution !== undefined;
}

export type EvaluationResultPort = {
  get(input: { scope: ConversationScope; id: string }): Promise<ConversationEvaluationRecord | null>;
  complete(input: Extract<ConversationEvaluationRecord, { state: "completed" }>): Promise<ConversationEvaluationRecord>;
  fail(input: Extract<ConversationEvaluationRecord, { state: "failed" }>): Promise<ConversationEvaluationRecord>;
};

/** The durable store owns pending/failed/completed transitions; this handler only computes deterministic evidence. */
export class ConversationEvaluationWorker {
  constructor(private readonly options: { store: Pick<ConversationStore, "get" | "history">; results: EvaluationResultPort }) {}

  async handle(job: Pick<ConversationJob, "kind" | "scope" | "payload">): Promise<ConversationJobResult> {
    if (job.kind !== "post_call_eval") return { code: "not_needed" };
    const payload = conversationEvaluationPayloadSchema.safeParse(job.payload);
    if (!payload.success) return { code: "not_needed" };
    const record = await this.options.results.get({ scope: job.scope, id: payload.data.evaluationId });
    if (record === null) return { code: "not_needed" };
    if (record.state === "completed") return { code: "completed" };
    const conversation = await this.options.store.get(job.scope);
    if (conversation === null) return this.fail(record, "history_read_failed");
    let history: readonly EvaluationHistoryEntry[];
    try { history = await this.options.store.history(job.scope); }
    catch { return this.fail(record, "history_read_failed"); }
    try {
      await this.options.results.complete(evaluateConversation({ conversation, history, id: record.id, version: record.version }));
      return { code: "completed" };
    } catch { return this.fail(record, "result_write_failed"); }
  }

  private async fail(record: Exclude<ConversationEvaluationRecord, { state: "completed" }>, failureCode: "history_read_failed" | "result_write_failed"): Promise<ConversationJobResult> {
    try {
      await this.options.results.fail({ ...record, state: "failed", verdict: null, failureCode });
    } catch { throw new Error("conversation_evaluation_failure_write_failed"); }
    throw new Error("conversation_evaluation_retryable_failure");
  }
}
