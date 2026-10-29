import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { conversationScopeSchema, type ConversationScope } from "./conversation-contract.js";
import type { ConversationCipher } from "./conversation-store.js";

export const conversationJobKinds = ["sms_turn", "sms_send", "sms_receipt", "voice_accept", "voice_recovery", "stub_timeout", "post_call_eval"] as const;
export type ConversationJobKind = typeof conversationJobKinds[number];
export type ConversationJobState = "pending" | "running" | "succeeded" | "failed" | "outcome_unknown" | "canceled";
export const conversationJobResultCodes = ["completed", "not_needed", "provider_accepted", "provider_delivered", "provider_undelivered", "provider_failed", "provider_unknown", "recovery_attached", "recovery_failed"] as const;
export type ConversationJobResultCode = typeof conversationJobResultCodes[number];
const evidenceIdSchema = z.string().trim().min(1).max(200);
const conversationJobResultSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("completed") }).strict(),
  z.object({ code: z.literal("not_needed") }).strict(),
  z.object({ code: z.literal("provider_accepted"), providerId: evidenceIdSchema, attemptId: evidenceIdSchema, state: z.literal("accepted") }).strict(),
  z.object({ code: z.literal("provider_delivered"), providerId: evidenceIdSchema, attemptId: evidenceIdSchema, state: z.literal("delivered") }).strict(),
  z.object({ code: z.literal("provider_undelivered"), providerId: evidenceIdSchema, attemptId: evidenceIdSchema, state: z.literal("undelivered") }).strict(),
  z.object({ code: z.literal("provider_failed"), providerId: evidenceIdSchema.optional(), attemptId: evidenceIdSchema.optional(), state: z.literal("failed").optional() }).strict(),
  z.object({ code: z.literal("provider_unknown"), providerId: evidenceIdSchema.optional(), attemptId: evidenceIdSchema.optional(), state: z.literal("unknown").optional() }).strict(),
  z.object({ code: z.literal("recovery_attached"), providerId: evidenceIdSchema, attemptId: evidenceIdSchema }).strict(),
  z.object({ code: z.literal("recovery_failed"), providerId: evidenceIdSchema.optional(), attemptId: evidenceIdSchema.optional() }).strict(),
]);
export type ConversationJobResult = z.infer<typeof conversationJobResultSchema>;

export type EnqueueConversationJobInput = {
  scope: ConversationScope;
  kind: ConversationJobKind;
  key: string;
  payload: unknown;
  availableAt: string;
  now?: string;
};
export type ConversationJob = {
  id: string;
  scope: ConversationScope;
  kind: ConversationJobKind;
  state: ConversationJobState;
  attemptCount: number;
  availableAt: string;
  payload: unknown;
  leaseToken: string | null;
  leaseUntil: string | null;
  resultCode: ConversationJobResultCode | null;
  result: ConversationJobResult | null;
};
export type ClaimedConversationJob = ConversationJob & { leaseToken: string; leaseUntil: string };
export type RecordConversationJobLateEvidenceInput = {
  scope: ConversationScope;
  jobId: string;
  kind: ConversationJobKind;
  leaseToken: string;
  observedAt: string;
  result: ConversationJobResult;
};
export type ConversationJobLateEvidence = {
  scope: ConversationScope;
  jobId: string;
  kind: ConversationJobKind;
  leaseToken: string;
  resultDigest: string;
  observedAt: string;
  result: ConversationJobResult;
};

type JobRow = {
  id: string;
  practice_id: string;
  instance_id: string;
  conversation_id: string;
  kind: ConversationJobKind;
  protected_payload: unknown;
  state: ConversationJobState;
  attempt_count: number;
  available_at: string;
  lease_token: string | null;
  lease_until: string | null;
  result_code: string | null;
  protected_result: unknown;
};
type EvidenceRow = {
  practice_id: string;
  instance_id: string;
  conversation_id: string;
  job_id: string;
  kind: ConversationJobKind;
  lease_token: string;
  result_digest: string;
  observed_at: string;
  protected_result: unknown;
};

