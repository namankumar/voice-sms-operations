import { randomUUID } from "node:crypto";
import { asksForAnotherPeriod, explicitAvailabilityConflict, isExplicitCallbackDecline, isExplicitPendingSlotWithdrawal, resumesOfferedAppointment, sideQuestionFromSpeech, type DialogueSideQuestion } from "./f2-dialogue-evidence.js";
import { normalizeSyntheticIdentityEvidence } from "./f2-synthetic-practice-contract.js";

import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { type F2ExecutionGateway, type F2ExecutionOutcome } from "./f2-execution-gateway.js";
import { querySyntheticPracticeKnowledge } from "./f2-knowledge.js";
import { parseF2ControlToolCall, type F2ControlToolCall } from "./f2-prompt.js";
import type { FullRequestDecision } from "./f2-request-policy.js";

type Gateway = Pick<F2ExecutionGateway, "plan" | "beginIdentity" | "verifyIdentity" | "verifyIdentityFactors" | "read" | "planAppointment" | "selectAppointmentSlot" | "mutationGate">;
type RequestInput = Readonly<{ scope: ConversationScope; requestId: string; sourceId: string }>;
type QuestionKind = "patient_status" | "identity_dob" | "identity_zip" | "slot_selection" | "appointment_consent" | "attendance_consent" | "request_clarification" | "name" | "message" | "callback_number_entry" | "callback_number";

export type F2TurnResult =
  | { kind: "no_action" }
  | { kind: "side_question"; topic: DialogueSideQuestion; requestId: string }
  | { kind: "question"; question: QuestionKind; requestId: string }
  | { kind: "identity"; state: "started" | "pending" | "verified" | "exhausted" }
  | { kind: "read"; receiptId: string; value: unknown }
  | { kind: "appointment_offered"; proposalId: string; slots: readonly unknown[]; queuedMessage: boolean }
  | { kind: "appointment_selected"; proposalId: string; slotId: string; queuedMessage: boolean }
  | { kind: "appointment_withdrawn"; requestId: string }
  | { kind: "knowledge"; factId: string; answer: string }
  | { kind: "knowledge_unknown"; topic: string }
  | { kind: "handoff"; reason: string }
  | { kind: "interrupt"; type: "emergency" | "human_request" | "urgent_unclear" }
  | { kind: "callback_captured"; requestId: string; supplemented?: true }
  | { kind: "callback_paused"; requestId: string }
  | { kind: "callback_dialogue"; requestId: string }
  | { kind: "sms_consent_delegated"; requestId: string; answer: "yes" | "no" | "unclear"; queuedMessage: false; committed: boolean }
  | { kind: "voice_consent_delegated"; requestId: string; answer: "yes" | "no" | "unclear"; queuedMessage: false; committed: boolean; receiptId: string | null; readbackRetry?: true }
  | { kind: "obsolete" }
  | { kind: "rejected"; reason: string };

export interface F2SmsConsentPort {
  /** Queues only server-derived text for a single current proposal; no model text enters this port. */
  queueExactProposal(input: RequestInput): Promise<{ messageId: string }>;
  requestExactConsent(input: RequestInput & { answer: "yes" | "no" | "unclear" }): Promise<{ kind: "not_confirmed" } | { kind: "committed" }>;
}

export interface F2VoiceConsentPort {
  prepareExactProposal(input: RequestInput): Promise<unknown>;
  commitExactConsent(input: RequestInput & { answer: "yes" | "no" | "unclear" }): Promise<{ kind: "not_confirmed"; reason?: "readback_unverified" } | { kind: "committed"; receiptId: string }>;
}

/** Must durably route the request to staff; this coordinator has no authority to synthesize a handoff. */
export interface F2HandoffPort {
  requestHandoff(input: RequestInput & { reason: string; signal?: AbortSignal }): Promise<{ accepted: boolean }>;
}

/** Shared voice/SMS control dispatch. Model calls only propose interpretation or caller input. */
export class F2TurnCoordinator {
  constructor(private readonly options: {
    conversations: Pick<ConversationStore, "get" | "execute"> & Partial<Pick<ConversationStore, "getEvent">>;
    gateway: Gateway;
    smsConsent: F2SmsConsentPort;
    voiceConsent?: F2VoiceConsentPort;
    controlledCallbackSaveFailure?: { consume(input: { conversation: Conversation; sourceId: string; requestId: string }): Promise<boolean> };
    handoffs: F2HandoffPort;
    now?: () => Date;
  }) {}

