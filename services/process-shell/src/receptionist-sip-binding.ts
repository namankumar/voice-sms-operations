import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { conversationSchema, conversationScopeSchema, type ConversationScope } from "./conversation-contract.js";
import { enqueueConversationJob } from "./conversation-jobs.js";
import type { ConversationCipher } from "./conversation-store.js";

const opaque = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const project = z.string().regex(/^proj_[A-Za-z0-9_-]{1,160}$/);
const bindingSchema = z.object({ scope: conversationScopeSchema, attemptId: z.string().uuid(), voiceEpoch: z.number().int().nonnegative(),
  configVersion: z.string().min(1).max(200), parentCallId: z.string().regex(/^CA[a-fA-F0-9]{32}$/), projectId: project,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.string().datetime() }).strict();
export type SipAttemptBinding = z.infer<typeof bindingSchema>;
type AttemptRow = { id: string; practice_id: string; instance_id: string; conversation_id: string; protected_binding: unknown;
  incoming_event_id: string | null; provider_call_id: string | null; close_requested_at: Date | string | null };
type StateRow = { revision: number; protected_state: unknown };
function aad(scope: ConversationScope, attemptId: string) { return { domain: "sip-attempt", ...scope, attemptId }; }

/** Only verified Twilio admission and verified OpenAI webhook code may use this store. */
export class PostgresSipBindings {
  private readonly sql: ReturnType<typeof postgres>;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher, private readonly clock: () => Date = () => new Date()) {
    this.sql = postgres(databaseUrl, { max: 3, connect_timeout: 5, onnotice: () => {}, connection: { application_name: "vegas-sip-binding" } });
  }

  async create(raw: { scope: ConversationScope; projectId: string }): Promise<SipAttemptBinding> {
    const scope = conversationScopeSchema.parse(raw.scope), projectId = project.parse(raw.projectId);
    return await this.sql.begin(async (tx) => {
      const rows = await tx<StateRow[]>`SELECT revision,protected_state FROM voice_sms_conversations WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND id=${scope.conversationId} FOR UPDATE`;
      const state = this.state(scope, rows[0]);
      if (state.phase !== "active" || state.admission.channel !== "voice" || state.providerTier !== "realtime") throw new Error("sip_admission_inactive");
      const existing = await tx<AttemptRow[]>`SELECT * FROM voice_sip_attempts WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} AND voice_epoch=${state.voiceEpoch}`;
      if (existing[0]) {
        const value = this.decode(existing[0]);
        if (value.projectId !== projectId || value.configVersion !== state.admission.configVersion) throw new Error("sip_binding_conflict");
        if (Date.parse(value.expiresAt) <= this.clock().getTime()) throw new Error("sip_binding_expired");
        return value;
      }
      const now = this.clock();
      const value = bindingSchema.parse({ scope, attemptId: randomUUID(), voiceEpoch: state.voiceEpoch, configVersion: state.admission.configVersion,
        parentCallId: state.admission.externalId, projectId, token: randomBytes(32).toString("base64url"), expiresAt: new Date(now.getTime() + 60_000).toISOString() });
      await tx`INSERT INTO voice_sip_attempts(id,practice_id,instance_id,conversation_id,voice_epoch,token_hash,project_key,protected_binding,expires_at,created_at)
        VALUES (${value.attemptId},${scope.practiceId},${scope.instanceId},${scope.conversationId},${value.voiceEpoch},${this.cipher.digest(value.token)},${this.cipher.digest(projectId)},${tx.json(this.cipher.protect(value,aad(scope,value.attemptId)) as postgres.JSONValue)},${value.expiresAt},${now.toISOString()})`;
      return value;
    }) as SipAttemptBinding;
  }

  async bindIncoming(raw: { practiceId: string; instanceId: string; token: string; projectId: string; eventId: string; callId: string }): Promise<{ binding: SipAttemptBinding; replay: boolean }> {
    const input = z.object({ practiceId: z.string().min(1).max(200), instanceId: z.string().min(1).max(200), token: bindingSchema.shape.token, projectId: project, eventId: opaque, callId: opaque }).strict().parse(raw);
    return await this.sql.begin(async (tx) => {
      // Lock the conversation before the attempt, matching create() and avoiding inversion.
      const found = await tx<AttemptRow[]>`SELECT * FROM voice_sip_attempts WHERE practice_id=${input.practiceId} AND instance_id=${input.instanceId} AND token_hash=${this.cipher.digest(input.token)} AND project_key=${this.cipher.digest(input.projectId)}`;
      if (!found[0]) throw new Error("sip_binding_missing");
      const value = this.decode(found[0]), s = value.scope;
      const states = await tx<StateRow[]>`SELECT revision,protected_state FROM voice_sms_conversations WHERE practice_id=${s.practiceId} AND instance_id=${s.instanceId} AND id=${s.conversationId} FOR UPDATE`;
      const locked = await tx<AttemptRow[]>`SELECT * FROM voice_sip_attempts WHERE id=${value.attemptId} FOR UPDATE`;
      const row = locked[0]!;
      if (row.provider_call_id !== null) {
        if (row.provider_call_id !== input.callId || row.incoming_event_id !== input.eventId) throw new Error("sip_binding_replayed");
        return { binding: value, replay: true };
      }
      const state = this.state(s, states[0]);
      if (state.phase !== "active" || state.providerTier !== "realtime" || state.voiceEpoch !== value.voiceEpoch || state.admission.configVersion !== value.configVersion
        || Date.parse(value.expiresAt) <= this.clock().getTime()) throw new Error("sip_binding_expired_or_stale");
      const now = this.clock().toISOString();
      await tx`UPDATE voice_sip_attempts SET incoming_event_id=${input.eventId},provider_call_id=${input.callId},bound_at=${now} WHERE id=${value.attemptId}`;
      await enqueueConversationJob(tx, this.cipher, { scope: s, kind: "voice_accept", key: value.attemptId,
        payload: { attemptId: value.attemptId, callId: input.callId, voiceEpoch: value.voiceEpoch }, availableAt: now, now });
      return { binding: value, replay: false };
    }) as { binding: SipAttemptBinding; replay: boolean };
  }

  async get(scope: ConversationScope, attemptId: string): Promise<{ binding: SipAttemptBinding; callId: string | null; closeRequested: boolean } | null> {
    conversationScopeSchema.parse(scope); z.string().uuid().parse(attemptId);
    const rows = await this.sql<AttemptRow[]>`SELECT * FROM voice_sip_attempts WHERE id=${attemptId} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId}`;
    return rows[0] ? { binding: this.decode(rows[0]), callId: rows[0].provider_call_id, closeRequested: rows[0].close_requested_at !== null } : null;
  }
  async requestClose(scope: ConversationScope, attemptId: string, callId: string): Promise<void> {
    conversationScopeSchema.parse(scope); z.string().uuid().parse(attemptId); opaque.parse(callId);
    const rows = await this.sql<AttemptRow[]>`UPDATE voice_sip_attempts SET close_requested_at=COALESCE(close_requested_at,${this.clock().toISOString()})
      WHERE id=${attemptId} AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
      AND conversation_id=${scope.conversationId} AND provider_call_id=${callId}
      RETURNING *`;
    if (rows.length !== 1) throw new Error("sip_close_binding_mismatch");
  }
  async cancelClose(scope: ConversationScope, attemptId: string, callId: string): Promise<void> {
    conversationScopeSchema.parse(scope); z.string().uuid().parse(attemptId); opaque.parse(callId);
    await this.sql`UPDATE voice_sip_attempts SET close_requested_at=NULL WHERE id=${attemptId}
      AND practice_id=${scope.practiceId} AND instance_id=${scope.instanceId}
      AND conversation_id=${scope.conversationId} AND provider_call_id=${callId}`;
  }
  async forVoiceEpoch(scope: ConversationScope, voiceEpoch: number): Promise<{ binding: SipAttemptBinding; callId: string | null } | null> {
    conversationScopeSchema.parse(scope);
    if (!Number.isSafeInteger(voiceEpoch) || voiceEpoch < 0) throw new Error("sip_epoch_invalid");
    const rows = await this.sql<AttemptRow[]>`SELECT * FROM voice_sip_attempts WHERE practice_id=${scope.practiceId}
      AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} AND voice_epoch=${voiceEpoch}`;
    return rows[0] ? { binding: this.decode(rows[0]), callId: rows[0].provider_call_id } : null;
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }
  private decode(row: AttemptRow): SipAttemptBinding {
    const scope = { practiceId: row.practice_id, instanceId: row.instance_id, conversationId: row.conversation_id };
    const value = bindingSchema.parse(this.cipher.unprotect(row.protected_binding, aad(scope, row.id)));
    if (value.attemptId !== row.id || JSON.stringify(value.scope) !== JSON.stringify(scope)) throw new Error("sip_binding_corrupt");
    return value;
  }
  private state(scope: ConversationScope, row: StateRow | undefined) {
    if (!row) throw new Error("sip_conversation_missing");
    const state = conversationSchema.parse(this.cipher.unprotect(row.protected_state, { ...scope, revision: row.revision, eventId: "snapshot", schemaVersion: 1 }));
    if (state.id !== scope.conversationId || state.admission.practiceId !== scope.practiceId || state.admission.instanceId !== scope.instanceId || state.revision !== row.revision) throw new Error("sip_conversation_corrupt");
    return state;
  }
}

export function sipDialTwiml(raw: SipAttemptBinding, options: { recordCalls?: boolean } = {}): string {
  const binding = bindingSchema.parse(raw);
  const uri = `sip:${binding.projectId}@sip.api.openai.com;transport=tls;secure=true?X-Voice-Operation-Correlation=${binding.token}`;
  if (uri.length >= 255) throw new Error("sip_uri_too_long");
  const recording = options.recordCalls === true ? ' record="record-from-answer-dual"' : "";
  const notice = options.recordCalls === true ? "<Say>This call will be recorded for quality review. Please use test information only.</Say>" : "";
  return `<Response>${notice}<Dial action="/voice/action?attempt_id=${binding.attemptId}" method="POST" answerOnBridge="true"${recording}><Sip>${uri}</Sip></Dial></Response>`;
}
