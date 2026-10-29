BEGIN;

CREATE TABLE voice_sms_jobs (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sms_turn','sms_send','sms_receipt','voice_accept','voice_recovery','stub_timeout','post_call_eval')),
  payload_hash text NOT NULL,
  protected_payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','running','succeeded','failed','outcome_unknown','canceled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  result_code text,
  protected_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX voice_sms_jobs_ready ON voice_sms_jobs(practice_id,instance_id,state,available_at,lease_until);
COMMENT ON COLUMN voice_sms_jobs.protected_payload IS 'Authenticated encrypted job references, never plaintext caller content.';
COMMENT ON COLUMN voice_sms_jobs.protected_result IS 'Authenticated encrypted recovery evidence; never emitted in operational logs.';

COMMIT;
