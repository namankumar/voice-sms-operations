import { parseReceptionistCandidateFixtureId } from "./receptionist-voice-candidate.js";
import postgres from "postgres";
import { z } from "zod";

import type { Admission } from "./conversation-contract.js";
import type { ConversationCipher } from "./conversation-store.js";

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const maxFixtureTtlMs = 15 * 60_000;
export const controlledSyntheticVoiceFixtureSchema = z.object({
  id: z.string().regex(/^fixture_[A-Za-z0-9_-]{1,160}$/), practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200),
  accountId: z.string().min(1).max(200), parentCallId: z.string().regex(/^CA[a-fA-F0-9]{32}$/), caller: phone, destination: phone,
  issuedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }), outcome: z.literal("demo_closed"),
}).strict().superRefine((value, context) => {
  const ttl = Date.parse(value.expiresAt) - Date.parse(value.issuedAt);
  if (ttl <= 0 || ttl > maxFixtureTtlMs) context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "fixture_expiry_invalid" });
});
export type ControlledSyntheticVoiceFixture = z.infer<typeof controlledSyntheticVoiceFixtureSchema>;
export type ControlledHoursClaim = NonNullable<Admission["controlledHours"]>;

export type ControlledSyntheticVoiceFixturePort = {
  provision(input: readonly ControlledSyntheticVoiceFixture[]): Promise<void>;
  claim(input: { practiceId: string; instanceId: string; accountId: string; parentCallId: string; caller: string; destination: string; now: string }): Promise<ControlledHoursClaim | null>;
  bind(input: { fixtureId: string; practiceId: string; instanceId: string; parentCallId: string; conversationId: string }): Promise<void>;
  close(): Promise<void>;
};

/** Internal-only durable fixture receipt. Signed carrier admission is its sole consumer. */
export class PostgresControlledSyntheticVoiceFixtures implements ControlledSyntheticVoiceFixturePort {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher) {
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "healthagents-controlled-fixtures" } });
  }
  private binding(kind: "caller" | "destination", value: string): string { return this.cipher.digest(["controlled-synthetic-voice-fixture", kind, value]); }
  async provision(raw: readonly ControlledSyntheticVoiceFixture[]): Promise<void> {
    const fixtures = raw.map((value) => controlledSyntheticVoiceFixtureSchema.parse(value));
    if (new Set(fixtures.map((value) => value.id)).size !== fixtures.length) throw new Error("controlled_fixture_duplicate_id");
    await this.sql.begin(async (tx) => { for (const fixture of fixtures) {
      const rows = await tx<{ id: string }[]>`INSERT INTO controlled_synthetic_voice_fixtures(
      id,practice_id,instance_id,account_id,expected_parent_call_id,caller_binding_hash,destination_binding_hash,outcome,issued_at,expires_at
    ) VALUES (${fixture.id},${fixture.practiceId},${fixture.instanceId},${fixture.accountId},${fixture.parentCallId},${this.binding("caller", fixture.caller)},${this.binding("destination", fixture.destination)},${fixture.outcome},${fixture.issuedAt}::timestamptz,${fixture.expiresAt}::timestamptz)
    ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id WHERE controlled_synthetic_voice_fixtures.practice_id=EXCLUDED.practice_id
      AND controlled_synthetic_voice_fixtures.instance_id=EXCLUDED.instance_id AND controlled_synthetic_voice_fixtures.account_id=EXCLUDED.account_id
      AND controlled_synthetic_voice_fixtures.expected_parent_call_id=EXCLUDED.expected_parent_call_id
      AND controlled_synthetic_voice_fixtures.caller_binding_hash=EXCLUDED.caller_binding_hash AND controlled_synthetic_voice_fixtures.destination_binding_hash=EXCLUDED.destination_binding_hash
      AND controlled_synthetic_voice_fixtures.outcome=EXCLUDED.outcome AND controlled_synthetic_voice_fixtures.issued_at=EXCLUDED.issued_at AND controlled_synthetic_voice_fixtures.expires_at=EXCLUDED.expires_at
    RETURNING id`;
      if (rows.length !== 1) throw new Error("controlled_fixture_provision_conflict");
    } });
  }
  async claim(input: { practiceId: string; instanceId: string; accountId: string; parentCallId: string; caller: string; destination: string; now: string }): Promise<ControlledHoursClaim | null> {
    return await this.sql.begin(async (tx) => {
      const rows = await tx<{ id: string; issued_at: Date; expires_at: Date; outcome: "demo_closed"; consumed_parent_call_id: string | null }[]>`SELECT id,issued_at,expires_at,outcome,consumed_parent_call_id FROM controlled_synthetic_voice_fixtures
        WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND account_id=${input.accountId}
          AND expected_parent_call_id=${input.parentCallId} AND caller_binding_hash=${this.binding("caller", input.caller)} AND destination_binding_hash=${this.binding("destination", input.destination)}
          AND (consumed_parent_call_id=${input.parentCallId} OR (consumed_at IS NULL AND issued_at<=${input.now}::timestamptz AND expires_at>${input.now}::timestamptz))
        ORDER BY issued_at,id FOR UPDATE LIMIT 2`;
      if (rows.length > 1) throw new Error("controlled_fixture_ambiguous");
      const row = rows[0]; if (row === undefined) return null;
      if (row.consumed_parent_call_id === null) await tx`UPDATE controlled_synthetic_voice_fixtures SET consumed_parent_call_id=${input.parentCallId},consumed_at=${input.now}::timestamptz WHERE id=${row.id} AND consumed_at IS NULL`;
      const parsedCandidate = parseReceptionistCandidateFixtureId(row.id);
      if (parsedCandidate.kind === "invalid") throw new Error("voice_candidate_fixture_invalid");
      return { fixtureId: row.id, parentCallId: input.parentCallId, issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(),
        outcome: parsedCandidate.kind === "candidate" ? parsedCandidate.binding.hoursFixture : row.outcome,
        ...(parsedCandidate.kind === "candidate" ? { candidate: parsedCandidate.binding } : {}) };
    });
  }
  async bind(input: { fixtureId: string; practiceId: string; instanceId: string; parentCallId: string; conversationId: string }): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`UPDATE controlled_synthetic_voice_fixtures SET conversation_id=${input.conversationId}::uuid,bound_at=now()
      WHERE id=${input.fixtureId} AND practice_id=${input.practiceId} AND instance_id=${input.instanceId}
        AND consumed_parent_call_id=${input.parentCallId} AND (conversation_id IS NULL OR conversation_id=${input.conversationId}::uuid)
      RETURNING id`;
    if (rows.length !== 1) throw new Error("controlled_fixture_binding_rejected");
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 5 }); }
}
