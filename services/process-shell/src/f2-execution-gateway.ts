import { randomUUID } from "node:crypto";

import type { Conversation, ConversationScope } from "./conversation-contract.js";
import type { ConversationStore, PostgresConversationStore } from "./conversation-store.js";
import { FullRequestGateway, type FullPlanResult } from "./f2-tool-gateway.js";
import type { SyntheticAttendanceProposal, SyntheticDatasetScope, SyntheticSlotProposal, TypedSyntheticReadKind } from "./f2-synthetic-practice-contract.js";
import { PostgresF2SyntheticPracticeStore, type F2TrustedConversationContext } from "./f2-synthetic-practice-store.js";
import { validateAppointmentPreference } from "./synthetic-trial.js";
import { schedulingPreference, type SchedulingPreference } from "./f2-scheduling-preference.js";
import { isCallbackQuestion, resumesOfferedAppointment } from "./f2-dialogue-evidence.js";
import type { ControlledProtectedReadFailurePort } from "./controlled-protected-read-failure.js";

type ExecutionInput = Readonly<{ scope: ConversationScope; requestId: string; sourceId: string }>;
type AppointmentOperation = "schedule" | "reschedule" | "attendance_confirm";

export type F2ExecutionOutcome =
  | { kind: "planned"; result: FullPlanResult }
  | { kind: "identity_started"; verificationId: string }
  | { kind: "identity"; state: "pending" | "verified" | "exhausted" | "revoked"; grantId: string | null; nextFactor?: "date_of_birth" | "zip" }
  | { kind: "read"; receiptId: string; value: unknown }
  | { kind: "appointment_planned"; proposal: SyntheticSlotProposal | SyntheticAttendanceProposal }
  | { kind: "appointment_selected"; proposal: SyntheticSlotProposal }
  | { kind: "obsolete" }
  | { kind: "rejected"; reason: "voice_mutation_denied" | "mutation_authority_required" | "identity_required" | "identity_source_mismatch" | "slot_selection_unavailable" | "slot_selection_source_mismatch" | "execution_unavailable" | "appointment_availability_unavailable" | "appointment_selection_required" | "appointment_type_requires_staff" };

type ExecutionContext = Readonly<{
  conversation: Conversation;
  binding: { scope: SyntheticDatasetScope; instanceId: string; conversationId: string; requestId: string; observedConversationRevision: number; requestRevision: number };
  trusted: F2TrustedConversationContext;
  channel: "voice" | "sms";
  operation: AppointmentOperation | null;
  source: Conversation["inputs"][number];
  pendingQuestion: Conversation["pendingQuestion"];
  schedulingPreference: SchedulingPreference | null;
}>;

/**
 * Server authority for F2 execution. Public methods accept only a durable scope,
 * selected request, and current source. Binding, owner epoch, grants, receipts,
 * expiry, and dataset scope are derived inside this gateway.
 */
export class F2ExecutionGateway {
  private readonly now: () => Date;
  private readonly planner: FullRequestGateway;
  constructor(private readonly options: {
    conversationStore: Pick<ConversationStore, "get" | "execute" | "getEvent"> & Partial<Pick<PostgresConversationStore, "executeInTransaction">>;
    store: PostgresF2SyntheticPracticeStore;
    dataset: SyntheticDatasetScope;
    model: string;
    promptVersion: string;
    controlledProtectedReadFailure?: ControlledProtectedReadFailurePort;
    now?: () => Date;
  }) {
    this.now = options.now ?? (() => new Date());
    this.planner = new FullRequestGateway({ store: options.conversationStore, model: options.model, promptVersion: options.promptVersion, now: this.now });
  }

  async plan(scope: ConversationScope, proposal: unknown, signal?: AbortSignal): Promise<F2ExecutionOutcome> {
    return { kind: "planned", result: await this.planner.invoke(scope, proposal, signal) };
  }

  async beginIdentity(input: ExecutionInput): Promise<F2ExecutionOutcome> {
    const context = await this.context(input);
    if (context === null) return unavailable();
    const pending = await this.options.store.pendingVerification(context);
    if (pending !== null) return { kind: "identity_started", verificationId: pending };
    const verificationId = `verify-${randomUUID()}`;
    await this.options.store.beginVerification({ ...context, verificationId, expiresAt: this.expiry() });
    return { kind: "identity_started", verificationId };
  }

  async verifyIdentity(input: ExecutionInput & { factor: "date_of_birth" | "zip"; value: string }): Promise<F2ExecutionOutcome> {
    return this.verifyIdentityBatch(input, [{ factor: input.factor, value: input.value }], true);
  }

