import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { enqueueConversationJob } from "./conversation-jobs.js";
import { historyNextStep, queueFilterSchema, queueStateOf, type ConversationHistoryProjection,
  type ConversationQueueProjection, type QueueFilter, type QueueMetricCounts } from "./conversation-query.js";
import { admissionSchema, applyConversationCommand, commandEnvelopeSchema, conversationSchema, conversationScopeSchema,
  ConversationConflict, newConversation, scopeOf, type Admission, type CommandEnvelope, type Conversation,
  type ConversationScope, unsupportedMediaNoticeId } from "./conversation-contract.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Ciphertexts are bound to their row identity and revision, not interchangeable blobs. */
export class ConversationCipher {
  private readonly key: Buffer;
  constructor(key: Buffer, readonly keyVersion = "v1") {
    if (key.length !== 32 || !/^[a-zA-Z0-9_-]{1,40}$/.test(keyVersion)) throw new Error("conversation_key_invalid");
    this.key = Buffer.from(key);
  }
  digest(value: unknown): string { return createHmac("sha256", this.key).update(canonical(value)).digest("hex"); }
  protect(value: unknown, binding: unknown): object {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(canonical({ domain: "vegas-conversation/v1", keyVersion: this.keyVersion, binding })));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return { version: 1, keyVersion: this.keyVersion, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: bytes.toString("base64") };
  }
  unprotect(value: unknown, binding: unknown): unknown {
    const e = value as { version?: number; keyVersion?: string; iv?: string; tag?: string; ciphertext?: string };
    if (e?.version !== 1 || e.keyVersion !== this.keyVersion || typeof e.iv !== "string" || typeof e.tag !== "string" || typeof e.ciphertext !== "string") throw new Error("conversation_ciphertext_invalid");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(e.iv, "base64"));
      decipher.setAAD(Buffer.from(canonical({ domain: "vegas-conversation/v1", keyVersion: this.keyVersion, binding })));
      decipher.setAuthTag(Buffer.from(e.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "base64")), decipher.final()]).toString("utf8"));
    } catch { throw new Error("conversation_ciphertext_invalid"); }
  }
}

export type TransitionReceipt = { eventId: string; accepted: boolean; error: string | null; state: Conversation; occurredAt: string };
const inboundSmsSchema = z.object({
  practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200), configVersion: z.string().min(1).max(200),
  mode: z.enum(["receptionist", "full"]), accountId: z.string().min(1).max(200), provider: z.literal("twilio"),
  messageTransport: z.enum(["sms", "whatsapp"]).default("sms"),
  contact: z.string().regex(/^\+[1-9]\d{7,14}$/), destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
  hours: z.enum(["demo_open", "demo_closed"]), messageSid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
  body: z.string().trim().max(8_000), numMedia: z.number().int().min(0).max(10),
  optOutType: z.enum(["STOP", "START", "HELP"]).optional(), threadExpirySeconds: z.number().int().min(1).max(604_800),
}).strict();
export type InboundSmsAdmission = z.infer<typeof inboundSmsSchema>;
export type InboundSmsReceipt = { conversation: Conversation; disposition: "accepted" | "suppressed" | "help"; jobQueued: boolean };
export type TransportIsolationRetirement = { retired: number; hasRemaining: boolean };
export interface ConversationStore {
  admit(input: Admission): Promise<Conversation>;
  get(scope: ConversationScope): Promise<Conversation | null>;
  execute(input: CommandEnvelope): Promise<TransitionReceipt>;
  /** Appends an authority-fenced speech review under the conversation row lock. */
  appendMonitorReview?(input: CommandEnvelope): Promise<TransitionReceipt>;
  queueSmsReplyOnce?(input: CommandEnvelope, sourceId: string): Promise<TransitionReceipt>;
  getEvent(scope: ConversationScope, eventId: string): Promise<{ input: CommandEnvelope; receipt: TransitionReceipt } | null>;
  history(scope: ConversationScope): Promise<readonly { input: CommandEnvelope; receipt: TransitionReceipt }[]>;
  list(input: { practiceId: string; instanceId: string; channel: "voice" | "sms"; limit: number; offset: number }): Promise<readonly Conversation[]>;
  count(input: { practiceId: string; instanceId: string; channel: "voice" | "sms" }): Promise<number>;
  subscribe(scope: { practiceId: string; instanceId: string }, listener: (change: { conversationId: string; revision: number }) => void): Promise<() => Promise<void>>;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}
type Row = { practice_id: string; instance_id: string; id: string; revision: number; protected_state: unknown; contact_key: string; policy_revision?: number; policy_suppressed?: boolean };
type EventRow = { event_id: string; command_hash: string; revision: number; protected_receipt: unknown };
type ThreadRow = { thread_key: string; binding_hash: string; conversation_id: string; expires_at: string };
type InboundEventRow = { payload_hash: string; protected_receipt: unknown; thread_key: string; num_media: number; opt_out_type: "STOP" | "START" | "HELP" | null };
type DispatchAttemptRow = Row & { attempt_id: string; message_id: string; provider_message_id: string | null };
type QueueProjectionRow = Row & {
  created_at: Date;
  updated_at: Date;
  phase: Conversation["phase"];
  voice_lease_until: Date | null;
  materialized: boolean;
  needs_follow_up: boolean;
  active_now: boolean;
  connected_to_staff: boolean;
  resolved_by_human: boolean;
  resolved_by_ai: boolean;
};
type QueueMetricsRow = {
  total: number;
  active_now: number;
  needs_follow_up: number;
  connected_to_staff: number;
  resolved_by_human: number;
  resolved_by_ai: number;
};
const dispatchAttemptLookupSchema = z.object({
  practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200), attemptId: z.string().min(1).max(200),
}).strict();
export type DispatchAttemptLookup = {
  scope: ConversationScope; messageId: string; accountId: string; from: string; to: string; transport: "sms" | "whatsapp"; providerId: string | null;
};
function binding(scope: ConversationScope, revision: number, eventId = "snapshot") { return { ...scope, revision, eventId, schemaVersion: 1 }; }
function inboundBinding(threadKey: string, messageSid: string) { return { domain: "sms-inbound", threadKey, messageSid }; }
function providerInboundHash(cipher: ConversationCipher, input: InboundSmsAdmission): string {
  return cipher.digest({ provider: input.provider, accountId: input.accountId, messageTransport: input.messageTransport,
    contact: input.contact, destination: input.destination, messageSid: input.messageSid, body: input.body, numMedia: input.numMedia,
    ...(input.optOutType === undefined ? {} : { optOutType: input.optOutType }) });
}
function legacyInboundHashWithoutTransport(cipher: ConversationCipher, input: InboundSmsAdmission): string {
  const { messageTransport: _messageTransport, ...beforeTransport } = input;
  return cipher.digest(beforeTransport);
}
function legacySmsReplayMatches(raw: unknown, row: InboundEventRow, input: InboundSmsAdmission): boolean {
  // Before transport was part of the admission hash, only plain SMS text has enough
  // durable evidence to re-establish a changed-config replay without trusting new input.
  if (input.messageTransport !== "sms" || row.num_media !== input.numMedia || row.opt_out_type !== (input.optOutType ?? null)) return false;
  const receipt = raw as { conversation?: unknown };
  const conversation = conversationSchema.safeParse(receipt.conversation);
  if (!conversation.success) return false;
  const admission = conversation.data.admission;
  if (admission.channel !== "sms" || admission.messageTransport !== "sms" || admission.provider !== input.provider || admission.accountId !== input.accountId || admission.contact !== input.contact || admission.destination !== input.destination) return false;
  return conversation.data.inputs.some((record) => record.id === input.messageSid && record.body === input.body);
}
function v2TextContactKey(cipher: ConversationCipher, input: Pick<Admission, "practiceId" | "provider" | "accountId" | "destination" | "contact">, transport: "sms" | "whatsapp"): string {
  return cipher.digest(["sms-contact-v2", input.practiceId, input.provider, input.accountId, input.destination, input.contact, transport]);
}
function v2TextAdmissionKey(cipher: ConversationCipher, input: Admission): string {
  return cipher.digest(["sms-admission-v2", input.provider, input.accountId, input.channel, input.messageTransport, input.externalId]);
}

