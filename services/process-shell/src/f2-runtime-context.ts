import { createHash } from "node:crypto";

import { scopeOf, type Conversation } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { buildF2PromptContext, type F2CapabilityAvailability, type F2PromptContextBuildInput, type TrustedF2PromptFact } from "./f2-context.js";
import type { F2PromptContext } from "./f2-prompt.js";
import { fullExecutableCapabilitySchema } from "./f2-request-policy.js";
import type { FullRequestProposal } from "./f2-request-policy.js";
import type { PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";
import type { F2RequestBinding, SyntheticDatasetScope, SyntheticIdentityGrant, TypedSyntheticReadReceipt } from "./f2-synthetic-practice-contract.js";
import type { F2VoiceProjectionPort } from "./f2-voice-driver.js";

const capabilities: readonly F2CapabilityAvailability[] = fullExecutableCapabilitySchema.options.map((capability) => ({
  capability, state: "available", reason: "Available in the synthetic F2 demonstration.",
}));

export type F2DurableReadFact = Readonly<{ statement: string; receipt: TypedSyntheticReadReceipt }>;
/** Transitional input shape retained only so callers fail closed until they pass `conversations`. */
export type F2DurableReadFactStore = Readonly<{
  currentFacts(input: { trusted: { expectedOwnerEpoch: number }; binding: F2RequestBinding; patientId: string; grantId: string }): Promise<readonly F2DurableReadFact[]>;
}>;
/**
 * Shared voice/SMS runtime projection. Conversation proposals are read from
 * durable state; grants, offers, and disclosure facts are independently
 * re-read through their authority-bound storage APIs.
 */
export class F2RuntimeContext implements F2VoiceProjectionPort {
  private readonly now: () => Date;
  constructor(private readonly options: {
    conversations: Pick<ConversationStore, "get">;
    practice: Pick<PostgresF2SyntheticPracticeStore, "currentGrant" | "currentProposal" | "currentReadFacts" | "describeProposalText">
      & Partial<Pick<PostgresF2SyntheticPracticeStore, "describeProposalSlots">>;
    dataset: SyntheticDatasetScope;
    model: string;
    knowledgeVersion: string;
    policyVersion: string;
    now?: () => Date;
    voiceMutationEnabled?: boolean;
  }) { this.now = options.now ?? (() => new Date()); }

  async load(input: { conversation: Conversation; sourceId?: string; reason: "opening" | "transcript" | "tool" }): Promise<F2PromptContext> {
    const conversation = await this.current(input.conversation, input.sourceId);
    const requestId = input.sourceId === undefined ? undefined : this.requestForSource({ conversation, sourceId: input.sourceId });
    return await this.build({ conversation, ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(requestId === null || requestId === undefined ? {} : { requestId }) });
  }

  requestForSource(input: { conversation: Conversation; sourceId: string; proposedCapability?: FullRequestProposal["capability"]; postCaptureMessageAddendum?: boolean }): string | null {
    if (input.conversation.admission.mode !== "full" || input.conversation.inputs.at(-1)?.id !== input.sourceId) return null;
    const pending = input.conversation.pendingQuestion;
    const pendingRequest = pending === null ? undefined : input.conversation.requests.find((request) => request.id === pending.requestId);
    // A new goal may share the caller source with an older pending question.
    // Once its own question is active, its authority-bound facts must win.
    if (pendingRequest?.sourceIds.includes(input.sourceId) && input.conversation.inputs.at(-1)?.questionId !== pending?.id
      && input.proposedCapability === undefined) return pendingRequest.id;
    if (pending === null && input.proposedCapability !== undefined) {
      const previousSourceId = input.conversation.inputs.at(-2)?.id;
      const resumed = input.conversation.requests.find((request) => request.state === "draft"
        && request.pausedCallbackSourceId === previousSourceId
        && request.fullProposal?.capability === input.proposedCapability);
      if (resumed !== undefined && !explicitDifferentPatient(input.conversation.inputs.at(-1)?.body ?? "")) return resumed.id;
    }
    if (input.postCaptureMessageAddendum === true && pending === null
      && input.conversation.admission.channel === "voice" && input.conversation.providerTier === "realtime") {
      const sourceBacked = (sourceId: string | null): boolean => sourceId !== null
        && input.conversation.inputs.some((item) => item.id === sourceId);
      const candidates = input.conversation.requests.filter((request) => request.state === "needs_callback"
        && request.callbackConfirmed && request.confirmationSourceId !== null && request.sourceIds.includes(request.confirmationSourceId)
        && sourceBacked(request.confirmationSourceId) && typeof request.callbackMessageSourceId === "string"
        && request.sourceIds.includes(request.callbackMessageSourceId) && sourceBacked(request.callbackMessageSourceId)
        && !request.sourceIds.includes(input.sourceId));
      if (candidates.length === 1) return candidates[0]!.id;
    }
    const existing = input.conversation.requests.find((request) => request.sourceIds.includes(input.sourceId));
    if (pending !== null && input.conversation.inputs.at(-1)?.questionId === pending.id) {
      if (pendingRequest !== undefined) {
        const clarificationAnswer = pending.kind === "request_clarification"
          && pendingRequest.fullProposal?.schedulingKind === "uncertain"
          && pendingRequest.fullProposal.capability === input.proposedCapability
          && !/\b(?:also|another|different|second)\b/i.test(input.conversation.inputs.at(-1)?.body ?? "");
        if (input.proposedCapability === undefined || (pending.kind === "patient_status"
          && pendingRequest.fullProposal?.capability === input.proposedCapability) || clarificationAnswer) return pending.requestId;
        // A full request while a factor/selection question is pending starts
        // another goal, even if it has the same capability. The reducer
        // provisionally links the source to the pending request.
        return `f2-request-${digest(`${input.conversation.id}:${input.sourceId}`)}`;
      }
    }
    // New request IDs are deterministic server values; the reducer remains
    // responsible for creating and binding the request to its source bundle.
    return existing?.id ?? `f2-request-${digest(`${input.conversation.id}:${input.sourceId}`)}`;
  }

  async build(input: { conversation: Conversation; sourceId?: string; requestId?: string; smsMutationGate?: F2PromptContextBuildInput["smsMutationGate"] }): Promise<F2PromptContext> {
      const conversation = await this.current(input.conversation, input.sourceId);
      if (conversation.admission.mode !== "full") throw new Error("f2_runtime_context_requires_full");
      const request = input.requestId === undefined ? latestRequest(conversation) : conversation.requests.find((item) => item.id === input.requestId) ?? null;
      const binding = request === null ? null : requestBinding(this.options.dataset, conversation, request.id);
      let grant: SyntheticIdentityGrant | null = null;
      if (binding !== null) {
        try { grant = await this.options.practice.currentGrant({ trusted: { expectedOwnerEpoch: conversation.ownerEpoch }, binding }); }
        catch { grant = null; }
      }
      const facts = binding === null || grant === null ? [] : await this.durableFacts(binding, grant, conversation.ownerEpoch, conversation.admission.channel);
      if (conversation.admission.channel === "sms" && input.smsMutationGate === undefined) throw new Error("f2_runtime_context_sms_mutation_gate_missing");
      return buildF2PromptContext({ conversation, versions: { model: this.options.model, knowledgeVersion: this.options.knowledgeVersion, policyVersion: this.options.policyVersion },
        phase: phaseFor(conversation), currentGrant: grant, identityWithoutGrant: "unverified", asOf: this.now().toISOString(),
        proposals: conversation.requests.flatMap((item) => item.fullProposal === undefined ? [] : [{ requestId: item.id, requestRevision: item.revision, proposal: item.fullProposal }]),
        facts, capabilities, voiceMutationEnabled: this.options.voiceMutationEnabled === true,
        ...(conversation.admission.channel === "sms" ? { smsMutationGate: input.smsMutationGate! } : {}) });
  }

  private async durableFacts(binding: F2RequestBinding, grant: SyntheticIdentityGrant, ownerEpoch: number, channel: "voice" | "sms"): Promise<readonly TrustedF2PromptFact[]> {
    const trusted = { expectedOwnerEpoch: ownerEpoch };
    const [reads, proposal] = await Promise.all([
      this.options.practice.currentReadFacts({ trusted, binding, patientId: grant.patientId, grantId: grant.id }),
      this.options.practice.currentProposal({ trusted, binding }),
    ]);
    const facts = reads.map((value) => readFact(value, binding, grant, this.now()));
    if (proposal === null) return facts;
    if (proposal.binding.conversationId !== binding.conversationId || proposal.binding.requestId !== binding.requestId || proposal.patientId !== grant.patientId
      || Date.parse(proposal.expiresAt) <= this.now().getTime()) return facts;
    let statement: string;
    if ("slots" in proposal && (proposal.slots.length !== 1 || channel === "voice")) {
      if (this.options.practice.describeProposalSlots === undefined) throw new Error("f2_offer_formatter_missing");
      statement = JSON.stringify({ kind: "appointment_slots", requestId: binding.requestId, requestRevision: binding.requestRevision,
        proposalId: proposal.id, operation: proposal.operation,
        slots: await this.options.practice.describeProposalSlots({ trusted, binding, patientId: grant.patientId, grantId: grant.id, proposalId: proposal.id }) });
    } else {
      statement = await this.options.practice.describeProposalText({ trusted, binding, patientId: grant.patientId, grantId: grant.id, proposalId: proposal.id,
        channel });
    }
    return [...facts, { status: "accepted", factId: proposal.id, statement, receiptId: proposal.id,
      sourceVersion: String(proposal.proposalRevision), sourceTimestamp: proposal.issuedAt }];
  }

  private async current(snapshot: Conversation, sourceId?: string): Promise<Conversation> {
    const current = await this.options.conversations.get(scopeOf(snapshot));
    if (current === null || current.admission.mode !== "full" || current.id !== snapshot.id || current.revision !== snapshot.revision
      || current.ownerEpoch !== snapshot.ownerEpoch || (sourceId !== undefined && current.inputs.at(-1)?.id !== sourceId)) throw new Error("f2_runtime_context_stale");
    return current;
  }
}

/** @deprecated A runtime context without durable conversation reads is unsafe. */
export function createF2RuntimeContext(_options: {
  practice: Pick<PostgresF2SyntheticPracticeStore, "currentGrant">;
  dataset: SyntheticDatasetScope;
  model: string;
  knowledgeVersion: string;
  policyVersion: string;
  readFacts: F2DurableReadFactStore;
}): F2RuntimeContext {
  throw new Error("f2_runtime_context_conversations_required");
}

function requestBinding(dataset: SyntheticDatasetScope, conversation: Conversation, requestId: string): F2RequestBinding {
  return { scope: dataset,
    instanceId: conversation.admission.instanceId, conversationId: conversation.id, requestId, observedConversationRevision: conversation.revision,
    requestRevision: conversation.requests.find((request) => request.id === requestId)!.revision };
}
function latestRequest(conversation: Conversation) { return [...conversation.requests].reverse().find((request) => request.state === "draft") ?? null; }

export function explicitDifferentPatient(text: string): boolean {
  return /\b(?:different|another|other)\s+(?:patient|person)\b|\b(?:someone|somebody)\s+else\b|\bfor\s+(?:my|his|her|their)\s+(?:wife|husband|mother|father|mom|dad|son|daughter|partner|child|friend)\b/i.test(text);
}
function phaseFor(conversation: Conversation): "understand_request" | "verify_identity" | "help_patient" | "execute_action" | "finish_or_handoff" {
  if (conversation.emergency !== null || conversation.owner !== "ai") return "finish_or_handoff";
  if (conversation.pendingQuestion?.kind === "identity_dob" || conversation.pendingQuestion?.kind === "identity_zip") return "verify_identity";
  return conversation.requests.length === 0 ? "understand_request" : "help_patient";
}
function readFact(value: F2DurableReadFact, binding: F2RequestBinding, grant: SyntheticIdentityGrant, asOf: Date): TrustedF2PromptFact {
  const receipt = value.receipt;
  if (receipt.binding.scope.practiceId !== binding.scope.practiceId || receipt.binding.scope.datasetId !== binding.scope.datasetId
    || receipt.binding.scope.generation !== binding.scope.generation || receipt.binding.instanceId !== binding.instanceId
    || receipt.binding.conversationId !== binding.conversationId || receipt.binding.requestId !== binding.requestId
    || receipt.binding.requestRevision !== binding.requestRevision || receipt.patientId !== grant.patientId || receipt.grantId !== grant.id
    || Date.parse(receipt.expiresAt) <= asOf.getTime()) throw new Error("f2_runtime_context_read_receipt_invalid");
  return { status: "accepted", factId: receipt.id, statement: value.statement, receiptId: receipt.id,
    sourceVersion: String(receipt.sourceVersion), sourceTimestamp: receipt.sourceTimestamp };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