  async dispatch(input: { conversation: Conversation; requestId: string; sourceId: string; toolCall: unknown; invocationId?: string; sourceEventIds?: readonly string[]; dialoguePolicy?: "legacy" | "adaptive"; signal?: AbortSignal }): Promise<F2TurnResult> {
    throwIfAborted(input.signal);
    const call = parseF2ControlToolCall(input.toolCall);
    if (!this.currentContext(input.conversation, input.sourceId)) return { kind: "rejected", reason: "context_unavailable" };
    const base: RequestInput = { scope: scopeOf(input.conversation), requestId: input.requestId, sourceId: input.sourceId };
    // A whole-turn refusal of the current message question cannot start a new request.
    // Preserve the existing callback-pause transition even if the model selected full request.
    if (call.name === "propose_full_request" && input.conversation.admission.channel === "voice" && input.conversation.providerTier === "realtime" && input.dialoguePolicy === "adaptive"
      && input.conversation.pendingQuestion?.kind === "message" && isExplicitCallbackDecline(input.conversation.inputs.at(-1)?.body ?? "")
      && this.pendingEvidence(input.conversation, base, "message")) return this.pauseCallback(base, input.conversation);
    switch (call.name) {
      case "propose_no_action": {
        const utterance = input.conversation.inputs.at(-1)?.body.trim() ?? "";
        const social = /^(?:hi|hello|hey|thank you|thanks|okay|ok|bye|goodbye|that's all|no thanks|no thank you)\b/i.test(utterance)
          && !/[?]|\b(?:can|could|would|please|need|want|schedule|reschedule|tell|show|book|change|move|check|look up|leave|take|send|call|transfer|connect|ask|what|where|when|who|why|how|but|also)\b/i.test(utterance);
        return input.conversation.admission.channel === "voice" && input.conversation.pendingQuestion === null && social
          ? { kind: "no_action" } : { kind: "rejected", reason: "no_action_not_social" };
      }
      case "propose_full_request": return this.fullRequest(base, call, input.invocationId ?? randomUUID(), input.sourceEventIds, input.dialoguePolicy, input.signal);
      case "propose_full_interrupt": {
        if (call.arguments.kind !== "human_request") return this.interrupt(base, call.arguments.kind);
        const handoffConversation = await this.ensureHandoffRequest(input.conversation, base);
        throwIfAborted(input.signal);
        return handoffConversation === null ? { kind: "rejected", reason: "handoff_request_transition_rejected" } : this.handoff(base, "explicit_person", input.signal);
      }
      default: {
        const request = this.currentRequest(input.conversation, input, call, input.dialoguePolicy);
        if (request === null) return { kind: "rejected", reason: "context_unavailable" };
        if (call.name === "propose_side_question") {
          const pending = input.conversation.pendingQuestion;
          const source = input.conversation.inputs.at(-1);
          if (pending === null || pending.requestId !== base.requestId || pending.requestRevision !== request.revision
            || source?.id !== base.sourceId || source.questionId !== pending.id) return { kind: "rejected", reason: "side_question_not_supported" };
          if (call.arguments.topic === "appointment_availability" && pending.kind === "appointment_consent" && explicitAvailabilityConflict(source.body)) {
            return this.consent(base, input.conversation.admission.channel, { name: "propose_exact_consent", arguments: { answer: "no" } }, input.signal);
          }
          // A model may misclassify an offered choice as an availability question.
          // Preserve the caller's exact words and let the gateway's offer-bound matcher decide.
          if (call.arguments.topic === "appointment_availability" && pending.kind === "slot_selection"
            && resumesOfferedAppointment(source.body) && !explicitAvailabilityConflict(source.body) && !asksForAnotherPeriod(source.body)) {
            return this.slotSelection(base, input.conversation.admission.channel, { name: "propose_slot_selection", arguments: { selection: source.body } });
          }
          return sideQuestionFromSpeech(source.body, pending.kind) === call.arguments.topic
            || call.arguments.topic === "appointment_availability" && pending.kind === "slot_selection"
            ? { kind: "side_question", topic: call.arguments.topic, requestId: base.requestId }
            : { kind: "rejected", reason: "side_question_not_supported" };
        }
        if (call.name === "propose_identity_factor") return this.identityFactor(base, input.conversation, request.fullProposal?.capability, call, input.dialoguePolicy, input.signal);
        if (call.name === "propose_identity_factors") return this.identityFactors(base, input.conversation, request.fullProposal?.capability, call, input.dialoguePolicy, input.signal);
        const pending = input.conversation.pendingQuestion, source = input.conversation.inputs.at(-1);
        const currentQuestionSource = pending !== null && source !== undefined
          && source.id === base.sourceId && source.questionId === pending.id
          && pending.requestId === base.requestId && pending.requestRevision === request.revision;
        if (call.name === "propose_slot_selection" && pending?.kind === "slot_selection" && currentQuestionSource
          && (explicitAvailabilityConflict(source.body) || asksForAnotherPeriod(source.body))) {
          return { kind: "side_question", topic: "appointment_availability", requestId: base.requestId };
        }
        if (call.name === "propose_exact_consent" && pending?.kind === "appointment_consent" && currentQuestionSource
          && explicitAvailabilityConflict(source.body)) {
          return this.consent(base, input.conversation.admission.channel, { name: "propose_exact_consent", arguments: { answer: "no" } }, input.signal);
        }
        // Do not let a model-issued consent reach the mutation port until a
        // durable selection has opened the exact-consent question.
        if (input.conversation.admission.channel === "voice" && input.dialoguePolicy === "adaptive"
          && call.name === "propose_exact_consent" && (pending?.kind !== "appointment_consent" || !currentQuestionSource)) {
          return { kind: "rejected", reason: "exact_consent_not_pending" };
        }
        if (call.name === "propose_slot_selection") return this.slotSelection(base, input.conversation.admission.channel, call);
        if (call.name === "propose_slot_withdrawal") return this.withdrawPendingAppointment(base, input.conversation, input.dialoguePolicy);
        if (call.name === "propose_exact_consent") return this.consent(base, input.conversation.admission.channel, call, input.signal);
        if (call.name === "propose_f2_callback_capture") {
          const resumed = this.resumableSchedulingRequest(base, input.conversation, call, input.dialoguePolicy);
          if (resumed === "unavailable" || resumed === "ambiguous" || resumed === "stale") return { kind: "rejected", reason: `scheduling_resume_${resumed}` };
          if (resumed !== null) {
            // The callback question displaced the prior offer. Replan against the
            // source-bound scheduling request rather than treating the choice as a message.
            return this.resumeSchedulingRequest(base, input.conversation, resumed, input.signal);
          }
          return this.capture(base, input.conversation, call, input.dialoguePolicy);
        }
        if (call.name === "propose_f2_callback_confirm") return this.confirmCapture(base, input.conversation, call);
        if (call.name === "propose_f2_callback_back") return this.pauseCallback(base, input.conversation);
        if (call.name === "propose_callback_dialogue") return this.callbackDialogue(base, input.conversation, input.dialoguePolicy);
        return { kind: "rejected", reason: "control_tool_unavailable" };
      }
    }
  }

  private async fullRequest(base: RequestInput, call: Extract<F2ControlToolCall, { name: "propose_full_request" }>, invocationId: string, sourceEventIds?: readonly string[], dialoguePolicy?: "legacy" | "adaptive", signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    const current = await this.options.conversations.get(base.scope);
    throwIfAborted(signal);
    if (current === null) return { kind: "rejected", reason: "context_unavailable" };
    // Planning appends this source and advances the request revision, which intentionally
    // clears its pending question. Preserve the pre-plan evidence binding for this turn.
    const caregiverIdentityRefusal = currentIdentityRefusal(current, base);
    const planned = await this.options.gateway.plan(base.scope, { invocationId, sourceId: base.sourceId, requestId: base.requestId,
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch, name: call.name, arguments: call.arguments,
      ...(sourceEventIds === undefined ? {} : { sourceEventIds: [...sourceEventIds] }) }, signal);
    throwIfAborted(signal);
    if (planned.kind !== "planned" || planned.result.kind !== "accepted") return rejected(planned);
    const fresh = await this.options.conversations.get(base.scope);
    throwIfAborted(signal);
    const request = fresh?.requests.find((item) => item.id === base.requestId);
    if (fresh === null || request === undefined || !request.sourceIds.includes(base.sourceId)) return { kind: "rejected", reason: "context_unavailable" };
    return this.applyDecision({ ...base, scope: scopeOf(fresh) }, fresh, request.fullProposal?.capability, planned.result.decision,
      caregiverIdentityRefusal, dialoguePolicy, signal);
  }

  private async identityFactor(base: RequestInput, conversation: Conversation, capability: string | undefined, call: Extract<F2ControlToolCall, { name: "propose_identity_factor" }>, dialoguePolicy?: "legacy" | "adaptive", signal?: AbortSignal): Promise<F2TurnResult> {
    const factor = this.adaptiveIdentityFactor(conversation, call.arguments, dialoguePolicy);
    if (factor === null) return { kind: "rejected", reason: "identity_value_unclear" };
    if (factor === "mismatch") return { kind: "rejected", reason: "identity_source_mismatch" };
    const result = await this.options.gateway.verifyIdentity({ ...base, ...factor });
    return this.identityResult(base, conversation.admission.channel, capability, result, signal);
  }

  private async identityFactors(base: RequestInput, conversation: Conversation, capability: string | undefined, call: Extract<F2ControlToolCall, { name: "propose_identity_factors" }>, dialoguePolicy?: "legacy" | "adaptive", signal?: AbortSignal): Promise<F2TurnResult> {
    const factors = call.arguments.factors.map((item) => this.adaptiveIdentityFactor(conversation, item, dialoguePolicy));
    if (factors.some((item) => item === null)) return { kind: "rejected", reason: "identity_value_unclear" };
    if (factors.some((item) => item === "mismatch")) return { kind: "rejected", reason: "identity_source_mismatch" };
    const result = await this.options.gateway.verifyIdentityFactors({ ...base, factors: factors as { factor: "date_of_birth" | "zip"; value: string }[] });
    return this.identityResult(base, conversation.admission.channel, capability, result, signal);
  }

  /** Adaptive voice treats the model value as a proposal, never as source evidence. */
  private adaptiveIdentityFactor(conversation: Conversation, factor: { factor: "date_of_birth" | "zip"; value: string }, dialoguePolicy?: "legacy" | "adaptive"): { factor: "date_of_birth" | "zip"; value: string } | "mismatch" | null {
    if (conversation.admission.channel !== "voice" || dialoguePolicy !== "adaptive") return factor;
    const now = (this.options.now ?? (() => new Date()))();
    const sourceValue = normalizeSyntheticIdentityEvidence(conversation.inputs.at(-1)?.body ?? "", factor.factor, now);
    const proposedValue = normalizeSyntheticIdentityEvidence(factor.value, factor.factor, now);
    if (sourceValue === null) return null;
    if (proposedValue === null || proposedValue !== sourceValue) return "mismatch";
    return { factor: factor.factor, value: proposedValue };
  }

  private async identityResult(base: RequestInput, channel: "voice" | "sms", capability: string | undefined, result: F2ExecutionOutcome, signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    if (result.kind !== "identity") return rejected(result);
    if (result.state === "verified") {
      if (!await this.clearVerifiedIdentityQuestion(base, signal)) return { kind: "rejected", reason: "identity_question_clear_failed" };
      throwIfAborted(signal);
      return this.executeProtected(base, capability, channel, signal);
    }
    if (result.state === "pending") {
      if (result.nextFactor === undefined) return { kind: "rejected", reason: "identity_next_factor_unavailable" };
      return this.question(base, result.nextFactor === "date_of_birth" ? "identity_dob" : "identity_zip", signal);
    }
    return this.handoff(base, "verification_exhausted", signal);
  }

  private async clearVerifiedIdentityQuestion(base: RequestInput, signal?: AbortSignal): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      throwIfAborted(signal);
      const current = await this.options.conversations.get(base.scope);
      throwIfAborted(signal);
      if (current === null) return false;
      const question = current.pendingQuestion;
      if (question === null) return true;
      if (question.requestId !== base.requestId || !["identity_dob", "identity_zip"].includes(question.kind)) return false;
      const receipt = await this.options.conversations.execute({ scope: base.scope, eventId: `verified-identity-question-${randomUUID()}`,
        expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
        actor: { kind: "system", id: "f2-turn-coordinator" },
        command: { type: "question.clear_verified_identity", questionId: question.id, requestId: base.requestId } });
      if (receipt.accepted) return true;
      if (receipt.error !== "stale_revision") return false;
    }
    return false;
  }

  private async applyDecision(base: RequestInput, conversation: Conversation, capability: string | undefined, decision: FullRequestDecision,
    caregiverIdentityRefusal: boolean, dialoguePolicy?: "legacy" | "adaptive", signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    if (decision.kind === "handoff") return this.handoff(base, decision.reason, signal);
    if (decision.kind === "clarify" && decision.field === "patient_status" && conversation.admission.channel === "voice"
      && conversation.providerTier === "realtime" && dialoguePolicy === "adaptive" && caregiverIdentityRefusal) {
      return this.handoff(base, "explicit_person", signal);
    }
    if (decision.kind === "clarify") return this.question(base, decision.field === "patient_status" ? "patient_status" : "request_clarification", signal);
    if (decision.kind === "public_lookup") {
      const knowledge = querySyntheticPracticeKnowledge({ practiceId: conversation.admission.practiceId, channel: conversation.admission.channel,
        topic: topicFor(decision.topic), access: "public", asOf: (this.options.now ?? (() => new Date()))().toISOString() });
      return knowledge.kind === "found" ? { kind: "knowledge", factId: knowledge.factId, answer: knowledge.answer } : this.handoff(base, "knowledge_unavailable", signal);
    }
    const existing = await this.executeProtected(base, capability, conversation.admission.channel, signal);
    if (existing.kind !== "rejected" || existing.reason !== "identity_required") return existing;
    const identity = await this.options.gateway.beginIdentity(base);
    if (identity.kind !== "identity_started") return rejected(identity);
    return this.question(base, "identity_dob", signal);
  }

  private async executeProtected(base: RequestInput, capability: string | undefined, channel?: "voice" | "sms", signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    if (capability === "appointment_details" || capability === "referral_status" || capability === "billing_balance") {
      try {
        const read = await this.options.gateway.read({ ...base, readKind: capability });
        return read.kind === "read" ? { kind: "read", receiptId: read.receiptId, value: read.value } : rejected(read);
      } catch {
        return this.handoff(base, "protected_read_unavailable", signal);
      }
    }
    if (capability === "appointment_schedule" || capability === "appointment_reschedule" || capability === "appointment_attendance_confirm") {
      const offer = await this.options.gateway.planAppointment(base);
      throwIfAborted(signal);
      if (offer.kind === "rejected" && (offer.reason === "appointment_availability_unavailable" || offer.reason === "appointment_selection_required" || offer.reason === "appointment_type_requires_staff")) {
        return this.handoff(base, offer.reason, signal);
      }
      if (offer.kind !== "appointment_planned") return rejected(offer);
      if ("slots" in offer.proposal) {
        const question = await this.question(base, "slot_selection", signal);
        if (question.kind === "rejected") return question;
        return { kind: "appointment_offered", proposalId: offer.proposal.id, slots: offer.proposal.slots, queuedMessage: false };
      }
      const question = await this.question(base, "attendance_consent", signal);
      if (question.kind === "rejected") return question;
      return await this.queueExactProposal(base, channel ?? "voice", offer.proposal.id, []);
    }
    return { kind: "rejected", reason: "protected_capability_unavailable" };
  }

  private async slotSelection(base: RequestInput, channel: "voice" | "sms", call: Extract<F2ControlToolCall, { name: "propose_slot_selection" }>): Promise<F2TurnResult> {
    const selected = await this.options.gateway.selectAppointmentSlot({ ...base, selection: call.arguments.selection });
    if (channel === "voice" && selected.kind === "rejected"
      && ["appointment_availability_unavailable", "appointment_selection_required", "appointment_type_requires_staff"].includes(selected.reason)) {
      return this.handoff(base, selected.reason);
    }
    if (channel === "voice" && selected.kind === "appointment_planned" && "slots" in selected.proposal) {
      const question = await this.question(base, "slot_selection");
      if (question.kind === "rejected") return question;
      return { kind: "appointment_offered", proposalId: selected.proposal.id, slots: selected.proposal.slots, queuedMessage: false };
    }
    if (selected.kind !== "appointment_selected") {
      if (channel === "voice" && selected.kind === "rejected" && selected.reason === "slot_selection_unavailable") {
        const current = await this.options.conversations.get(base.scope);
        const question = current?.pendingQuestion;
        if (question?.kind === "slot_selection" && question.requestId === base.requestId)
          return { kind: "side_question", topic: "appointment_availability", requestId: base.requestId };
      }
      return rejected(selected);
    }
    const question = await this.question(base, "appointment_consent");
    if (question.kind === "rejected") return question;
    const queued = await this.queueExactProposal(base, channel, selected.proposal.id, selected.proposal.slots);
    return queued.kind === "rejected" ? queued : { kind: "appointment_selected", proposalId: selected.proposal.id, slotId: selected.proposal.slots[0]!.id, queuedMessage: queued.queuedMessage };
  }

  /** A preselection withdrawal ends only the uncommitted scheduling request. */
  private async withdrawPendingAppointment(base: RequestInput, conversation: Conversation, dialoguePolicy?: "legacy" | "adaptive"): Promise<F2TurnResult> {
    const question = conversation.pendingQuestion;
    const request = conversation.requests.find((item) => item.id === base.requestId);
    const source = conversation.inputs.at(-1);
    if (dialoguePolicy !== "adaptive" || conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime"
      || question?.kind !== "slot_selection" || request?.state !== "draft"
      || source?.id !== base.sourceId || !isExplicitPendingSlotWithdrawal(source.body)
      || !this.pendingEvidence(conversation, base, "slot_selection")) {
      return { kind: "rejected", reason: "slot_withdrawal_not_pending" };
    }
    const abandoned = await this.command(conversation, base, `f2-abandon-pending-appointment-${base.sourceId}`, "system",
      { type: "request.abandon", requestId: base.requestId, questionId: question.id, sourceEventId: base.sourceId });
    return abandoned === null ? { kind: "rejected", reason: "slot_withdrawal_transition_rejected" }
      : { kind: "appointment_withdrawn", requestId: base.requestId };
  }

  private async consent(base: RequestInput, channel: "voice" | "sms", call: Extract<F2ControlToolCall, { name: "propose_exact_consent" }>, signal?: AbortSignal): Promise<F2TurnResult> {
    if (channel === "voice") {
      if (this.options.voiceConsent === undefined) return rejected(this.options.gateway.mutationGate("voice"));
      const outcome = await this.options.voiceConsent.commitExactConsent({ ...base, answer: call.arguments.answer });
      if (call.arguments.answer === "no") {
        const current = await this.options.conversations.get(base.scope);
        const request = current?.requests.find((item) => item.id === base.requestId);
        if (current?.pendingQuestion?.kind === "appointment_consent" && current.pendingQuestion.requestId === base.requestId
          && (request?.fullProposal?.capability === "appointment_schedule" || request?.fullProposal?.capability === "appointment_reschedule")) {
          return this.executeProtected(base, request.fullProposal.capability, "voice", signal);
        }
      }
      return { kind: "voice_consent_delegated", requestId: base.requestId, answer: call.arguments.answer, queuedMessage: false,
        committed: outcome.kind === "committed", receiptId: outcome.kind === "committed" ? outcome.receiptId : null,
        ...(outcome.kind === "not_confirmed" && outcome.reason === "readback_unverified" ? { readbackRetry: true as const } : {}) };
    }
    const outcome = await this.options.smsConsent.requestExactConsent({ ...base, answer: call.arguments.answer });
    return { kind: "sms_consent_delegated", requestId: base.requestId, answer: call.arguments.answer, queuedMessage: false, committed: outcome.kind === "committed" };
  }

  private async queueExactProposal(base: RequestInput, channel: "voice" | "sms", proposalId: string, slots: readonly unknown[]): Promise<Extract<F2TurnResult, { kind: "appointment_offered" | "rejected" }>> {
    try {
      if (channel === "voice") {
        if (this.options.voiceConsent === undefined) {
          const denied = this.options.gateway.mutationGate("voice");
          return denied.kind === "rejected" ? { kind: "rejected", reason: denied.reason } : { kind: "rejected", reason: "voice_mutation_denied" };
        }
        await this.options.voiceConsent.prepareExactProposal(base);
        return { kind: "appointment_offered", proposalId, slots, queuedMessage: false };
      }
      await this.options.smsConsent.queueExactProposal(base);
      return { kind: "appointment_offered", proposalId, slots, queuedMessage: true };
    } catch {
      return { kind: "rejected", reason: "exact_proposal_queue_rejected" };
    }
  }

  private async capture(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_capture" }>, dialoguePolicy?: "legacy" | "adaptive"): Promise<F2TurnResult> {
    const expected = call.arguments.field === "name" ? "name" : call.arguments.field === "message" ? "message" : "callback_number_entry";
    if (await this.replayedPostCaptureAddendum(base, conversation, call, dialoguePolicy)) return { kind: "callback_captured", requestId: base.requestId, supplemented: true };
    if (this.postCaptureMessageAddendum(base, conversation, call, dialoguePolicy)) {
      const callerText = conversation.inputs.at(-1)?.body ?? "";
      if (!isSupplementableMessageCorrection(callerText, conversation.admission.contact)) return { kind: "rejected", reason: "callback_message_not_stated" };
      const supplemented = await this.command(conversation, base, `f2-callback-supplement-${base.sourceId}`, "system",
        { type: "request.supplement", requestId: base.requestId, sourceEventId: base.sourceId });
      return supplemented === null ? { kind: "rejected", reason: "callback_capture_transition_rejected" }
        : { kind: "callback_captured", requestId: base.requestId, supplemented: true };
    }
    const correctionQuestion = this.messageCorrectionQuestion(base, conversation, call, dialoguePolicy);
    if (correctionQuestion !== null) {
      const callerText = conversation.inputs.at(-1)?.body ?? "";
      if (!isSupplementableMessageCorrection(callerText, conversation.admission.contact)) return { kind: "rejected", reason: "callback_message_not_stated" };
      const supplemented = await this.command(conversation, base, `f2-callback-supplement-${base.sourceId}`, "system",
        { type: "request.supplement", requestId: base.requestId, sourceEventId: base.sourceId });
      return supplemented === null ? { kind: "rejected", reason: "callback_capture_transition_rejected" }
        : this.question(base, correctionQuestion);
    }
    const correctingNumber = call.arguments.field === "callback_number" && this.pendingEvidence(conversation, base, "callback_number");
    if (!correctingNumber && !this.pendingEvidence(conversation, base, expected)) return { kind: "rejected", reason: "callback_capture_not_pending" };
    const callerText = conversation.inputs.at(-1)?.body ?? "";
    if (call.arguments.field === "message" && conversation.admission.channel === "voice" && dialoguePolicy === "adaptive" && isExplicitCallbackDecline(callerText)) {
      return this.pauseCallback(base, conversation);
    }
    if (call.arguments.field === "message" && (/^(?:i (?:just |already )?told you|i (?:already )?said (?:that|it)|you (?:already )?have (?:it|my message))\b/i.test(callerText.trim())
      || /^(?:yes|yeah|yep|uh[ -]?huh|okay|ok|thank you|thanks|да)[.!?\s]*$/i.test(callerText.trim()))) {
      return { kind: "rejected", reason: "callback_message_not_stated" };
    }
    const callbackName = call.arguments.field === "name"
      ? conversation.admission.channel === "voice" && dialoguePolicy === "adaptive"
        ? normalizeAdaptiveCallerName(call.arguments.value, callerText, call.arguments.nameConfidence)
        : normalizeCallerName(callerText)
      : null;
    if (call.arguments.field === "name" && callbackName === null) return { kind: "rejected", reason: "callback_name_invalid" };
    const callbackNumber = call.arguments.field === "callback_number"
      ? normalizeCallerCallbackNumber(callerText, conversation.admission.contact) : null;
    if (call.arguments.field === "callback_number" && callbackNumber === null) return { kind: "rejected", reason: "callback_number_invalid" };
    const command = call.arguments.field === "name"
      ? { type: "request.draft" as const, requestId: base.requestId, sourceEventId: base.sourceId, name: callbackName! }
      : call.arguments.field === "callback_number"
        ? { type: "request.draft" as const, requestId: base.requestId, sourceEventId: base.sourceId, callbackNumber: callbackNumber! }
        // The model may identify the field but never supplies the saved message.
        : { type: "request.capture_callback_message" as const, requestId: base.requestId, sourceEventId: base.sourceId };
    const saved = await this.command(conversation, base, `f2-callback-${base.sourceId}-${call.arguments.field}`, "ai", command);
    if (saved === null) return { kind: "rejected", reason: "callback_capture_transition_rejected" };
    const next = conversation.admission.channel === "voice"
      ? call.arguments.field === "message" ? "name" : call.arguments.field === "name" ? "callback_number_entry" : "callback_number"
      : call.arguments.field === "name" ? "message" : call.arguments.field === "message" ? "callback_number_entry" : "callback_number";
    return this.question(base, next);
  }

  /** A current caller correction supplements the saved message, then rebinds the requested contact field. */
  private messageCorrectionQuestion(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_capture" }>, dialoguePolicy?: "legacy" | "adaptive"): Extract<QuestionKind, "name" | "callback_number_entry" | "callback_number"> | null {
    const source = conversation.inputs.at(-1), question = conversation.pendingQuestion;
    const request = conversation.requests.find((item) => item.id === base.requestId);
    if (call.arguments.field !== "message" || conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime" || dialoguePolicy !== "adaptive"
      || request?.state !== "draft" || typeof request.callbackMessageSourceId !== "string" || !request.sourceIds.includes(request.callbackMessageSourceId)
      || source?.id !== base.sourceId || question === null || !["name", "callback_number_entry", "callback_number"].includes(question.kind)
      || source.questionId !== question.id || question.requestId !== base.requestId || question.requestRevision !== request.revision
      || source.sequence <= question.activatedRevision || source.sequence <= request.proposalRevision) return null;
    return question.kind as Extract<QuestionKind, "name" | "callback_number_entry" | "callback_number">;
  }

  /** A callback capture cannot consume an explicit choice to return to one prior scheduling agenda. */
  private resumableSchedulingRequest(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_capture" }>, dialoguePolicy?: "legacy" | "adaptive"): Conversation["requests"][number] | "unavailable" | "ambiguous" | "stale" | null {
    if (conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime" || dialoguePolicy !== "adaptive"
      || call.arguments.field !== "message") return null;
    const source = conversation.inputs.at(-1), callback = conversation.requests.find((request) => request.id === base.requestId);
    if (source === undefined || !resumesOfferedAppointment(source.body)) return null;
    const question = conversation.pendingQuestion;
    if (callback === undefined || question?.kind !== "message" || question.requestId !== base.requestId || source.id !== base.sourceId
      || source.questionId !== question.id || question.requestRevision !== callback.revision || source.sequence <= question.activatedRevision) return "stale";
    const candidates = conversation.requests.filter((request) => request.id !== base.requestId && request.state === "draft"
      && (request.fullProposal?.capability === "appointment_schedule" || request.fullProposal?.capability === "appointment_reschedule"));
    return candidates.length === 1 ? candidates[0]! : candidates.length === 0 ? "unavailable" : "ambiguous";
  }

  private async resumeSchedulingRequest(callback: RequestInput, conversation: Conversation, resumed: Conversation["requests"][number], signal?: AbortSignal): Promise<F2TurnResult> {
    const question = conversation.pendingQuestion;
    if (question === null) return { kind: "rejected", reason: "scheduling_resume_transition_rejected" };
    const abandoned = await this.command(conversation, callback, `f2-abandon-callback-${callback.sourceId}`, "system",
      { type: "request.abandon_callback", requestId: callback.requestId, resumeRequestId: resumed.id,
        questionId: question.id, sourceEventId: callback.sourceId });
    if (abandoned === null) return { kind: "rejected", reason: "scheduling_resume_transition_rejected" };
    const base = { ...callback, requestId: resumed.id };
    const bound = await this.command(abandoned, base, `f2-resume-scheduling-${base.sourceId}`, "ai",
      { type: "request.draft", requestId: base.requestId, sourceEventId: base.sourceId });
    return bound === null ? { kind: "rejected", reason: "scheduling_resume_transition_rejected" }
      : this.executeProtected(base, resumed.fullProposal!.capability, "voice", signal);
  }

  private async confirmCapture(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_confirm" }>): Promise<F2TurnResult> {
    if (!this.pendingEvidence(conversation, base, "callback_number")) return { kind: "rejected", reason: "callback_confirmation_not_pending" };
    if (call.arguments.answer !== "yes") return this.question(base, call.arguments.answer === "no" ? "callback_number_entry" : "callback_number");
    const number = conversation.pendingQuestion!.callbackNumber;
    if (number === null) return { kind: "rejected", reason: "callback_number_missing" };
    if (conversation.admission.channel === "voice" && conversation.providerTier === "realtime"
      && await this.options.controlledCallbackSaveFailure?.consume({ conversation, sourceId: base.sourceId, requestId: base.requestId })) {
      return { kind: "rejected", reason: "callback_capture_transition_rejected" };
    }
    const captured = await this.command(conversation, base, `f2-callback-capture-${base.sourceId}`, "system", { type: "request.confirm_and_capture_callback", requestId: base.requestId, callbackNumber: number, sourceEventId: base.sourceId });
    return captured === null ? { kind: "rejected", reason: "callback_capture_transition_rejected" } : { kind: "callback_captured", requestId: base.requestId };
  }

  private async pauseCallback(base: RequestInput, conversation: Conversation): Promise<F2TurnResult> {
    const question = conversation.pendingQuestion;
    if (conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime"
      || question === null || !["name", "message", "callback_number_entry", "callback_number"].includes(question.kind)
      || !this.pendingEvidence(conversation, base, question.kind as QuestionKind)) {
      return { kind: "rejected", reason: "callback_pause_not_pending" };
    }
    const paused = await this.command(conversation, base, `f2-callback-back-${base.sourceId}`, "system",
      { type: "question.pause_callback", questionId: question.id, requestId: base.requestId, sourceEventId: base.sourceId });
    return paused === null ? { kind: "rejected", reason: "callback_pause_transition_rejected" }
      : { kind: "callback_paused", requestId: base.requestId };
  }

  /** Keeps a current adaptive callback-message question open without recording caller data. */
  private callbackDialogue(base: RequestInput, conversation: Conversation, dialoguePolicy?: "legacy" | "adaptive"): F2TurnResult {
    const question = conversation.pendingQuestion;
    const source = conversation.inputs.at(-1);
    const request = conversation.requests.find((item) => item.id === base.requestId);
    if (conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime" || dialoguePolicy !== "adaptive"
      || question?.kind !== "message" || request?.state !== "draft"
      || source?.id !== base.sourceId || source.questionId !== question.id
      || question.requestId !== base.requestId || question.requestRevision !== request.revision
      || source.sequence <= question.activatedRevision) {
      return { kind: "rejected", reason: "callback_dialogue_not_pending" };
    }
    return { kind: "callback_dialogue", requestId: base.requestId };
  }

  private async interrupt(base: RequestInput, kind: "emergency" | "human_request" | "urgent_unclear"): Promise<F2TurnResult> {
    if (kind === "human_request") return this.handoff(base, "explicit_person");
    const current = await this.options.conversations.get(base.scope);
    if (current === null) return { kind: "rejected", reason: "context_unavailable" };
    const receipt = await this.options.conversations.execute({ scope: base.scope, eventId: `f2-interrupt-${base.sourceId}-${kind}`,
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "ai", id: "f2-turn-coordinator" },
      command: { type: "emergency.assess", sourceEventId: base.sourceId, classification: kind === "emergency" ? "caller_emergency" : "urgent_unclear" } });
    return receipt.accepted ? { kind: "interrupt", type: kind } : { kind: "rejected", reason: "interrupt_transition_rejected" };
  }

  private async handoff(base: RequestInput, reason: string, signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    return (await this.options.handoffs.requestHandoff({ ...base, reason, ...(signal === undefined ? {} : { signal }) })).accepted
      ? { kind: "handoff", reason }
      : { kind: "rejected", reason: "handoff_transition_rejected" };
  }

  /** A spontaneous request for a person still needs a staff-owned request before the handoff service can route it. */
  private async ensureHandoffRequest(conversation: Conversation, base: RequestInput): Promise<Conversation | null> {
    const existing = conversation.requests.find((item) => item.id === base.requestId);
    if (existing?.sourceIds.includes(base.sourceId)) return conversation;
    return this.command(conversation, base, `f2-handoff-request-${base.sourceId}`, "ai", {
      type: "request.draft", requestId: base.requestId, sourceEventId: base.sourceId, category: "general_or_uncertain",
    });
  }

  private async question(base: RequestInput, kind: QuestionKind, signal?: AbortSignal): Promise<F2TurnResult> {
    throwIfAborted(signal);
    const current = await this.options.conversations.get(base.scope);
    throwIfAborted(signal);
    if (current === null || !this.currentContext(current, base.sourceId)) return { kind: "rejected", reason: "context_unavailable" };
    if (current.pendingQuestion?.requestId === base.requestId && current.pendingQuestion.kind === kind) return { kind: "question", question: kind, requestId: base.requestId };
    const receipt = await this.options.conversations.execute({ scope: base.scope, eventId: `f2-question-${base.sourceId}-${kind}`,
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "system", id: "f2-turn-coordinator" },
      command: { type: "question.activate", questionId: `question-${base.sourceId}-${kind}`, kind, requestId: base.requestId } });
    return receipt.accepted ? { kind: "question", question: kind, requestId: base.requestId } : { kind: "rejected", reason: "question_transition_rejected" };
  }

  private async command(conversation: Conversation, base: RequestInput, eventId: string, actor: "ai" | "system", command: Parameters<ConversationStore["execute"]>[0]["command"]): Promise<Conversation | null> {
    const receipt = await this.options.conversations.execute({ scope: base.scope, eventId, expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch,
      actor: { kind: actor, id: "f2-turn-coordinator" }, command });
    return receipt.accepted ? receipt.state : null;
  }

  private pendingEvidence(conversation: Conversation, base: RequestInput, kind: QuestionKind): boolean {
    const source = conversation.inputs.at(-1);
    return source?.id === base.sourceId && source.questionId === conversation.pendingQuestion?.id
      && conversation.pendingQuestion?.requestId === base.requestId && conversation.pendingQuestion.kind === kind;
  }

  private postCaptureMessageAddendum(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_capture" }>, dialoguePolicy?: "legacy" | "adaptive"): boolean {
    const request = conversation.requests.find((item) => item.id === base.requestId);
    const sourceBacked = (sourceId: string | null): boolean => sourceId !== null
      && conversation.inputs.some((input) => input.id === sourceId);
    const candidates = conversation.requests.filter((item) => item.state === "needs_callback"
      && item.callbackConfirmed && item.confirmationSourceId !== null && item.sourceIds.includes(item.confirmationSourceId)
      && sourceBacked(item.confirmationSourceId) && typeof item.callbackMessageSourceId === "string"
      && item.sourceIds.includes(item.callbackMessageSourceId) && sourceBacked(item.callbackMessageSourceId));
    return call.arguments.field === "message" && conversation.admission.channel === "voice" && conversation.providerTier === "realtime"
      && dialoguePolicy === "adaptive" && conversation.pendingQuestion === null && request?.state === "needs_callback"
      && candidates.length === 1 && candidates[0]?.id === request.id
      && !request.sourceIds.includes(base.sourceId) && conversation.inputs.at(-1)?.id === base.sourceId;
  }

  /** A provider retry returns the accepted amendment receipt without a second append. */
  private async replayedPostCaptureAddendum(base: RequestInput, conversation: Conversation, call: Extract<F2ControlToolCall, { name: "propose_f2_callback_capture" }>, dialoguePolicy?: "legacy" | "adaptive"): Promise<boolean> {
    if (call.arguments.field !== "message" || conversation.admission.channel !== "voice" || conversation.providerTier !== "realtime"
      || dialoguePolicy !== "adaptive" || conversation.pendingQuestion !== null || conversation.inputs.at(-1)?.id !== base.sourceId) return false;
    const request = conversation.requests.find((item) => item.id === base.requestId);
    if (request?.state !== "needs_callback" || !request.sourceIds.includes(base.sourceId)
      || request.callbackMessageSourceId === base.sourceId || request.confirmationSourceId === base.sourceId
      || this.options.conversations.getEvent === undefined) return false;
    const prior = await this.options.conversations.getEvent(base.scope, `f2-callback-supplement-${base.sourceId}`);
    const current = await this.options.conversations.get(base.scope);
    if (current === null || !this.currentContext(current, base.sourceId)) return false;
    const currentRequest = current.requests.find((item) => item.id === base.requestId);
    if (currentRequest?.state !== "needs_callback" || !currentRequest.sourceIds.includes(base.sourceId)
      || currentRequest.callbackMessageSourceId === base.sourceId || currentRequest.confirmationSourceId === base.sourceId) return false;
    return prior?.receipt.accepted === true && prior.input.command.type === "request.supplement"
      && prior.input.command.requestId === base.requestId && prior.input.command.sourceEventId === base.sourceId;
  }

  private currentRequest(conversation: Conversation, input: { requestId: string; sourceId: string }, call: F2ControlToolCall, dialoguePolicy?: "legacy" | "adaptive") {
    const request = conversation.requests.find((item) => item.id === input.requestId);
    if (!this.currentContext(conversation, input.sourceId) || request === undefined) return null;
    if (request.sourceIds.includes(input.sourceId)) return request;
    return call.name === "propose_f2_callback_capture" && this.postCaptureMessageAddendum({ ...input, scope: scopeOf(conversation) }, conversation, call, dialoguePolicy)
      ? request : null;
  }

  private currentContext(conversation: Conversation, sourceId: string): boolean {
    return conversation.admission.mode === "full" && conversation.phase === "active" && conversation.owner === "ai" && conversation.emergency === null
      && !conversation.suppressed && conversation.inputs.at(-1)?.id === sourceId;
  }
}