/** Enqueue inside an existing conversation transaction so input/event and job publication commit together. */
export async function enqueueConversationJob(tx: postgres.TransactionSql, cipher: ConversationCipher, raw: EnqueueConversationJobInput): Promise<ConversationJob> {
  const input = parseEnqueue(raw);
  const jobId = cipher.digest({ scope: input.scope, kind: input.kind, key: input.key });
  const payloadHash = cipher.digest(input.payload);
  const now = input.now ?? new Date().toISOString();
  const payload = cipher.protect(input.payload, jobBinding(input.scope, jobId, "payload"));
  const inserted = await tx<JobRow[]>`INSERT INTO voice_sms_jobs(id,practice_id,instance_id,conversation_id,kind,payload_hash,protected_payload,state,available_at,created_at,updated_at)
    VALUES (${jobId},${input.scope.practiceId},${input.scope.instanceId},${input.scope.conversationId},${input.kind},${payloadHash},${tx.json(payload as postgres.JSONValue)},'pending',${input.availableAt}::timestamptz,${now}::timestamptz,${now}::timestamptz)
    ON CONFLICT (id) DO NOTHING
    RETURNING id,practice_id,instance_id,conversation_id,kind,protected_payload,state,attempt_count,available_at,lease_token,lease_until,result_code,protected_result`;
  if (inserted[0] !== undefined) return decodeJob(cipher, inserted[0]);
  const prior = await tx<(JobRow & { payload_hash: string })[]>`SELECT id,practice_id,instance_id,conversation_id,kind,payload_hash,protected_payload,state,attempt_count,available_at,lease_token,lease_until,result_code,protected_result
    FROM voice_sms_jobs WHERE id=${jobId} FOR UPDATE`;
  if (prior[0] === undefined) throw new Error("conversation_job_missing_after_conflict");
  if (prior[0].payload_hash !== payloadHash) throw new Error("conversation_job_payload_conflict");
  return decodeJob(cipher, prior[0]);
}

