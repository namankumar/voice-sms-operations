import postgres from "postgres";
import { z } from "zod";

import { conversationScopeSchema, scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { fullAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";

const maxTtlMs = 15 * 60_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const provisionSchema = z.object({
  id,
  scope: conversationScopeSchema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
const cancellationSchema = z.object({ id, scope: conversationScopeSchema }).strict();

type FailureRow = {
  id: string;
  practice_id: string;
  instance_id: string;
  conversation_id: string;
  config_version: string;
  request_id: string;
  request_revision: number;
  question_id: string;
  question_activated_revision: number;
  owner_epoch: number;
  armed_after_revision: number;
  expires_at: Date;
  consumed_source_id: string | null;
};

type ArmedCallback = {
  requestId: string;
  requestRevision: number;
  questionId: string;
  questionActivatedRevision: number;
  ownerEpoch: number;
  armedAfterRevision: number;
};

/** Synthetic-only, durable P07 fault control. It never receives callback content. */
export class PostgresControlledCallbackSaveFailures {
  private readonly sql: ReturnType<typeof postgres>;
  private readonly instance;
  private readonly now: () => Date;

  constructor(databaseUrl: string, private readonly options: {
    instance: VoiceAppInstance;
    conversations: Pick<ConversationStore, "get">;
    enabled: boolean;
    now?: () => Date;
  }) {
    this.instance = fullAppInstanceSchema.parse(options.instance);
    if (this.instance.dataMode !== "synthetic_only") throw new Error("controlled_callback_failure_synthetic_full_only");
    this.now = options.now ?? (() => new Date());
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-callback-failure" } });
  }

  async provision(raw: { id: string; scope: ConversationScope; expiresAt: string }, signal?: AbortSignal): Promise<void> {
    if (!this.options.enabled) throw new Error("controlled_callback_failure_disabled");
    const input = provisionSchema.parse(raw);
    const now = this.now().getTime(), expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= now || expires - now > maxTtlMs) throw new Error("controlled_callback_failure_expiry_invalid");
    this.throwIfAborted(signal);
    const conversation = await this.options.conversations.get(input.scope);
    this.throwIfAborted(signal);
    const armed = conversation === null ? null : this.armed(conversation, input.scope);
    if (armed === null) throw new Error("controlled_callback_failure_not_armable");
    await this.sql.begin(async (tx) => {
      this.throwIfAborted(signal);
      // Lock before recording the fence. A source committed after this point waits;
      // one committed before it makes the sampled durable revision stale.
      await this.lockRevision(tx, input.scope, conversation!.revision);
      this.throwIfAborted(signal);
      const rows = await tx<{ id: string }[]>`INSERT INTO controlled_callback_save_failures(
        id,practice_id,instance_id,conversation_id,config_version,request_id,request_revision,question_id,
        question_activated_revision,owner_epoch,armed_after_revision,expires_at
      ) VALUES (
        ${input.id},${input.scope.practiceId},${input.scope.instanceId},${input.scope.conversationId}::uuid,
        ${conversation!.admission.configVersion},${armed.requestId},${armed.requestRevision},${armed.questionId},
        ${armed.questionActivatedRevision},${armed.ownerEpoch},${armed.armedAfterRevision},${input.expiresAt}::timestamptz
      ) ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
        WHERE controlled_callback_save_failures.practice_id=EXCLUDED.practice_id
          AND controlled_callback_save_failures.instance_id=EXCLUDED.instance_id
          AND controlled_callback_save_failures.conversation_id=EXCLUDED.conversation_id
          AND controlled_callback_save_failures.config_version=EXCLUDED.config_version
          AND controlled_callback_save_failures.request_id=EXCLUDED.request_id
          AND controlled_callback_save_failures.request_revision=EXCLUDED.request_revision
          AND controlled_callback_save_failures.question_id=EXCLUDED.question_id
          AND controlled_callback_save_failures.question_activated_revision=EXCLUDED.question_activated_revision
          AND controlled_callback_save_failures.owner_epoch=EXCLUDED.owner_epoch
          AND controlled_callback_save_failures.armed_after_revision=EXCLUDED.armed_after_revision
          AND controlled_callback_save_failures.expires_at=EXCLUDED.expires_at
      RETURNING id`;
      this.throwIfAborted(signal);
      if (rows.length !== 1) throw new Error("controlled_callback_failure_provision_conflict");
      // This is the final abort fence before postgres commits this transaction.
      this.throwIfAborted(signal);
    });
    if (signal?.aborted) {
      // An abort observed after commit must make the durable fixture inert before
      // provision rejects. Do not use the aborted signal for this cleanup.
      await this.cancel({ id: input.id, scope: input.scope });
      throw new Error("controlled_callback_failure_provision_aborted");
    }
  }

  /**
   * Expires one pending fixture under the same conversation-then-fixture lock order.
   * This remains available while the control is disabled so abort and shutdown cleanup
   * can make an already-created fixture inert.
   */
  async cancel(raw: { id: string; scope: ConversationScope }): Promise<boolean> {
    const input = cancellationSchema.parse(raw);
    if (input.scope.practiceId !== this.instance.practiceId || input.scope.instanceId !== this.instance.instanceId) return false;
    const cancelledAt = this.now().toISOString();
    return await this.sql.begin(async (tx) => {
      await this.lockRevision(tx, input.scope);
      const rows = await tx<{ id: string }[]>`SELECT id FROM controlled_callback_save_failures
        WHERE id=${input.id} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId}
          AND conversation_id=${input.scope.conversationId}::uuid AND config_version=${this.instance.configVersion}
        FOR UPDATE`;
      if (rows.length !== 1) return false;
      const cancelled = await tx<{ id: string }[]>`UPDATE controlled_callback_save_failures
        SET expires_at=${cancelledAt}::timestamptz
        WHERE id=${input.id} AND consumed_at IS NULL AND expires_at > ${cancelledAt}::timestamptz
        RETURNING id`;
      return cancelled.length === 1;
    });
  }

  async consume(input: { conversation: Conversation; sourceId: string; requestId: string }): Promise<boolean> {
    if (!this.options.enabled || !id.safeParse(input.sourceId).success || !id.safeParse(input.requestId).success) return false;
    const scope = scopeOf(input.conversation);
    return await this.sql.begin(async (tx) => {
      const lockedRevision = await this.lockRevision(tx, scope);
      const rows = await tx<FailureRow[]>`SELECT id,practice_id,instance_id,conversation_id,config_version,request_id,request_revision,
          question_id,question_activated_revision,owner_epoch,armed_after_revision,expires_at,consumed_source_id
        FROM controlled_callback_save_failures
        WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}::uuid
          AND request_id=${input.requestId}
        FOR UPDATE`;
      if (rows.length !== 1) return false;
      const row = rows[0]!;
      // A retry of the exact source must retain the recorded controlled outcome,
      // including after fixture expiry or a process restart.
      if (row.consumed_source_id === input.sourceId) return true;
      if (row.consumed_source_id !== null || row.expires_at.getTime() <= this.now().getTime()) return false;
      const current = await this.options.conversations.get(scope);
      if (current === null || current.revision !== lockedRevision || !this.matches(row, current, input.sourceId)) return false;
      const claimed = await tx<{ id: string }[]>`UPDATE controlled_callback_save_failures
        SET consumed_source_id=${input.sourceId},consumed_at=${this.now().toISOString()}::timestamptz
        WHERE id=${row.id} AND consumed_at IS NULL
        RETURNING id`;
      return claimed.length === 1;
    });
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("controlled_callback_failure_provision_aborted");
  }

  /** All paths take the conversation lock before the fixture row lock. */
  private async lockRevision(tx: postgres.TransactionSql, scope: ConversationScope, expected?: number): Promise<number> {
    const rows = await tx<{ revision: number }[]>`SELECT revision FROM voice_sms_conversations
      WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}::uuid FOR UPDATE`;
    const revision = rows[0]?.revision;
    if (revision === undefined) throw new Error("controlled_callback_failure_conversation_missing");
    if (expected !== undefined && revision !== expected) throw new Error("controlled_callback_failure_provision_stale");
    return revision;
  }

  private armed(conversation: Conversation, scope: ConversationScope): ArmedCallback | null {
    if (!this.matchesInstance(conversation, scope)) return null;
    const question = conversation.pendingQuestion;
    if (question?.kind !== "callback_number" || question.requestId === null || question.requestRevision === null || question.callbackNumber === null) return null;
    const request = conversation.requests.find((candidate) => candidate.id === question.requestId);
    if (request === undefined || request.revision !== question.requestRevision || request.state !== "draft" || request.callbackConfirmed
      || request.name.trim().length === 0 || request.callbackNumber !== question.callbackNumber) return null;
    const messageSourceId = request.callbackMessageSourceId;
    if (messageSourceId === null || messageSourceId === undefined || !request.sourceIds.includes(messageSourceId)
      || !conversation.inputs.some((source) => source.id === messageSourceId)) return null;
    return { requestId: request.id, requestRevision: request.revision, questionId: question.id,
      questionActivatedRevision: question.activatedRevision, ownerEpoch: conversation.ownerEpoch, armedAfterRevision: conversation.revision };
  }

  private matches(row: FailureRow, conversation: Conversation, sourceId: string): boolean {
    const scope = { practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.conversation_id };
    const armed = this.armed(conversation, scope);
    const source = conversation.inputs.at(-1);
    return armed !== null && conversation.admission.configVersion === row.config_version
      && armed.requestId === row.request_id && armed.requestRevision === row.request_revision
      && armed.questionId === row.question_id && armed.questionActivatedRevision === row.question_activated_revision
      && armed.ownerEpoch === row.owner_epoch && source !== undefined && source.id === sourceId
      && source.questionId === row.question_id && source.sequence > row.armed_after_revision
      && source.sequence > row.question_activated_revision;
  }

  private matchesInstance(conversation: Conversation, scope: ConversationScope): boolean {
    const admission = conversation.admission;
    return scopeOf(conversation).practiceId === scope.practiceId && scopeOf(conversation).instanceId === scope.instanceId
      && scopeOf(conversation).conversationId === scope.conversationId
      && admission.practiceId === this.instance.practiceId && admission.instanceId === this.instance.instanceId
      && admission.accountId === this.instance.accountId && admission.configVersion === this.instance.configVersion
      && admission.mode === "full" && admission.provider === "twilio" && admission.messageTransport === "sms"
      && admission.channel === "voice" && admission.destination === this.instance.numberBinding.sourceNumberE164
      && this.instance.numberBinding.channels.includes("voice") && conversation.providerTier === "realtime"
      && conversation.phase === "active" && conversation.owner === "ai" && !conversation.suppressed
      && conversation.emergency === null && conversation.transfers.length === 0;
  }
}
