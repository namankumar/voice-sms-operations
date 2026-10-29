import { createHash } from "node:crypto";
import { z } from "zod";
import { ConversationConflict, scopeOf, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore, TransitionReceipt } from "./conversation-store.js";
import { selectPendingCallerInputs } from "./f2-context.js";
import { decideFullRequest, fullRequestProposalSchema, type FullRequestDecision, type FullRequestProposal } from "./f2-request-policy.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const sourceId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const invocationSchema = z.object({
  invocationId: id, sourceId, requestId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(), expectedOwnerEpoch: z.number().int().nonnegative(),
  name: z.literal("propose_full_request"), arguments: fullRequestProposalSchema,
  sourceEventIds: z.array(sourceId).min(2).max(8).optional(),
}).strict();
export type FullPlanResult =
  | { kind: "accepted"; decision: FullRequestDecision; requestId: string; requestRevision: number; conversationRevision: number; eventId: string }
  | { kind: "rejected"; reason: "invalid_proposal" | "full_mode_required" | "context_stale" | "source_not_current" | "source_bundle_invalid" | "invocation_conflict" | "transition_rejected" };

/** Planning persists caller intent; it never supplies patient data or authorizes a mutation. */
export class FullRequestGateway {
  constructor(private readonly options: { store: Pick<ConversationStore, "get" | "execute" | "getEvent">; model: string; promptVersion: string; now?: () => Date }) {}