export class PostgresConversationJobs {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher, private readonly clock: () => Date = () => new Date()) {
    this.sql = postgres(databaseUrl, { max: 5, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "vegas-conversation-jobs" } });
  }

  async enqueue(input: EnqueueConversationJobInput): Promise<ConversationJob> {
    const now = input.now ?? this.clock().toISOString();
    return await this.sql.begin(async (tx) => enqueueConversationJob(tx, this.cipher, { ...input, now })) as ConversationJob;
  }

  async claim(input: { practiceId: string; instanceId: string; now: string; leaseMs: number; kinds?: readonly ConversationJobKind[] }): Promise<ClaimedConversationJob | null> {
    const now = parseTime(input.now, "conversation_job_time_invalid");
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 300_000) throw new Error("conversation_job_lease_invalid");
    const kinds = parseClaimKinds(input.kinds);
    const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString();
    const leaseToken = randomUUID();
    return await this.sql.begin(async (tx) => {
      await tx`UPDATE voice_sms_jobs job SET state='outcome_unknown',lease_token=NULL,lease_until=NULL,updated_at=${input.now}::timestamptz
        WHERE job.practice_id=${input.practiceId} AND job.instance_id=${input.instanceId} AND job.state='running' AND job.lease_until <= ${input.now}::timestamptz
          AND job.kind IN ('sms_send','voice_accept','voice_recovery')
          AND EXISTS (SELECT 1 FROM voice_sms_job_effects effect
            WHERE effect.practice_id=job.practice_id AND effect.instance_id=job.instance_id AND effect.conversation_id=job.conversation_id
              AND effect.job_id=job.id AND effect.lease_token=job.lease_token)`;
      await tx`UPDATE voice_sms_jobs job SET state=CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,available_at=CASE WHEN attempt_count >= 3 THEN available_at ELSE ${input.now}::timestamptz END,updated_at=${input.now}::timestamptz
        WHERE job.practice_id=${input.practiceId} AND job.instance_id=${input.instanceId} AND job.state='running' AND job.lease_until <= ${input.now}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM voice_sms_job_effects effect
            WHERE effect.practice_id=job.practice_id AND effect.instance_id=job.instance_id AND effect.conversation_id=job.conversation_id
              AND effect.job_id=job.id AND effect.lease_token=job.lease_token)`;
      const rows = await tx<JobRow[]>`WITH candidate AS (
          SELECT job.id FROM voice_sms_jobs job
          JOIN voice_sms_conversations conversation
            ON conversation.practice_id=job.practice_id AND conversation.instance_id=job.instance_id AND conversation.id=job.conversation_id
          WHERE job.practice_id=${input.practiceId} AND job.instance_id=${input.instanceId} AND job.state='pending'
            AND job.kind=ANY(${kinds}::text[]) AND job.available_at <= ${input.now}::timestamptz AND job.attempt_count < 3
            AND NOT EXISTS (SELECT 1 FROM voice_sms_jobs active
              WHERE active.practice_id=job.practice_id AND active.instance_id=job.instance_id AND active.conversation_id=job.conversation_id
                AND active.state='running' AND active.lease_until > ${input.now}::timestamptz)
          ORDER BY job.available_at,job.created_at,job.id FOR UPDATE OF job,conversation SKIP LOCKED LIMIT 1
        ) UPDATE voice_sms_jobs job
        SET state='running',attempt_count=job.attempt_count+1,lease_token=${leaseToken}::uuid,lease_until=${leaseUntil}::timestamptz,updated_at=${input.now}::timestamptz
        FROM candidate WHERE job.id=candidate.id
        RETURNING job.id,job.practice_id,job.instance_id,job.conversation_id,job.kind,job.protected_payload,job.state,job.attempt_count,job.available_at,job.lease_token,job.lease_until,job.result_code,job.protected_result`;
      const row = rows[0];
      if (row === undefined) return null;
      const job = decodeJob(this.cipher, row);
      if (job.leaseToken === null || job.leaseUntil === null) throw new Error("conversation_job_claim_missing_lease");
      await tx`INSERT INTO voice_sms_job_leases(practice_id,instance_id,conversation_id,job_id,lease_token,issued_at,lease_until,attempt_count)
        VALUES (${job.scope.practiceId},${job.scope.instanceId},${job.scope.conversationId},${job.id},${job.leaseToken}::uuid,${input.now}::timestamptz,${job.leaseUntil}::timestamptz,${job.attemptCount})`;
      return job as ClaimedConversationJob;
    }) as ClaimedConversationJob | null;
  }

  async markEffectStarted(input: { scope: ConversationScope; id: string; kind: ConversationJobKind; leaseToken: string; attemptId: string; now: string }): Promise<boolean> {
    const scope = conversationScopeSchema.parse(input.scope);
    const now = parseTime(input.now, "conversation_job_time_invalid").toISOString();
    const attemptId = evidenceIdSchema.parse(input.attemptId);
    if (!effectfulKinds.has(input.kind) || !isUuid(input.leaseToken)) return false;
    const rows = await this.sql<{ job_id: string }[]>`WITH current_job AS (
        SELECT id FROM voice_sms_jobs
        WHERE id=${input.id} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}
          AND kind=${input.kind} AND state='running' AND lease_token=${input.leaseToken}::uuid AND lease_until > ${now}::timestamptz
        FOR UPDATE
      ), inserted AS (
        INSERT INTO voice_sms_job_effects(practice_id,instance_id,conversation_id,job_id,lease_token,attempt_id,started_at)
        SELECT ${scope.practiceId},${scope.instanceId},${scope.conversationId},id,${input.leaseToken}::uuid,${attemptId},${now}::timestamptz FROM current_job
        ON CONFLICT (practice_id,instance_id,conversation_id,job_id,lease_token) DO NOTHING
        RETURNING job_id
      ) SELECT job_id FROM inserted
      UNION ALL
      SELECT effect.job_id FROM voice_sms_job_effects effect JOIN current_job ON current_job.id=effect.job_id
      WHERE effect.practice_id=${scope.practiceId} AND effect.instance_id=${scope.instanceId} AND effect.conversation_id=${scope.conversationId}
        AND effect.lease_token=${input.leaseToken}::uuid AND effect.attempt_id=${attemptId}
      LIMIT 1`;
    return rows.length === 1;
  }

  async complete(input: { scope: ConversationScope; id: string; kind: ConversationJobKind; leaseToken: string; now: string; result: ConversationJobResult }): Promise<boolean> {
    const scope = conversationScopeSchema.parse(input.scope);
    const now = parseTime(input.now, "conversation_job_time_invalid").toISOString();
    const result = parseConversationJobResultForKind(input.kind, input.result);
    if (!isUuid(input.leaseToken)) return false;
    const protectedResult = this.cipher.protect(result, jobBinding(scope, input.id, "result"));
    const state = terminalStateForResult(result.code);
    const requiresEffect = requiresStartedEffect(input.kind, result);
    const resultAttemptId = "attemptId" in result ? result.attemptId ?? null : null;
    const rows = await this.sql`UPDATE voice_sms_jobs SET state=${state},lease_token=NULL,lease_until=NULL,result_code=${result.code},protected_result=${this.sql.json(protectedResult as postgres.JSONValue)},updated_at=${now}::timestamptz
      WHERE id=${input.id} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} AND kind=${input.kind}
        AND state='running' AND lease_token=${input.leaseToken}::uuid AND lease_until > ${now}::timestamptz
        AND (${requiresEffect}=false OR EXISTS (SELECT 1 FROM voice_sms_job_effects effect
          WHERE effect.practice_id=${scope.practiceId} AND effect.instance_id=${scope.instanceId} AND effect.conversation_id=${scope.conversationId}
            AND effect.job_id=${input.id} AND effect.lease_token=${input.leaseToken}::uuid))
        AND (${resultAttemptId}::text IS NULL OR EXISTS (SELECT 1 FROM voice_sms_job_effects effect
          WHERE effect.practice_id=${scope.practiceId} AND effect.instance_id=${scope.instanceId} AND effect.conversation_id=${scope.conversationId}
            AND effect.job_id=${input.id} AND effect.lease_token=${input.leaseToken}::uuid AND effect.attempt_id=${resultAttemptId}))
      RETURNING id`;
    return rows.length === 1;
  }

  /** Appends supplemental evidence from an issued scoped lease; it never changes completion authority or job state. */
  async recordLateEvidence(raw: RecordConversationJobLateEvidenceInput): Promise<boolean> {
    const scope = conversationScopeSchema.parse(raw.scope);
    const observedAt = parseTime(raw.observedAt, "conversation_job_time_invalid").toISOString();
    if (!isUuid(raw.leaseToken)) return false;
    const result = parseConversationJobResultForKind(raw.kind, raw.result);
    const requiresEffect = requiresStartedEffect(raw.kind, result);
    const resultAttemptId = "attemptId" in result ? result.attemptId ?? null : null;
    const resultDigest = this.cipher.digest(result);
    const protectedResult = this.cipher.protect(result, evidenceBinding(scope, raw.jobId, raw.leaseToken, resultDigest));
    const rows = await this.sql<{ result_digest: string }[]>`WITH issued_lease AS (
        SELECT lease.job_id FROM voice_sms_job_leases lease JOIN voice_sms_jobs job
          ON job.practice_id=lease.practice_id AND job.instance_id=lease.instance_id AND job.conversation_id=lease.conversation_id AND job.id=lease.job_id
        WHERE lease.practice_id=${scope.practiceId} AND lease.instance_id=${scope.instanceId} AND lease.conversation_id=${scope.conversationId}
          AND lease.job_id=${raw.jobId} AND lease.lease_token=${raw.leaseToken}::uuid AND job.kind=${raw.kind}
          AND (${requiresEffect}=false OR EXISTS (SELECT 1 FROM voice_sms_job_effects effect
            WHERE effect.practice_id=lease.practice_id AND effect.instance_id=lease.instance_id AND effect.conversation_id=lease.conversation_id
              AND effect.job_id=lease.job_id AND effect.lease_token=lease.lease_token))
          AND (${resultAttemptId}::text IS NULL OR EXISTS (SELECT 1 FROM voice_sms_job_effects effect
            WHERE effect.practice_id=lease.practice_id AND effect.instance_id=lease.instance_id AND effect.conversation_id=lease.conversation_id
              AND effect.job_id=lease.job_id AND effect.lease_token=lease.lease_token AND effect.attempt_id=${resultAttemptId}))
      ), inserted AS (
        INSERT INTO voice_sms_job_evidence(practice_id,instance_id,conversation_id,job_id,lease_token,result_digest,observed_at,protected_result)
        SELECT ${scope.practiceId},${scope.instanceId},${scope.conversationId},job_id,${raw.leaseToken}::uuid,${resultDigest},${observedAt}::timestamptz,${this.sql.json(protectedResult as postgres.JSONValue)} FROM issued_lease
        ON CONFLICT (practice_id,instance_id,conversation_id,job_id,lease_token,result_digest) DO NOTHING
        RETURNING result_digest
      ) SELECT result_digest FROM inserted
      UNION ALL
      SELECT evidence.result_digest FROM voice_sms_job_evidence evidence JOIN issued_lease ON evidence.job_id=issued_lease.job_id
      WHERE evidence.practice_id=${scope.practiceId} AND evidence.instance_id=${scope.instanceId} AND evidence.conversation_id=${scope.conversationId} AND evidence.lease_token=${raw.leaseToken}::uuid AND evidence.result_digest=${resultDigest}
      LIMIT 1`;
    return rows.length === 1;
  }

  async getLateEvidence(input: { scope: ConversationScope; jobId: string }): Promise<readonly ConversationJobLateEvidence[]> {
    const scope = conversationScopeSchema.parse(input.scope);
    const rows = await this.sql<EvidenceRow[]>`SELECT evidence.practice_id,evidence.instance_id,evidence.conversation_id,evidence.job_id,job.kind,evidence.lease_token,evidence.result_digest,evidence.observed_at,evidence.protected_result
      FROM voice_sms_job_evidence evidence JOIN voice_sms_jobs job
        ON job.practice_id=evidence.practice_id AND job.instance_id=evidence.instance_id AND job.conversation_id=evidence.conversation_id AND job.id=evidence.job_id
      WHERE evidence.practice_id=${scope.practiceId} AND evidence.instance_id=${scope.instanceId} AND evidence.conversation_id=${scope.conversationId} AND evidence.job_id=${input.jobId}
      ORDER BY evidence.observed_at,evidence.created_at,evidence.result_digest`;
    return rows.map((row) => decodeLateEvidence(this.cipher, row));
  }

  async get(input: { scope: ConversationScope; id: string }): Promise<ConversationJob | null> {
    const scope = conversationScopeSchema.parse(input.scope);
    const rows = await this.sql<JobRow[]>`SELECT id,practice_id,instance_id,conversation_id,kind,protected_payload,state,attempt_count,available_at,lease_token,lease_until,result_code,protected_result
      FROM voice_sms_jobs WHERE id=${input.id} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}`;
    return rows[0] === undefined ? null : decodeJob(this.cipher, rows[0]);
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }
}

