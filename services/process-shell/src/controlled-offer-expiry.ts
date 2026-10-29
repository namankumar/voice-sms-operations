import postgres from "postgres";
import { z } from "zod";

import { conversationScopeSchema, scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import type { F2RequestBinding, SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import type { F2TrustedConversationContext } from "./f2-synthetic-practice-store.js";
import { fullAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const maxReceiptTtlMs = 15 * 60_000;
const provisionSchema = z.object({ id, fixtureId: id, scope: conversationScopeSchema, requestId: id,
  offerTtlMs: z.number().int().min(1_000).max(60_000), expiresAt: z.string().datetime({ offset: true }) }).strict();

type Receipt = { id: string; practice_id: string; instance_id: string; conversation_id: string; request_id: string;
  request_revision: number; owner_epoch: number; verification_id: string; offer_ttl_ms: number; expires_at: Date;
  consumed_proposal_id: string | null; presented_at: Date | null; presentation_id: string | null };

export type ControlledOfferPresentation = Readonly<{
  id: string;
  scope: ConversationScope;
  requestId: string;
  requestRevision: number;
  proposalId: string;
  questionId: string;
  ownerEpoch: number;
  voiceEpoch: number;
  responseId: string;
  outputItemId: string;
}>;

/** Synthetic-only E02 control. It can shorten one newly-created canonical offer; it cannot alter an existing offer. */
export class PostgresControlledOfferExpiry {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly instance: VoiceAppInstance;
  private readonly now: () => Date;

  constructor(databaseUrl: string, private readonly options: { instance: VoiceAppInstance; dataset: SyntheticDatasetScope; conversations: Pick<ConversationStore, "get">;
    pendingVerification(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding }): Promise<string | null>;
    /** Default-deny comparison against the currently bound server offer. */
    canonicalOffer?(input: { scope: ConversationScope; requestId: string; requestRevision: number; ownerEpoch: number; voiceEpoch: number;
      proposalId: string; transcript: string }): Promise<boolean>;
    enabled: boolean; now?: () => Date }) {
    this.instance = fullAppInstanceSchema.parse(options.instance);
    if (this.instance.dataMode !== "synthetic_only") throw new Error("controlled_offer_expiry_synthetic_full_only");
    this.now = options.now ?? (() => new Date());
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-offer-expiry" } });
  }

  async ready(): Promise<void> {
    const rows = await this.sql<{ present: string | null }[]>`SELECT to_regclass('public.controlled_offer_expiry_receipts')::text AS present`;
    if (rows[0]?.present === null || rows[0] === undefined) throw new Error("controlled_offer_expiry_schema_not_ready");
  }

  async provision(raw: { id: string; fixtureId: string; scope: ConversationScope; requestId: string; offerTtlMs: number; expiresAt: string }): Promise<void> {
    if (!this.options.enabled) throw new Error("controlled_offer_expiry_disabled");
    const input = provisionSchema.parse(raw);
    const now = this.now().getTime(), expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= now || expires - now > maxReceiptTtlMs) throw new Error("controlled_offer_expiry_receipt_invalid");
    const conversation = await this.options.conversations.get(input.scope);
    const authority = conversation === null ? null : this.authority(conversation, input.scope, input.requestId);
    if (authority === null) throw new Error("controlled_offer_expiry_not_armable");
    if (conversation!.admission.controlledHours?.fixtureId !== input.fixtureId) throw new Error("controlled_offer_expiry_fixture_mismatch");
    if (!await this.confirmedRendezvous(conversation!)) throw new Error("controlled_offer_expiry_rendezvous_required");
    const verificationId = await this.options.pendingVerification({ trusted: { expectedOwnerEpoch: conversation!.ownerEpoch }, binding: authority.binding });
    if (verificationId === null) throw new Error("controlled_offer_expiry_verification_required");
    await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string }[]>`INSERT INTO controlled_offer_expiry_receipts(
        id,practice_id,instance_id,conversation_id,request_id,request_revision,owner_epoch,verification_id,offer_ttl_ms,expires_at
      ) VALUES (${input.id},${input.scope.practiceId},${input.scope.instanceId},${input.scope.conversationId}::uuid,
        ${input.requestId},${authority.binding.requestRevision},${conversation!.ownerEpoch},${verificationId},${input.offerTtlMs},${input.expiresAt}::timestamptz)
      ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
        WHERE controlled_offer_expiry_receipts.practice_id=EXCLUDED.practice_id
          AND controlled_offer_expiry_receipts.instance_id=EXCLUDED.instance_id
          AND controlled_offer_expiry_receipts.conversation_id=EXCLUDED.conversation_id
          AND controlled_offer_expiry_receipts.request_id=EXCLUDED.request_id
          AND controlled_offer_expiry_receipts.request_revision=EXCLUDED.request_revision
          AND controlled_offer_expiry_receipts.owner_epoch=EXCLUDED.owner_epoch
          AND controlled_offer_expiry_receipts.verification_id=EXCLUDED.verification_id
          AND controlled_offer_expiry_receipts.offer_ttl_ms=EXCLUDED.offer_ttl_ms
          AND controlled_offer_expiry_receipts.expires_at=EXCLUDED.expires_at
      RETURNING id`;
      if (rows.length !== 1) throw new Error("controlled_offer_expiry_provision_conflict");
    });
  }

  async cancel(input: { id: string; scope: ConversationScope }): Promise<boolean> {
    const parsed = z.object({ id, scope: conversationScopeSchema }).strict().parse(input);
    const now = this.now().toISOString();
    const rows = await this.sql<{ id: string }[]>`UPDATE controlled_offer_expiry_receipts SET expires_at=${now}::timestamptz
      WHERE id=${parsed.id} AND practice_id=${parsed.scope.practiceId} AND instance_id=${parsed.scope.instanceId}
        AND conversation_id=${parsed.scope.conversationId}::uuid AND consumed_at IS NULL AND expires_at>${now}::timestamptz RETURNING id`;
    return rows.length === 1;
  }

  async consume(tx: postgres.TransactionSql, input: { conversation: Conversation; binding: F2RequestBinding; trusted: F2TrustedConversationContext;
    grantId: string; proposalId: string }): Promise<number | null> {
    if (!this.options.enabled) return null;
    const scope = scopeOf(input.conversation), now = this.now();
    const rows = await tx<Receipt[]>`SELECT id,practice_id,instance_id,conversation_id,request_id,request_revision,owner_epoch,verification_id,offer_ttl_ms,expires_at,consumed_proposal_id
      FROM controlled_offer_expiry_receipts WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
        AND conversation_id=${scope.conversationId}::uuid AND request_id=${input.binding.requestId} FOR UPDATE`;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (row.consumed_proposal_id !== null || row.expires_at.getTime() <= now.getTime() || row.request_revision !== input.binding.requestRevision
      || row.owner_epoch !== input.trusted.expectedOwnerEpoch || input.grantId !== `grant-${row.verification_id}` || !this.matches(input.conversation, input.binding)) return null;
    const claimed = await tx<{ id: string }[]>`UPDATE controlled_offer_expiry_receipts SET consumed_proposal_id=${input.proposalId},consumed_at=${now.toISOString()}::timestamptz
      WHERE id=${row.id} AND consumed_at IS NULL RETURNING id`;
    return claimed.length === 1 ? row.offer_ttl_ms : null;
  }

  /** Observation-only E02 receipt. This never creates consent, hearing, or mutation authority. */
  async presented(raw: ControlledOfferPresentation): Promise<boolean> {
    if (!this.options.enabled) return false;
    const input = z.object({ id, scope: conversationScopeSchema, requestId: id, requestRevision: z.number().int().nonnegative(), proposalId: id,
      questionId: id, ownerEpoch: z.number().int().nonnegative(), voiceEpoch: z.number().int().nonnegative(), responseId: id, outputItemId: id }).strict().parse(raw);
    const conversation = await this.options.conversations.get(input.scope);
    const request = conversation?.requests.find((candidate) => candidate.id === input.requestId);
    const question = conversation?.pendingQuestion;
    if (conversation === null || conversation.ownerEpoch !== input.ownerEpoch || conversation.voiceEpoch !== input.voiceEpoch
      || request?.revision !== input.requestRevision || request.state !== "draft" || question?.id !== input.questionId
      || question.kind !== "slot_selection" || question.requestId !== request.id || question.requestRevision !== request.revision
      || !this.matches(conversation, { scope: this.options.dataset, instanceId: input.scope.instanceId, conversationId: input.scope.conversationId,
        requestId: input.requestId, requestRevision: input.requestRevision, observedConversationRevision: conversation.revision })) return false;
    const now = this.now().toISOString();
    const rows = await this.sql<{ id: string }[]>`UPDATE controlled_offer_expiry_receipts SET presented_at=${now}::timestamptz,
      presentation_id=${input.id},presentation_response_id=${input.responseId},presentation_output_item_id=${input.outputItemId}
      WHERE practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND conversation_id=${input.scope.conversationId}::uuid
        AND request_id=${input.requestId} AND request_revision=${input.requestRevision} AND owner_epoch=${input.ownerEpoch}
        AND consumed_proposal_id=${input.proposalId} AND presented_at IS NULL AND expires_at>${now}::timestamptz RETURNING id`;
    return rows.length === 1;
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }

  /** Finite observation of a drained response, not proof of consent or hearing. */
  async drained(input: { scope: ConversationScope; responseId: string; outputItemId: string; ownerEpoch: number; voiceEpoch: number }): Promise<void> {
    if (!this.options.enabled) return;
    const conversation = await this.options.conversations.get(input.scope);
    const question = conversation?.pendingQuestion;
    if (conversation === null || question?.kind !== "slot_selection" || question.requestId === null
      || conversation.ownerEpoch !== input.ownerEpoch || conversation.voiceEpoch !== input.voiceEpoch) return;
    const review = conversation.speechReviews.find((item) => item.responseId === input.responseId && item.outputItemId === input.outputItemId
      && item.voiceEpoch === input.voiceEpoch && item.authorityRevision >= question.activatedRevision && item.correction === "not_required");
    if (review === undefined) return;
    const rows = await this.sql<{ consumed_proposal_id: string }[]>`SELECT consumed_proposal_id FROM controlled_offer_expiry_receipts
      WHERE practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND conversation_id=${input.scope.conversationId}::uuid
        AND request_id=${question.requestId} AND request_revision=${question.requestRevision} AND owner_epoch=${input.ownerEpoch}
        AND consumed_proposal_id IS NOT NULL AND presented_at IS NULL LIMIT 2`;
    if (rows.length !== 1) return;
    const proposalId = rows[0]!.consumed_proposal_id;
    const admissibleReview = review.verdict === "clear" || review.verdict === "suspected"
      && review.reasons.length === 1 && review.reasons[0] === "ambiguous_claim"
      && review.claims.length === 1 && review.claims[0]!.kind === "appointment_changed" && review.claims[0]!.assertion === "uncertain"
      // The assessor returns the declarative offer, while the server-owned
      // transcript also includes the slot-selection question.
      && review.transcript.startsWith(review.claims[0]!.quote);
    // A clear preamble is not the offered slots, including in multi-item audio.
    const permitsPresentation = admissibleReview && await this.options.canonicalOffer?.({ ...input,
      requestId: question.requestId, requestRevision: question.requestRevision!, proposalId, transcript: review.transcript }) === true;
    if (!permitsPresentation) return;
    // `presented` rereads the conversation after the async canonical lookup.
    // It is the durable owner/voice/question fence immediately before the write.
    await this.presented({ ...input, id: review.id, requestId: question.requestId, requestRevision: question.requestRevision!,
      proposalId, questionId: question.id });
  }

  async readPresentation(input: { id: string; scope: ConversationScope }): Promise<{ proposalId: string; expiresAt: string; presentedAt: string; responseId: string; outputItemId: string } | null> {
    const parsed = z.object({ id, scope: conversationScopeSchema }).strict().parse(input);
    const rows = await this.sql<{ proposal_id: string; expires_at: Date; presented_at: Date; response_id: string; output_item_id: string }[]>`
      SELECT receipt.consumed_proposal_id AS proposal_id,evidence.expires_at,receipt.presented_at,
        receipt.presentation_response_id AS response_id,receipt.presentation_output_item_id AS output_item_id
      FROM controlled_offer_expiry_receipts receipt JOIN synthetic_evidence evidence ON evidence.evidence_id=receipt.consumed_proposal_id
        AND evidence.practice_id=receipt.practice_id AND evidence.instance_id=receipt.instance_id
        AND evidence.conversation_id=receipt.conversation_id AND evidence.request_id=receipt.request_id AND evidence.kind='proposal'
      WHERE receipt.id=${parsed.id} AND receipt.practice_id=${parsed.scope.practiceId} AND receipt.instance_id=${parsed.scope.instanceId}
        AND receipt.conversation_id=${parsed.scope.conversationId}::uuid AND receipt.presented_at IS NOT NULL
        AND evidence.dataset_id=${this.options.dataset.datasetId} AND evidence.generation=${this.options.dataset.generation}
        AND receipt.presented_at<evidence.expires_at LIMIT 2`;
    const row = rows.length === 1 ? rows[0] : undefined;
    return row === undefined ? null : { proposalId: row.proposal_id, expiresAt: row.expires_at.toISOString(), presentedAt: row.presented_at.toISOString(),
      responseId: row.response_id, outputItemId: row.output_item_id };
  }

  private authority(conversation: Conversation, scope: ConversationScope, requestId: string): { binding: F2RequestBinding } | null {
    if (!this.matches(conversation, { scope: this.options.dataset, instanceId: scope.instanceId,
      conversationId: scope.conversationId, requestId, requestRevision: -1, observedConversationRevision: conversation.revision })) return null;
    const request = conversation.requests.find((candidate) => candidate.id === requestId);
    if (request === undefined || request.state !== "draft" || request.fullProposal?.capability !== "appointment_reschedule" && request.fullProposal?.capability !== "appointment_schedule") return null;
    const question = conversation.pendingQuestion;
    if (question?.kind !== "identity_zip" || question.requestId !== request.id || question.requestRevision !== request.revision) return null;
    return { binding: { scope: this.options.dataset, instanceId: scope.instanceId,
      conversationId: scope.conversationId, requestId, observedConversationRevision: conversation.revision, requestRevision: request.revision } };
  }

  private matches(conversation: Conversation, binding: F2RequestBinding): boolean {
    const admission = conversation.admission, request = conversation.requests.find((candidate) => candidate.id === binding.requestId);
    return admission.practiceId === this.instance.practiceId && admission.instanceId === this.instance.instanceId && admission.accountId === this.instance.accountId
      && admission.configVersion === this.instance.configVersion && admission.mode === "full" && admission.channel === "voice" && admission.provider === "twilio"
      && admission.controlledHours !== null && admission.controlledHours.fixtureId.startsWith("fixture_") && conversation.providerTier === "realtime"
      && conversation.phase === "active" && conversation.owner === "ai" && !conversation.suppressed && conversation.emergency === null
      && request !== undefined && request.state === "draft" && (binding.requestRevision < 0 || request.revision === binding.requestRevision);
  }

  private async confirmedRendezvous(conversation: Conversation): Promise<boolean> {
    const controlled = conversation.admission.controlledHours;
    if (controlled === null || !controlled.fixtureId.startsWith("fixture_")) return false;
    const attemptId = controlled.fixtureId.slice("fixture_".length);
    const scope = scopeOf(conversation);
    const rows = await this.sql<{ id: string }[]>`SELECT id FROM controlled_voice_rendezvous_attempts
      WHERE id=${attemptId} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
        AND conversation_id=${scope.conversationId}::uuid AND bound_parent_call_id=${controlled.parentCallId}
        AND state IN ('confirmed','redirected') LIMIT 2`;
    return rows.length === 1;
  }
}

