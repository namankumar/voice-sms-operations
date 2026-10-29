import postgres from "postgres";
import { z } from "zod";

import { conversationSchema, type Conversation } from "./conversation-contract.js";
import { ConversationCipher } from "./conversation-store.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const receiptTtlMs = 150_000;
const scopeSchema = z.object({ practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200) }).strict();
type ControlScope = z.infer<typeof scopeSchema>;
const bindingSchema = z.object({ attemptId: id, scope: scopeSchema }).strict();

export type ControlledActionConfirmationFailurePort = {
  ready(): Promise<void>;
  provision(input: { attemptId: string; scope: ControlScope; expiresAt: string }): Promise<void>;
  consume(input: { attemptId: string; scope: ControlScope; conversationId: string; requestId: string; actionReceiptId: string; ownerEpoch: number; voiceEpoch: number }): Promise<boolean>;
  read(input: { attemptId: string; scope: ControlScope }): Promise<{ state: "pending" | "consumed" | "inconclusive"; requestId: string | null; actionReceiptId: string | null; ownerEpoch: number | null; voiceEpoch: number | null } | null>;
  cancel(input: { attemptId: string; scope: ControlScope }): Promise<boolean>;
  close(): Promise<void>;
};

/** Synthetic-only E04 receipt. It has no discovery query and never carries caller content. */
export class PostgresControlledActionConfirmationFailure implements ControlledActionConfirmationFailurePort {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher) {
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-action-confirmation-failure" } });
  }

  private decode(row: { practice_id: string; instance_id: string; conversation_id: string; revision: number; protected_state: unknown }): Conversation {
    return conversationSchema.parse(this.cipher.unprotect(row.protected_state, {
      practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.conversation_id,
      revision: row.revision, eventId: "snapshot", schemaVersion: 1,
    }));
  }

  async ready(): Promise<void> {
    const tables = await this.sql<{ present: string | null }[]>`SELECT to_regclass('public.' || name)::text AS present FROM unnest(ARRAY['controlled_voice_rendezvous_attempts','controlled_action_confirmation_failure_receipts']) AS name`;
    if (tables.length !== 2 || tables.some((table) => table.present === null)) throw new Error("controlled_action_confirmation_failure_schema_not_ready");
  }

  async provision(raw: Parameters<ControlledActionConfirmationFailurePort["provision"]>[0]): Promise<void> {
    const input = z.object({ attemptId: id, scope: scopeSchema, expiresAt: z.string().datetime({ offset: true }) }).strict().parse(raw);
    const expires = Date.parse(input.expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now() || expires - Date.now() > receiptTtlMs) throw new Error("controlled_action_confirmation_failure_expiry_invalid");
    await this.sql.begin(async (tx) => {
      const binding = await tx<{ conversation_id: string | null }[]>`SELECT conversation_id FROM controlled_voice_rendezvous_attempts WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND state IN ('confirmed','redirected') FOR UPDATE`;
      const conversationId = binding[0]?.conversation_id;
      if (conversationId === null || conversationId === undefined) throw new Error("controlled_action_confirmation_failure_binding_required");
      const rows = await tx<{ attempt_id: string }[]>`INSERT INTO controlled_action_confirmation_failure_receipts(attempt_id,practice_id,instance_id,conversation_id,expires_at) VALUES (${input.attemptId},${input.scope.practiceId},${input.scope.instanceId},${conversationId}::uuid,${input.expiresAt}::timestamptz) ON CONFLICT (attempt_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id WHERE controlled_action_confirmation_failure_receipts.practice_id=EXCLUDED.practice_id AND controlled_action_confirmation_failure_receipts.instance_id=EXCLUDED.instance_id AND controlled_action_confirmation_failure_receipts.conversation_id=EXCLUDED.conversation_id AND controlled_action_confirmation_failure_receipts.expires_at=EXCLUDED.expires_at RETURNING attempt_id`;
      if (rows.length !== 1) throw new Error("controlled_action_confirmation_failure_provision_conflict");
    });
  }

  async consume(raw: Parameters<ControlledActionConfirmationFailurePort["consume"]>[0]): Promise<boolean> {
    const input = z.object({ attemptId: id, scope: scopeSchema, conversationId: z.string().uuid(), requestId: id, actionReceiptId: id, ownerEpoch: z.number().int().nonnegative(), voiceEpoch: z.number().int().nonnegative() }).strict().parse(raw);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ practice_id: string; instance_id: string; conversation_id: string; revision: number; protected_state: unknown }[]>`SELECT conversation.practice_id,conversation.instance_id,conversation.id AS conversation_id,conversation.revision,conversation.protected_state FROM controlled_action_confirmation_failure_receipts receipt JOIN controlled_voice_rendezvous_attempts attempt ON attempt.id=receipt.attempt_id JOIN voice_sms_conversations conversation ON conversation.practice_id=receipt.practice_id AND conversation.instance_id=receipt.instance_id AND conversation.id=receipt.conversation_id WHERE receipt.attempt_id=${input.attemptId} AND receipt.practice_id=${input.scope.practiceId} AND receipt.instance_id=${input.scope.instanceId} AND receipt.conversation_id=${input.conversationId}::uuid AND attempt.conversation_id=receipt.conversation_id AND attempt.state IN ('confirmed','redirected') AND receipt.state='pending' AND receipt.expires_at>now() FOR UPDATE OF receipt,conversation`;
      const row = rows[0];
      if (row === undefined) return false;
      const state = this.decode(row), request = state.requests.find((candidate) => candidate.id === input.requestId);
      if (state.phase !== "active" || state.owner !== "ai" || state.suppressed || state.emergency !== null || state.ownerEpoch !== input.ownerEpoch || state.voiceEpoch !== input.voiceEpoch || request?.state !== "ai_resolved" || request.aiResolution?.kind !== "action" || request.aiResolution.operation !== "reschedule" || request.aiResolution.receiptId !== input.actionReceiptId) return false;
      const consumed = await tx<{ attempt_id: string }[]>`UPDATE controlled_action_confirmation_failure_receipts SET state='consumed',request_id=${input.requestId},action_receipt_id=${input.actionReceiptId},owner_epoch=${input.ownerEpoch},voice_epoch=${input.voiceEpoch},consumed_at=now() WHERE attempt_id=${input.attemptId} AND state='pending' RETURNING attempt_id`;
      return consumed.length === 1;
    });
  }

  async read(raw: Parameters<ControlledActionConfirmationFailurePort["read"]>[0]) {
    const input = bindingSchema.parse(raw);
    const rows = await this.sql<{ state: "pending" | "consumed" | "inconclusive"; request_id: string | null; action_receipt_id: string | null; owner_epoch: number | null; voice_epoch: number | null }[]>`SELECT state,request_id,action_receipt_id,owner_epoch,voice_epoch FROM controlled_action_confirmation_failure_receipts WHERE attempt_id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId}`;
    const row = rows[0]; return row === undefined ? null : { state: row.state, requestId: row.request_id, actionReceiptId: row.action_receipt_id, ownerEpoch: row.owner_epoch, voiceEpoch: row.voice_epoch };
  }

  async cancel(raw: Parameters<ControlledActionConfirmationFailurePort["cancel"]>[0]): Promise<boolean> {
    const input = bindingSchema.parse(raw);
    const rows = await this.sql<{ attempt_id: string }[]>`UPDATE controlled_action_confirmation_failure_receipts SET state='inconclusive' WHERE attempt_id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND state='pending' RETURNING attempt_id`;
    return rows.length === 1;
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}
