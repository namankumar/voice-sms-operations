import { parseReceptionistCandidateAttemptId } from "./receptionist-voice-candidate.js";
import postgres from "postgres";
import { z } from "zod";

import type { ConversationCipher } from "./conversation-store.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const callId = z.string().regex(/^CA[a-fA-F0-9]{32}$/);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const digits = z.string().regex(/^(?:\d{4}|\d{24})$/);
const maxTtlMs = 150_000;
const scope = z.object({ practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200) }).strict();

export type ControlledVoiceRendezvousPort = {
  /** Read-only startup guard for the optional P06/P07 control tables. */
  ready(input: { voiceFixtures: boolean; callbackFailures: boolean }): Promise<void>;
  provision(input: { attemptId: string; scope: z.infer<typeof scope>; accountId: string; caller: string; destination: string; digits: string; expiresAt: string }): Promise<void>;
  claimChallenge(input: { scope: z.infer<typeof scope>; accountId: string; caller: string; destination: string; parentCallId: string; now: string; admissionMode?: "full" | "receptionist"; candidateProfileSha256?: string }): Promise<{ attemptId: string } | { rejected: true } | null>;
  redeem(input: { attemptId: string; scope: z.infer<typeof scope>; accountId: string; caller: string; destination: string; parentCallId: string; digits: string; now: string; admissionMode?: "full" | "receptionist"; candidateProfileSha256?: string }): Promise<{ attemptId: string; parentCallId: string } | null>;
  markRedirected(input: { attemptId: string; scope: z.infer<typeof scope>; parentCallId: string }): Promise<boolean>;
  cancel(input: { attemptId: string; scope: z.infer<typeof scope> }): Promise<boolean>;
  readBinding(input: { attemptId: string; scope: z.infer<typeof scope> }): Promise<{ parentCallId: string; conversationId: string | null } | null>;
  bindConversation(input: { attemptId: string; scope: z.infer<typeof scope>; parentCallId: string; conversationId: string }): Promise<void>;
  close(): Promise<void>;
};

