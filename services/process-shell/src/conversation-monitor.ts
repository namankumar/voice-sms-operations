import { createHash } from "node:crypto";
import { z } from "zod";
import type { Conversation, ConversationScope } from "./conversation-contract.js";
import { compareProtectedReadSpeech, protectedReadCorrection, protectedReadReviewSchema, protectedReadSpeechAuthoritySchema,
  protectedReadSpeechClaimSchema, type ProtectedReadKind, type ProtectedReadSpeechAuthority } from "./f2-read-monitor.js";
import { approvedEmergencyVoiceInstruction } from "./receptionist-emergency-text.js";
import { callbackNumberReadbackCandidate, callbackNumberReadbackMatches, callbackNumberReadbackQuestion } from "./receptionist-callback-number.js";

const identifier = z.string().min(1).max(200);
// Current text must stay byte-for-byte aligned with receptionistAllowedFacts.savedClosed; retain the prior exact acknowledgement for replay. The monitor cannot import that value: policy -> contract -> monitor is an ESM cycle.
const approvedAfterHoursCallbackAcknowledgement = "I've saved your message. The team will return your call during business hours.";
const approvedCurrentAfterHoursCallbackAcknowledgement = "I've saved your message. A team member will call you back during business hours. Please watch for their call.";
const receptionistSpeechClaimSchema = z.object({
  kind: z.enum(["callback_saved", "staff_connected", "appointment_changed", "clinical_advice", "callback_deadline"]),
  quote: z.string().min(1).max(2000),
  requestId: identifier.nullable(),
  assertion: z.enum(["asserted", "uncertain"]),
}).strict();
export const speechClaimSchema = z.union([receptionistSpeechClaimSchema, protectedReadSpeechClaimSchema]);
export const speechAssessmentSchema = z.object({
  assessable: z.boolean(), claims: z.array(speechClaimSchema).max(16),
}).strict();
export type SpeechAssessment = z.infer<typeof speechAssessmentSchema>;
export const speechReviewSchema = z.object({
  scope: z.object({ practiceId: identifier, instanceId: identifier, conversationId: identifier }).strict(),
  id: identifier, version: identifier, responseId: identifier, outputItemId: identifier,
  voiceEpoch: z.number().int().nonnegative(), authorityRevision: z.number().int().nonnegative(),
  transcript: z.string().min(1).max(8000),
  verdict: z.enum(["clear", "confirmed", "suspected", "unassessable"]),
  reasons: z.array(z.enum(["no_critical_claim", "unsupported_saved_claim", "unsupported_connection", "unsupported_appointment",
    "clinical_advice", "unsupported_callback_deadline", "ambiguous_claim", "invalid_source", "monitor_unavailable", "missing_authority"])).min(1).max(16),
  claims: z.array(speechClaimSchema).max(16),
  protectedReadCheck: protectedReadReviewSchema.nullable().optional(),
  correction: z.enum(["not_required", "pending", "attempting", "generated", "unheard", "staff_resolved"]),
}).strict();
export type SpeechReview = z.infer<typeof speechReviewSchema>;
export const publicKnowledgeSpeechAuthoritySchema = z.object({
  requestId: identifier, requestRevision: z.number().int().nonnegative(), sourceId: identifier,
  factId: identifier, factVersion: identifier, text: z.string().trim().min(1).max(2_000),
  proposalRevision: z.number().int().nonnegative(), authorityRevision: z.number().int().nonnegative(),
  ownerEpoch: z.number().int().nonnegative(), voiceEpoch: z.number().int().nonnegative(),
}).strict().superRefine((binding, context) => {
  if (binding.proposalRevision > binding.authorityRevision) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["proposalRevision"], message: "public_knowledge_proposal_revision_future" });
  }
});
export type PublicKnowledgeSpeechAuthority = z.infer<typeof publicKnowledgeSpeechAuthoritySchema>;
export type SpeechReviewInput = {
  scope: ConversationScope; responseId: string; outputItemId: string; voiceEpoch: number;
  transcript: string; authority: Conversation | null;
  /** Trusted response binding supplied by the server; never sourced from model output. */
  protectedRead?: ProtectedReadSpeechAuthority | null;
  /** One-shot binding for an exact approved public fact supplied by the server. */
  publicKnowledge?: PublicKnowledgeSpeechAuthority | null;
};
export type SpeechAssessor = { assess(input: { transcript: string; requestIds: readonly string[];
  expectedProtectedReadKind?: ProtectedReadKind | null; signal: AbortSignal; scope?: ConversationScope }): Promise<unknown> };