  async invoke(scope: ConversationScope, raw: unknown, signal?: AbortSignal): Promise<FullPlanResult> {
    throwIfAborted(signal);
    const parsed = invocationSchema.safeParse(raw);
    if (!parsed.success) return { kind: "rejected", reason: "invalid_proposal" };
    const input = parsed.data, eventId = `full-plan-${input.invocationId}`, retryEventId = `${eventId}-retry`;
    const inputHash = createHash("sha256").update(JSON.stringify([scope, input, this.options.model, this.options.promptVersion])).digest("hex");
    const previous = await this.options.store.getEvent(scope, eventId);
    throwIfAborted(signal);
    if (previous !== null) {
      if (previous.input.proposal?.inputHash !== inputHash) return { kind: "rejected", reason: "invocation_conflict" };
      const request = previous.receipt.state.requests.find((item) => item.id === input.requestId);
      if (!previous.receipt.accepted && previous.receipt.error === "stale_revision") {
        const retry = await this.options.store.getEvent(scope, retryEventId);
        throwIfAborted(signal);
        if (retry !== null) {
          if (retry.input.proposal?.inputHash !== inputHash) return { kind: "rejected", reason: "invocation_conflict" };
          const retriedRequest = retry.receipt.state.requests.find((item) => item.id === input.requestId);
          if (retry.receipt.accepted && retriedRequest?.fullProposal !== undefined) {
            return { kind: "accepted", decision: decideFullRequest(retriedRequest.fullProposal), requestId: retriedRequest.id,
              requestRevision: retriedRequest.revision, conversationRevision: retry.receipt.state.revision, eventId: retryEventId };
          }
        }
      }
      if (!previous.receipt.accepted || request?.fullProposal === undefined) return { kind: "rejected", reason: "transition_rejected" };
      return { kind: "accepted", decision: decideFullRequest(request.fullProposal), requestId: request.id,
        requestRevision: request.revision, conversationRevision: previous.receipt.state.revision, eventId };
    }
    const current = await this.options.store.get(scope);
    throwIfAborted(signal);
    if (current?.admission.mode !== "full") return { kind: "rejected", reason: "full_mode_required" };
    if (current.revision !== input.expectedRevision || current.ownerEpoch !== input.expectedOwnerEpoch
      || current.owner !== "ai" || current.phase !== "active" || current.emergency !== null || current.suppressed) return { kind: "rejected", reason: "context_stale" };
    if (current.admission.channel === "voice" && (current.activityLeaseUntil === null
      || Date.parse(current.activityLeaseUntil) <= (this.options.now?.() ?? new Date()).getTime())) return { kind: "rejected", reason: "context_stale" };
    if (current.inputs.at(-1)?.id !== input.sourceId) return { kind: "rejected", reason: "source_not_current" };
    const bundle = input.sourceEventIds;
    if (bundle !== undefined) {
      const latest = current.inputs.at(-1)!;
      let selected: readonly string[];
      try { selected = selectPendingCallerInputs(current, latest).map((source) => source.id); }
      catch { return { kind: "rejected", reason: "source_bundle_invalid" }; }
      if (current.admission.channel !== "sms" || current.requests.some((request) => request.id === input.requestId)
        || current.requests.some((request) => request.sourceIds.some((source) => bundle.includes(source)))
        || selected.length !== bundle.length || selected.some((source, index) => source !== bundle[index])) {
        return { kind: "rejected", reason: "source_bundle_invalid" };
      }
    }
    const callerTexts = (bundle === undefined ? [current.inputs.at(-1)!] : bundle.map((sourceId) => current.inputs.find((item) => item.id === sourceId)!))
      .map((item) => item.body);
    let explicitMessage = false;
    for (const text of callerTexts) {
      if (/\b(?:do not|don't|no need to|not)\s+(?:want to\s+)?(?:leave|take|send)\s+(?:(?:a|the|my)\s+)?message\b/i.test(text)) explicitMessage = false;
      else if (/\b(?:leave|take|send)\s+(?:(?:a|the|my)\s+)?message\b/i.test(text)) explicitMessage = true;
    }
    const latestText = callerTexts.at(-1) ?? "";
    const explicitParking = /\b(?:where (?:do|can|should) (?:i|we) park|where (?:is|are) (?:the )?parking|(?:can|may) (?:i|we) park|(?:need|want|looking for) parking|parking (?:lot|garage|directions|information|options)|how (?:do|can) (?:i|we) park)\b/i.test(latestText)
      && !/\b(?:not|don't|do not)\s+(?:asking|ask|care|need|want|looking|about)\b.{0,35}\bpark(?:ing)?\b/i.test(latestText);
    const parkingOverride = !explicitMessage && explicitParking
      && (input.arguments.capability === "office_address" || input.arguments.capability === "approved_practice_information")
      && input.arguments.knowledgeTopic !== "parking";
    // A first-person request for an existing appointment establishes the workflow,
    // not identity. DOB and ZIP are still required before any private read.
    const mentionsOwnAppointment = (/\bmy\s+(?:(?:next|upcoming|scheduled)\s+)?(?:appointment|visit)\b/i.test(latestText)
        || /\bi\s+(?:(?:already|currently)\s+)?(?:have|have got|got)\s+(?:an?\s+)?(?:scheduled\s+)?(?:appointment|visit)\b/i.test(latestText))
      && !/\b(?:for|about)\s+(?:my|his|her|their)\s+(?:wife|husband|mother|father|mom|dad|son|daughter|partner|child|friend)\b/i.test(latestText);
    const ownAppointment = current.admission.channel === "voice" && !explicitMessage && mentionsOwnAppointment
      && (input.arguments.capability === "appointment_details" || input.arguments.capability === "appointment_reschedule");
    const explicitAppointmentDirections = current.admission.channel === "voice" && !explicitMessage && !explicitParking && mentionsOwnAppointment
      && /\b(?:where|which\s+(?:office|building|location)|how\s+(?:(?:do|can|should)\s+(?:i|we)\s+|to\s+)?(?:get|go|travel|reach)(?:\s+there)?|directions?|address|location|building|entrance|route|travel)\b/i.test(latestText)
      && !/\b(?:not|don't|do not)\s+(?:asking|ask|care|need|want|looking|about)\b.{0,35}\b(?:my\s+)?appointment\b/i.test(latestText);
    const appointmentLocationOverride = explicitAppointmentDirections
      && (input.arguments.capability === "office_address" || input.arguments.capability === "approved_practice_information");
    const timeDateOnlyAppointment = ownAppointment && !explicitAppointmentDirections && !/\b(?:and|also|but)\b/i.test(latestText)
      && /\b(?:when|what\s+(?:day|date|time)|(?:day|date|time)\s+(?:is|of)|at\s+what\s+time)\b/i.test(latestText);
    const timeOnlyDirectionsNormalized = timeDateOnlyAppointment && input.arguments.knowledgeTopic === "directions";
    const proposal: FullRequestProposal = explicitMessage && input.arguments.capability !== "human_request"
      ? { capability: "human_request", patientStatus: input.arguments.patientStatus, schedulingKind: "not_applicable", knowledgeTopic: "not_applicable" }
        : appointmentLocationOverride ? { capability: "appointment_details", patientStatus: "established", schedulingKind: "not_applicable", knowledgeTopic: "directions" }
        : parkingOverride ? { ...input.arguments, capability: "approved_practice_information", knowledgeTopic: "parking" }
        // A time-only lookup does not request optional directions.
        : ownAppointment ? { ...input.arguments, patientStatus: "established",
          knowledgeTopic: timeOnlyDirectionsNormalized ? "not_applicable" : input.arguments.knowledgeTopic } : input.arguments;
    const overrideReason = explicitMessage && input.arguments.capability !== "human_request" ? "explicit_message_request"
      : appointmentLocationOverride ? "appointment_location_requires_identity"
        : parkingOverride ? "explicit_parking_question" : timeOnlyDirectionsNormalized ? "time_only_appointment_lookup"
          : ownAppointment && input.arguments.patientStatus !== "established" ? "first_person_existing_appointment" : null;
    const command = { type: "request.draft" as const, requestId: input.requestId, sourceEventId: input.sourceId,
      ...(bundle === undefined ? {} : { originalSourceEventId: bundle[0], sourceEventIds: bundle }),
      category: category(proposal), fullProposal: proposal };
    const executeDraft = async (state: typeof current, id: string) => await this.options.store.execute({ scope: scopeOf(state), eventId: id,
      expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "ai", id: "full-request-gateway" },
      proposal: { invocationId: input.invocationId, tool: input.name, sourceId: input.sourceId, model: this.options.model,
        provider: "openai", promptVersion: this.options.promptVersion,
        arguments: overrideReason === null ? input.arguments
          : { ...input.arguments, effectiveCapability: proposal.capability, effectiveKnowledgeTopic: proposal.knowledgeTopic,
            effectivePatientStatus: proposal.patientStatus, overrideReason }, inputHash }, command });
    let receipt: TransitionReceipt;
    throwIfAborted(signal);
    try { receipt = await executeDraft(current, eventId);
      if (!receipt.accepted && receipt.error === "stale_revision") {
        const refreshed = await this.options.store.get(scope);
        throwIfAborted(signal);
        if (canRetryDraft(current, refreshed, input, bundle, this.options.now?.() ?? new Date())) receipt = await executeDraft(refreshed, retryEventId);
      }
      // A write may have committed while the owner deadline fired. Never use
      // its receipt to begin a second durable operation after that fence.
      throwIfAborted(signal);
    }
    catch (error) {
      if (error instanceof ConversationConflict) return { kind: "rejected", reason: error.code === "event_payload_conflict" ? "invocation_conflict" : "transition_rejected" };
      throw error;
    }
    const request = receipt.state.requests.find((item) => item.id === input.requestId);
    if (!receipt.accepted || request?.fullProposal === undefined) return { kind: "rejected", reason: "transition_rejected" };
    return { kind: "accepted", decision: decideFullRequest(request.fullProposal), requestId: request.id,
      requestRevision: request.revision, conversationRevision: receipt.state.revision, eventId: receipt.eventId };
  }
}

function canRetryDraft(initial: Parameters<typeof scopeOf>[0], refreshed: Parameters<typeof scopeOf>[0] | null,
  input: z.infer<typeof invocationSchema>, bundle: readonly string[] | undefined, now: Date): refreshed is Parameters<typeof scopeOf>[0] {
  if (refreshed === null || refreshed.revision === initial.revision || refreshed.ownerEpoch !== initial.ownerEpoch
    || refreshed.owner !== "ai" || refreshed.phase !== "active" || refreshed.emergency !== null || refreshed.suppressed
    || refreshed.voiceEpoch !== initial.voiceEpoch || JSON.stringify(refreshed.inputs) !== JSON.stringify(initial.inputs)
    || JSON.stringify(refreshed.requests) !== JSON.stringify(initial.requests)
    || JSON.stringify(refreshed.pendingQuestion) !== JSON.stringify(initial.pendingQuestion)) return false;
  if (refreshed.admission.mode !== "full" || refreshed.inputs.at(-1)?.id !== input.sourceId) return false;
  if (refreshed.admission.channel === "voice" && (refreshed.activityLeaseUntil === null || Date.parse(refreshed.activityLeaseUntil) <= now.getTime())) return false;
  if (bundle !== undefined) {
    let selected: readonly string[];
    try { selected = selectPendingCallerInputs(refreshed, refreshed.inputs.at(-1)!).map((source) => source.id); }
    catch { return false; }
    if (selected.length !== bundle.length || selected.some((source, index) => source !== bundle[index])) return false;
  }
  return true;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("f2_operation_aborted");
}

function category(proposal: FullRequestProposal) {
  switch (proposal.capability) {
    case "appointment_details": case "appointment_schedule": case "appointment_reschedule": case "appointment_attendance_confirm": return "scheduling" as const;
    case "referral_status": return "referrals" as const;
    case "billing_balance": return "billing_or_insurance" as const;
    case "clinical": return "clinical" as const;
    default: return "general_or_uncertain" as const;
  }
}
