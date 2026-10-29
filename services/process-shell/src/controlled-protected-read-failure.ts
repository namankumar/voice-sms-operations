import postgres from "postgres";
import { z } from "zod";

import { conversationScopeSchema, scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { fullAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";

const maxTtlMs = 150_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const provisionSchema = z.object({ id, scope: conversationScopeSchema, expiresAt: z.string().datetime({ offset: true }) }).strict();
const cancellationSchema = z.object({ id, scope: conversationScopeSchema }).strict();

type FailureRow = { id: string; config_version: string; request_id: string; request_revision: number; question_id: string; question_activated_revision: number; owner_epoch: number; voice_epoch: number; armed_after_revision: number; expires_at: Date; consumed_source_id: string | null };

export type ControlledProtectedReadFailurePort = {
  consume(input: { conversation: Conversation; sourceId: string; requestId: string; readKind: "appointment_details" | "referral_status" | "billing_balance" }): Promise<boolean>;
};

/** Synthetic-only, one-shot failure immediately before an otherwise authorized appointment-details read. */
export class PostgresControlledProtectedReadFailure implements ControlledProtectedReadFailurePort {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly instance: VoiceAppInstance;
  private readonly now: () => Date;

  constructor(databaseUrl: string, private readonly options: { instance: VoiceAppInstance; conversations: Pick<ConversationStore, "get">; enabled: boolean; now?: () => Date }) {
    this.instance = fullAppInstanceSchema.parse(options.instance);
    if (this.instance.mode !== "full" || this.instance.dataMode !== "synthetic_only") throw new Error("controlled_protected_read_failure_synthetic_full_only");
    this.now = options.now ?? (() => new Date());
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-protected-read-failure" } });
  }

  async ready(): Promise<void> {
    const rows = await this.sql<{ present: string | null }[]>`SELECT to_regclass('public.controlled_protected_read_failures')::text AS present`;
    if (rows[0]?.present === null || rows[0] === undefined) throw new Error("controlled_protected_read_failure_schema_not_ready");
  }

  async provision(raw: { id: string; scope: ConversationScope; expiresAt: string }, signal?: AbortSignal): Promise<void> {
    if (!this.options.enabled) throw new Error("controlled_protected_read_failure_disabled");
    const input = provisionSchema.parse(raw);
    const expires = Date.parse(input.expiresAt), now = this.now().getTime();
    if (!Number.isFinite(expires) || expires <= now || expires - now > maxTtlMs) throw new Error("controlled_protected_read_failure_expiry_invalid");
    this.throwIfAborted(signal);
    const conversation = await this.options.conversations.get(input.scope);
    this.throwIfAborted(signal);
    const armed = conversation === null ? null : this.armed(conversation, input.scope);
    if (armed === null) throw new Error("controlled_protected_read_failure_not_armable");
    await this.sql.begin(async (tx) => {
      await this.lockRevision(tx, input.scope, conversation!.revision);
      this.throwIfAborted(signal);
      if (!await this.rendezvousBound(tx, input.scope, conversation!)) throw new Error("controlled_protected_read_failure_admission_required");
      const rows = await tx<{ id: string }[]>`INSERT INTO controlled_protected_read_failures(id,practice_id,instance_id,conversation_id,config_version,request_id,request_revision,question_id,question_activated_revision,owner_epoch,voice_epoch,armed_after_revision,expires_at) VALUES (${input.id},${input.scope.practiceId},${input.scope.instanceId},${input.scope.conversationId}::uuid,${conversation!.admission.configVersion},${armed.requestId},${armed.requestRevision},${armed.questionId},${armed.questionActivatedRevision},${armed.ownerEpoch},${armed.voiceEpoch},${armed.armedAfterRevision},${input.expiresAt}::timestamptz) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE controlled_protected_read_failures.practice_id=EXCLUDED.practice_id AND controlled_protected_read_failures.instance_id=EXCLUDED.instance_id AND controlled_protected_read_failures.conversation_id=EXCLUDED.conversation_id AND controlled_protected_read_failures.config_version=EXCLUDED.config_version AND controlled_protected_read_failures.request_id=EXCLUDED.request_id AND controlled_protected_read_failures.request_revision=EXCLUDED.request_revision AND controlled_protected_read_failures.question_id=EXCLUDED.question_id AND controlled_protected_read_failures.question_activated_revision=EXCLUDED.question_activated_revision AND controlled_protected_read_failures.owner_epoch=EXCLUDED.owner_epoch AND controlled_protected_read_failures.voice_epoch=EXCLUDED.voice_epoch AND controlled_protected_read_failures.armed_after_revision=EXCLUDED.armed_after_revision AND controlled_protected_read_failures.expires_at=EXCLUDED.expires_at RETURNING id`;
      if (rows.length !== 1) throw new Error("controlled_protected_read_failure_provision_conflict");
      this.throwIfAborted(signal);
    });
    if (signal?.aborted) { await this.cancel({ id: input.id, scope: input.scope }); throw new Error("controlled_protected_read_failure_provision_aborted"); }
  }

  async consume(input: Parameters<ControlledProtectedReadFailurePort["consume"]>[0]): Promise<boolean> {
    if (!this.options.enabled || input.readKind !== "appointment_details" || !id.safeParse(input.sourceId).success || !id.safeParse(input.requestId).success) return false;
    const scope = scopeOf(input.conversation);
    return await this.sql.begin(async (tx) => {
      const revision = await this.lockRevision(tx, scope);
      const rows = await tx<FailureRow[]>`SELECT id,config_version,request_id,request_revision,question_id,question_activated_revision,owner_epoch,voice_epoch,armed_after_revision,expires_at,consumed_source_id FROM controlled_protected_read_failures WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}::uuid AND request_id=${input.requestId} FOR UPDATE`;
      if (rows.length !== 1) return false;
      const row = rows[0]!;
      const current = await this.options.conversations.get(scope);
      if (current === null || current.revision !== revision || !await this.matches(tx, row, current, input.sourceId)) return false;
      if (row.consumed_source_id === input.sourceId) return true;
      if (row.consumed_source_id !== null || row.expires_at.getTime() <= this.now().getTime()) return false;
      const claimed = await tx<{ id: string }[]>`UPDATE controlled_protected_read_failures SET consumed_source_id=${input.sourceId},consumed_at=${this.now().toISOString()}::timestamptz WHERE id=${row.id} AND consumed_at IS NULL RETURNING id`;
      return claimed.length === 1;
    });
  }

  async cancel(raw: { id: string; scope: ConversationScope }): Promise<boolean> {
    const input = cancellationSchema.parse(raw);
    if (input.scope.practiceId !== this.instance.practiceId || input.scope.instanceId !== this.instance.instanceId) return false;
    return await this.sql.begin(async (tx) => {
      await this.lockRevision(tx, input.scope);
      const rows = await tx<{ id: string }[]>`UPDATE controlled_protected_read_failures SET expires_at=${this.now().toISOString()}::timestamptz WHERE id=${input.id} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND conversation_id=${input.scope.conversationId}::uuid AND consumed_at IS NULL AND expires_at>${this.now().toISOString()}::timestamptz RETURNING id`;
      return rows.length === 1;
    });
  }
  async read(raw: { id: string; scope: ConversationScope }): Promise<{ consumedSourceId: string | null; expiresAt: string } | null> {
    const input = cancellationSchema.parse(raw);
    const rows = await this.sql<{ consumed_source_id: string | null; expires_at: Date }[]>`SELECT consumed_source_id,expires_at FROM controlled_protected_read_failures WHERE id=${input.id} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND conversation_id=${input.scope.conversationId}::uuid`;
    const row = rows[0];
    return row === undefined ? null : { consumedSourceId: row.consumed_source_id, expiresAt: row.expires_at.toISOString() };
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }

  private throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("controlled_protected_read_failure_provision_aborted"); }
  private async lockRevision(tx: postgres.TransactionSql, scope: ConversationScope, expected?: number): Promise<number> {
    const rows = await tx<{ revision: number }[]>`SELECT revision FROM voice_sms_conversations WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}::uuid FOR UPDATE`;
    const revision = rows[0]?.revision;
    if (revision === undefined) throw new Error("controlled_protected_read_failure_conversation_missing");
    if (expected !== undefined && revision !== expected) throw new Error("controlled_protected_read_failure_provision_stale");
    return revision;
  }
  private armed(conversation: Conversation, scope: ConversationScope) {
    if (!this.matchesInstance(conversation, scope)) return null;
    const question = conversation.pendingQuestion;
    if (question?.kind !== "identity_zip" || question.requestId === null || question.requestRevision === null) return null;
    const request = conversation.requests.find((candidate) => candidate.id === question.requestId);
    if (request === undefined || request.revision !== question.requestRevision || request.state !== "draft" || request.fullProposal?.capability !== "appointment_details") return null;
    return { requestId: request.id, requestRevision: request.revision, questionId: question.id, questionActivatedRevision: question.activatedRevision, ownerEpoch: conversation.ownerEpoch, voiceEpoch: conversation.voiceEpoch, armedAfterRevision: conversation.revision };
  }
  private async matches(tx: postgres.TransactionSql, row: FailureRow, conversation: Conversation, sourceId: string): Promise<boolean> {
    if (!this.matchesInstance(conversation, scopeOf(conversation)) || conversation.admission.configVersion !== row.config_version || conversation.phase !== "active" || conversation.owner !== "ai" || conversation.ownerEpoch !== row.owner_epoch || conversation.voiceEpoch !== row.voice_epoch) return false;
    const request = conversation.requests.find((candidate) => candidate.id === row.request_id), source = conversation.inputs.at(-1);
    return await this.rendezvousBound(tx, scopeOf(conversation), conversation) && request?.revision === row.request_revision && request.state === "draft" && request.fullProposal?.capability === "appointment_details"
      && source?.id === sourceId && source.questionId === row.question_id && source.sequence > row.question_activated_revision && source.sequence > row.armed_after_revision;
  }
  /** Durable operator admission binds this conversation to its exact signed fixture and rendezvous attempt. */
  private async rendezvousBound(tx: postgres.TransactionSql, scope: ConversationScope, conversation: Conversation): Promise<boolean> {
    const fixtureId = conversation.admission.controlledHours?.fixtureId;
    if (fixtureId === null || fixtureId === undefined) return false;
    const rows = await tx<{ id: string }[]>`SELECT attempt.id FROM controlled_voice_rendezvous_attempts attempt JOIN controlled_synthetic_voice_fixtures fixture ON fixture.id=${fixtureId} AND fixture.practice_id=attempt.practice_id AND fixture.instance_id=attempt.instance_id AND fixture.conversation_id=attempt.conversation_id WHERE attempt.practice_id=${scope.practiceId} AND attempt.instance_id=${scope.instanceId} AND attempt.conversation_id=${scope.conversationId}::uuid AND attempt.state IN ('confirmed','redirected') AND ${fixtureId}=('fixture_' || attempt.id) FOR UPDATE OF attempt,fixture`;
    return rows.length === 1;
  }
  private matchesInstance(conversation: Conversation, scope: ConversationScope): boolean {
    const admission = conversation.admission;
    return scopeOf(conversation).practiceId === scope.practiceId && scopeOf(conversation).instanceId === scope.instanceId && scopeOf(conversation).conversationId === scope.conversationId
      && admission.practiceId === this.instance.practiceId && admission.instanceId === this.instance.instanceId && admission.accountId === this.instance.accountId && admission.configVersion === this.instance.configVersion
      && admission.mode === "full" && admission.provider === "twilio" && admission.messageTransport === "sms" && admission.channel === "voice" && admission.destination === this.instance.numberBinding.sourceNumberE164 && admission.controlledHours !== null
      && this.instance.numberBinding.channels.includes("voice") && conversation.providerTier === "realtime" && !conversation.suppressed && conversation.emergency === null && conversation.transfers.length === 0;
  }
}