/** Checks generated claims against the snapshot captured before that response, not later writes. */
export function assessSpeech(input: SpeechReviewInput, raw: unknown, version: string): SpeechReview {
  const base = { scope: input.scope, id: reviewId(input, version), version, responseId: input.responseId, outputItemId: input.outputItemId,
    voiceEpoch: input.voiceEpoch, authorityRevision: input.authority?.revision ?? 0, transcript: input.transcript };
  const result = speechAssessmentSchema.safeParse(raw);
  const authority = input.authority;
  if (authority === null || authority.id !== input.scope.conversationId || authority.admission.practiceId !== input.scope.practiceId
    || authority.admission.instanceId !== input.scope.instanceId || authority.voiceEpoch !== input.voiceEpoch) {
    return speechReviewSchema.parse({ ...base, verdict: "unassessable", reasons: ["missing_authority"], claims: [], correction: "not_required" });
  }
  const protectedAuthority = input.protectedRead === undefined || input.protectedRead === null
    ? null : protectedReadSpeechAuthoritySchema.safeParse(input.protectedRead);
  if (protectedAuthority !== null && (!protectedAuthority.success || !protectedAuthorityMatches(input, protectedAuthority.data))) {
    const protectedReadCheck = protectedAuthority.success
      ? protectedReadReviewSchema.parse({ ...protectedReference(protectedAuthority.data), status: "unassessable", reason: "invalid_authority" })
      : null;
    return speechReviewSchema.parse({ ...base, verdict: "unassessable", reasons: ["missing_authority"], claims: [], protectedReadCheck, correction: "not_required" });
  }
  const callbackReadback = currentCallbackReadback(authority);
  const callbackReadbackMismatch = callbackReadback !== null && callbackReadback.candidate(input.transcript) && !callbackReadback.matches(input.transcript);
  if (!result.success || !result.data.assessable) {
    if (callbackReadbackMismatch) {
      return speechReviewSchema.parse({ ...base, verdict: "confirmed", reasons: ["invalid_source"], claims: [], correction: "pending" });
    }
    const protectedReadCheck = protectedAuthority?.success
      ? compareProtectedReadSpeech({ transcript: input.transcript, authority: protectedAuthority.data, claims: [] }) : undefined;
    return speechReviewSchema.parse({ ...base, verdict: "unassessable", reasons: ["monitor_unavailable"], claims: [],
      ...(protectedReadCheck === undefined ? {} : { protectedReadCheck }), correction: "not_required" });
  }
  if (result.data.claims.some((claim) => !input.transcript.includes(claim.quote))) {
    return speechReviewSchema.parse({ ...base, verdict: callbackReadbackMismatch ? "confirmed" : "unassessable", reasons: ["invalid_source"], claims: [],
      correction: callbackReadbackMismatch ? "pending" : "not_required" });
  }
  // The assessor can mislabel these exact, incomplete-capture acknowledgements
  // as durable saves. Keep mixed or completed-delivery claims reviewable.
  const assessedClaims = result.data.claims.filter((claim) => claim.kind !== "callback_saved" || !nonAssertedCallbackSavedQuote(claim.quote));
  const deterministicDelivery = completedCallbackDeliveryClaim(input.transcript, authority);
  const claims = deterministicDelivery === null || assessedClaims.some((claim) => claim.kind === "callback_saved" && claim.assertion === "asserted" && claim.quote === deterministicDelivery.quote)
    ? assessedClaims : [...assessedClaims, deterministicDelivery];
  const reasons: SpeechReview["reasons"] = [];
  let confirmed = false, suspected = false, unassessable = false;
  let protectedReadCheck: SpeechReview["protectedReadCheck"] | undefined;
  if (callbackReadbackMismatch) {
    confirmed = true;
    reasons.push("invalid_source");
  }
  const protectedClaims = claims.filter((claim): claim is z.infer<typeof protectedReadSpeechClaimSchema> => claim.kind === "protected_read");
  const safeClinicalAdministrativeSpeech = nonAdvisoryClinicalRefusalSpeech(input.transcript);
  const approvedPublicKnowledge = protectedAuthority?.success !== true
    && !(input.publicKnowledge === undefined || input.publicKnowledge === null)
    && publicKnowledgeSpeechAuthorityMatches(input, authority);
  // A server-created public-fact binding is exact-response authority. Keep the
  // assessor's claims for audit, but do not let its label redefine that speech.
  const approvedPersistedCallback = approvedPersistedCallbackSpeech(input, authority);
  const reviewableClaims = approvedPublicKnowledge ? [] : approvedPersistedCallback
    ? claims.filter((claim) => claim.kind !== "callback_saved" && claim.kind !== "callback_deadline")
    : claims;
  const reviewableProtectedClaims = approvedPublicKnowledge
    ? []
    : safeClinicalAdministrativeSpeech
    ? protectedClaims.filter((claim) => !administrativeIdentityQuestionClaim(claim.quote)) : protectedClaims;
  if (protectedAuthority?.success) {
    protectedReadCheck = compareProtectedReadSpeech({ transcript: input.transcript, authority: protectedAuthority.data, claims: reviewableProtectedClaims });
    if (protectedReadCheck.status === "unassessable") {
      return speechReviewSchema.parse({ ...base, verdict: "unassessable", reasons: [protectedReadCheck.reason === "invalid_source" ? "invalid_source" : "monitor_unavailable"],
        claims, protectedReadCheck, correction: "not_required" });
    }
    if (protectedReadCheck.status === "mismatch") { confirmed = true; reasons.push("invalid_source"); }
    if (protectedReadCheck.status === "uncertain") { suspected = true; reasons.push("ambiguous_claim"); }
  } else if (reviewableProtectedClaims.length > 0) {
    suspected = true;
    reasons.push("missing_authority");
  }
  for (const claim of reviewableClaims) {
    if (claim.kind === "protected_read") continue;
    if (claim.kind === "clinical_advice" && (administrativeIdentitySpeech(input.transcript)
      || safeClinicalAdministrativeSpeech || approvedEmergencyDirectiveSpeech(input, authority))) continue;
    if (claim.assertion === "uncertain") { suspected = true; reasons.push("ambiguous_claim"); continue; }
    if (claim.kind === "callback_saved") {
      const callback = callbackAuthority(authority, claim.requestId);
      if (callback === "matched") continue;
      if (callback === "ambiguous") { suspected = true; reasons.push("ambiguous_claim"); continue; }
      confirmed = true; reasons.push("unsupported_saved_claim");
    } else if (claim.kind === "appointment_changed") {
      const action = appointmentActionAuthority(authority, claim.requestId, claim.quote);
      if (action === "matched") continue;
      if (action === "unassessable") { unassessable = true; reasons.push("ambiguous_claim"); continue; }
      confirmed = true; reasons.push("unsupported_appointment");
    } else {
      // A full-mode read or callback does not authorize connection, clinical advice, or a promised deadline.
      const reason = { staff_connected: "unsupported_connection", clinical_advice: "clinical_advice",
        callback_deadline: "unsupported_callback_deadline" } as const;
      confirmed = true; reasons.push(reason[claim.kind]);
    }
  }
  const verdict = confirmed ? "confirmed" : unassessable ? "unassessable" : suspected ? "suspected" : "clear";
  return speechReviewSchema.parse({ ...base, verdict, reasons: reasons.length ? [...new Set(reasons)] : ["no_critical_claim"],
    claims, ...(protectedReadCheck === undefined ? {} : { protectedReadCheck }), correction: verdict === "confirmed" ? "pending" : "not_required" });
}