/** Only a current, source-bound refusal to share identity evidence can leave the patient-status loop. */
function currentIdentityRefusal(conversation: Conversation, base: RequestInput): boolean {
  const source = conversation.inputs.at(-1);
  const question = conversation.pendingQuestion;
  const request = conversation.requests.find((item) => item.id === base.requestId);
  if (question?.kind !== "patient_status" || source?.id !== base.sourceId || source.questionId !== question.id || source.sequence <= question.activatedRevision
    || question.requestId !== base.requestId || question.requestRevision !== request?.revision) return false;
  const explicitlyUnableToShare = /\b(?:I(?:'m|\s+am)|we(?:'re|\s+are)|they(?:'re|\s+are))\s+(?:not\s+authorized|unauthorized)\s+(?:to\s+)?(?:provide|share|give)\b/i.test(source.body)
    || /\b(?:cannot|can't|unable|not\s+able)\s+(?:to\s+)?(?:provide|share|give)\b/i.test(source.body);
  return explicitlyUnableToShare && /\b(?:date\s+of\s+birth|dob|zip(?:\s+code)?|identity(?:\s+information)?)\b/i.test(source.body);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("f2_operation_aborted");
}

function normalizeCallerName(utterance: string): string | null {
  const spoken = utterance.trim().replace(/[.!]+\s*$/, "");
  if (spoken.length === 0 || /\?/u.test(spoken)) return null;
  if (/^(?:wait|hold on|one (?:moment|second)|just a (?:moment|second)|give me a (?:moment|second))\b/iu.test(spoken)) return null;
  if (/^(?:ugh|um|uh|(?:this is|that's|that is) (?:ridiculous|frustrating|unacceptable|terrible)|i(?:'m| am) (?:frustrated|upset|angry|annoyed))\b/iu.test(spoken)) return null;

  const introduction = spoken.match(/^(?:(?:hi|hello|hey|yes|yeah|no|actually|well|sure|okay|ok)[,.!]?\s+)*(?:my name is|my name's|i'm|i am|this is|it's|its|it is)\s+(.+)$/iu);
  const trailingIntroduction = spoken.match(/^(.+?)\s+is my name$/iu);
  if (introduction === null && trailingIntroduction === null && /^(?:hi|hello|hey|my|this|it)\b/iu.test(spoken)) return null;
  const name = (introduction?.[1] ?? trailingIntroduction?.[1] ?? spoken).trim();

  if (!lexicallyPlausibleName(name)) return null;
  const words = name.split(" ");
  if (introduction === null && trailingIntroduction === null && words.length > 2) return null;
  return name;
}

/** Clear voice interpretation may differ from ASR; a contact label never authenticates the caller. */
function normalizeAdaptiveCallerName(candidate: string, source: string, confidence?: "clear" | "uncertain" | "not_applicable"): string | null {
  if (confidence === "uncertain" || confidence === "not_applicable") return null;
  if (unsafeAdaptiveNameSource(source)) return null;
  const declared = explicitCurrentSelfIdentification(source);
  if (confidence === "clear") {
    if (candidate.length === 0 || candidate.length > 200 || !lexicallyPlausibleName(candidate)) return null;
    if (/^(?:yes|yeah|yep|no|nope|ok|okay|sure|thanks|thank you|all right)[.!?\s]*$/iu.test(source.trim())) return null;
    // Require a current self-name answer even when audio and ASR disagree.
    const bare = source.trim().replace(/[.!]+\s*$/, "");
    const sourceName = declared.recognized ? declared.name
      : normalizeCallerName(source) ?? (bare.split(" ").length > 2 && lexicallyPlausibleName(bare) ? bare : null);
    return sourceName === null ? null : candidate;
  }
  // An anchored self-declaration is the source authority. The model must still
  // point at that source span, but cannot select a different name from the turn.
  if (declared.recognized) return declared.name !== null && declared.phrases.some((phrase) => sameSourcePhrase(candidate, phrase)) ? declared.name : null;
  if (candidate.length === 0 || candidate.length > 200 || !lexicallyPlausibleName(candidate)) return null;
  // Realtime may normalize capitalization while transcribing the same spoken name.
  // Persist the bounded source spelling rather than trusting that normalization.
  return exactNameSpan(source, candidate);
}

/** Extract only an anchored, current first-person declaration; never decode its spelling explanation. */
function explicitCurrentSelfIdentification(source: string): { recognized: boolean; name: string | null; phrases: readonly string[] } {
  const spoken = source.trim();
  const introduction = spoken.match(/^(?:(?:hi|hello|hey|no|actually|yes|yeah|sure|okay|ok)[,.!]?\s+)*my (?:full )?name is\s+(.+)$/iu);
  if (introduction === null) return { recognized: false, name: null, phrases: [] };
  if ([...spoken.matchAll(/\bmy (?:full )?name is\b/giu)].length !== 1) return { recognized: true, name: null, phrases: [] };
  const stated = introduction[1]!;
  // This is deliberately a delimiter, not a spelling decoder. The initial
  // source sentence remains the authority even when the suffix is mistaken.
  const spelling = /[,.!?]\s+(?:\p{L}[\p{L}\p{M}'’\-–]*\s+)?(?:is\s+)?(?:spelled\s+)?\p{L}(?:-\p{L})+(?:\s+\p{L}(?:-\p{L})+)*(?:[.!?]|$)/iu.exec(stated);
  const firstSentence = stated.match(/^(.+?)[.!?]\s+/u)?.[1];
  const rawName = (spelling?.index === undefined ? firstSentence ?? stated : stated.slice(0, spelling.index)).trim();
  const name = lexicallyPlausibleName(rawName) ? rawName : rawName.replace(/[,.!?]+$/u, "");
  // Whole-utterance candidates are tolerated only for the spelling form. A
  // normal mixed turn must still point to the declared name itself.
  const phrases = spelling === null ? [name] : [spoken, stated, name];
  return { recognized: true, name: lexicallyPlausibleName(name) ? name : null, phrases };
}

function sameSourcePhrase(candidate: string, source: string): boolean {
  return candidate.trim().toLowerCase() === source.trim().toLowerCase();
}

function unsafeAdaptiveNameSource(source: string): boolean {
  const spoken = source.trim();
  if (/^(?:wait|hold on|one (?:moment|second)|just a (?:moment|second)|give me a (?:moment|second))\b/iu.test(spoken)) return true;
  if (/\b(?:if|when|unless)\s+my (?:full )?name is\b/iu.test(spoken) || /\bmy (?:full )?name is\s+not\b/iu.test(spoken) || /\bmy (?:full )?name (?:was|used to be)\b/iu.test(spoken)) return true;
  return /\b(?:his|her|their|the patient(?:['’]s)?|my (?:wife|husband|mother|father|daughter|son|friend)(?:['’]s)?|someone else(?:['’]s)?)\s+(?:full )?name is\b/iu.test(spoken);
}

/** Keep the adaptive exact source span, but apply the same lexical name guard. */
function lexicallyPlausibleName(name: string): boolean {
  // Preserve the caller's script; Unicode letters and combining marks cover multilingual names without transliteration.
  const nameWord = String.raw`\p{L}[\p{L}\p{M}'’\-–]*`;
  const namePattern = new RegExp(`^${nameWord}(?: ${nameWord}){0,4}(?: (?:Jr\\.?|Sr\\.?|II|III|IV|V))?$`, "iu");
  if (!namePattern.test(name)) return false;
  const nonNameWords = new Set(["again", "already", "and", "about", "am", "appointment", "are", "can", "call", "calling", "change", "do", "first", "help", "here", "hold", "i", "is", "last", "me", "moment", "need", "new", "no", "not", "now", "patient", "please", "referral", "repeat", "said", "schedule", "scheduling", "second", "sorry", "tell", "the", "this", "time", "to", "wait", "want", "what", "whatever", "why", "you", "yes"]);
  return !name.split(" ").some((word) => nonNameWords.has(word.toLowerCase()));
}

function exactNameSpan(source: string, candidate: string): string | null {
  const nameCharacter = /[\p{L}\p{M}]/u;
  const escapedCandidate = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of source.matchAll(new RegExp(escapedCandidate, "giu"))) {
    const start = match.index!;
    const sourceSpan = match[0];
    const before = Array.from(source.slice(0, start)).at(-1) ?? "";
    const after = Array.from(source.slice(start + sourceSpan.length))[0] ?? "";
    if (!nameCharacter.test(before) && !nameCharacter.test(after)) return sourceSpan;
  }
  return null;
}

function normalizeCallerCallbackNumber(utterance: string, caller: string): string | null {
  if (/^\s*(?:please\s+)?use\s+(?:my\s+caller|the\s+number\s+i(?:'m| am)\s+calling\s+from|this)\s+(?:number|phone)?\s*[.!?]*\s*$/i.test(utterance)) {
    return /^\+[1-9]\d{7,14}$/.test(caller) ? caller : null;
  }
  const words: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const spoken = utterance.toLowerCase().replace(/\bplus\b/g, "+").replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (_, word: string) => words[word]!);
  const digits = spoken.replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(digits) && caller.startsWith("+1")) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

/** A correction must add message content, not consume the contact question or a caller exit. */
function isSupplementableMessageCorrection(utterance: string, caller: string): boolean {
  const text = utterance.trim();
  if (text.length === 0 || isExplicitCallbackDecline(text)
    || /^(?:i (?:just |already )?told you|i (?:already )?said (?:that|it)|you (?:already )?have (?:it|my message))\b/i.test(text)
    || /^(?:yes|yeah|yep|uh[ -]?huh|okay|ok|thank you|thanks|да)[.!?\s]*$/i.test(text)
    || /^(?:wait|hold on|one (?:moment|second)|just a (?:moment|second)|give me a (?:moment|second))\b/i.test(text)) return false;
  return normalizeCallerName(text) === null && normalizeCallerCallbackNumber(text, caller) === null;
}

function topicFor(topic: "address" | "demo_way_directions" | "sample_city_address" | "locations" | "parking" | "hours" | "other"): string {
  return ({ address: "practice_address", demo_way_directions: "practice_directions_demo_way",
    sample_city_address: "practice_address_sample_city", locations: "practice_locations" } as Record<string, string>)[topic] ?? topic;
}
function rejected(result: F2ExecutionOutcome): F2TurnResult {
  if (result.kind === "obsolete") return { kind: "obsolete" };
  if (result.kind === "rejected") return { kind: "rejected", reason: result.reason };
  if (result.kind === "planned" && result.result.kind === "rejected") return { kind: "rejected", reason: result.result.reason };
  return { kind: "rejected", reason: "execution_unavailable" };
}
