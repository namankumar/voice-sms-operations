import postgres from "postgres";
import { z } from "zod";

import { ConversationCipher } from "./conversation-store.js";

const callSid = z.string().regex(/^CA[a-fA-F0-9]{32}$/);
const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);
const timestamp = z.string().datetime({ offset: true });
const streamSchema = z.object({ streamSid: bounded(200), reservationId: bounded(200), sourceCommit: bounded(80), model: bounded(120), deploymentId: bounded(200) }).strict();
const safeString = bounded(1_000);
const safeNumber = z.number().finite();
/** Flat, bounded diagnostic metadata only; transcript text has its own encrypted field. */
const payloadSchema = z.object({
  type: safeString.optional(), start_ms: safeNumber.optional(), end_ms: safeNumber.optional(), clock: safeString.optional(), scope: safeString.optional(), source: safeString.optional(), errorClass: safeString.optional(), action: safeString.optional(),
  markEpoch: safeNumber.optional(), totalOutputBytes: safeNumber.optional(), playedMarkBytes: safeNumber.optional(), clearedThroughBytes: safeNumber.optional(), pendingMarkCount: safeNumber.optional(), lastNonFFByteEnd: safeNumber.nullable().optional(), markId: safeString.optional(),
  serverMonotonicMs: safeNumber.optional(), evidenceMeaning: safeString.optional(), asrReceiptToMediaSentMs: safeNumber.nonnegative().optional(), timingPrecision: safeString.optional(), timingOrigin: safeString.optional(),
  saved: z.boolean().optional(), requestId: safeString.optional(), name: safeString.optional(), callId: safeString.optional(), status: safeString.optional(), transferId: safeString.optional(),
}).strict();
const deliverySchema = z.object({
  state: z.enum(["generated", "played", "interrupted", "unknown"]), timingPrecision: z.enum(["exact", "estimated", "unavailable"]),
  markId: bounded(240).optional(), playedAt: timestamp.optional(), interruptedAt: timestamp.optional(), interruptionReason: bounded(200).optional(),
}).strict().superRefine((value, context) => {
  if (value.state === "played" && (value.markId === undefined || value.playedAt === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_delivery_played_evidence_missing" });
  if (value.state === "interrupted" && value.interruptedAt === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_delivery_interruption_evidence_missing" });
});
const carrierPlaybackSchema = z.object({
  /** Transport receipt only. It never establishes that audio reached a handset. */
  type: z.literal("carrier_playback/v1"),
  action: z.enum(["media_sent", "mark_queued", "mark_ack", "clear_sent"]),
  byteBoundary: z.object({ totalOutputBytes: z.number().int().nonnegative(), playedMarkBytes: z.number().int().nonnegative(), clearedThroughBytes: z.number().int().nonnegative(), lastNonFFByteEnd: z.number().int().nonnegative().nullable() }).strict(),
  carrierMark: z.object({ name: bounded(240).nullable(), acknowledged: z.boolean() }).strict(),
  asrReceiptToMediaSentMs: z.number().finite().nonnegative().optional(), timingOrigin: z.literal("last ASR receipt proxy").optional(), timingPrecision: z.literal("estimated").optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "mark_ack" && (!value.carrierMark.acknowledged || value.carrierMark.name === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_carrier_mark_ack_evidence_missing" });
  const timingPresent = value.asrReceiptToMediaSentMs !== undefined || value.timingOrigin !== undefined || value.timingPrecision !== undefined;
  if (timingPresent && (value.asrReceiptToMediaSentMs === undefined || value.timingOrigin !== "last ASR receipt proxy" || value.timingPrecision !== "estimated")) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_carrier_timing_evidence_invalid" });
});
const actionEvidenceSchema = z.object({ type: safeString, name: safeString.optional(), callId: safeString.optional(), status: safeString.optional(), saved: z.boolean().optional(), transferId: safeString.optional(), requestId: safeString.optional(), scope: safeString.optional() }).strict();

export const liveConversationReviewBindingSchema = z.object({ practiceId: bounded(200), instanceId: bounded(200), accountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/), callSid }).strict();
export type LiveConversationReviewBinding = z.infer<typeof liveConversationReviewBindingSchema>;
export const liveConversationReviewEventSchema = z.object({
  eventId: bounded(240), occurredAt: timestamp,
  kind: z.enum(["caller_transcript", "assistant_transcript", "live_event", "save_receipt", "transfer", "closing", "error"]),
  speaker: z.enum(["caller", "assistant", "system", "none"]), text: z.string().max(16_000).nullable(),
  reviewState: z.enum(["complete", "incomplete", "no_speech", "unavailable"]), stream: streamSchema,
  /** Text and structured facts remain encrypted; no caller content is a SQL column. */
  payload: payloadSchema, delivery: deliverySchema.optional(), actionEvidence: actionEvidenceSchema.optional(),
  carrierPlayback: carrierPlaybackSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "assistant_transcript" && value.delivery === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_assistant_delivery_missing" });
  if (value.kind !== "assistant_transcript" && value.delivery !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_delivery_not_assistant" });
  if ((value.kind === "caller_transcript" || value.kind === "assistant_transcript") && value.actionEvidence !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_action_evidence_not_lifecycle" });
  if (value.kind !== "live_event" && value.carrierPlayback !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_carrier_playback_not_live_event" });
  if (value.kind === "caller_transcript" && (value.speaker !== "caller" || value.text === null || value.text.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_caller_text_missing" });
  if (value.kind === "assistant_transcript" && (value.speaker !== "assistant" || value.text === null || value.text.length === 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: "live_review_assistant_text_missing" });
});
export type LiveConversationReviewEvent = z.infer<typeof liveConversationReviewEventSchema>;
export type LiveConversationReviewEntry = Readonly<LiveConversationReviewEvent & { binding: LiveConversationReviewBinding; appendOrdinal: number; serverReceivedAt: string }>;
type Row = { append_ordinal: string; event_id: string; occurred_at: Date; server_received_at: Date; stream_sid: string; reservation_id: string; source_commit: string; model: string; deployment_id: string; protected_event: unknown };

/** Durable encrypted evidence only: no callback projection, save, or audio work. */
export class PostgresLiveConversationReviewStore {
  private readonly sql: postgres.Sql;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher) { this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "synthetic-live-conversation-review" } }); }
  async ready(): Promise<boolean> {
    try { const rows = await this.sql<{ table: string | null }[]>`SELECT to_regclass('public.gpt_live_conversation_reviews')::text AS table`; return rows[0]?.table === "gpt_live_conversation_reviews"; }
    catch { return false; }
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }

  /** Exact binding + event ID idempotency; changed payload under one ID is refused. */
  async append(input: { binding: LiveConversationReviewBinding; event: LiveConversationReviewEvent }): Promise<{ kind: "appended" | "duplicate" }> {
    const binding = liveConversationReviewBindingSchema.parse(input.binding), event = liveConversationReviewEventSchema.parse(input.event);
    const eventHash = this.cipher.digest({ binding, event }), protectedEvent = this.cipher.protect({ binding, event }, cipherBinding(binding, event));
    return await this.sql.begin(async tx => {
      const inserted = await tx<{ event_hash: string }[]>`INSERT INTO gpt_live_conversation_reviews(practice_id,instance_id,account_sid,call_sid,event_id,event_hash,occurred_at,stream_sid,reservation_id,source_commit,model,deployment_id,protected_event)
        VALUES (${binding.practiceId},${binding.instanceId},${binding.accountSid},${binding.callSid},${event.eventId},${eventHash},${event.occurredAt}::timestamptz,${event.stream.streamSid},${event.stream.reservationId},${event.stream.sourceCommit},${event.stream.model},${event.stream.deploymentId},${tx.json(protectedEvent as postgres.JSONValue)})
        ON CONFLICT (practice_id,instance_id,account_sid,call_sid,event_id) DO NOTHING RETURNING event_hash`;
      if (inserted.length === 1) return { kind: "appended" as const };
      const prior = (await tx<{ event_hash: string }[]>`SELECT event_hash FROM gpt_live_conversation_reviews
        WHERE practice_id=${binding.practiceId} AND instance_id=${binding.instanceId} AND account_sid=${binding.accountSid} AND call_sid=${binding.callSid} AND event_id=${event.eventId}`)[0];
      if (prior?.event_hash !== eventHash) throw new Error("live_conversation_review_event_conflict");
      return { kind: "duplicate" as const };
    });
  }

  /** Existing staff selection supplies all four values; CallSid alone is not a reader capability. */
  async list(bindingInput: LiveConversationReviewBinding): Promise<readonly LiveConversationReviewEntry[]> {
    const binding = liveConversationReviewBindingSchema.parse(bindingInput);
    const rows = await this.sql<Row[]>`SELECT append_ordinal,event_id,occurred_at,server_received_at,stream_sid,reservation_id,source_commit,model,deployment_id,protected_event FROM gpt_live_conversation_reviews
      WHERE practice_id=${binding.practiceId} AND instance_id=${binding.instanceId} AND account_sid=${binding.accountSid} AND call_sid=${binding.callSid} AND expires_at > now() ORDER BY append_ordinal ASC`;
    return rows.map(row => {
      const stream = { streamSid: row.stream_sid, reservationId: row.reservation_id, sourceCommit: row.source_commit, model: row.model, deploymentId: row.deployment_id };
      const value = z.object({ binding: liveConversationReviewBindingSchema, event: liveConversationReviewEventSchema }).strict().parse(this.cipher.unprotect(row.protected_event, cipherBinding(binding, { eventId: row.event_id, occurredAt: row.occurred_at.toISOString(), stream })));
      if (!sameBinding(value.binding, binding) || !sameStream(value.event.stream, stream)) throw new Error("live_conversation_review_binding_invalid");
      return { ...value.event, binding, appendOrdinal: Number(row.append_ordinal), serverReceivedAt: row.server_received_at.toISOString() };
    });
  }

  /** Bounded maintenance only; never call from media, callback-save, or audio paths. */
  async purgeExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("live_conversation_review_purge_limit_invalid");
    const rows = await this.sql`DELETE FROM gpt_live_conversation_reviews WHERE append_ordinal IN (SELECT append_ordinal FROM gpt_live_conversation_reviews WHERE expires_at <= now() ORDER BY append_ordinal ASC LIMIT ${limit})`;
    return rows.count;
  }
}

function cipherBinding(binding: LiveConversationReviewBinding, event: Pick<LiveConversationReviewEvent, "eventId" | "occurredAt" | "stream">) {
  return { domain: "gpt-live-conversation-review/v1", ...binding, eventId: event.eventId, occurredAt: event.occurredAt, streamSid: event.stream.streamSid, reservationId: event.stream.reservationId, sourceCommit: event.stream.sourceCommit, model: event.stream.model, deploymentId: event.stream.deploymentId };
}
function sameBinding(left: LiveConversationReviewBinding, right: LiveConversationReviewBinding): boolean {
  return left.practiceId === right.practiceId && left.instanceId === right.instanceId && left.accountSid === right.accountSid && left.callSid === right.callSid;
}
function sameStream(left: LiveConversationReviewEvent["stream"], right: LiveConversationReviewEvent["stream"]): boolean {
  return left.streamSid === right.streamSid && left.reservationId === right.reservationId && left.sourceCommit === right.sourceCommit && left.model === right.model && left.deploymentId === right.deploymentId;
}