/** A public fact can suppress only a misclassified protected read on its exact response binding. */
function publicKnowledgeSpeechAuthorityMatches(input: SpeechReviewInput, authority: Conversation): boolean {
  const parsed = publicKnowledgeSpeechAuthoritySchema.safeParse(input.publicKnowledge);
  if (!parsed.success) return false;
  const binding = parsed.data;
  const request = authority.requests.find((item) => item.id === binding.requestId);
  return input.transcript === binding.text
    && input.voiceEpoch === binding.voiceEpoch
    && authority.revision === binding.authorityRevision
    && authority.ownerEpoch === binding.ownerEpoch
    && request?.state === "draft"
    && request.revision === binding.requestRevision
    && request.proposalRevision === binding.proposalRevision
    && request.sourceIds.includes(binding.sourceId)
    && (request.fullProposal?.capability === "approved_practice_information"
      || request.fullProposal?.capability === "office_address" && request.fullProposal.knowledgeTopic === "address");
}

/** An exact callback readback is authoritative only for the one active, source-backed draft it names. */
function currentCallbackReadback(authority: Conversation): { text: string; candidate(transcript: string): boolean; matches(transcript: string): boolean } | null {
  if (authority.admission.mode !== "receptionist" || authority.admission.channel !== "voice" || authority.phase !== "active"
    || authority.owner !== "ai" || authority.emergency !== null) return null;
  const question = authority.pendingQuestion;
  if (question?.kind !== "callback_number" || question.requestId === null || question.requestRevision === null) return null;
  const request = authority.requests.find((item) => item.id === question.requestId);
  const newest = authority.inputs.at(-1);
  if (request?.state !== "draft" || request.revision !== question.requestRevision || request.callbackConfirmed
    || request.name.trim() === "" || request.callbackNumber !== question.callbackNumber
    || !/^\+[1-9]\d{7,14}$/.test(request.callbackNumber) || newest === undefined || !request.sourceIds.includes(newest.id)
    || authority.requests.filter((item) => item.state === "draft").length !== 1) return null;
  return { text: callbackNumberReadbackQuestion(question.callbackNumber, request.name),
    candidate: (transcript: string) => callbackNumberReadbackCandidate(transcript),
    matches: (transcript: string) => callbackNumberReadbackMatches(transcript, question.callbackNumber, request.name) };
}