const queueQuerySchema = z.object({
  practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200), channel: z.enum(["voice", "sms"]),
  filter: queueFilterSchema.default("total"), page: z.number().int().min(1).max(10_000), pageSize: z.number().int().min(1).max(100),
}).strict();
const historyQuerySchema = z.object({
  scope: conversationScopeSchema, channel: z.enum(["voice", "sms"]),
}).strict();

export class PostgresConversationStore implements ConversationStore {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher, private readonly clock: () => Date = () => new Date()) {
    this.sql = postgres(databaseUrl, { max: 5, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "vegas-voice-sms" } });
  }
  private decode(row: Row): Conversation {
    const scope = { practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.id };
    const c = conversationSchema.parse(this.cipher.unprotect(row.protected_state, binding(scope, row.revision)));
    if (canonical(scopeOf(c)) !== canonical(scope) || c.revision !== row.revision) throw new Error("conversation_snapshot_mismatch");
    if (c.admission.channel === "sms" && row.policy_revision !== undefined && row.policy_suppressed !== undefined) {
      c.suppressionRevision = row.policy_revision; c.suppressed = row.policy_suppressed;
    }
    return c;
  }
  private synchronizePolicy(row: Row, policy: { revision: number; suppressed: boolean }): Conversation {
    const state = this.decode(row);
    if (state.admission.channel !== "sms") return state;
    state.suppressionRevision = policy.revision;
    state.suppressed = policy.suppressed;
    for (const message of state.messages) {
      if (message.state === "queued" && message.suppressionRevision !== policy.revision) {
        message.state = "canceled";
      }
    }
    return conversationSchema.parse(state);
  }
  private async writeQueueProjection(tx: postgres.TransactionSql, state: Conversation, contactKey: string): Promise<void> {
    const queue = queueStateOf(state, this.clock()), scope = scopeOf(state);
    await tx`INSERT INTO voice_sms_queue_projection(
      practice_id,instance_id,conversation_id,contact_key,channel,snapshot_revision,materialized,created_at,updated_at,
      phase,voice_lease_until,needs_follow_up,connected_to_staff,resolved_by_human,resolved_by_ai
    ) VALUES (
      ${scope.practiceId},${scope.instanceId},${scope.conversationId},${contactKey},${state.admission.channel},${state.revision},true,
      ${state.createdAt}::timestamptz,${state.updatedAt}::timestamptz,
      ${state.phase},${state.activityLeaseUntil}::timestamptz,
      ${queue.needsFollowUp},${queue.connectedToStaff},${queue.resolvedByHuman},${queue.resolvedByAi}
    ) ON CONFLICT (practice_id,instance_id,conversation_id) DO UPDATE SET
      contact_key=EXCLUDED.contact_key,channel=EXCLUDED.channel,snapshot_revision=EXCLUDED.snapshot_revision,materialized=true,
      created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,phase=EXCLUDED.phase,voice_lease_until=EXCLUDED.voice_lease_until,needs_follow_up=EXCLUDED.needs_follow_up,
      connected_to_staff=EXCLUDED.connected_to_staff,
      resolved_by_human=EXCLUDED.resolved_by_human,resolved_by_ai=EXCLUDED.resolved_by_ai`;
  }
  private async enqueuePendingEvaluations(tx: postgres.TransactionSql, state: Conversation, now: string): Promise<void> {
    const scope = scopeOf(state);
    for (const evaluation of state.evaluations) {
      if (evaluation.state !== "pending") continue;
      await enqueueConversationJob(tx, this.cipher, { scope, kind: "post_call_eval", key: evaluation.id,
        payload: { evaluationId: evaluation.id }, availableAt: state.admission.channel === "voice" ? new Date(Date.parse(now) + 15_000).toISOString() : now, now });
    }
  }
  async ready(): Promise<boolean> {
    try {
      const rows = await this.sql`SELECT to_regclass('voice_sms_conversations') AS conversations, to_regclass('voice_sms_events') AS events, to_regclass('voice_sms_contact_policy') AS policy, to_regclass('voice_sms_dispatch_attempts') AS attempts, to_regclass('voice_sms_recoveries') AS recoveries, to_regclass('voice_sms_jobs') AS jobs, to_regclass('voice_sms_threads') AS threads, to_regclass('voice_sms_inbound_events') AS inbound_events, to_regclass('voice_sms_job_leases') AS job_leases, to_regclass('voice_sms_job_evidence') AS job_evidence, to_regclass('voice_sms_job_effects') AS job_effects, to_regclass('voice_sip_attempts') AS sip_attempts, to_regclass('voice_sms_queue_projection') AS queue_projection`;
      if (Object.values(rows[0] ?? {}).length !== 13 || !Object.values(rows[0]!).every((value) => value !== null)) return false;
      const completeness = await this.sql<{ complete: boolean }[]>`SELECT NOT EXISTS (
        SELECT 1 FROM voice_sms_conversations conversation LEFT JOIN voice_sms_queue_projection projection
          ON projection.practice_id=conversation.practice_id AND projection.instance_id=conversation.instance_id AND projection.conversation_id=conversation.id
        WHERE projection.conversation_id IS NULL OR projection.materialized=false OR projection.snapshot_revision<>conversation.revision
      ) AS complete`;
      return completeness[0]?.complete === true;
    } catch { return false; }
  }
  async transportIsolationReady(): Promise<boolean> {
    try {
      const rows = await this.sql<{ marked: boolean; legacy: boolean }[]>`SELECT
        EXISTS (SELECT 1 FROM voice_sms_transport_cutover WHERE singleton=true) AS marked,
        EXISTS (SELECT 1 FROM voice_sms_conversations WHERE channel='sms' AND transport_isolation_version=1) AS legacy`;
      return rows[0]?.marked === true && rows[0]?.legacy === false;
    } catch { return false; }
  }
  async retireTransportIsolationBatch(input: { limit: number }): Promise<TransportIsolationRetirement> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("transport_isolation_batch_limit_invalid");
    const now = this.clock().toISOString();
    return await this.sql.begin(async (tx) => {
      const rows = await tx<(Row & { transport_isolation_version: number; policy_revision: number; policy_suppressed: boolean })[]>`SELECT conversation.*,policy.revision AS policy_revision,policy.suppressed AS policy_suppressed
        FROM voice_sms_conversations conversation
        JOIN voice_sms_contact_policy policy ON policy.contact_key=conversation.contact_key
        WHERE conversation.channel='sms' AND conversation.transport_isolation_version=1
        ORDER BY conversation.created_at,conversation.id FOR UPDATE OF conversation SKIP LOCKED LIMIT ${input.limit}`;
      for (const row of rows) {
        const legacyPolicy = { revision: row.policy_revision, suppressed: row.policy_suppressed };
        const current = this.synchronizePolicy(row, legacyPolicy);
        for (const transport of ["sms", "whatsapp"] as const) {
          const key = v2TextContactKey(this.cipher, current.admission, transport);
          await tx`INSERT INTO voice_sms_contact_policy(contact_key) VALUES (${key}) ON CONFLICT DO NOTHING`;
          const policy = (await tx<{ revision: number; suppressed: boolean }[]>`SELECT revision,suppressed FROM voice_sms_contact_policy WHERE contact_key=${key} FOR UPDATE`)[0]!;
          if (legacyPolicy.suppressed && !policy.suppressed) {
            await tx`UPDATE voice_sms_contact_policy SET revision=${policy.revision + 1},suppressed=true WHERE contact_key=${key}`;
          }
        }
        const scope = scopeOf(current);
        if (current.phase === "active") {
          const command: CommandEnvelope = { scope, eventId: `transport-isolation-${randomUUID()}`, expectedRevision: current.revision,
            expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "system", id: "transport-isolation" }, command: { type: "conversation.disconnect" } };
          const state = applyConversationCommand(current, command, now);
          const receipt: TransitionReceipt = { eventId: command.eventId, accepted: true, error: null, state, occurredAt: now };
          await tx`UPDATE voice_sms_jobs SET state='canceled',updated_at=${now}::timestamptz
            WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}
              AND state='pending' AND kind IN ('sms_turn','sms_send')`;
          await this.enqueuePendingEvaluations(tx, state, now);
          await tx`UPDATE voice_sms_conversations SET revision=${state.revision},protected_state=${tx.json(this.cipher.protect(state, binding(scope, state.revision)) as postgres.JSONValue)},updated_at=${now}::timestamptz,transport_isolation_version=2
            WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}`;
          await this.writeQueueProjection(tx, state, row.contact_key);
          await tx`INSERT INTO voice_sms_events(practice_id,instance_id,conversation_id,event_id,command_hash,revision,protected_receipt,created_at)
            VALUES (${scope.practiceId},${scope.instanceId},${scope.conversationId},${command.eventId},${this.cipher.digest(command)},${state.revision},${tx.json(this.cipher.protect({ input: command, receipt }, binding(scope, state.revision, command.eventId)) as postgres.JSONValue)},${now}::timestamptz)`;
          await tx`SELECT pg_notify('vegas_voice_sms_changed', ${JSON.stringify({ practiceId: scope.practiceId, instanceId: scope.instanceId, conversationId: scope.conversationId, revision: state.revision })})`;
        } else {
          await tx`UPDATE voice_sms_jobs SET state='canceled',updated_at=${now}::timestamptz
            WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}
              AND state='pending' AND kind IN ('sms_turn','sms_send')`;
          await tx`UPDATE voice_sms_conversations SET transport_isolation_version=2 WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}`;
        }
      }
      const hasRemaining = (await tx<{ exists: boolean }[]>`SELECT EXISTS(SELECT 1 FROM voice_sms_conversations WHERE channel='sms' AND transport_isolation_version=1) AS exists`)[0]!.exists;
      if (!hasRemaining) await tx`INSERT INTO voice_sms_transport_cutover(singleton,completed_at) VALUES (true,${now}::timestamptz) ON CONFLICT (singleton) DO NOTHING`;
      return { retired: rows.length, hasRemaining };
    }) as TransportIsolationRetirement;
  }
  async admitInboundSms(raw: InboundSmsAdmission): Promise<InboundSmsReceipt> {
    const input = inboundSmsSchema.parse(raw);
    const now = this.clock().toISOString();
    const providerAccountKey = this.cipher.digest([input.provider, input.accountId]);
    const replayKey = this.cipher.digest(["sms-inbound-replay", input.practiceId, input.instanceId, input.provider, input.accountId, input.messageSid]);
    const threadBinding = [input.messageTransport, input.provider, input.accountId, input.destination, input.contact, input.practiceId, input.instanceId, input.configVersion];
    const threadKey = this.cipher.digest(["sms-thread-v2", ...threadBinding]);
    const bindingHash = this.cipher.digest(threadBinding);
    const payloadHash = providerInboundHash(this.cipher, input);
    const legacyPayloadHash = this.cipher.digest(input);
    const legacyPayloadHashWithoutTransport = legacyInboundHashWithoutTransport(this.cipher, input);
    const contactKey = v2TextContactKey(this.cipher, input, input.messageTransport);
    return await this.sql.begin(async (tx) => {
      // A config change derives a different thread key. Serialize provider retries first
      // so the unique MessageSid admission remains idempotent across that boundary.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${replayKey}, 0))`;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${threadKey}, 0))`;
      const replay = await tx<InboundEventRow[]>`SELECT payload_hash,protected_receipt,thread_key,num_media,opt_out_type FROM voice_sms_inbound_events
        WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND provider_account_key=${providerAccountKey} AND message_sid=${input.messageSid} FOR UPDATE`;
      if (replay[0] !== undefined) {
        const stored = this.cipher.unprotect(replay[0].protected_receipt, inboundBinding(replay[0].thread_key, input.messageSid));
        // Older rows used the full local admission object as their hash. First verify
        // an exact old shape; otherwise recover only a recorded, plain-SMS text turn.
        const exact = replay[0].payload_hash === payloadHash || replay[0].payload_hash === legacyPayloadHash
          || (input.messageTransport === "sms" && replay[0].payload_hash === legacyPayloadHashWithoutTransport);
        if (!exact && !legacySmsReplayMatches(stored, replay[0], input)) throw new ConversationConflict("inbound_payload_conflict");
        return stored as InboundSmsReceipt;
      }
      await tx`INSERT INTO voice_sms_contact_policy(contact_key) VALUES (${contactKey}) ON CONFLICT DO NOTHING`;
      const policy = (await tx<{ revision: number; suppressed: boolean }[]>`SELECT revision,suppressed FROM voice_sms_contact_policy WHERE contact_key=${contactKey} FOR UPDATE`)[0]!;
      const threads = await tx<ThreadRow[]>`SELECT thread_key,binding_hash,conversation_id,expires_at FROM voice_sms_threads WHERE thread_key=${threadKey} FOR UPDATE`;
      const createThread = async (): Promise<Row> => {
        const admission: Admission = { practiceId: input.practiceId, instanceId: input.instanceId, configVersion: input.configVersion, mode: input.mode,
          accountId: input.accountId, provider: input.provider, channel: "sms", messageTransport: input.messageTransport,
          externalId: input.messageSid, contact: input.contact, destination: input.destination, hours: input.hours };
        const state = newConversation(admission, randomUUID(), now);
        state.suppressed = policy.suppressed; state.suppressionRevision = policy.revision;
        const scope = scopeOf(state), payload = this.cipher.protect(state, binding(scope, 0));
        const admissionKey = this.cipher.digest(["sms-inbound-admission-v2", input.practiceId, input.instanceId, input.provider, input.accountId, input.messageTransport, input.messageSid]);
        await tx`INSERT INTO voice_sms_conversations(practice_id,instance_id,id,admission_key,admission_hash,contact_key,channel,revision,protected_state,created_at,updated_at,transport_isolation_version)
          VALUES (${input.practiceId},${input.instanceId},${state.id},${admissionKey},${this.cipher.digest(admission)},${contactKey},'sms',0,${tx.json(payload as postgres.JSONValue)},${now}::timestamptz,${now}::timestamptz,2)`;
        await this.writeQueueProjection(tx, state, contactKey);
        const expiresAt = new Date(Date.parse(now) + input.threadExpirySeconds * 1000).toISOString();
        await tx`INSERT INTO voice_sms_threads(thread_key,binding_hash,practice_id,instance_id,config_version,provider_account_key,conversation_id,expires_at,updated_at)
          VALUES (${threadKey},${bindingHash},${input.practiceId},${input.instanceId},${input.configVersion},${providerAccountKey},${state.id},${expiresAt}::timestamptz,${now}::timestamptz)
          ON CONFLICT (thread_key) DO UPDATE SET conversation_id=EXCLUDED.conversation_id,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`;
        return { practice_id: input.practiceId, instance_id: input.instanceId, id: state.id, revision: 0, protected_state: payload, contact_key: contactKey };
      };
      const cancelPendingSmsJobs = async (scope: ConversationScope): Promise<void> => {
        await tx`UPDATE voice_sms_jobs SET state='canceled',updated_at=${now}::timestamptz
          WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}
            AND state='pending' AND kind IN ('sms_turn','sms_send')`;
      };
      const retireThread = async (row: Row): Promise<void> => {
        const current = this.synchronizePolicy(row, policy), scope = scopeOf(current);
        const command: CommandEnvelope = { scope, eventId: `sms:rollover:${input.messageSid}`, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
          actor: { kind: "system", id: "sms-ingress" }, command: { type: "conversation.disconnect" } };
        const state = applyConversationCommand(current, command, now);
        const receipt: TransitionReceipt = { eventId: command.eventId, accepted: true, error: null, state, occurredAt: now };
        await cancelPendingSmsJobs(scope);
        await this.enqueuePendingEvaluations(tx, state, now);
        await tx`UPDATE voice_sms_conversations SET revision=${state.revision},protected_state=${tx.json(this.cipher.protect(state, binding(scope, state.revision)) as postgres.JSONValue)},updated_at=${now}
          WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}`;
        await this.writeQueueProjection(tx, state, row.contact_key);
        await tx`INSERT INTO voice_sms_events(practice_id,instance_id,conversation_id,event_id,command_hash,revision,protected_receipt,created_at)
          VALUES (${scope.practiceId},${scope.instanceId},${scope.conversationId},${command.eventId},${this.cipher.digest(command)},${state.revision},${tx.json(this.cipher.protect({ input: command, receipt }, binding(scope, state.revision, command.eventId)) as postgres.JSONValue)},${now}::timestamptz)`;
        await tx`SELECT pg_notify('vegas_voice_sms_changed', ${JSON.stringify({ practiceId: scope.practiceId, instanceId: scope.instanceId, conversationId: scope.conversationId, revision: state.revision })})`;
      };
      let row: Row | undefined;
      if (threads[0] !== undefined && threads[0].binding_hash !== bindingHash) throw new ConversationConflict("thread_binding_conflict");
      const expiredThread = threads[0] !== undefined && new Date(threads[0].expires_at) <= new Date(now);
      if (threads[0] !== undefined) {
        row = (await tx<Row[]>`SELECT * FROM voice_sms_conversations WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND id=${threads[0].conversation_id} FOR UPDATE`)[0];
      }
      if (row !== undefined) {
        const current = this.synchronizePolicy(row, policy);
        if (expiredThread && current.phase === "active") { await retireThread(row); row = undefined; }
        else if (current.phase !== "active") { await cancelPendingSmsJobs(scopeOf(current)); await this.enqueuePendingEvaluations(tx, current, now); row = undefined; }
      }
      if (row === undefined) row = await createThread();
      let current = this.synchronizePolicy(row, policy), scope = scopeOf(current);
      const control = input.messageTransport === "whatsapp" ? localWhatsappControl(input.body) : input.optOutType;
      const unsupportedContent = input.body.length === 0
        ? input.numMedia > 0 ? { kind: "media" as const, count: input.numMedia } : { kind: "non_text" as const, count: 1 }
        : null;
      const commandFor = (state: Conversation): CommandEnvelope => unsupportedContent !== null
        ? { scope: scopeOf(state), eventId: `sms:${input.messageSid}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
          actor: { kind: "provider", id: "twilio" }, command: { type: "sms.unsupported_media", sourceId: input.messageSid, kind: unsupportedContent.kind, mediaCount: unsupportedContent.kind === "media" ? unsupportedContent.count : 0 } }
        : control === "STOP" || control === "START"
        ? { scope: scopeOf(state), eventId: `sms:${input.messageSid}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "provider", id: "twilio" }, command: { type: "sms.suppression", suppressed: control === "STOP" } }
        : control === "HELP"
          ? { scope: scopeOf(state), eventId: `sms:${input.messageSid}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "provider", id: "twilio" }, command: { type: "sms.inbound_activity" } }
        : { scope: scopeOf(state), eventId: `sms:${input.messageSid}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "provider", id: "twilio" }, command: { type: "input.record", sourceId: input.messageSid, body: input.body, ...(state.pendingQuestion === null ? {} : { questionId: state.pendingQuestion.id }) } };
      let command = commandFor(current);
      let state = current, error: string | null = null;
      try { state = applyConversationCommand(current, command, now); }
      catch (caught) {
        if (!(caught instanceof ConversationConflict)) throw caught;
        if (caught.code === "conversation_capacity_reached" && control === undefined) {
          await retireThread(row);
          row = await createThread();
          current = this.synchronizePolicy(row, policy); scope = scopeOf(current); command = commandFor(current);
          state = applyConversationCommand(current, command, now);
        } else error = caught.code;
      }
      const receipt: TransitionReceipt = { eventId: command.eventId, accepted: error === null, error, state, occurredAt: now };
      if (error !== null) throw new ConversationConflict(error);
      if (control === "STOP" || control === "START") await tx`UPDATE voice_sms_contact_policy SET revision=${state.suppressionRevision},suppressed=${state.suppressed} WHERE contact_key=${contactKey}`;
      if (control === "STOP") await tx`UPDATE voice_sms_jobs job SET state='canceled',updated_at=${now}::timestamptz
        FROM voice_sms_conversations conversation
        WHERE job.practice_id=conversation.practice_id AND job.instance_id=conversation.instance_id AND job.conversation_id=conversation.id
          AND conversation.contact_key=${contactKey} AND job.state='pending' AND job.kind IN ('sms_turn','sms_send')`;
      const jobQueued = control === undefined && unsupportedContent === null && !state.suppressed;
      if (jobQueued) await enqueueConversationJob(tx, this.cipher, { scope, kind: "sms_turn", key: input.messageSid, payload: { sourceId: input.messageSid }, availableAt: now, now });
      const mediaNotice = state.messages.find((message) => message.id === unsupportedMediaNoticeId(input.messageSid));
      if (unsupportedContent !== null && mediaNotice?.state === "queued") await enqueueConversationJob(tx, this.cipher, { scope, kind: "sms_send", key: mediaNotice.id,
        payload: { messageId: mediaNotice.id }, availableAt: now, now });
      const protectedState = this.cipher.protect(state, binding(scope, state.revision));
      await tx`UPDATE voice_sms_conversations SET revision=${state.revision},protected_state=${tx.json(protectedState as postgres.JSONValue)},updated_at=${now}::timestamptz
        WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}`;
      await this.writeQueueProjection(tx, state, row.contact_key);
      const protectedReceipt = this.cipher.protect({ input: command, receipt }, binding(scope, state.revision, command.eventId));
      await tx`INSERT INTO voice_sms_events(practice_id,instance_id,conversation_id,event_id,command_hash,revision,protected_receipt,created_at)
        VALUES (${scope.practiceId},${scope.instanceId},${scope.conversationId},${command.eventId},${this.cipher.digest(command)},${state.revision},${tx.json(protectedReceipt as postgres.JSONValue)},${now}::timestamptz)`;
      const expiresAt = new Date(Date.parse(now) + input.threadExpirySeconds * 1000).toISOString();
      await tx`UPDATE voice_sms_threads SET expires_at=${expiresAt}::timestamptz,updated_at=${now}::timestamptz WHERE thread_key=${threadKey}`;
      const result: InboundSmsReceipt = { conversation: state, disposition: control === "STOP" ? "suppressed" : control === "HELP" ? "help" : "accepted", jobQueued };
      await tx`INSERT INTO voice_sms_inbound_events(practice_id,instance_id,provider_account_key,message_sid,thread_key,conversation_id,payload_hash,num_media,opt_out_type,protected_receipt,received_at)
        VALUES (${input.practiceId},${input.instanceId},${providerAccountKey},${input.messageSid},${threadKey},${scope.conversationId},${payloadHash},${input.numMedia},${control ?? null},${tx.json(this.cipher.protect(result, inboundBinding(threadKey, input.messageSid)) as postgres.JSONValue)},${now}::timestamptz)`;
      await tx`SELECT pg_notify('vegas_voice_sms_changed', ${JSON.stringify({ practiceId: scope.practiceId, instanceId: scope.instanceId, conversationId: scope.conversationId, revision: state.revision })})`;
      return result;
    }) as InboundSmsReceipt;
  }
  async admit(raw: Admission): Promise<Conversation> {
    const input = admissionSchema.parse(raw);
    const admissionKey = input.channel === "sms" ? v2TextAdmissionKey(this.cipher, input)
      : this.cipher.digest([input.provider, input.accountId, input.channel, input.externalId]);
    // Existing voice admissions predate the nullable controlled fixture receipt.
    // Keep their exact hash shape so a carrier replay remains idempotent after rollout.
    const { controlledHours, ...legacyAdmission } = input;
    const admissionHash = this.cipher.digest(controlledHours === null ? legacyAdmission : input);
    // Suppression follows the sender number and recipient within its practice, across instance revisions.
    const contactKey = input.channel === "sms" ? v2TextContactKey(this.cipher, input, input.messageTransport)
      : this.cipher.digest([input.practiceId, input.provider, input.accountId, input.destination, input.contact]);
    const transportIsolationVersion = input.channel === "sms" ? 2 : 1;
    return await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${admissionKey}, 0))`;
      const existing = await tx<(Row & { admission_hash: string })[]>`SELECT c.*,p.revision AS policy_revision,p.suppressed AS policy_suppressed FROM voice_sms_conversations c JOIN voice_sms_contact_policy p USING(contact_key)
        WHERE c.admission_key=${admissionKey}`;
      if (existing[0]) {
        if (existing[0].admission_hash !== admissionHash) throw new ConversationConflict("admission_binding_conflict");
        return this.synchronizePolicy(existing[0], { revision: existing[0].policy_revision!, suppressed: existing[0].policy_suppressed! });
      }
      await tx`INSERT INTO voice_sms_contact_policy(contact_key) VALUES (${contactKey}) ON CONFLICT DO NOTHING`;
      const policies = await tx<{ revision: number; suppressed: boolean }[]>`SELECT revision,suppressed FROM voice_sms_contact_policy WHERE contact_key=${contactKey} FOR UPDATE`;
      const state = newConversation(input, randomUUID(), this.clock().toISOString());
      if (input.channel === "sms") { state.suppressed = policies[0]!.suppressed; state.suppressionRevision = policies[0]!.revision; }
      const payload = this.cipher.protect(state, binding(scopeOf(state), 0));
      await tx`INSERT INTO voice_sms_conversations(practice_id,instance_id,id,admission_key,admission_hash,contact_key,channel,revision,protected_state,created_at,updated_at,transport_isolation_version)
        VALUES (${input.practiceId},${input.instanceId},${state.id},${admissionKey},${admissionHash},${contactKey},${input.channel},0,${tx.json(payload as postgres.JSONValue)},${state.createdAt},${state.updatedAt},${transportIsolationVersion})`;
      await this.writeQueueProjection(tx, state, contactKey);
      await tx`SELECT pg_notify('vegas_voice_sms_changed', ${JSON.stringify({ practiceId: input.practiceId, instanceId: input.instanceId, conversationId: state.id, revision: state.revision })})`;
      return state;
    }) as Conversation;
  }
  async findVoiceByParent(input: { practiceId: string; instanceId: string; accountId: string; parentCallId: string }): Promise<Conversation | null> {
    if (!/^CA[a-fA-F0-9]{32}$/.test(input.parentCallId) || !/^AC[a-fA-F0-9]{32}$/.test(input.accountId)) return null;
    const key = this.cipher.digest(["twilio", input.accountId, "voice", input.parentCallId]);
    const rows = await this.sql<Row[]>`SELECT * FROM voice_sms_conversations
      WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND channel='voice' AND admission_key=${key}`;
    if (rows[0] === undefined) return null;
    const state = this.decode(rows[0]);
    return state.admission.accountId === input.accountId && state.admission.externalId === input.parentCallId ? state : null;
  }
  async getDispatchAttempt(raw: { practiceId: string; instanceId: string; attemptId: string }): Promise<DispatchAttemptLookup | null> {
    const input = dispatchAttemptLookupSchema.parse(raw);
    const rows = await this.sql<DispatchAttemptRow[]>`SELECT conversation.*,attempt.attempt_id,attempt.message_id,attempt.provider_message_id
      FROM voice_sms_dispatch_attempts attempt
      JOIN voice_sms_conversations conversation ON conversation.practice_id=attempt.practice_id AND conversation.instance_id=attempt.instance_id AND conversation.id=attempt.conversation_id
      WHERE attempt.practice_id=${input.practiceId} AND attempt.instance_id=${input.instanceId} AND attempt.attempt_id=${input.attemptId}`;
    const row = rows[0];
    if (row === undefined) return null;
    const state = this.decode(row);
    const message = state.messages.find((value) => value.id === row.message_id);
    if (message === undefined || message.dispatchAttemptId !== row.attempt_id || message.providerId !== row.provider_message_id) {
      throw new Error("dispatch_attempt_snapshot_mismatch");
    }
    return { scope: scopeOf(state), messageId: message.id, accountId: state.admission.accountId,
      from: state.admission.destination, to: state.admission.contact, transport: state.admission.messageTransport, providerId: row.provider_message_id };
  }
  async get(raw: ConversationScope): Promise<Conversation | null> {
    const s = conversationScopeSchema.parse(raw);
    const rows = await this.sql<Row[]>`SELECT c.*,p.revision AS policy_revision,p.suppressed AS policy_suppressed FROM voice_sms_conversations c JOIN voice_sms_contact_policy p USING(contact_key)
      WHERE c.practice_id=${s.practiceId} AND c.instance_id=${s.instanceId} AND c.id=${s.conversationId}`;
    return rows[0] ? this.synchronizePolicy(rows[0], { revision: rows[0].policy_revision!, suppressed: rows[0].policy_suppressed! }) : null;
  }
  async execute(raw: CommandEnvelope): Promise<TransitionReceipt> {
    return await this.sql.begin(async (tx) => this.executeInTransaction(tx, raw)) as TransitionReceipt;
  }
  async appendMonitorReview(raw: CommandEnvelope): Promise<TransitionReceipt> {
    const input = commandEnvelopeSchema.parse(raw);
    if (input.command.type !== "monitor.review" || input.actor.kind !== "system" || input.actor.id !== "speech-monitor") {
      throw new Error("monitor_review_append_invalid");
    }
    return await this.sql.begin(async (tx) => this.executeInTransaction(tx, input, true)) as TransitionReceipt;
  }
  async queueSmsReplyOnce(raw: CommandEnvelope, sourceId: string): Promise<TransitionReceipt> {
    const input = commandEnvelopeSchema.parse(raw);
    if (input.command.type !== "sms.queue" || input.actor.kind !== "ai" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(sourceId)) {
      throw new Error("source_bound_reply_invalid");
    }
    const replyPrefix = `f2-sms-reply-${createHash("sha256").update(sourceId).digest("hex")}`;
    if (!input.eventId.startsWith(`${replyPrefix}-r`)) throw new Error("source_bound_reply_event_invalid");
    const scope = input.scope;
    return await this.sql.begin(async (tx) => {
      const identity = (await tx<{ contact_key: string }[]>`SELECT contact_key FROM voice_sms_conversations
        WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId}`)[0];
      if (identity === undefined) throw new ConversationConflict("conversation_not_found");
      await tx`SELECT revision FROM voice_sms_contact_policy WHERE contact_key=${identity.contact_key} FOR UPDATE`;
      await tx`SELECT revision FROM voice_sms_conversations WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
        AND id=${scope.conversationId} FOR UPDATE`;
      const priorRows = await tx<EventRow[]>`SELECT * FROM voice_sms_events WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
        AND conversation_id=${scope.conversationId} AND (event_id=${replyPrefix} OR event_id LIKE ${`${replyPrefix}-r%`}) ORDER BY sequence`;
      const prior = priorRows.map((row) => this.cipher.unprotect(row.protected_receipt, binding(scope, row.revision, row.event_id)) as {
        input: CommandEnvelope; receipt: TransitionReceipt }).find((event) => event.receipt.accepted && event.input.command.type === "sms.queue");
      return prior?.receipt ?? await this.executeInTransaction(tx, input);
    }) as TransitionReceipt;
  }
  /** Internal composition seam: action receipts and their conversation outcome commit or roll back together. */
  async executeInTransaction(tx: postgres.TransactionSql, raw: CommandEnvelope, rebaseMonitorReview = false): Promise<TransitionReceipt> {
    const input = commandEnvelopeSchema.parse(raw), s = input.scope, hash = this.cipher.digest(input);
      if (rebaseMonitorReview && (input.command.type !== "monitor.review" || input.actor.kind !== "system" || input.actor.id !== "speech-monitor")) {
        throw new Error("monitor_review_append_invalid");
      }
      const identity = (await tx<Row[]>`SELECT * FROM voice_sms_conversations WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND id=${s.conversationId}`)[0];
      if (!identity) throw new ConversationConflict("conversation_not_found");
      // Inbound SMS takes the contact lock before the conversation; all writers use that order.
      const policy = (await tx<{ revision: number; suppressed: boolean }[]>`SELECT revision,suppressed FROM voice_sms_contact_policy WHERE contact_key=${identity.contact_key} FOR UPDATE`)[0]!;
      const rows = await tx<Row[]>`SELECT * FROM voice_sms_conversations WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND id=${s.conversationId} FOR UPDATE`;
      const row = rows[0]; if (!row) throw new ConversationConflict("conversation_not_found");
      const previous = await tx<EventRow[]>`SELECT * FROM voice_sms_events WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND conversation_id=${s.conversationId} AND event_id=${input.eventId}`;
      if (previous[0]) {
        if (previous[0].command_hash !== hash) throw new ConversationConflict("event_payload_conflict");
        return (this.cipher.unprotect(previous[0].protected_receipt, binding(s, previous[0].revision, input.eventId)) as { receipt: TransitionReceipt }).receipt;
      }
      let current = this.decode(row);
      current = this.synchronizePolicy(row, policy);
      const now = this.clock().toISOString();
      // Reviews are immutable historical observations. Rebase only their revision
      // after holding the row lock; ownership and every action fence stay intact.
      const transition = rebaseMonitorReview
        ? { ...input, expectedRevision: current.revision }
        : input;
      let state = current, error: string | null = null;
      if (input.command.type === "sms.dispatch") {
        const others = await tx<Row[]>`SELECT DISTINCT conversation.* FROM voice_sms_conversations conversation
          JOIN voice_sms_dispatch_attempts attempt ON attempt.practice_id=conversation.practice_id AND attempt.instance_id=conversation.instance_id AND attempt.conversation_id=conversation.id
          WHERE conversation.contact_key=${row.contact_key} AND NOT (conversation.practice_id=${s.practiceId} AND conversation.instance_id=${s.instanceId} AND conversation.id=${s.conversationId})
            AND attempt.state IN ('submitting','unknown')`;
        const unresolved = others.some((other) => this.synchronizePolicy(other, policy).messages.some((message) =>
          message.state === "submitting" || (message.state === "unknown" && !message.sendHoldReleased)));
        if (unresolved) error = "send_reconciliation_required";
      }
      if (error === null) {
        try { state = applyConversationCommand(current, transition, now); }
        catch (e) { if (!(e instanceof ConversationConflict)) throw e; error = e.code; }
      }
      if (error === null && (input.command.type === "sms.dispatch" || input.command.type === "sms.receipt")) {
        const messageId = input.command.messageId;
        try {
          await tx.savepoint(async (savepoint) => {
            const message = state.messages.find((value) => value.id === messageId)!;
            if (input.command.type === "sms.dispatch") {
              await savepoint`INSERT INTO voice_sms_dispatch_attempts(attempt_id,practice_id,instance_id,conversation_id,message_id,provider_account_key,state)
                VALUES (${message.dispatchAttemptId!},${s.practiceId},${s.instanceId},${s.conversationId},${message.id},${this.cipher.digest([current.admission.provider,current.admission.accountId])},${message.state})`;
            } else {
              await savepoint`UPDATE voice_sms_dispatch_attempts SET provider_message_id=${message.providerId},state=${message.state} WHERE attempt_id=${message.dispatchAttemptId!} AND practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND conversation_id=${s.conversationId}`;
            }
          });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          state = current;
          error = input.command.type === "sms.dispatch" ? "dispatch_attempt_conflict" : "provider_id_conflict";
        }
      }
      const receipt: TransitionReceipt = { eventId: input.eventId, accepted: error === null, error, state, occurredAt: now };
      if (error === null) {
        if (state.admission.channel === "sms" && input.command.type === "input.record") {
          await enqueueConversationJob(tx, this.cipher, { scope: s, kind: "sms_turn", key: input.command.sourceId,
            payload: { sourceId: input.command.sourceId }, availableAt: now, now });
        }
        if (input.command.type === "sms.queue" || input.command.type === "emergency.sms_instruction") {
          await enqueueConversationJob(tx, this.cipher, { scope: s, kind: "sms_send", key: input.command.messageId,
            payload: { messageId: input.command.messageId }, availableAt: now, now });
        }
        if (input.command.type === "transfer.start") {
          const transferId = input.command.transferId;
          const transfer = state.transfers.find((value) => value.id === transferId);
          if (transfer === undefined) throw new Error("transfer_missing_after_acceptance");
          await enqueueConversationJob(tx, this.cipher, { scope: s, kind: "stub_timeout", key: transfer.id,
            payload: { transferId: transfer.id }, availableAt: transfer.deadline, now });
        }
        if (input.command.type === "conversation.disconnect" || input.command.type === "evaluation.schedule") await this.enqueuePendingEvaluations(tx, state, now);
        if (input.command.type === "sms.suppression") await tx`UPDATE voice_sms_contact_policy SET revision=${state.suppressionRevision},suppressed=${state.suppressed} WHERE contact_key=${row.contact_key}`;
        for (const r of state.recoveries) await tx`INSERT INTO voice_sms_recoveries(practice_id,instance_id,conversation_id,recovery_id,from_epoch,state)
          VALUES (${s.practiceId},${s.instanceId},${s.conversationId},${r.id},${r.fromEpoch},${r.state})
          ON CONFLICT (practice_id,instance_id,conversation_id,recovery_id) DO UPDATE SET state=EXCLUDED.state`;
        const protectedState = this.cipher.protect(state, binding(s, state.revision));
        await tx`UPDATE voice_sms_conversations SET revision=${state.revision},protected_state=${tx.json(protectedState as postgres.JSONValue)},updated_at=${now}
          WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND id=${s.conversationId}`;
        await this.writeQueueProjection(tx, state, row.contact_key);
      }
      const protectedReceipt = this.cipher.protect({ input, receipt }, binding(s, state.revision, input.eventId));
      await tx`INSERT INTO voice_sms_events(practice_id,instance_id,conversation_id,event_id,command_hash,revision,protected_receipt,created_at)
        VALUES (${s.practiceId},${s.instanceId},${s.conversationId},${input.eventId},${hash},${state.revision},${tx.json(protectedReceipt as postgres.JSONValue)},${now})`;
      if (error === null) await tx`SELECT pg_notify('vegas_voice_sms_changed', ${JSON.stringify({ practiceId: s.practiceId, instanceId: s.instanceId, conversationId: s.conversationId, revision: state.revision })})`;
      return receipt;
  }
  async getEvent(raw: ConversationScope, eventId: string): Promise<{ input: CommandEnvelope; receipt: TransitionReceipt } | null> {
    const s = conversationScopeSchema.parse(raw);
    const rows = await this.sql<EventRow[]>`SELECT * FROM voice_sms_events WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND conversation_id=${s.conversationId} AND event_id=${eventId}`;
    const row = rows[0];
    return row ? this.cipher.unprotect(row.protected_receipt, binding(s, row.revision, row.event_id)) as { input: CommandEnvelope; receipt: TransitionReceipt } : null;
  }
  async history(raw: ConversationScope): Promise<readonly { input: CommandEnvelope; receipt: TransitionReceipt }[]> {
    const s = conversationScopeSchema.parse(raw);
    const rows = await this.sql<EventRow[]>`SELECT * FROM voice_sms_events WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND conversation_id=${s.conversationId} ORDER BY sequence`;
    return rows.map((row) => this.cipher.unprotect(row.protected_receipt, binding(s,row.revision,row.event_id)) as { input: CommandEnvelope; receipt: TransitionReceipt });
  }
  async list(input: { practiceId: string; instanceId: string; channel: "voice" | "sms"; limit: number; offset: number }): Promise<readonly Conversation[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isInteger(input.offset) || input.offset < 0) throw new Error("conversation_page_invalid");
    const rows = await this.sql<Row[]>`SELECT c.*,p.revision AS policy_revision,p.suppressed AS policy_suppressed FROM voice_sms_conversations c JOIN voice_sms_contact_policy p USING(contact_key)
      WHERE c.practice_id=${input.practiceId} AND c.instance_id=${input.instanceId} AND c.channel=${input.channel} ORDER BY c.created_at DESC,c.id DESC LIMIT ${input.limit} OFFSET ${input.offset}`;
    return rows.map((row) => this.synchronizePolicy(row, { revision: row.policy_revision!, suppressed: row.policy_suppressed! }));
  }
  async count(input: { practiceId: string; instanceId: string; channel: "voice" | "sms" }): Promise<number> {
    const rows = await this.sql<{ total: number }[]>`SELECT count(*)::integer AS total FROM voice_sms_conversations
      WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND channel=${input.channel}`;
    return rows[0]!.total;
  }
  /** Materializes at most `limit` legacy encrypted snapshots; callers must loop until remaining is zero before readiness. */
  async backfillQueueProjection(input: { limit: number }): Promise<{ materialized: number; remaining: number }> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error("queue_projection_backfill_limit_invalid");
    return await this.sql.begin(async (tx) => {
      const rows = await tx<Row[]>`SELECT conversation.* FROM voice_sms_conversations conversation
        LEFT JOIN voice_sms_queue_projection projection
          ON projection.practice_id=conversation.practice_id AND projection.instance_id=conversation.instance_id AND projection.conversation_id=conversation.id
        WHERE projection.conversation_id IS NULL OR projection.materialized=false OR projection.snapshot_revision<>conversation.revision
        ORDER BY conversation.created_at,conversation.id FOR UPDATE OF conversation SKIP LOCKED LIMIT ${input.limit}`;
      for (const row of rows) await this.writeQueueProjection(tx, this.decode(row), row.contact_key);
      const remainingRows = await tx<{ remaining: number }[]>`SELECT count(*)::integer AS remaining FROM voice_sms_conversations conversation
        LEFT JOIN voice_sms_queue_projection projection
          ON projection.practice_id=conversation.practice_id AND projection.instance_id=conversation.instance_id AND projection.conversation_id=conversation.id
        WHERE projection.conversation_id IS NULL OR projection.materialized=false OR projection.snapshot_revision<>conversation.revision`;
      return { materialized: rows.length, remaining: remainingRows[0]!.remaining };
    }) as { materialized: number; remaining: number };
  }
  async queryQueue(raw: { practiceId: string; instanceId: string; channel: "voice" | "sms"; filter?: QueueFilter; page: number; pageSize: number }): Promise<ConversationQueueProjection> {
    const input = queueQuerySchema.parse(raw);
    return this.sql.begin("isolation level repeatable read read only", async (tx) => {
    const incomplete = await tx<{ incomplete: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM voice_sms_conversations conversation LEFT JOIN voice_sms_queue_projection projection
        ON projection.practice_id=conversation.practice_id AND projection.instance_id=conversation.instance_id AND projection.conversation_id=conversation.id
      WHERE conversation.practice_id=${input.practiceId} AND conversation.instance_id=${input.instanceId} AND conversation.channel=${input.channel}
        AND (projection.conversation_id IS NULL OR projection.materialized=false OR projection.snapshot_revision<>conversation.revision)
    ) AS incomplete`;
    if (incomplete[0]?.incomplete) throw new Error("queue_projection_incomplete");
    const metricsRows = await tx<QueueMetricsRow[]>`SELECT count(*)::integer AS total,
      count(*) FILTER (WHERE channel='voice' AND phase='active' AND voice_lease_until>CURRENT_TIMESTAMP)::integer AS active_now,
      count(*) FILTER (WHERE needs_follow_up)::integer AS needs_follow_up,
      count(*) FILTER (WHERE connected_to_staff)::integer AS connected_to_staff,
      count(*) FILTER (WHERE resolved_by_human)::integer AS resolved_by_human,
      count(*) FILTER (WHERE resolved_by_ai)::integer AS resolved_by_ai
      FROM voice_sms_queue_projection
      WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND channel=${input.channel} AND materialized=true`;
    const metrics = queueMetrics(metricsRows[0]);
    const total = metricTotal(metrics, input.filter);
    const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)));
    const offset = (page - 1) * input.pageSize;
    const rows = await tx<QueueProjectionRow[]>`SELECT conversation.*,policy.revision AS policy_revision,policy.suppressed AS policy_suppressed,
      projection.materialized,projection.needs_follow_up,
      (projection.channel='voice' AND projection.phase='active' AND projection.voice_lease_until>CURRENT_TIMESTAMP) AS active_now,
      projection.connected_to_staff,projection.resolved_by_human,projection.resolved_by_ai,projection.phase,projection.voice_lease_until
      FROM voice_sms_queue_projection projection
      JOIN voice_sms_conversations conversation ON conversation.practice_id=projection.practice_id AND conversation.instance_id=projection.instance_id AND conversation.id=projection.conversation_id
      JOIN voice_sms_contact_policy policy ON policy.contact_key=conversation.contact_key
      WHERE projection.practice_id=${input.practiceId} AND projection.instance_id=${input.instanceId} AND projection.channel=${input.channel} AND projection.materialized=true
        AND CASE ${input.filter}
          WHEN 'total' THEN true
          WHEN 'active_now' THEN projection.channel='voice' AND projection.phase='active' AND projection.voice_lease_until>CURRENT_TIMESTAMP
          WHEN 'needs_follow_up' THEN projection.needs_follow_up
          WHEN 'connected_to_staff' THEN projection.connected_to_staff
          WHEN 'resolved_by_human' THEN projection.resolved_by_human
          WHEN 'resolved_by_ai' THEN projection.resolved_by_ai
          ELSE false
        END
      ORDER BY projection.created_at DESC,projection.conversation_id DESC LIMIT ${input.pageSize} OFFSET ${offset}`;
    return { channel: input.channel, filter: input.filter, page, pageSize: input.pageSize, total, metrics,
      rows: rows.map((row) => this.synchronizePolicy(row, { revision: row.policy_revision!, suppressed: row.policy_suppressed! })) };
    }) as Promise<ConversationQueueProjection>;
  }
  async queryHistory(raw: { scope: ConversationScope; channel: "voice" | "sms" }): Promise<ConversationHistoryProjection> {
    const input = historyQuerySchema.parse(raw);
    const unavailable = (): ConversationHistoryProjection => ({ channel: input.channel, availability: "unavailable", unavailableReason: "projection_incomplete",
      earliestRetainedAt: null, latestRetainedAt: null, retainedCount: 0, priorCount: 0, recent: [], numberMatchDoesNotEstablishIdentity: true });
    return this.sql.begin("isolation level repeatable read read only", async (tx) => {
    const incomplete = await tx<{ incomplete: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM voice_sms_conversations conversation LEFT JOIN voice_sms_queue_projection projection
        ON projection.practice_id=conversation.practice_id AND projection.instance_id=conversation.instance_id AND projection.conversation_id=conversation.id
      WHERE conversation.practice_id=${input.scope.practiceId} AND conversation.instance_id=${input.scope.instanceId} AND conversation.channel=${input.channel}
        AND (projection.conversation_id IS NULL OR projection.materialized=false OR projection.snapshot_revision<>conversation.revision)
    ) AS incomplete`;
    if (incomplete[0]?.incomplete) return unavailable();
    const target = await tx<{ contact_key: string }[]>`SELECT contact_key FROM voice_sms_queue_projection
      WHERE practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND conversation_id=${input.scope.conversationId}
        AND channel=${input.channel} AND materialized=true`;
    if (target[0] === undefined) return unavailable();
    const coverage = await tx<{ earliest: Date | null; latest: Date | null; total: number }[]>`SELECT min(created_at) AS earliest,max(created_at) AS latest,count(*)::integer AS total
      FROM voice_sms_queue_projection WHERE practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND channel=${input.channel} AND materialized=true`;
    const prior = await tx<(QueueProjectionRow & { prior_count: number })[]>`SELECT conversation.*,policy.revision AS policy_revision,policy.suppressed AS policy_suppressed,
      projection.materialized,projection.needs_follow_up,
      (projection.channel='voice' AND projection.phase='active' AND projection.voice_lease_until>CURRENT_TIMESTAMP) AS active_now,
      projection.connected_to_staff,projection.resolved_by_human,projection.resolved_by_ai,projection.phase,projection.voice_lease_until,
      count(*) OVER()::integer AS prior_count
      FROM voice_sms_queue_projection projection
      JOIN voice_sms_conversations conversation ON conversation.practice_id=projection.practice_id AND conversation.instance_id=projection.instance_id AND conversation.id=projection.conversation_id
      JOIN voice_sms_contact_policy policy ON policy.contact_key=conversation.contact_key
      WHERE projection.practice_id=${input.scope.practiceId} AND projection.instance_id=${input.scope.instanceId} AND projection.channel=${input.channel}
        AND projection.contact_key=${target[0].contact_key} AND projection.materialized=true AND projection.conversation_id<>${input.scope.conversationId}
      ORDER BY projection.created_at DESC,projection.conversation_id DESC LIMIT 5`;
    try {
      const current = coverage[0]!;
      const recent = prior.map((row) => {
        const conversation = this.synchronizePolicy(row, { revision: row.policy_revision!, suppressed: row.policy_suppressed! });
        return { conversationId: conversation.id, createdAt: dateString(row.created_at), updatedAt: dateString(row.updated_at), phase: conversation.phase,
          nextStep: historyNextStep(conversation), requestSummary: historySummary(conversation) };
      });
      return { channel: input.channel, availability: "available", unavailableReason: null,
        earliestRetainedAt: current.earliest === null ? null : dateString(current.earliest), latestRetainedAt: current.latest === null ? null : dateString(current.latest),
        retainedCount: current.total, priorCount: prior[0]?.prior_count ?? 0, recent, numberMatchDoesNotEstablishIdentity: true };
    } catch {
      return { ...unavailable(), unavailableReason: "snapshot_unavailable" };
    }
    }) as Promise<ConversationHistoryProjection>;
  }
  async subscribe(scope: { practiceId: string; instanceId: string }, listener: (change: { conversationId: string; revision: number }) => void): Promise<() => Promise<void>> {
    const subscription = await this.sql.listen("vegas_voice_sms_changed", (payload) => {
      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        if (event.practiceId === scope.practiceId && event.instanceId === scope.instanceId && typeof event.conversationId === "string" && Number.isSafeInteger(event.revision)) {
          listener({ conversationId: event.conversationId, revision: event.revision as number });
        }
      } catch { /* Invalid notifications carry no authority; clients reconcile from a scoped snapshot. */ }
    });
    return async () => { await subscription.unlisten(); };
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function queueMetrics(row: QueueMetricsRow | undefined): QueueMetricCounts {
  return { total: row?.total ?? 0, activeNow: row?.active_now ?? 0, needsFollowUp: row?.needs_follow_up ?? 0,
    connectedToStaff: row?.connected_to_staff ?? 0, resolvedByHuman: row?.resolved_by_human ?? 0, resolvedByAi: row?.resolved_by_ai ?? 0 };
}

function metricTotal(metrics: QueueMetricCounts, filter: QueueFilter): number {
  switch (filter) {
    case "total": return metrics.total;
    case "active_now": return metrics.activeNow;
    case "needs_follow_up": return metrics.needsFollowUp;
    case "connected_to_staff": return metrics.connectedToStaff;
    case "resolved_by_human": return metrics.resolvedByHuman;
    case "resolved_by_ai": return metrics.resolvedByAi;
  }
}

function dateString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("queue_projection_time_invalid");
  return date.toISOString();
}

function localWhatsappControl(body: string): "STOP" | "START" | "HELP" | undefined {
  const value = body.trim().toUpperCase();
  return value === "STOP" || value === "START" || value === "HELP" ? value : undefined;
}

export function requestSourceSummary(conversation: Conversation, request: Conversation["requests"][number] | undefined): string | null {
  if (request === undefined) return null;
  const sourceIds = new Set(request.sourceIds);
  const related = conversation.inputs
    .filter((input) => sourceIds.has(input.id) && input.body.trim().length > 0)
    .sort((a, b) => a.sequence - b.sequence);
  const originalId = related.find((input) => input.body === request.originalRequest)?.id ?? related[0]?.id;
  const sourced = related.filter((input) => input.questionId === undefined || input.id === originalId);
  const unique = sourced.filter((input) => {
    if (!sourceIds.delete(input.id)) return false;
    return true;
  });
  if (unique.length === 0) return boundedSummary(request.originalRequest.trim());
  const selected = unique.length <= 4 ? unique : [...unique.slice(0, 2), ...unique.slice(-2)];
  const omission = unique.length > 4 ? `[${unique.length - 4} earlier messages omitted]` : null;
  const separator = " · ";
  const segmentCount = selected.length + (omission === null ? 0 : 1);
  const budget = 500 - separator.length * (segmentCount - 1) - (omission?.length ?? 0);
  const perSource = Math.floor(budget / selected.length);
  const segments = selected.map((input) => boundedSummary(input.body.trim(), perSource)!);
  if (omission !== null) segments.splice(2, 0, omission);
  return segments.join(separator);
}

function boundedSummary(value: string, limit = 500): string | null {
  if (value.length === 0) return null;
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function historySummary(conversation: Conversation): string | null {
  return requestSourceSummary(conversation, conversation.requests.at(-1))
    ?? boundedSummary(conversation.inputs.at(-1)?.body.trim() ?? "");
}
