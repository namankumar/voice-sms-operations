import { createHash } from "node:crypto";
import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import type { SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import type { PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";
import { renderF2ReadResult } from "./f2-sms-turn.js";
import { protectedReadSpeechAuthoritySchema, voiceReadPresentationReceiptSchema, type ProtectedReadSpeechAuthority, type VoiceReadPresentationReceipt } from "./f2-read-monitor.js";

/** Read success means the exact grounded reply was delivered, not merely retrieved or queued. */
export class F2ReadDeliveryService {
  constructor(private readonly options: { conversations: Pick<ConversationStore, "get" | "execute" | "history">;
    practice: Pick<PostgresF2SyntheticPracticeStore, "currentGrant" | "currentReadFacts">; dataset: SyntheticDatasetScope }) {}

  async authorityForRead(input: { conversation: Conversation; requestId: string; receiptId: string }): Promise<ProtectedReadSpeechAuthority | null> {
    const scope = scopeOf(input.conversation);
    const current = await this.options.conversations.get(scope);
    const request = current?.requests.find((item) => item.id === input.requestId);
    if (!current || current.admission.mode !== "full" || current.admission.channel !== "voice" || current.phase !== "active"
      || current.owner !== "ai" || current.suppressed || current.emergency !== null || request?.state !== "draft"
      || current.ownerEpoch !== input.conversation.ownerEpoch || current.voiceEpoch !== input.conversation.voiceEpoch) return null;
    const binding = { scope: this.options.dataset, instanceId: scope.instanceId, conversationId: scope.conversationId,
      requestId: request.id, requestRevision: request.revision, observedConversationRevision: current.revision };
    const trusted = { expectedOwnerEpoch: current.ownerEpoch };
    const grant = await this.options.practice.currentGrant({ binding, trusted });
    if (!grant) return null;
    const facts = await this.options.practice.currentReadFacts({ binding, trusted, patientId: grant.patientId, grantId: grant.id });
    const fact = facts.find((item) => item.receipt.id === input.receiptId);
    if (!fact) return null;
    const receipt = fact.receipt;
    const decoded = JSON.parse(fact.statement) as { value: unknown };
    const result = protectedReadSpeechAuthoritySchema.safeParse({ directiveId: `read-${receipt.id}`, requestId: request.id,
      requestRevision: request.revision, ownerEpoch: current.ownerEpoch, voiceEpoch: current.voiceEpoch,
      receiptId: receipt.id, receiptHash: receipt.receiptHash, resultHash: receipt.resultHash, sourceVersion: receipt.sourceVersion,
      readKind: receipt.kind, value: decoded.value, ...(receipt.kind === "appointment_details" ? { timeZone: "UTC" } : {}) });
    return result.success ? result.data : null;
  }

  /** Resolve a grounded read only after its exact reviewed audio drains to the carrier. */
  async voicePresented(input: { scope: ConversationScope; presentation: VoiceReadPresentationReceipt }): Promise<void> {
    const presentation = voiceReadPresentationReceiptSchema.parse(input.presentation);
    let read: { id: string; kind: ProtectedReadSpeechAuthority["readKind"]; receiptHash: string; resultHash: string; sourceVersion: number } | null = null;
    let presented: Conversation | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conversation = await this.options.conversations.get(input.scope);
      if (!conversation || conversation.admission.mode !== "full" || conversation.admission.channel !== "voice"
        || conversation.owner !== "ai" || conversation.phase !== "active" || conversation.suppressed || conversation.emergency !== null
        || conversation.ownerEpoch !== presentation.ownerEpoch || conversation.voiceEpoch !== presentation.voiceEpoch) return;
      const request = conversation.requests.find((item) => item.id === presentation.requestId);
      if (request?.state !== "draft" || request.revision !== presentation.requestRevision) return;
      const binding = { scope: this.options.dataset, instanceId: input.scope.instanceId, conversationId: input.scope.conversationId,
        requestId: request.id, requestRevision: request.revision, observedConversationRevision: conversation.revision };
      const trusted = { expectedOwnerEpoch: conversation.ownerEpoch };
      const grant = await this.options.practice.currentGrant({ binding, trusted });
      if (!grant) return;
      const facts = await this.options.practice.currentReadFacts({ binding, trusted, patientId: grant.patientId, grantId: grant.id });
      const fact = facts.find((item) => item.receipt.id === presentation.receiptId);
      const check = conversation.speechReviews.find((item) => item.id === presentation.reviewId)?.protectedReadCheck;
      if (!fact || !check || check.receiptHash !== fact.receipt.receiptHash || check.resultHash !== fact.receipt.resultHash
        || check.sourceVersion !== fact.receipt.sourceVersion) return;
      const result = await this.options.conversations.execute({ scope: input.scope,
        eventId: `f2-read-presented-${createHash("sha256").update(`${presentation.id}:${conversation.revision}`).digest("hex")}`,
        expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch,
        actor: { kind: "system", id: "f2-read-delivery" }, command: { type: "voice.read_presented", presentation } });
      if (result.accepted) { read = fact.receipt; presented = result.state; break; }
      if (result.error !== "stale_revision") throw new Error("f2_read_presentation_transition_rejected");
    }
    if (read === null) throw new Error("f2_read_presentation_retry_exhausted");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = attempt === 0 ? presented : await this.options.conversations.get(input.scope);
      const presentedRequest = latest?.requests.find((item) => item.id === presentation.requestId);
      if (!latest || latest.ownerEpoch !== presentation.ownerEpoch || latest.voiceEpoch !== presentation.voiceEpoch
        || !latest.voiceReadPresentations.some((item) => item.id === presentation.id && item.receiptId === read.id)) return;
      if (presentedRequest?.state === "ai_resolved" && presentedRequest.aiResolution?.kind === "read"
        && presentedRequest.aiResolution.receiptId === read.id) return;
      const sourceEventId = presentedRequest?.sourceIds.at(-1);
      if (presentedRequest?.state !== "draft" || presentedRequest.revision !== presentation.requestRevision
        || !sourceEventId || !latest.inputs.some((item) => item.id === sourceEventId)) return;
      const resolved = await this.options.conversations.execute({ scope: input.scope,
        eventId: `f2-voice-read-resolved-${createHash("sha256").update(`${presentation.id}:${latest.revision}`).digest("hex")}`,
        expectedRevision: latest.revision, expectedOwnerEpoch: latest.ownerEpoch,
        actor: { kind: "system", id: "f2-read-delivery" }, command: { type: "request.resolve_ai", requestId: presentation.requestId,
          requestRevision: presentation.requestRevision, sourceEventId,
          result: { kind: "read", receiptId: read.id, readKind: read.kind, receiptHash: read.receiptHash,
            resultHash: read.resultHash, sourceVersion: read.sourceVersion } } });
      if (resolved.accepted) return;
      if (resolved.error !== "stale_revision") throw new Error("f2_voice_read_resolution_rejected");
    }
    throw new Error("f2_voice_read_resolution_retry_exhausted");
  }

  async smsDelivered(input: { scope: ConversationScope; messageId: string }): Promise<void> {
    if (!input.messageId.startsWith("f2-read-")) return;
    const conversation = await this.options.conversations.get(input.scope);
    const message = conversation?.messages.find((candidate) => candidate.id === input.messageId);
    if (!conversation || conversation.admission.mode !== "full" || conversation.admission.channel !== "sms" || conversation.owner !== "ai"
      || conversation.phase !== "active" || conversation.suppressed || conversation.emergency !== null || message?.state !== "delivered" || !message.providerId) return;
    const history = await this.options.conversations.history(input.scope);
    const delivered = history.some((event) => event.receipt.accepted && event.input.actor.kind === "provider" && event.input.command.type === "sms.receipt"
      && event.input.command.messageId === message.id && event.input.command.providerId === message.providerId && event.input.command.state === "delivered");
    if (!delivered) return;
    const queued = history.find((event) => event.receipt.accepted && event.input.command.type === "sms.queue"
      && event.input.command.messageId === message.id && event.input.command.body === message.body);
    if (!queued) return;
    const receiptId = input.messageId.slice("f2-read-".length);
    for (const request of conversation.requests.filter((candidate) => candidate.state === "draft")) {
      const binding = { scope: this.options.dataset, instanceId: input.scope.instanceId, conversationId: input.scope.conversationId,
        requestId: request.id, requestRevision: request.revision, observedConversationRevision: conversation.revision };
      const trusted = { expectedOwnerEpoch: conversation.ownerEpoch };
      const grant = await this.options.practice.currentGrant({ binding, trusted });
      if (!grant) continue;
      const facts = await this.options.practice.currentReadFacts({ binding, trusted, patientId: grant.patientId, grantId: grant.id });
      const fact = facts.find((candidate) => candidate.receipt.id === receiptId);
      if (!fact) continue;
      const decoded = JSON.parse(fact.statement) as { value: unknown };
      if (renderF2ReadResult(decoded.value) !== message.body) throw new Error("f2_read_delivery_body_mismatch");
      const source = queued.receipt.state.inputs.at(-1)?.id;
      if (!source || !request.sourceIds.includes(source)) throw new Error("f2_read_delivery_source_missing");
      const receipt = fact.receipt;
      const result = await this.options.conversations.execute({ scope: input.scope,
        eventId: `f2-read-delivered-${createHash("sha256").update(`${message.id}:${conversation.revision}`).digest("hex")}`,
        expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch, actor: { kind: "system", id: "f2-read-delivery" },
        command: { type: "request.resolve_ai", requestId: request.id, requestRevision: request.revision, sourceEventId: source,
          result: { kind: "read", receiptId, readKind: receipt.kind, receiptHash: receipt.receiptHash, resultHash: receipt.resultHash, sourceVersion: receipt.sourceVersion } } });
      if (!result.accepted) throw new Error("f2_read_delivery_transition_rejected");
      return;
    }
  }
}