/** The exact after-hours acknowledgement is a server-owned result of one completed callback capture. */
function approvedPersistedCallbackSpeech(input: SpeechReviewInput, authority: Conversation): boolean {
  if (![approvedAfterHoursCallbackAcknowledgement, approvedCurrentAfterHoursCallbackAcknowledgement].includes(input.transcript) || authority.admission.channel !== "voice" || authority.admission.hours !== "demo_closed") return false;
  const sourceBacked = authority.requests.filter((request) => request.sourceIds.length > 0
    && request.sourceIds.every((sourceId) => authority.inputs.some((item) => item.id === sourceId))
    && request.proposalRevision <= authority.revision);
  const completed = sourceBacked.filter((request) => request.state === "needs_callback"
    && request.callbackMessageSourceId !== null && request.callbackMessageSourceId !== undefined && request.sourceIds.includes(request.callbackMessageSourceId)
    && request.name.trim() !== "" && /^\+[1-9]\d{7,14}$/.test(request.callbackNumber) && request.callbackConfirmed
    && request.confirmationSourceId !== null && request.confirmationSourceId !== undefined);
  const latestRevision = sourceBacked.reduce((latest, request) => Math.max(latest, request.proposalRevision), -1);
  const latest = sourceBacked.filter((request) => request.proposalRevision === latestRevision);
  if (completed.length !== 1 || latest.length !== 1 || latest[0]!.id !== completed[0]!.id
    || authority.requests.some((request) => request.id !== completed[0]!.id && request.state === "draft")) return false;
  const callback = completed[0]!;
  const confirmation = authority.inputs.find((item) => item.id === callback.confirmationSourceId);
  const newest = authority.inputs.at(-1);
  return confirmation !== undefined && confirmation.sequence > callback.proposalRevision
    && newest?.id === confirmation.id && callback.proposalRevision <= authority.revision;
}

