import postgres from "postgres";
import { ConversationCipher } from "./conversation-store.js";
import type { RecordingTranscript, RecordingTranscriptScope, RecordingTranscriptStore } from "./recording-transcript.js";

type Sql = ReturnType<typeof postgres>;
type Row = { recording_id: string; state: "claimed" | RecordingTranscript["status"]; protected_transcript: unknown | null };
export type RecordingTranscriptView = Readonly<{ recordingId: string; state: "claimed" | RecordingTranscript["status"]; transcript: RecordingTranscript | null }>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS voice_sms_recording_transcripts (
    practice_id text NOT NULL,
    instance_id text NOT NULL,
    conversation_id text NOT NULL,
    recording_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('claimed', 'complete', 'no_speech', 'failed', 'partial', 'unavailable')),
    protected_transcript jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (practice_id, instance_id, conversation_id, recording_id),
    CHECK ((state = 'claimed') = (protected_transcript IS NULL))
  );
  CREATE INDEX IF NOT EXISTS voice_sms_recording_transcripts_conversation_idx
    ON voice_sms_recording_transcripts (practice_id, instance_id, conversation_id, created_at);
`;

/** Durable, encrypted transcript persistence. A claimed row is never eligible for automatic resubmission. */
export class PostgresRecordingTranscriptStore implements RecordingTranscriptStore {
  private readonly sql: Sql;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher) {
    this.sql = postgres(databaseUrl, { max: 5, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "vegas-recording-transcript" } });
  }
  async initialize(): Promise<void> { await this.sql.unsafe(SCHEMA); }
  async ready(): Promise<boolean> {
    try { const rows = await this.sql<{ table: string | null }[]>`SELECT to_regclass('public.voice_sms_recording_transcripts')::text AS table`; return rows[0]?.table === "voice_sms_recording_transcripts"; }
    catch { return false; }
  }
  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }
  async isClaimed(input: { scope: RecordingTranscriptScope; recordingId: string }): Promise<boolean> {
    const scope = input.scope;
    const rows = await this.sql`SELECT 1 FROM voice_sms_recording_transcripts WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} AND recording_id=${input.recordingId} LIMIT 1`;
    return rows.length === 1;
  }
  async claim(input: { scope: RecordingTranscriptScope; recordingId: string }): Promise<"claimed" | "already_claimed"> {
    const scope = input.scope;
    const rows = await this.sql`INSERT INTO voice_sms_recording_transcripts (practice_id,instance_id,conversation_id,recording_id,state)
      VALUES (${scope.practiceId},${scope.instanceId},${scope.conversationId},${input.recordingId},'claimed')
      ON CONFLICT (practice_id,instance_id,conversation_id,recording_id) DO NOTHING RETURNING recording_id`;
    return rows.length === 1 ? "claimed" : "already_claimed";
  }
  async save(transcript: RecordingTranscript): Promise<void> {
    const scope = transcript.scope, protectedTranscript = this.cipher.protect(transcript, binding(scope, transcript.recordingId));
    const rows = await this.sql`UPDATE voice_sms_recording_transcripts SET state=${transcript.status},protected_transcript=${this.sql.json(protectedTranscript as postgres.JSONValue)},updated_at=now()
      WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} AND recording_id=${transcript.recordingId} AND state='claimed'
      RETURNING recording_id`;
    if (rows.length !== 1) throw new Error("recording_transcript_claim_missing");
  }
  /** Includes claimed work so UI can distinguish pending work from absent recordings. */
  async getByConversation(scope: RecordingTranscriptScope): Promise<readonly RecordingTranscriptView[]> {
    const rows = await this.sql<Row[]>`SELECT recording_id,state,protected_transcript FROM voice_sms_recording_transcripts
      WHERE practice_id=${scope.practiceId} AND instance_id=${scope.instanceId} AND conversation_id=${scope.conversationId} ORDER BY created_at ASC`;
    return rows.map((row) => ({ recordingId: row.recording_id, state: row.state,
      transcript: row.protected_transcript === null ? null : this.cipher.unprotect(row.protected_transcript, binding(scope, row.recording_id)) as RecordingTranscript }));
  }
}
function binding(scope: RecordingTranscriptScope, recordingId: string) {
  return { domain: "recording-transcript/v1", practiceId: scope.practiceId, instanceId: scope.instanceId, conversationId: scope.conversationId, recordingId };
}