function parseEnqueue(raw: EnqueueConversationJobInput): Required<EnqueueConversationJobInput> {
  const scope = conversationScopeSchema.parse(raw.scope);
  if (!conversationJobKinds.includes(raw.kind)) throw new Error("conversation_job_kind_invalid");
  if (typeof raw.key !== "string" || raw.key.trim().length === 0 || raw.key.length > 200) throw new Error("conversation_job_key_invalid");
  assertSerialized(raw.payload, "conversation_job_payload_invalid");
  parseTime(raw.availableAt, "conversation_job_time_invalid");
  const now = raw.now === undefined ? new Date().toISOString() : parseTime(raw.now, "conversation_job_time_invalid").toISOString();
  return { scope, kind: raw.kind, key: raw.key, payload: raw.payload, availableAt: raw.availableAt, now };
}

function decodeJob(cipher: ConversationCipher, row: JobRow): ConversationJob {
  const scope = conversationScopeSchema.parse({ practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.conversation_id });
  if (!conversationJobKinds.includes(row.kind) || !isState(row.state)) throw new Error("conversation_job_row_invalid");
  const payload = cipher.unprotect(row.protected_payload, jobBinding(scope, row.id, "payload"));
  if ((row.result_code === null) !== (row.protected_result === null)) throw new Error("conversation_job_result_invalid");
  const protectedResult = row.protected_result === null ? null : parseConversationJobResult(cipher.unprotect(row.protected_result, jobBinding(scope, row.id, "result")));
  if (protectedResult !== null && protectedResult.code !== row.result_code) throw new Error("conversation_job_result_invalid");
  const resultCode = protectedResult === null ? null : protectedResult.code;
  return { id: row.id, scope, kind: row.kind, state: row.state, attemptCount: row.attempt_count, availableAt: new Date(row.available_at).toISOString(), payload,
    leaseToken: row.lease_token, leaseUntil: row.lease_until === null ? null : new Date(row.lease_until).toISOString(), resultCode, result: protectedResult };
}