  async verifyIdentityFactors(input: ExecutionInput & { factors: readonly { factor: "date_of_birth" | "zip"; value: string }[] }): Promise<F2ExecutionOutcome> {
    return this.verifyIdentityBatch(input, input.factors, false);
  }

  private async verifyIdentityBatch(input: ExecutionInput, factors: readonly { factor: "date_of_birth" | "zip"; value: string }[], legacy: boolean): Promise<F2ExecutionOutcome> {
    const context = await this.context(input);
    if (context === null) return unavailable();
    if (!currentQuestionAnswer(context, input.requestId, "identity")) {
      return { kind: "rejected", reason: "identity_source_mismatch" };
    }
    const verificationId = await this.options.store.pendingVerification(context);
    if (verificationId === null) return unavailable();
    let result;
    try {
      result = legacy ? await this.options.store.verifyFactor({ ...context, verificationId, factor: factors[0]!.factor, value: factors[0]!.value,
        answerSourceId: context.source.id }) : await this.options.store.verifyFactors({ ...context, verificationId, factors,
        answerSourceId: context.source.id });
    } catch (error) {
      if (isStaleAnswer(error)) return { kind: "obsolete" };
      throw error;
    }
    return { kind: "identity", state: result.state, grantId: result.grant?.id ?? null,
      ...(result.nextFactor === undefined ? {} : { nextFactor: result.nextFactor }) };
  }

  async read(input: ExecutionInput & { readKind: TypedSyntheticReadKind }): Promise<F2ExecutionOutcome> {
    const context = await this.context(input);
    if (context === null) return unavailable();
    const grant = await this.options.store.currentGrant(context);
    if (grant === null) return { kind: "rejected", reason: "identity_required" };
    if (await this.options.controlledProtectedReadFailure?.consume({ conversation: context.conversation, sourceId: input.sourceId,
      requestId: input.requestId, readKind: input.readKind }) === true) throw new Error("controlled_protected_read_failure");
    const result = await this.options.store.read({ ...context, patientId: grant.patientId, grantId: grant.id, kind: input.readKind,
      id: `read-${randomUUID()}`, expiresAt: this.expiry() });
    return { kind: "read", receiptId: result.receipt.id, value: result.value };
  }

  async planAppointment(input: ExecutionInput, refresh = false): Promise<F2ExecutionOutcome> {
    const context = await this.context(input);
    if (context === null || context.operation === null) return unavailable();
    const grant = await this.options.store.currentGrant(context);
    if (grant === null) return { kind: "rejected", reason: "identity_required" };
    const publish = this.options.conversationStore.executeInTransaction?.bind(this.options.conversationStore);
    if (refresh && publish === undefined) return unavailable();
    try {
      const proposal = await this.options.store.planAppointment({ ...context, patientId: grant.patientId, grantId: grant.id, operation: context.operation,
        preference: context.schedulingPreference, ...(refresh ? { answerSourceId: input.sourceId } : {}) }, refresh ? async (tx, { current, proposal }) => {
          const receipt = await publish!(tx, { scope: input.scope, eventId: `f2-refresh-${proposal.id}`,
            expectedRevision: current.conversation.revision, expectedOwnerEpoch: current.conversation.ownerEpoch,
            actor: { kind: "system", id: "f2-offer-refresh" }, command: { type: "question.activate",
              questionId: `question-${proposal.id}`, kind: "slot_selection", requestId: input.requestId } });
          if (!receipt.accepted) throw new Error("f2_offer_refresh_question_rejected");
        } : undefined);
      return { kind: "appointment_planned", proposal };
    } catch (error) {
      if (refresh && isStaleAnswer(error)) return { kind: "obsolete" };
      // These are expected synthetic domain outcomes, not execution failures.
      if (error instanceof Error && error.message === "synthetic_no_eligible_slots") return { kind: "rejected", reason: "appointment_availability_unavailable" };
      if (error instanceof Error && error.message === "synthetic_appointment_selection_required") return { kind: "rejected", reason: "appointment_selection_required" };
      if (error instanceof Error && error.message === "synthetic_appointment_type_requires_staff") return { kind: "rejected", reason: "appointment_type_requires_staff" };
      throw error;
    }
  }

