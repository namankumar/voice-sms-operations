import { createHash } from "node:crypto";
import { z } from "zod";

import { type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { createF2ResolutionPublisher } from "./f2-resolution-publisher.js";
import { f2RequestBindingSchema, type ExactConsent, type F2RequestBinding, type SyntheticAttendanceProposal, type SyntheticDatasetScope,
  type SyntheticIdentityGrant, type SyntheticSlotProposal, voiceProposalReadbackReceiptSchema, type VoiceProposalReadbackReceipt } from "./f2-synthetic-practice-contract.js";
import { type F2Mutation, type F2TrustedConversationContext, PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";

type Proposal = SyntheticSlotProposal | SyntheticAttendanceProposal;
type ConversationPort = Pick<ConversationStore, "get" | "execute" | "history">;
type ResolutionConversationPort = ConversationPort & Pick<import("./conversation-store.js").PostgresConversationStore, "executeInTransaction">;
const identifier = z.string().min(1).max(200);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Server-owned directive attached to exactly one response-owner token. */
export const voiceProposalSpeechAuthoritySchema = z.object({
  id: identifier,
  binding: f2RequestBindingSchema,
  patientId: identifier,
  proposalId: identifier,
  proposalRevision: z.number().int().nonnegative(),
  directiveId: identifier,
  parameterHash: hash,
  exactText: z.string().trim().min(1).max(2_000),
  exactTextHash: hash,
  questionId: identifier,
  ownerEpoch: z.number().int().nonnegative(),
  voiceEpoch: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export type VoiceProposalSpeechAuthority = z.infer<typeof voiceProposalSpeechAuthoritySchema>;

export type F2VoiceConsentInput = Readonly<{ scope: ConversationScope; requestId: string }>;
export type F2VoiceConsentControlInput = F2VoiceConsentInput & Readonly<{ sourceId: string; answer: "yes" | "no" | "unclear" }>;
export type F2VoiceConsentOutcome =
  | Readonly<{ kind: "not_confirmed"; reason?: "readback_unverified" }>
  | Readonly<{ kind: "committed"; receiptId: string; operation: "schedule" | "reschedule" | "attendance_confirm"; resultingVersion: number; resultHash: string; readbackHash: string }>;

/** Opt-in synthetic-only exact readback and subsequent voice-consent authority. */
export class F2VoiceConsentService {
  private readonly publisher;
  constructor(private readonly options: {
    conversations: ResolutionConversationPort;
    practice: PostgresF2SyntheticPracticeStore;
    dataset: SyntheticDatasetScope;
  }) { this.publisher = createF2ResolutionPublisher(options.conversations).action; }

  async prepareExactProposal(input: F2VoiceConsentInput): Promise<VoiceProposalSpeechAuthority> {
    const context = await this.context(input);
    const proposal = await this.proposal(context);
    const question = context.conversation.pendingQuestion;
    if (question?.kind !== questionKind(proposal) || question.requestId !== input.requestId
      || question.requestRevision !== context.binding.requestRevision) throw new Error("f2_voice_question_missing");
    const exactText = await this.options.practice.describeProposalText({ trusted: context.trusted, binding: context.binding,
      patientId: context.grant.patientId, grantId: context.grant.id, proposalId: proposal.id, channel: "voice" });
    return voiceProposalSpeechAuthoritySchema.parse({ id: voiceAuthorityReceiptId(proposal.id), binding: context.binding,
      patientId: context.grant.patientId, proposalId: proposal.id, proposalRevision: proposal.proposalRevision,
      directiveId: proposal.directiveId, parameterHash: proposal.parameterHash, exactText, exactTextHash: sha256(exactText),
      questionId: question.id, ownerEpoch: context.conversation.ownerEpoch, voiceEpoch: context.conversation.voiceEpoch,
      expiresAt: proposal.expiresAt });
  }

  async recordReadback(input: { scope: ConversationScope; receipt: VoiceProposalReadbackReceipt }): Promise<void> {
    const receipt = voiceProposalReadbackReceiptSchema.parse(input.receipt);
    const context = await this.context({ scope: input.scope, requestId: receipt.binding.requestId });
    const expected = await this.prepareExactProposal({ scope: input.scope, requestId: receipt.binding.requestId });
    if (receipt.id !== expected.id || receipt.patientId !== expected.patientId || receipt.proposalId !== expected.proposalId
      || receipt.proposalRevision !== expected.proposalRevision || receipt.directiveId !== expected.directiveId
      || receipt.parameterHash !== expected.parameterHash || receipt.exactTextHash !== expected.exactTextHash
      || receipt.questionId !== expected.questionId || receipt.ownerEpoch !== expected.ownerEpoch
      || receipt.voiceEpoch !== expected.voiceEpoch) throw new Error("f2_voice_readback_stale");
    await tolerateEvidenceReplay(() => this.options.practice.persistVoiceReadbackAuthority({ trusted: context.trusted, receipt }));
  }

  async commitExactConsent(input: F2VoiceConsentControlInput): Promise<F2VoiceConsentOutcome> {
    if (input.answer !== "yes") return { kind: "not_confirmed" };
    const context = await this.context(input);
    const proposal = await this.proposal(context);
    const question = context.conversation.pendingQuestion;
    if (question?.kind !== questionKind(proposal) || question.requestId !== input.requestId || question.requestRevision !== context.binding.requestRevision) {
      return { kind: "not_confirmed" };
    }
    const source = await latestAffirmativeInput(this.options.conversations, input.scope, context.conversation, question.id, input.requestId, input.sourceId);
    if (source === null) return { kind: "not_confirmed" };
    const mutation = mutationFor(context, proposal, source.sourceId);
    try { return committedOutcome(await this.options.practice.commitMutation(mutation, this.publisher)); }
    catch (error) {
      if (!(error instanceof Error) || !["synthetic_consent_invalid", "synthetic_authorization_receipt_invalid"].includes(error.message)) throw error;
    }
    const consent: ExactConsent = { id: voiceConsentEvidenceId(proposal.id, source.sourceId), binding: context.binding,
      patientId: context.grant.patientId, proposalId: proposal.id, proposalRevision: proposal.proposalRevision,
      parameterHash: proposal.parameterHash, questionId: question.id, channel: "voice", explicit: true, sourceEventId: source.sourceId,
      receivedAt: source.receivedAt, expiresAt: proposal.expiresAt };
    await tolerateEvidenceReplay(() => this.options.practice.persistExactConsent({ trusted: context.trusted, consent }));
    try { return committedOutcome(await this.options.practice.commitMutation({ ...mutation, consentEvidenceId: consent.id }, this.publisher)); }
    catch (error) {
      if (error instanceof Error && error.message === "synthetic_authorization_receipt_invalid") {
        return { kind: "not_confirmed", reason: "readback_unverified" };
      }
      throw error;
    }
  }

  private async context(input: F2VoiceConsentInput): Promise<VoiceContext> {
    const conversation = await this.options.conversations.get(input.scope);
    if (!isCurrentVoiceConversation(conversation)) throw new Error("f2_voice_channel_required");
    const request = conversation.requests.find((item) => item.id === input.requestId);
    if (request === undefined || request.state !== "draft") throw new Error("f2_voice_request_unavailable");
    const binding: F2RequestBinding = { scope: this.options.dataset, instanceId: conversation.admission.instanceId, conversationId: conversation.id,
      requestId: request.id, observedConversationRevision: conversation.revision, requestRevision: request.revision };
    const trusted = { expectedOwnerEpoch: conversation.ownerEpoch };
    const grant = await this.options.practice.currentGrant({ trusted, binding });
    if (grant === null) throw new Error("f2_voice_identity_required");
    return { conversation, binding, trusted, grant };
  }

  private async proposal(context: VoiceContext): Promise<Proposal> {
    const proposal = await this.options.practice.currentProposal({ trusted: context.trusted, binding: context.binding });
    if (proposal === null || proposal.patientId !== context.grant.patientId) throw new Error("f2_voice_proposal_unavailable");
    if ("slots" in proposal && proposal.slots.length !== 1) throw new Error("f2_voice_exact_slot_required");
    return proposal;
  }
}

type VoiceContext = Readonly<{ conversation: Conversation; binding: F2RequestBinding; trusted: F2TrustedConversationContext; grant: SyntheticIdentityGrant }>;
function isCurrentVoiceConversation(conversation: Conversation | null): conversation is Conversation {
  return conversation !== null && conversation.admission.channel === "voice" && conversation.admission.mode === "full" && conversation.phase === "active"
    && conversation.owner === "ai" && !conversation.suppressed && conversation.emergency === null;
}
function questionKind(proposal: Proposal): "appointment_consent" | "attendance_consent" { return "slots" in proposal ? "appointment_consent" : "attendance_consent"; }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function opaque(parts: readonly string[]): string { return createHash("sha256").update(JSON.stringify(parts)).digest("hex"); }
function voiceAuthorityReceiptId(proposalId: string): string { return `f2-voice-authority-${opaque([proposalId])}`; }
function voiceConsentEvidenceId(proposalId: string, sourceId: string): string { return `f2-voice-consent-${opaque([proposalId, sourceId])}`; }

async function latestAffirmativeInput(store: Pick<ConversationStore, "history">, scope: ConversationScope, conversation: Conversation,
  questionId: string, requestId: string, sourceId: string): Promise<{ sourceId: string; receivedAt: string } | null> {
  const event = (await store.history(scope)).find((candidate) => candidate.receipt.accepted && candidate.input.actor.kind === "provider"
    && candidate.input.command.type === "input.record" && candidate.input.command.sourceId === sourceId && candidate.input.command.questionId === questionId);
  // The realtime tool supplies semantic interpretation. Authority still comes
  // from this exact durable, current, question-bound caller source.
  if (event === undefined || event.input.command.type !== "input.record"
    || conversation.inputs.at(-1)?.id !== sourceId || conversation.inputs.at(-1)?.questionId !== questionId
    || !conversation.requests.find((request) => request.id === requestId)?.sourceIds.includes(sourceId)) return null;
  return { sourceId, receivedAt: event.receipt.occurredAt };
}

function mutationFor(context: VoiceContext, proposal: Proposal, sourceId: string): F2Mutation {
  const attendance = !("slots" in proposal);
  return { actionId: `f2-voice-action-${opaque([proposal.id, sourceId])}`, trusted: context.trusted, binding: context.binding,
    patientId: context.grant.patientId, grantId: context.grant.id, proposalId: proposal.id,
    consentEvidenceId: voiceConsentEvidenceId(proposal.id, sourceId), authorizationReceiptId: voiceAuthorityReceiptId(proposal.id),
    operation: attendance ? "attendance_confirm" : proposal.operation, requestKind: attendance ? "not_applicable" : "office_visit",
    selectedSlotId: attendance ? null : proposal.slots[0]!.id, idempotencyKey: `f2-voice-${opaque([proposal.id, sourceId, proposal.parameterHash])}`,
    parameterHash: proposal.parameterHash, expectedAppointmentVersion: attendance ? proposal.appointmentVersion : proposal.originalAppointmentVersion };
}
async function tolerateEvidenceReplay(write: () => Promise<void>): Promise<void> {
  try { await write(); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return; throw error; }
}
function committedOutcome(receipt: Awaited<ReturnType<PostgresF2SyntheticPracticeStore["commitMutation"]>>): F2VoiceConsentOutcome {
  if (receipt.state !== "committed" || receipt.resultingAppointmentVersion === null || receipt.resultHash === null || receipt.readbackHash === null) {
    throw new Error("f2_voice_commit_receipt_invalid");
  }
  return { kind: "committed", receiptId: receipt.id, operation: receipt.operation, resultingVersion: receipt.resultingAppointmentVersion,
    resultHash: receipt.resultHash, readbackHash: receipt.readbackHash };
}