export class PostgresControlledVoiceRendezvous implements ControlledVoiceRendezvousPort {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher) { this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-voice-rendezvous" } }); }
  private hash(kind: string, value: string): string { return this.cipher.digest(["controlled-voice-rendezvous", kind, value]); }
  async ready(raw: Parameters<ControlledVoiceRendezvousPort["ready"]>[0]): Promise<void> {
    const input = z.object({ voiceFixtures: z.boolean(), callbackFailures: z.boolean() }).strict().parse(raw);
    const required = new Map<string, readonly string[]>([
      ...(input.voiceFixtures ? [
        ["controlled_synthetic_voice_fixtures", ["id", "expected_parent_call_id", "caller_binding_hash", "destination_binding_hash", "consumed_at", "conversation_id"]] as const,
        ["controlled_voice_rendezvous_attempts", ["id", "state", "challenged_parent_call_id", "bound_parent_call_id", "conversation_id"]] as const,
      ] : []),
      ...(input.callbackFailures ? [["controlled_callback_save_failures", ["id", "conversation_id", "request_id", "consumed_at"]] as const] : []),
    ]);
    const tablesToCheck = [...required.keys()];
    if (tablesToCheck.length === 0) return;
    const tableList = tablesToCheck.join(",");
    const tables = await this.sql<{ name: string; present: string | null }[]>`SELECT name,to_regclass('public.' || name)::text AS present
      FROM unnest(string_to_array(${tableList},',')) AS name`;
    if (tables.some((table) => required.has(table.name) && table.present === null)) throw new Error("controlled_voice_control_schema_not_ready");
    const columns = await this.sql<{ table_name: string; column_name: string }[]>`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=ANY(string_to_array(${tableList},','))`;
    const available = new Set(columns.map((column) => `${column.table_name}.${column.column_name}`));
    for (const [table, names] of required) if (names.some((name) => !available.has(`${table}.${name}`))) throw new Error("controlled_voice_control_schema_not_ready");
  }
  async provision(raw: Parameters<ControlledVoiceRendezvousPort["provision"]>[0]): Promise<void> {
    const input = z.object({ attemptId: id, scope, accountId: z.string().min(1).max(200), caller: phone, destination: phone, digits, expiresAt: z.string().datetime({ offset: true }) }).strict().parse(raw);
    const attempt = parseReceptionistCandidateAttemptId(input.attemptId);
    if (attempt.kind === "invalid") throw new Error("voice_candidate_attempt_invalid");
    if (input.digits.length !== (attempt.kind === "candidate" && attempt.binding.version === "vvc2" ? 4 : 24)) throw new Error("controlled_voice_digits_invalid");
    const expires = Date.parse(input.expiresAt), now = Date.now(); if (!Number.isFinite(expires) || expires <= now || expires - now > maxTtlMs) throw new Error("controlled_voice_rendezvous_expiry_invalid");
    const rows = await this.sql<{ id: string }[]>`INSERT INTO controlled_voice_rendezvous_attempts(id,practice_id,instance_id,account_id,caller_binding_hash,destination_binding_hash,digits_hash,expires_at)
      VALUES (${input.attemptId},${input.scope.practiceId},${input.scope.instanceId},${input.accountId},${this.hash("caller", input.caller)},${this.hash("destination", input.destination)},${this.hash("digits", input.digits)},${input.expiresAt}::timestamptz)
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (rows.length !== 1) throw new Error("controlled_voice_rendezvous_provision_conflict");
  }
  async claimChallenge(raw: Parameters<ControlledVoiceRendezvousPort["claimChallenge"]>[0]) {
    const input = z.object({ scope, accountId: z.string().min(1).max(200), caller: phone, destination: phone, parentCallId: callId, now: z.string().datetime({ offset: true }), admissionMode: z.enum(["full", "receptionist"]).optional(), candidateProfileSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).strict().parse(raw);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; challenged_parent_call_id: string | null; expires_at: Date }[]>`SELECT id,challenged_parent_call_id,expires_at FROM controlled_voice_rendezvous_attempts WHERE practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND account_id=${input.accountId} AND caller_binding_hash=${this.hash("caller", input.caller)} AND destination_binding_hash=${this.hash("destination", input.destination)} AND state IN ('pending','awaiting_digits') AND expires_at>${input.now}::timestamptz ORDER BY expires_at,id FOR UPDATE LIMIT 2`;
      const candidateRows = rows.filter(row => parseReceptionistCandidateAttemptId(row.id).kind !== "legacy");
      if (rows.length !== 1) return candidateRows.length ? { rejected: true as const } : null;
      const candidate = parseReceptionistCandidateAttemptId(rows[0]!.id);
      if (candidate.kind === "invalid" || candidate.kind === "candidate" && (input.admissionMode !== "receptionist"
        || input.candidateProfileSha256 !== candidate.binding.profileSha256 || rows[0]!.expires_at.getTime() <= Date.parse(input.now))) return { rejected: true as const };
      if (candidate.kind === "legacy" && input.admissionMode === "receptionist") return null;
      if (rows[0]!.challenged_parent_call_id !== null && rows[0]!.challenged_parent_call_id !== input.parentCallId) return candidate.kind === "candidate" ? { rejected: true as const } : null;
      const row = rows[0]!;
      if (row.challenged_parent_call_id === null) await tx`UPDATE controlled_voice_rendezvous_attempts SET state='awaiting_digits',challenged_parent_call_id=${input.parentCallId},challenged_at=${input.now}::timestamptz WHERE id=${row.id} AND state='pending'`;
      return { attemptId: row.id };
    });
  }
  async redeem(raw: Parameters<ControlledVoiceRendezvousPort["redeem"]>[0]) {
    const input = z.object({ attemptId: id, scope, accountId: z.string().min(1).max(200), caller: phone, destination: phone, parentCallId: callId, digits, now: z.string().datetime({ offset: true }), admissionMode: z.enum(["full", "receptionist"]).optional(), candidateProfileSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).strict().parse(raw);
    const candidate = parseReceptionistCandidateAttemptId(input.attemptId);
    if (candidate.kind === "invalid" || candidate.kind === "candidate" && (input.admissionMode !== "receptionist" || candidate.binding.profileSha256 !== input.candidateProfileSha256)
      || candidate.kind === "legacy" && input.admissionMode === "receptionist" || input.digits.length !== (candidate.kind === "candidate" && candidate.binding.version === "vvc2" ? 4 : 24)) return null;
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ state: string; bound_parent_call_id: string | null }[]>`SELECT state,bound_parent_call_id FROM controlled_voice_rendezvous_attempts WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND account_id=${input.accountId} AND caller_binding_hash=${this.hash("caller", input.caller)} AND destination_binding_hash=${this.hash("destination", input.destination)} AND digits_hash=${this.hash("digits", input.digits)} AND challenged_parent_call_id=${input.parentCallId} AND expires_at>${input.now}::timestamptz FOR UPDATE`;
      const row = rows[0]; if (row === undefined) return null;
      if ((row.state === "confirmed" || row.state === "redirected") && row.bound_parent_call_id === input.parentCallId) return { attemptId: input.attemptId, parentCallId: input.parentCallId };
      if (row.state !== "awaiting_digits") return null;
      const fixtureId = `fixture_${input.attemptId}`;
      const fixture = await tx<{ id: string }[]>`INSERT INTO controlled_synthetic_voice_fixtures(id,practice_id,instance_id,account_id,expected_parent_call_id,caller_binding_hash,destination_binding_hash,outcome,issued_at,expires_at)
        VALUES (${fixtureId},${input.scope.practiceId},${input.scope.instanceId},${input.accountId},${input.parentCallId},${this.cipher.digest(["controlled-synthetic-voice-fixture","caller",input.caller])},${this.cipher.digest(["controlled-synthetic-voice-fixture","destination",input.destination])},'demo_closed',${input.now}::timestamptz,${input.now}::timestamptz + interval '150 seconds') RETURNING id`;
      if (fixture.length !== 1) throw new Error("controlled_voice_rendezvous_fixture_rejected");
      const confirmed = await tx<{ id: string }[]>`UPDATE controlled_voice_rendezvous_attempts SET state='confirmed',bound_parent_call_id=${input.parentCallId},consumed_at=${input.now}::timestamptz WHERE id=${input.attemptId} AND state='awaiting_digits' RETURNING id`;
      return confirmed.length === 1 ? { attemptId: input.attemptId, parentCallId: input.parentCallId } : null;
    });
  }
  async markRedirected(raw: Parameters<ControlledVoiceRendezvousPort["markRedirected"]>[0]): Promise<boolean> {
    const input = z.object({ attemptId: id, scope, parentCallId: callId }).strict().parse(raw);
    const rows = await this.sql<{ id: string }[]>`UPDATE controlled_voice_rendezvous_attempts SET state='redirected' WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND bound_parent_call_id=${input.parentCallId} AND state IN ('confirmed','redirected') RETURNING id`;
    return rows.length === 1;
  }
  /** Run-exit cleanup may only make an unconfirmed operator attempt inert. */
  async cancel(raw: Parameters<ControlledVoiceRendezvousPort["cancel"]>[0]): Promise<boolean> {
    const input = z.object({ attemptId: id, scope }).strict().parse(raw);
    const rows = await this.sql<{ id: string }[]>`UPDATE controlled_voice_rendezvous_attempts SET state='inconclusive',expires_at=now()
      WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId}
        AND state IN ('pending','awaiting_digits') RETURNING id`;
    return rows.length === 1;
  }
  async readBinding(raw: Parameters<ControlledVoiceRendezvousPort["readBinding"]>[0]): Promise<{ parentCallId: string; conversationId: string | null } | null> { const input = z.object({ attemptId: id, scope }).strict().parse(raw); const rows = await this.sql<{ bound_parent_call_id: string | null; conversation_id: string | null }[]>`SELECT bound_parent_call_id,conversation_id FROM controlled_voice_rendezvous_attempts WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND state IN ('confirmed','redirected')`; const row = rows[0]; return row?.bound_parent_call_id === null || row === undefined ? null : { parentCallId: row.bound_parent_call_id, conversationId: row.conversation_id }; }
  async bindConversation(raw: Parameters<ControlledVoiceRendezvousPort["bindConversation"]>[0]) { const input = z.object({ attemptId: id, scope, parentCallId: callId, conversationId: z.string().uuid() }).strict().parse(raw); const rows = await this.sql<{ id: string }[]>`UPDATE controlled_voice_rendezvous_attempts SET conversation_id=${input.conversationId}::uuid,bound_at=now() WHERE id=${input.attemptId} AND practice_id=${input.scope.practiceId} AND instance_id=${input.scope.instanceId} AND bound_parent_call_id=${input.parentCallId} AND (conversation_id IS NULL OR conversation_id=${input.conversationId}::uuid) RETURNING id`; if (rows.length !== 1) throw new Error("controlled_voice_rendezvous_binding_rejected"); }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}