  /** Narrows a persisted offer only after the model's proposed selection identifies exactly one offered slot. */
  async selectAppointmentSlot(input: ExecutionInput & { selection: string }): Promise<F2ExecutionOutcome> {
    const context = await this.context(input);
    if (context === null || (context.operation !== "schedule" && context.operation !== "reschedule")) return unavailable();
    if (!currentQuestionAnswer(context, input.requestId, "slot_selection")) return { kind: "rejected", reason: "slot_selection_source_mismatch" };
    const grant = await this.options.store.currentGrant(context);
    if (grant === null) return { kind: "rejected", reason: "identity_required" };
    let proposal = await this.options.store.currentProposal(context);
    if (proposal === null && context.channel === "voice" && isCallbackQuestion(context.pendingQuestion?.kind)) {
      proposal = await this.options.store.resumeAppointmentOffer({ ...context, patientId: grant.patientId, grantId: grant.id,
        answerSourceId: context.source.id });
    }
    // An old choice cannot authorize a fresh offer. Refresh read-only options and
    // let the coordinator ask again rather than sending voice an empty offer.
    if (proposal === null && context.channel === "voice") return this.planAppointment(input, true);
    if (proposal === null || !("slots" in proposal)) return { kind: "rejected", reason: "slot_selection_unavailable" };
    // A model-supplied slot ID is not evidence that the caller chose it. The
    // current, question-bound transcript must itself identify one offered slot.
    const slotId = slotForSelection(context.source.body, proposal, this.now());
    if (slotId === null) return { kind: "rejected", reason: "slot_selection_unavailable" };
    let selected;
    try {
      selected = await this.options.store.selectAppointmentSlot({ ...context, patientId: grant.patientId, grantId: grant.id, proposalId: proposal.id, slotId,
        answerSourceId: context.source.id });
    } catch (error) {
      if (isStaleAnswer(error)) return { kind: "obsolete" };
      throw error;
    }
    return { kind: "appointment_selected", proposal: selected };
  }

  /** Derives the authority fence from durable conversation state; callers cannot provide it. */
  private async context(input: ExecutionInput): Promise<ExecutionContext | null> {
    const conversation = await this.options.conversationStore.get(input.scope);
    const request = conversation?.requests.find((item) => item.id === input.requestId);
    if (conversation === null || request === undefined || conversation.admission.mode !== "full" || conversation.phase !== "active" || conversation.owner !== "ai"
      || conversation.inputs.at(-1)?.id !== input.sourceId || !request.sourceIds.includes(input.sourceId) || conversation.suppressed || conversation.emergency !== null) return null;
    return { conversation, binding: { scope: this.options.dataset, instanceId: conversation.admission.instanceId, conversationId: conversation.id,
      requestId: request.id, observedConversationRevision: conversation.revision, requestRevision: request.revision },
      trusted: { expectedOwnerEpoch: conversation.ownerEpoch }, channel: conversation.admission.channel, operation: operationFor(request.fullProposal?.capability),
      source: conversation.inputs.at(-1)!, pendingQuestion: conversation.pendingQuestion,
      schedulingPreference: schedulingPreference(conversation.inputs.filter((item) => request.sourceIds.includes(item.id))) };
  }

  /** Voice never commits a mutation; SMS needs server-persisted authority and consent evidence. */
  mutationGate(channel: "voice" | "sms"): F2ExecutionOutcome {
    return channel === "voice" ? { kind: "rejected", reason: "voice_mutation_denied" } : { kind: "rejected", reason: "mutation_authority_required" };
  }

  private expiry(): string { return new Date(this.now().getTime() + 10 * 60_000).toISOString(); }
}

function unavailable(): F2ExecutionOutcome { return { kind: "rejected", reason: "execution_unavailable" }; }
function isStaleAnswer(error: unknown): boolean { return error instanceof Error && error.message === "f2_answer_source_stale"; }
function currentQuestionAnswer(context: ExecutionContext, requestId: string, family: "identity" | "slot_selection"): boolean {
  const question = context.pendingQuestion;
  const currentKind = family === "identity" ? question?.kind === "identity_dob" || question?.kind === "identity_zip"
    : question?.kind === "slot_selection" || context.channel === "voice" && isCallbackQuestion(question?.kind) && resumesOfferedAppointment(context.source.body);
  return currentKind && question?.requestId === requestId && question.requestRevision === context.binding.requestRevision
    && context.source.questionId === question.id && context.source.sequence > question.activatedRevision;
}
function operationFor(capability: string | undefined): AppointmentOperation | null {
  if (capability === "appointment_schedule") return "schedule";
  if (capability === "appointment_reschedule") return "reschedule";
  if (capability === "appointment_attendance_confirm") return "attendance_confirm";
  return null;
}

