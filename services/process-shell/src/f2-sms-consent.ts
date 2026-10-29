import { createHash } from "node:crypto";

import { type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { createF2ResolutionPublisher } from "./f2-resolution-publisher.js";
import { type ExactConsent, type F2RequestBinding, type SmsProposalAcceptance, type SyntheticAttendanceProposal, type SyntheticDatasetScope, type SyntheticIdentityGrant, type SyntheticSlotProposal } from "./f2-synthetic-practice-contract.js";
import { type F2AuthorityReceiptResolver, type F2Mutation, type F2TrustedConversationContext, PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";

type Proposal = SyntheticSlotProposal | SyntheticAttendanceProposal;
type ConversationPort = Pick<ConversationStore, "get" | "getEvent" | "execute" | "history">;
type ResolutionConversationPort = ConversationPort & Pick<import("./conversation-store.js").PostgresConversationStore, "executeInTransaction">;

export type F2SmsConsentInput = Readonly<{ scope: ConversationScope; requestId: string }>;
export type F2SmsQueuedProposal = Readonly<{ messageId: string; questionId: string; body: string }>;
export type F2SmsConsentControlInput = F2SmsConsentInput & Readonly<{ sourceId: string; answer: "yes" | "no" | "unclear" }>;
export type F2SmsConsentOutcome =
  | Readonly<{ kind: "not_confirmed" }>
  | Readonly<{ kind: "committed"; receiptId: string; operation: "schedule" | "reschedule" | "attendance_confirm"; resultingVersion: number; resultHash: string; readbackHash: string }>;

/**
 * Server-only provider evidence adapter. It derives every field from the
 * current durable proposal, queued message, and provider-authenticated event.
 */
export class F2SmsAuthorityResolver implements F2AuthorityReceiptResolver {
  constructor(private readonly options: {
    conversations: Pick<ConversationStore, "get" | "history">;
    practice: () => Pick<PostgresF2SyntheticPracticeStore, "currentGrant" | "currentProposal" | "describeProposalText">;
  }) {}

  async resolve(receiptId: string, binding: F2RequestBinding): Promise<SmsProposalAcceptance | null> {
    const conversation = await this.options.conversations.get(scopeFor(binding));
    if (!isCurrentSmsConversation(conversation, binding)) return null;
    const trusted = { expectedOwnerEpoch: conversation.ownerEpoch };
    const practice = this.options.practice();
    try {
      const proposal = await practice.currentProposal({ trusted, binding });
      const grant = await practice.currentGrant({ trusted, binding });
      if (proposal === null || grant === null || proposal.patientId !== grant.patientId || receiptId !== f2SmsAuthorityReceiptId(proposal.id)) return null;
      const expectedBody = await practice.describeProposalText({ trusted, binding, patientId: grant.patientId, grantId: grant.id, proposalId: proposal.id });
      const messageId = f2ProposalMessageId(proposal.id);
      const message = conversation.messages.find((candidate) => candidate.id === messageId);
      if (message?.body !== expectedBody || message.providerId === null || !["accepted", "delivered"].includes(message.state)) return null;
      const acceptance = (await this.options.conversations.history(scopeFor(binding))).find((event) => event.input.actor.kind === "provider"
        && event.receipt.accepted && event.input.command.type === "sms.receipt" && event.input.command.messageId === messageId
        && event.input.command.providerId === message.providerId && ["accepted", "delivered"].includes(event.input.command.state));
      if (acceptance === undefined) return null;
      return {
        id: receiptId, binding, patientId: grant.patientId, proposalId: proposal.id, proposalRevision: proposal.proposalRevision,
        parameterHash: proposal.parameterHash, source: "provider_accepted", providerMessageId: message.providerId,
        acceptedAt: acceptance.receipt.occurredAt, expiresAt: proposal.expiresAt,
      };
    } catch {
      // An unavailable, stale, or malformed durable authority cannot become consent evidence.
      return null;
    }
  }
}

/**
 * SMS-only exact-proposal authority producer and mutation committer. The model
 * supplies neither wording, provider evidence, affirmative intent, nor action arguments.
 */
export class F2SmsConsentService {
  private readonly publisher;
  constructor(private readonly options: {
    conversations: ResolutionConversationPort;
    practice: PostgresF2SyntheticPracticeStore;
    dataset: SyntheticDatasetScope;
  }) {
    this.publisher = createF2ResolutionPublisher(options.conversations).action;
  }

  async queue(input: F2SmsConsentInput): Promise<F2SmsQueuedProposal> {
    let context = await this.context(input);
    const proposal = await this.proposal(context);
    const kind = questionKind(proposal);
    let questionId = matchingQuestionId(context.conversation, kind, context.binding);
    if (context.conversation.pendingQuestion !== null && questionId === null) {
      throw new Error("f2_sms_question_pending");
    }
    if (questionId === null) {
      questionId = f2ProposalQuestionId(proposal.id);
      const receipt = await this.options.conversations.execute({ scope: input.scope, eventId: f2EventId("question", proposal.id),
        expectedRevision: context.conversation.revision, expectedOwnerEpoch: context.conversation.ownerEpoch,
        actor: { kind: "system", id: "f2-sms-consent" }, command: { type: "question.activate", questionId, kind, requestId: input.requestId } });
      if (!receipt.accepted) throw new Error("f2_sms_question_rejected");
      context = await this.context(input);
      questionId = matchingQuestionId(context.conversation, kind, context.binding);
      if (questionId === null) throw new Error("f2_sms_question_missing");
    }
    const currentProposal = await this.proposal(context);
    if (currentProposal.id !== proposal.id) throw new Error("f2_sms_proposal_stale");
    const body = await this.options.practice.describeProposalText({ trusted: context.trusted, binding: context.binding,
      patientId: context.grant.patientId, grantId: context.grant.id, proposalId: currentProposal.id, channel: "sms" });
    const messageId = f2ProposalMessageId(currentProposal.id);
    if (messageId.length > 200) throw new Error("f2_sms_message_id_invalid");
    const existing = context.conversation.messages.find((message) => message.id === messageId);
    if (existing !== undefined) {
      if (existing.body !== body) throw new Error("f2_sms_message_conflict");
      return { messageId, questionId, body };
    }
    const prior = await this.options.conversations.getEvent(input.scope, f2EventId("queue", currentProposal.id));
    if (prior !== null) {
      if (!prior.receipt.accepted || prior.input.command.type !== "sms.queue" || prior.input.command.messageId !== messageId || prior.input.command.body !== body) {
        throw new Error("f2_sms_queue_conflict");
      }
      return { messageId, questionId, body };
    }
    const queued = await this.options.conversations.execute({ scope: input.scope, eventId: f2EventId("queue", currentProposal.id),
      expectedRevision: context.conversation.revision, expectedOwnerEpoch: context.conversation.ownerEpoch,
      actor: { kind: "ai", id: "f2-sms-consent" }, command: { type: "sms.queue", messageId, body } });
    if (!queued.accepted) throw new Error("f2_sms_queue_rejected");
    return { messageId, questionId, body };
  }

  /** Named integration entrypoint for SMS turn handlers after a selected exact proposal. */
  async queueExactProposal(input: F2SmsConsentInput): Promise<F2SmsQueuedProposal> { return await this.queue(input); }

  async commit(input: F2SmsConsentInput) {
    const context = await this.context(input);
    const proposal = await this.proposal(context);
    const questionId = matchingQuestionId(context.conversation, questionKind(proposal), context.binding);
    if (questionId === null) throw new Error("f2_sms_question_missing");
    const source = await latestAffirmativeInput(this.options.conversations, input.scope, context.conversation, questionId, input.requestId);
    if (source === null) throw new Error("f2_sms_exact_consent_missing");
    const mutation = mutationFor(context, proposal, source.sourceId);

    // A durable action replay returns before it reads one-time evidence.
    try {
      return await this.options.practice.commitMutation(mutation, this.publisher);
    } catch (error) {
      if (!(error instanceof Error) || !["synthetic_consent_invalid", "synthetic_authorization_receipt_invalid"].includes(error.message)) throw error;
    }

    await tolerateEvidenceReplay(() => this.options.practice.persistAdapterAuthority({ trusted: context.trusted, binding: context.binding,
      receiptId: f2SmsAuthorityReceiptId(proposal.id) }));
    const consent: ExactConsent = { id: f2SmsConsentEvidenceId(proposal.id, source.sourceId), binding: context.binding,
      patientId: context.grant.patientId, proposalId: proposal.id, proposalRevision: proposal.proposalRevision,
      parameterHash: proposal.parameterHash, questionId, channel: "sms", explicit: true, sourceEventId: source.sourceId,
      receivedAt: source.receivedAt, expiresAt: proposal.expiresAt };
    await tolerateEvidenceReplay(() => this.options.practice.persistExactConsent({ trusted: context.trusted, consent }));
    return await this.options.practice.commitMutation({ ...mutation, consentEvidenceId: consent.id }, this.publisher);
  }

  /** Typed path for handlers that need to render a factual post-commit result. */
  async commitExactConsent(input: F2SmsConsentControlInput): Promise<F2SmsConsentOutcome> {
    if (input.answer !== "yes") return { kind: "not_confirmed" };
    const conversation = await this.options.conversations.get(input.scope);
    if (conversation === null || conversation.inputs.at(-1)?.id !== input.sourceId) throw new Error("f2_sms_consent_source_stale");
    const replay = resolvedOutcome(conversation, input.requestId, input.sourceId);
    if (replay !== null) return replay;
    try {
      return committedOutcome(await this.commit(input));
    } catch (error) {
      // A racing worker may have published the action between this worker's
      // draft-state read and its provider-evidence write.
      const latest = await this.options.conversations.get(input.scope);
      const raced = latest !== null && latest.inputs.at(-1)?.id === input.sourceId
        ? resolvedOutcome(latest, input.requestId, input.sourceId)
        : null;
      if (raced !== null) return raced;
      throw error;
    }
  }

  /** Implements Ram's frozen coordinator port without granting model text any authority. */
  async requestExactConsent(input: F2SmsConsentControlInput): Promise<F2SmsConsentOutcome> {
    return await this.commitExactConsent(input);
  }

  private async context(input: F2SmsConsentInput): Promise<SmsContext> {
    const conversation = await this.options.conversations.get(input.scope);
    if (!isCurrentSmsConversation(conversation) || conversation.admission.mode !== "full") throw new Error("f2_sms_channel_required");
    const request = conversation.requests.find((item) => item.id === input.requestId);
    if (request === undefined || request.state !== "draft") throw new Error("f2_sms_request_unavailable");
    const binding: F2RequestBinding = { scope: this.options.dataset, instanceId: conversation.admission.instanceId, conversationId: conversation.id,
      requestId: request.id, observedConversationRevision: conversation.revision, requestRevision: request.revision };
    const trusted = { expectedOwnerEpoch: conversation.ownerEpoch };
    const grant = await this.options.practice.currentGrant({ trusted, binding });
    if (grant === null) throw new Error("f2_sms_identity_required");
    return { conversation, binding, trusted, grant };
  }

  private async proposal(context: SmsContext): Promise<Proposal> {
    const proposal = await this.options.practice.currentProposal({ trusted: context.trusted, binding: context.binding });
    if (proposal === null || proposal.patientId !== context.grant.patientId) throw new Error("f2_sms_proposal_unavailable");
    if ("slots" in proposal && proposal.slots.length !== 1) throw new Error("f2_sms_exact_slot_required");
    return proposal;
  }
}

type SmsContext = Readonly<{ conversation: Conversation; binding: F2RequestBinding; trusted: F2TrustedConversationContext; grant: SyntheticIdentityGrant }>;

function scopeFor(binding: F2RequestBinding): ConversationScope {
  return { practiceId: binding.scope.practiceId, instanceId: binding.instanceId, conversationId: binding.conversationId };
}
function isCurrentSmsConversation(conversation: Conversation | null, binding?: F2RequestBinding): conversation is Conversation {
  return conversation !== null && conversation.admission.channel === "sms" && conversation.admission.mode === "full" && conversation.phase === "active"
    && conversation.owner === "ai" && !conversation.suppressed && conversation.emergency === null
    && (binding === undefined || conversation.id === binding.conversationId && conversation.admission.practiceId === binding.scope.practiceId
      && conversation.admission.instanceId === binding.instanceId && conversation.requests.some((request) => request.id === binding.requestId && request.revision === binding.requestRevision));
}
function questionKind(proposal: Proposal): "appointment_consent" | "attendance_consent" { return "slots" in proposal ? "appointment_consent" : "attendance_consent"; }
function matchingQuestionId(conversation: Conversation, kind: "appointment_consent" | "attendance_consent", binding: F2RequestBinding): string | null {
  const question = conversation.pendingQuestion;
  return question?.kind === kind && question.requestId === binding.requestId && question.requestRevision === binding.requestRevision ? question.id : null;
}
function opaque(parts: readonly string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function f2EventId(kind: "question" | "queue", proposalId: string): string { return `f2-sms-${kind}-${opaque([proposalId])}`; }
export function f2ProposalMessageId(proposalId: string): string { return `f2-proposal-${proposalId}`; }
export function f2ProposalQuestionId(proposalId: string): string { return `f2-sms-question-${opaque([proposalId])}`; }
export function f2SmsAuthorityReceiptId(proposalId: string): string { return `f2-sms-authority-${opaque([proposalId])}`; }
function f2SmsConsentEvidenceId(proposalId: string, sourceId: string): string { return `f2-sms-consent-${opaque([proposalId, sourceId])}`; }

async function latestAffirmativeInput(store: Pick<ConversationStore, "history">, scope: ConversationScope, conversation: Conversation, questionId: string, requestId: string): Promise<{ sourceId: string; receivedAt: string } | null> {
  const event = (await store.history(scope)).filter((candidate) => candidate.receipt.accepted && candidate.input.actor.kind === "provider"
    && candidate.input.command.type === "input.record" && candidate.input.command.questionId === questionId).at(-1);
  if (event === undefined || event.input.command.type !== "input.record") return null;
  const command = event.input.command;
  if (command.body.trim().toUpperCase() !== "YES" || !conversation.inputs.some((item) => item.id === command.sourceId && item.questionId === questionId)
    || conversation.inputs.at(-1)?.id !== command.sourceId
    || !conversation.requests.find((request) => request.id === requestId)?.sourceIds.includes(command.sourceId)) return null;
  return { sourceId: command.sourceId, receivedAt: event.receipt.occurredAt };
}

function mutationFor(context: SmsContext, proposal: Proposal, sourceId: string): F2Mutation {
  const attendance = !("slots" in proposal);
  return { actionId: `f2-sms-action-${opaque([proposal.id, sourceId])}`, trusted: context.trusted, binding: context.binding,
    patientId: context.grant.patientId, grantId: context.grant.id, proposalId: proposal.id,
    consentEvidenceId: f2SmsConsentEvidenceId(proposal.id, sourceId), authorizationReceiptId: f2SmsAuthorityReceiptId(proposal.id),
    operation: attendance ? "attendance_confirm" : proposal.operation, requestKind: attendance ? "not_applicable" : "office_visit",
    selectedSlotId: attendance ? null : proposal.slots[0]!.id, idempotencyKey: `f2-sms-${opaque([proposal.id, sourceId, proposal.parameterHash])}`,
    parameterHash: proposal.parameterHash, expectedAppointmentVersion: attendance ? proposal.appointmentVersion : proposal.originalAppointmentVersion };
}

/** IDs are SHA-256-derived from immutable server facts, so an exact duplicate is a retry, not a new authority. */
async function tolerateEvidenceReplay(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return;
    throw error;
  }
}

function committedOutcome(receipt: Awaited<ReturnType<PostgresF2SyntheticPracticeStore["commitMutation"]>>): F2SmsConsentOutcome {
  if (receipt.state !== "committed" || receipt.resultingAppointmentVersion === null || receipt.resultHash === null || receipt.readbackHash === null) {
    throw new Error("f2_sms_commit_receipt_invalid");
  }
  return { kind: "committed", receiptId: receipt.id, operation: receipt.operation, resultingVersion: receipt.resultingAppointmentVersion,
    resultHash: receipt.resultHash, readbackHash: receipt.readbackHash };
}

/** A concurrent caller may observe the request after the first exact commit published its durable result. */
function resolvedOutcome(conversation: Conversation, requestId: string, sourceId: string): F2SmsConsentOutcome | null {
  const request = conversation.requests.find((candidate) => candidate.id === requestId);
  const result = request?.aiResolution;
  if (request?.state !== "ai_resolved" || !request.sourceIds.includes(sourceId) || result?.kind !== "action") return null;
  return { kind: "committed", receiptId: result.receiptId, operation: result.operation, resultingVersion: result.resultingVersion,
    resultHash: result.resultHash, readbackHash: result.readbackHash };
}