function nonAssertedCallbackSavedQuote(quote: string): boolean {
  const normalized = quote.toLowerCase().replace(/[’]/g, "'").trim().replace(/[.!?]+$/, "");
  return /^i(?:'ll| will) record that number for the callback$/.test(normalized)
    || /^i need to correct that:\s+(?:(?:your|the)\s+)?message was not yet saved$/.test(normalized)
    || /^(?:(?:(?:your|the)\s+)?(?:message|callback)\s+)?(?:(?:was|is)\s+not(?:\s+yet)?|has\s+not\s+been|wasn't|isn't|hasn't\s+been|not(?:\s+yet)?)\s+(?:saved|captured)$/.test(normalized);
}

/** Completed first-person delivery is a claim of durable callback handling, not a future offer. */
function completedCallbackDeliveryClaim(transcript: string, authority: Conversation): z.infer<typeof receptionistSpeechClaimSchema> | null {
  for (const quote of transcript.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean)) {
    const sentence = quote.toLowerCase().replace(/[’]/g, "'");
    const delivery = /\bi(?:'ve| have)\s+(?:already\s+|just\s+)?(?:(?:passed along|sent|forwarded)\s+(?:(?:what|everything) you asked|(?:your|the) (?:message|request))|passed\s+(?:your|the)\s+(?:message|request)\s+along)\b/.exec(sentence);
    if (delivery === null) continue;
    const prefix = sentence.slice(0, delivery.index);
    const deliveryClausePrefix = prefix.split(/\b(?:but|however)\b/).at(-1)!;
    if (/\bi (?:haven't|have not|didn't|did not|can't|cannot)\b.{0,40}\b(?:passed(?:\s+(?:your|the)\s+(?:message|request))?\s+along|sent|forwarded)\b/.test(deliveryClausePrefix)
      || /\b(?:if|unless|when|after|once|before|until)\b/.test(prefix)) continue;
    const sourceBacked = authority.requests.filter((request) => request.sourceIds.length > 0
      && request.sourceIds.every((sourceId) => authority.inputs.some((input) => input.id === sourceId))
      && request.proposalRevision <= authority.revision);
    return { kind: "callback_saved", quote, requestId: sourceBacked.length === 1 ? sourceBacked[0]!.id : null, assertion: "asserted" };
  }
  return null;
}

/** Exact administrative utterances cannot acquire a clinical meaning from an assessor label. */
function administrativeIdentitySpeech(transcript: string): boolean {
  const sentences = normalizedSentences(transcript);
  return sentences.length > 0 && sentences.every((sentence) => administrativeSentences.has(sentence));
}

/** Only the server's exact emergency directive is non-clinical after emergency state is durable. */
function approvedEmergencyDirectiveSpeech(input: SpeechReviewInput, authority: Conversation): boolean {
  return input.transcript === approvedEmergencyVoiceInstruction && authority.emergency !== null
    && authority.emergency.declaredRevision <= authority.revision;
}

/** A refusal plus referral is not advice; every other sentence must remain server-owned administration. */
function nonAdvisoryClinicalRefusalSpeech(transcript: string): boolean {
  const sentences = normalizedSentences(transcript);
  let refusal = false, referral = false;
  for (const sentence of sentences) {
    if (/^(?:i can help with your appointment time, but )?i (?:can't|cannot) (?:provide (?:clinical|medical) advice(?: about stopping your blood thinner(?: medications)?)?|advise on stopping (?:your )?blood thinner(?: medications)?)$/.test(sentence)) {
      refusal = true;
    } else if (/^(?:for that,? please follow your (?:clinician|doctor|care team)'s instructions|that has to come from your (?:clinician|doctor|care team)|please speak with your care team)$/.test(sentence)) {
      referral = true;
    } else if (!administrativeSentences.has(sentence) && !administrativeIdentityContinuation(sentence)) {
      return false;
    }
  }
  return refusal && referral;
}

function normalizedSentences(transcript: string): string[] {
  return transcript.toLowerCase().replace(/[’]/g, "'").replace(/[—–]/g, ".").split(/[.!?]+/)
    .map((part) => part.trim().replace(/^(?:(?:okay|ok|sorry|thank you)[,\s]+)+/, "")).filter(Boolean);
}

function administrativeIdentityContinuation(sentence: string): boolean {
  return /^(?:for now,? )?to look up your appointment,? what's your date of birth$/.test(sentence);
}

function administrativeIdentityQuestionClaim(quote: string): boolean {
  const sentences = normalizedSentences(quote);
  return sentences.length === 1 && (administrativeIdentityContinuation(sentences[0]!)
    || /^(?:what is|what's) your (?:date of birth|five-digit zip code)$/.test(sentences[0]!));
}

const administrativeSentences = new Set([
    "i couldn't match that date of birth", "please say the month, day, and four-digit year slowly",
    "what is your date of birth", "what is your five-digit zip code",
    "i couldn't confirm the zip code", "please say all five digits, one at a time",
    "i cannot provide medical advice", "please speak with your care team", "if this is an emergency, hang up and call 911",
    "for your appointment timing, i can help look it up, but the system needs to verify your identity first",
    "if you'd like, share your date of birth so i can proceed with the appointment lookup",
    "now, for identity verification, please say your date of birth again by saying the month, then the day, then the year, one piece at a time",
  ]);

export type SpeechMonitor = {
  observe(input: SpeechReviewInput): Promise<SpeechReview>;
  /** Freezes one voice epoch, an entire conversation when epoch is omitted, or every conversation when scope is omitted. */
  drain(scope?: ConversationScope, voiceEpoch?: number): Promise<void>;
};

/** Runs after speech events. It never waits in the caller's audio path or certifies that speech was heard. */
export function createSpeechMonitor(options: {
  version: string; assessor: SpeechAssessor;
  persist(input: { scope: ConversationScope; review: SpeechReview; signal: AbortSignal }): Promise<SpeechReview>;
  claimCorrection(input: { scope: ConversationScope; review: SpeechReview; signal: AbortSignal }): Promise<boolean>;
  /** Implementations must stop pending provider effects when signal is aborted. */
  correct(input: { scope: ConversationScope; review: SpeechReview; directive: string; signal: AbortSignal }): Promise<"generated" | "unheard">;
  unavailable(input: { scope: ConversationScope; voiceEpoch: number; signal: AbortSignal }): Promise<void>;
  timeoutMs?: number;
  /** Bounds shutdown waiting without canceling an underlying side-effect promise. */
  drainTimeoutMs?: number;
  capacity?: number;
}): SpeechMonitor {
  identifier.parse(options.version);
  const timeout = options.timeoutMs ?? 5000, capacity = options.capacity ?? 8;
  const drainTimeout = options.drainTimeoutMs ?? Math.min(120_000, Math.max(1_000, timeout * 4));
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000
    || !Number.isSafeInteger(drainTimeout) || drainTimeout <= timeout || drainTimeout > 120_000
    || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64) throw new Error("monitor_limits_invalid");
  const active = new Map<string, { scopeKey: string; voiceEpoch: number; work: Promise<SpeechReview> }>();
  const settlements = new Set<{ scopeKey: string; voiceEpoch: number; work: Promise<void> }>();
  const completed = new Map<string, SpeechReview>();
  const fingerprints = new Map<string, string>();
  const ambiguous = new Set<string>();
  const frozenScopes = new Set<string>();
  const frozenEpochs = new Set<string>();
  let globallyClosed = false;
  let primaryActive = 0;

  async function run(input: SpeechReviewInput, assess: boolean): Promise<SpeechReview> {
    const inputScopeKey = scopeKey(input.scope);
    const wait = <T>(operation: (signal: AbortSignal) => Promise<T>, trackSideEffect = true) => bounded(operation, timeout,
      trackSideEffect ? (work) => {
        const tracked = { scopeKey: inputScopeKey, voiceEpoch: input.voiceEpoch, work };
        settlements.add(tracked);
        void work.then(() => settlements.delete(tracked));
      } : undefined);
    let recoveryAttempted = false;
    const recover = async (): Promise<void> => {
      if (recoveryAttempted) return;
      recoveryAttempted = true;
      try {
        await wait((signal) => options.unavailable({ scope: input.scope, voiceEpoch: input.voiceEpoch, signal }));
      } catch { throw new Error("speech_monitor_recovery_unknown"); }
    };
    try {
      let raw: unknown = { assessable: false, claims: [] };
      if (assess) {
        try {
          raw = await wait((signal) => options.assessor.assess({ transcript: input.transcript,
            requestIds: input.authority?.requests.map((item) => item.id) ?? [],
            expectedProtectedReadKind: input.protectedRead?.readKind ?? null, signal, scope: input.scope }), false);
        } catch { /* A failed or late assessment remains explicitly unassessable. */ }
      }
      let review = assessSpeech(input, raw, options.version);
      review = await wait((signal) => options.persist({ scope: input.scope, review, signal }));
      if (review.verdict === "unassessable") {
        await recover();
        return review;
      }
      if (review.verdict === "confirmed" && review.correction === "attempting") {
        review = await wait((signal) => options.persist({ scope: input.scope,
          review: { ...review, correction: "unheard" }, signal }));
        return review;
      }
      if (review.verdict === "confirmed" && review.correction === "pending"
        && await wait((signal) => options.claimCorrection({ scope: input.scope, review, signal }))) {
        let correction: "generated" | "unheard" = "unheard";
        try {
          correction = await wait((signal) => options.correct({ scope: input.scope, review,
            directive: correctionDirective(review, input.protectedRead, input.authority), signal }));
        } catch { /* An aborted or unknown correction is never evidence that it was heard. */ }
        review = { ...review, correction };
        review = await wait((signal) => options.persist({ scope: input.scope, review, signal }));
      }
      return review;
    } catch (error) {
      if (!recoveryAttempted) await recover();
      if (error instanceof Error && error.message === "speech_monitor_recovery_unknown") throw error;
      throw new Error("speech_monitor_attempt_unknown");
    }
  }
  return {
    observe(rawInput) {
      const input = structuredClone(rawInput);
      const key = reviewId(input, options.version);
      const fingerprint = createHash("sha256").update(JSON.stringify([input.transcript, input.authority, input.protectedRead ?? null])).digest("hex");
      const existing = fingerprints.get(key);
      if (existing !== undefined && existing !== fingerprint) return Promise.reject(new Error("speech_review_payload_conflict"));
      if (ambiguous.has(key)) return Promise.reject(new Error("speech_monitor_attempt_unknown"));
      const cached = completed.get(key);
      if (cached) return Promise.resolve(cached);
      const pending = active.get(key);
      if (pending) return pending.work;
      const inputScopeKey = scopeKey(input.scope);
      if (globallyClosed || frozenScopes.has(inputScopeKey) || frozenEpochs.has(epochKey(input.scope, input.voiceEpoch))) return Promise.reject(new Error("speech_monitor_closed"));
      const assess = primaryActive < capacity;
      if (assess) primaryActive += 1;
      fingerprints.set(key, fingerprint);
      const work = Promise.resolve().then(() => run(input, assess)).then((review) => {
        completed.set(key, review);
        if (completed.size > 128) { const first = completed.keys().next().value!; completed.delete(first); fingerprints.delete(first); }
        return review;
      }).catch((error) => {
        ambiguous.add(key);
        throw error;
      }).finally(() => {
        active.delete(key);
        if (assess) primaryActive -= 1;
      });
      active.set(key, { scopeKey: inputScopeKey, voiceEpoch: input.voiceEpoch, work });
      return work;
    },
    async drain(scope, voiceEpoch) {
      if (voiceEpoch !== undefined && (scope === undefined || !Number.isSafeInteger(voiceEpoch) || voiceEpoch < 0)) throw new Error("speech_monitor_drain_target_invalid");
      const target = scope === undefined ? null : scopeKey(scope);
      if (target === null) globallyClosed = true;
      else if (voiceEpoch === undefined) frozenScopes.add(target);
      else frozenEpochs.add(epochKey(scope!, voiceEpoch));
      const matches = (item: { scopeKey: string; voiceEpoch: number }) =>
        target === null || item.scopeKey === target && (voiceEpoch === undefined || item.voiceEpoch === voiceEpoch);
      const deadline = Date.now() + drainTimeout;
      let failure: unknown;
      while (true) {
        const admitted = [...active.values()].filter(matches).map((item) => item.work);
        const underlying = [...settlements].filter(matches).map((item) => item.work);
        if (admitted.length === 0 && underlying.length === 0) {
          if (failure !== undefined) throw failure;
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw drainFailure(underlying.length > 0);
        let results: PromiseSettledResult<unknown>[];
        try {
          results = await settleWithin([...admitted, ...underlying], remaining);
        } catch {
          const unsettled = [...settlements].some(matches);
          throw drainFailure(unsettled);
        }
        const rejected = results.slice(0, admitted.length).find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure === undefined && rejected !== undefined) failure = rejected.reason;
      }
    },
  };
}

async function settleWithin(promises: readonly Promise<unknown>[], timeout: number): Promise<PromiseSettledResult<unknown>[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(promises),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("monitor_drain_deadline")), timeout); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function drainFailure(unsettledSideEffect: boolean): Error {
  return new Error(unsettledSideEffect ? "speech_monitor_unsettled_side_effect" : "speech_monitor_drain_timeout");
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeout: number,
  admitted?: (settlement: Promise<void>) => void): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(() => operation(controller.signal)).then((result) => {
    if (controller.signal.aborted) throw new Error("monitor_deadline");
    return result;
  });
  admitted?.(work.then(() => undefined, () => undefined));
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("monitor_deadline")); }, timeout);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function scopeKey(scope: ConversationScope): string {
  return JSON.stringify([scope.practiceId, scope.instanceId, scope.conversationId]);
}
function epochKey(scope: ConversationScope, voiceEpoch: number): string {
  return JSON.stringify([scope.practiceId, scope.instanceId, scope.conversationId, voiceEpoch]);
}

export function correctionDirective(review: SpeechReview, protectedRead?: ProtectedReadSpeechAuthority | null, authority?: Conversation | null): string {
  const statements: string[] = [];
  const callbackReadback = authority === undefined || authority === null ? null : currentCallbackReadback(authority);
  if (review.reasons.includes("invalid_source") && callbackReadback !== null && callbackReadback.candidate(review.transcript) && !callbackReadback.matches(review.transcript)) {
    statements.push(`I need to correct that. ${callbackReadback.text}`);
  }
  if (review.protectedReadCheck?.status === "mismatch" && protectedRead !== undefined && protectedRead !== null) {
    const checked = protectedReadSpeechAuthoritySchema.safeParse(protectedRead);
    if (checked.success && checked.data.directiveId === review.protectedReadCheck.directiveId
      && checked.data.receiptId === review.protectedReadCheck.receiptId) statements.push(protectedReadCorrection(checked.data));
  }
  if (review.reasons.includes("unsupported_saved_claim")) statements.push("I need to correct that: your message was not yet saved.");
  if (review.reasons.includes("unsupported_connection")) statements.push("You have not been connected to a staff member. This demo uses a transfer placeholder.");
  if (review.reasons.includes("unsupported_appointment")) statements.push("Your appointment has not been changed by this receptionist.");
  if (review.reasons.includes("clinical_advice")) statements.push("I cannot provide medical advice. Please speak with your care team. If this is an emergency, hang up and call 911.");
  if (review.reasons.includes("unsupported_callback_deadline")) statements.push("I cannot promise a specific callback time. The office can follow up during business hours.");
  return statements.join(" ");
}

function protectedAuthorityMatches(input: SpeechReviewInput, authority: ProtectedReadSpeechAuthority): boolean {
  const conversation = input.authority;
  const request = conversation?.requests.find((candidate) => candidate.id === authority.requestId);
  return conversation !== null && conversation !== undefined && conversation.admission.mode === "full" && conversation.admission.channel === "voice"
    && conversation.phase === "active" && conversation.owner === "ai" && conversation.ownerEpoch === authority.ownerEpoch
    && conversation.voiceEpoch === authority.voiceEpoch && input.voiceEpoch === authority.voiceEpoch
    && request?.state === "draft" && request.revision === authority.requestRevision
    && request.fullProposal?.capability === authority.readKind;
}

function callbackAuthority(authority: Conversation, requestId: string | null): "matched" | "ambiguous" | "unsupported" {
  const sourceBacked = authority.requests.filter((request) => request.sourceIds.length > 0
    && request.sourceIds.every((sourceId) => authority.inputs.some((input) => input.id === sourceId))
    && request.proposalRevision <= authority.revision);
  const request = requestId === null ? null : sourceBacked.find((candidate) => candidate.id === requestId) ?? null;
  const latestRevision = sourceBacked.reduce((latest, candidate) => Math.max(latest, candidate.proposalRevision), -1);
  const latest = sourceBacked.filter((candidate) => candidate.proposalRevision === latestRevision);
  const confirmation = request?.confirmationSourceId === null || request?.confirmationSourceId === undefined ? null
    : authority.inputs.find((input) => input.id === request.confirmationSourceId) ?? null;
  const captured = request !== null && ["needs_callback", "in_progress", "completed"].includes(request.state)
    && request.callbackConfirmed && /^\+[1-9]\d{7,14}$/.test(request.callbackNumber) && request.name.trim() !== ""
    && confirmation !== null && confirmation.sequence > request.proposalRevision;
  if (captured && latest.length === 1 && latest[0]!.id === request.id
    && !authority.requests.some((candidate) => candidate.id !== request.id && candidate.state === "draft")) return "matched";
  if (captured || requestId === null && sourceBacked.some((candidate) => ["needs_callback", "in_progress", "completed"].includes(candidate.state))) {
    return "ambiguous";
  }
  return "unsupported";
}

function appointmentActionAuthority(authority: Conversation, requestId: string | null, quote: string): "matched" | "missing" | "unassessable" {
  const mutationRequests = authority.requests.filter((request) => request.sourceIds.length > 0
    && request.sourceIds.every((sourceId) => authority.inputs.some((input) => input.id === sourceId))
    && request.proposalRevision <= authority.revision
    && request.fullProposal !== undefined
    && ["appointment_schedule", "appointment_reschedule", "appointment_attendance_confirm"].includes(request.fullProposal.capability));
  const latestRevision = mutationRequests.reduce((latest, request) => Math.max(latest, request.proposalRevision), -1);
  const latest = mutationRequests.filter((request) => request.proposalRevision === latestRevision);
  const actionReceipts = authority.requests.filter((request) => request.state === "ai_resolved" && request.aiResolution?.kind === "action");
  if (authority.admission.mode !== "full" || latest.length !== 1 || requestId !== null && latest[0]!.id !== requestId) {
    return actionReceipts.length > 0 ? "unassessable" : "missing";
  }
  const request = latest[0]!;
  if (request.state !== "ai_resolved" || request.aiResolution?.kind !== "action") return actionReceipts.length > 0 ? "unassessable" : "missing";
  const expectedOperation = request.fullProposal!.capability === "appointment_schedule" ? "schedule"
    : request.fullProposal!.capability === "appointment_reschedule" ? "reschedule" : "attendance_confirm";
  if (request.aiResolution.operation !== expectedOperation) return "unassessable";
  return spokenAppointmentOperation(quote) === expectedOperation ? "matched" : "unassessable";
}

function spokenAppointmentOperation(quote: string): "schedule" | "reschedule" | "attendance_confirm" | "cancel" | null {
  const value = quote.normalize("NFKD").toLowerCase().replace(/[^a-z']+/g, " ").trim();
  const exact = new Map<string, "schedule" | "reschedule" | "attendance_confirm" | "cancel">([
    ["your appointment has been scheduled", "schedule"], ["your appointment has been booked", "schedule"],
    ["i scheduled your appointment", "schedule"], ["i booked your appointment", "schedule"],
    ["your appointment has been rescheduled", "reschedule"], ["your appointment has been moved", "reschedule"],
    ["i rescheduled your appointment", "reschedule"], ["i moved your appointment", "reschedule"],
    ["your attendance has been confirmed", "attendance_confirm"], ["i confirmed your attendance", "attendance_confirm"],
    ["you are confirmed to attend", "attendance_confirm"], ["you're confirmed to attend", "attendance_confirm"],
    ["your appointment has been canceled", "cancel"], ["your appointment has been cancelled", "cancel"],
    ["i canceled your appointment", "cancel"], ["i cancelled your appointment", "cancel"],
  ]);
  return exact.get(value) ?? null;
}

function protectedReference(authority: ProtectedReadSpeechAuthority) {
  return { directiveId: authority.directiveId, requestId: authority.requestId, requestRevision: authority.requestRevision,
    receiptId: authority.receiptId, receiptHash: authority.receiptHash, resultHash: authority.resultHash,
    sourceVersion: authority.sourceVersion, readKind: authority.readKind };
}

function reviewId(input: SpeechReviewInput, version: string): string {
  return `speech-${createHash("sha256").update(JSON.stringify([input.scope, input.voiceEpoch, input.responseId, input.outputItemId, version])).digest("hex")}`;
}