/** A follow-up source is usable only when durable input recording bound it to the active request question. */
function slotForSelection(selection: string, proposal: SyntheticSlotProposal, now: Date): string | null {
  const exact = proposal.slots.find((slot) => slot.id === selection.trim());
  if (exact !== undefined) return exact.id;

  if (proposal.slots.length === 1 && /^(?:yes|yeah|yep|sure|okay|ok)(?:[\s,.!]+(?:please|that works|sounds good|thank you))*[\s,.!]*$/i.test(selection.trim())) {
    return proposal.slots[0]!.id;
  }

  const option = offeredOrdinalChoice(selection);
  if (option !== null) {
    const indexed = proposal.slots[option === "first" ? 0 : 1];
    if (indexed !== undefined) return indexed.id;
  }

  const offeredDate = offeredDateChoice(selection, proposal);
  if (offeredDate !== null) return offeredDate;

  // A weekday-only choice refers to the offered times, not the next occurrence
  // of that weekday on the calendar. Never infer a choice from a dated or
  // negated request, or when more than one offered time shares that weekday.
  const offeredWeekday = weekdayOnlyChoice(selection);
  if (offeredWeekday !== null) {
    const matching = proposal.slots.filter((slot) => new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", weekday: "long",
    }).format(new Date(slot.startsAt)) === offeredWeekday);
    return matching.length === 1 ? matching[0]!.id : null;
  }

  const date = validateAppointmentPreference(selection, now);
  if (date.kind !== "valid" || date.isoDate === undefined) return null;
  const matching = proposal.slots.filter((slot) => slot.startsAt.slice(0, 10) === date.isoDate);
  return matching.length === 1 ? matching[0]!.id : null;
}

function offeredOrdinalChoice(selection: string): "first" | "second" | null {
  const text = selection.trim().toLowerCase().replace(/^(?:(?:actually|okay|ok|yes|sure|it's okay)[,.\s]+)+/, "")
    .replace(/[.!?,]+$/g, "").replace(/\s+/g, " ")
    .replace(/ that you (?:gave|offered)(?: me)?(?: for booking my appointment)?$/, "")
    .replace(/^i(?:'ll| will| can) (?:just )?/, "i ")
    .replace(/[;,]?\s+nothing else$/, "").replace(/ is fine$/, " works");
  if (/(?:\b(?:not|no|either|both|or|next|this)\b|\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b)/.test(text)) return null;
  const choices: Array<"first" | "second"> = [];
  for (const clause of text.split(/[.!?]+/).map((item) => item.trim()).filter(Boolean)) {
    const normalized = clause.replace(/^(?:thanks?|thank you)[,.\s]+/, "")
      .replace(/^i(?:'ll| will| can) (?:just )?/, "i ").replace(/,\s*/g, " ");
    const choice = normalized.match(/^(?:(?:i(?:'d| would)? (?:like|take|choose|want)(?: the)?|(?:please )?(?:book|take)(?: the)?|the) )?(first|second|option (?:one|two|too|1|2)|number (?:one|two|too|1|2))(?: (?:one|on|option|time|slot))?(?: please| works(?: for me)?)?$/);
    if (choice !== null) {
      choices.push(/^(?:second|option (?:two|too|2)|number (?:two|too|2))$/.test(choice[1]!) ? "second" : "first");
    } else if (!/^(?:thanks?|thank you|yes(?: please)?|okay|ok|sure)[,.\s]*$/.test(normalized)) return null;
  }
  return choices.length > 0 && choices.every((choice) => choice === choices[0]) ? choices[0]! : null;
}

function offeredDateChoice(selection: string, proposal: SyntheticSlotProposal): string | null {
  const dates = [...selection.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(?:the\s+)?([1-9]|[12]\d|3[01])(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)];
  if (dates.length !== 1 || /\b(?:not|no|or|instead of|rather than|before|after)\b/i.test(selection)) return null;
  const match = dates[0]!;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1;
  const day = Number(match[2]);
  const year = match[3] === undefined ? null : Number(match[3]);
  const matching = proposal.slots.filter((slot) => {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date(slot.startsAt));
    const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    return value("month") === month && value("day") === day && (year === null || value("year") === year);
  });
  return matching.length === 1 ? matching[0]!.id : null;
}

function weekdayOnlyChoice(selection: string): string | null {
  const weekdays = [...selection.matchAll(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi)];
  if (weekdays.length !== 1 || selection.length > 100
    || /\b(next|this|last|not|no|except|before|after|instead|rather|or|either|both|doesn't|don't|can't|cannot|won't)\b|\?|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{1,4}\b/i.test(selection)) return null;
  return weekdays[0]![1]![0]!.toUpperCase() + weekdays[0]![1]!.slice(1).toLowerCase();
}
