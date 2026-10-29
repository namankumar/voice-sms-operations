BEGIN;

CREATE TABLE controlled_voice_rendezvous_attempts (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  account_id text NOT NULL,
  caller_binding_hash text NOT NULL,
  destination_binding_hash text NOT NULL,
  digits_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','awaiting_digits','confirmed','redirected','inconclusive')),
  challenged_parent_call_id text,
  challenged_at timestamptz,
  bound_parent_call_id text,
  consumed_at timestamptz,
  conversation_id uuid,
  bound_at timestamptz,
  CHECK ((challenged_parent_call_id IS NULL) = (challenged_at IS NULL)),
  CHECK ((bound_parent_call_id IS NULL) = (consumed_at IS NULL)),
  CHECK ((conversation_id IS NULL) = (bound_at IS NULL)),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE INDEX controlled_voice_rendezvous_pending_idx ON controlled_voice_rendezvous_attempts
  (practice_id,instance_id,account_id,caller_binding_hash,destination_binding_hash,expires_at)
  WHERE consumed_at IS NULL;
COMMENT ON TABLE controlled_voice_rendezvous_attempts IS 'Synthetic-only, operator-provisioned pre-admission DTMF rendezvous attempts. Contains HMAC digests only; no DTMF secret is retained.';

COMMIT;