function decodeLateEvidence(cipher: ConversationCipher, row: EvidenceRow): ConversationJobLateEvidence {
  const scope = conversationScopeSchema.parse({ practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.conversation_id });
  if (!isUuid(row.lease_token)) throw new Error("conversation_job_evidence_invalid");
  const result = parseConversationJobResultForKind(row.kind, cipher.unprotect(row.protected_result, evidenceBinding(scope, row.job_id, row.lease_token, row.result_digest)));
  if (cipher.digest(result) !== row.result_digest) throw new Error("conversation_job_evidence_invalid");
  return { scope, jobId: row.job_id, kind: row.kind, leaseToken: row.lease_token, resultDigest: row.result_digest, observedAt: new Date(row.observed_at).toISOString(), result };
}

const effectfulKinds = new Set<ConversationJobKind>(["sms_send", "voice_accept", "voice_recovery"]);
function jobBinding(scope: ConversationScope, jobId: string, domain: "payload" | "result") { return { domain, scope, jobId }; }
function evidenceBinding(scope: ConversationScope, jobId: string, leaseToken: string, resultDigest: string) { return { domain: "late_evidence", scope, jobId, leaseToken, resultDigest }; }
function isState(value: string): value is ConversationJobState { return ["pending", "running", "succeeded", "failed", "outcome_unknown", "canceled"].includes(value); }
function terminalStateForResult(code: ConversationJobResultCode): Extract<ConversationJobState, "succeeded" | "failed" | "outcome_unknown"> {
  if (code === "provider_unknown") return "outcome_unknown";
  if (code === "provider_failed" || code === "provider_undelivered" || code === "recovery_failed") return "failed";
  return "succeeded";
}
function parseTime(value: string, code: string): Date { const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new Error(code); return parsed; }
function parseClaimKinds(value: readonly ConversationJobKind[] | undefined): readonly ConversationJobKind[] {
  if (value === undefined) return conversationJobKinds;
  if (!Array.isArray(value) || value.length < 1 || value.length > conversationJobKinds.length) throw new Error("conversation_job_kinds_invalid");
  const allowed = new Set<string>(conversationJobKinds);
  if (new Set(value).size !== value.length || value.some((kind) => !allowed.has(kind))) throw new Error("conversation_job_kinds_invalid");
  return [...value];
}
export function parseConversationJobResult(value: unknown): ConversationJobResult {
  const parsed = conversationJobResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("conversation_job_result_invalid");
  assertSerialized(parsed.data, "conversation_job_result_invalid");
  return parsed.data;
}
export function parseConversationJobResultForKind(kind: ConversationJobKind, value: unknown): ConversationJobResult {
  if (!conversationJobKinds.includes(kind)) throw new Error("conversation_job_kind_invalid");
  const result = parseConversationJobResult(value);
  const allowed = kind === "sms_send"
    ? ["not_needed", "provider_accepted", "provider_delivered", "provider_undelivered", "provider_failed", "provider_unknown"]
    : kind === "voice_accept"
      ? ["not_needed", "provider_accepted", "provider_failed", "provider_unknown"]
      : kind === "voice_recovery"
        ? ["not_needed", "recovery_attached", "recovery_failed", "provider_unknown"]
        : ["completed", "not_needed"];
  if (!allowed.includes(result.code)) throw new Error("conversation_job_result_kind_invalid");
  return result;
}
function requiresStartedEffect(kind: ConversationJobKind, result: ConversationJobResult): boolean {
  return effectfulKinds.has(kind) && result.code !== "not_needed";
}
function assertSerialized(value: unknown, code: string): void {
  try {
    if (!isPlainJson(value)) throw new Error();
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 16 * 1024) throw new Error();
  } catch { throw new Error(code); }
}
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isPlainJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    return value.every(isPlainJson);
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isPlainJson);
}