/** Matches the established exact-proposal comparison, including a safe Pacific-zone synonym. */
export function equivalentCanonicalOfferTranscript(actual: string, expected: string): boolean {
  const normalizedActual = normalizeProposalTranscript(actual), normalizedExpected = normalizeProposalTranscript(expected);
  if (normalizedActual === normalizedExpected) return true;
  const actualZones = proposalTimeZones(normalizedActual), expectedZones = proposalTimeZones(normalizedExpected);
  if (actualZones === null || expectedZones === null || actualZones.length !== expectedZones.length
    || stripProposalTimeZones(normalizedActual) !== stripProposalTimeZones(normalizedExpected)) return false;
  return actualZones.every((actualZone, index) => equivalentPacificTimeZone(actualZone, expectedZones[index]!, normalizedExpected, index));
}

function normalizeProposalTranscript(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/['"\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[!?;,\u2026\u2013\u2014]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, "")
    .replace(/\b(\d{1,2}):00(?=\s*(?:am|pm)\b)/g, "$1")
    .replace(/\s+/g, " ").trim();
}

function proposalTimeZones(value: string): ("pacific" | "pst" | "pdt")[] | null {
  const zones = [...value.matchAll(/\b(pacific(?: time)?|pst|pdt)\b/g)].map((match) => match[1]!.replace(" time", ""));
  return zones.length > 0 && zones.every((zone) => zone === "pacific" || zone === "pst" || zone === "pdt")
    ? zones as ("pacific" | "pst" | "pdt")[] : null;
}
function stripProposalTimeZones(value: string): string { return value.replace(/\b(pacific(?: time)?|pst|pdt)\b/g, "<timezone>"); }
function equivalentPacificTimeZone(actual: "pacific" | "pst" | "pdt", expected: "pacific" | "pst" | "pdt", text: string, occurrence: number): boolean {
  if (actual === expected) return true;
  if (actual !== "pacific" && expected !== "pacific") return false;
  const zone = [...text.matchAll(/\b(pacific(?: time)?|pst|pdt)\b/g)][occurrence];
  if (zone === undefined || zone.index === undefined) return false;
  const dates = [...text.slice(0, zone.index).matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/g)];
  const match = dates[dates.length - 1];
  if (match === undefined) return false;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1]!);
  const day = Number(match[2]), year = Number(match[3]);
  if (month < 0 || !Number.isInteger(day) || !Number.isInteger(year)
    || new Date(Date.UTC(year, month, day)).getUTCDate() !== day) return false;
  const zoneNames = [8, 20].map((hour) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", timeZoneName: "short" })
    .formatToParts(new Date(Date.UTC(year, month, day, hour))).find((part) => part.type === "timeZoneName")?.value.toLowerCase());
  return zoneNames[0] === zoneNames[1] && (actual === "pacific" ? expected : actual) === zoneNames[0];
}
