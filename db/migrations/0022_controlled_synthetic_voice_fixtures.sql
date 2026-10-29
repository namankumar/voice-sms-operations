BEGIN;

CREATE TABLE controlled_synthetic_voice_fixtures (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  account_id text NOT NULL,
  expected_parent_call_id text NOT NULL,
  caller_binding_hash text NOT NULL,
  destination_binding_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome = 'demo_closed'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_parent_call_id text,
  consumed_at timestamptz,
  conversation_id uuid,
  bound_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK ((consumed_parent_call_id IS NULL) = (consumed_at IS NULL)),
  CHECK ((conversation_id IS NULL) = (bound_at IS NULL)),
  UNIQUE (practice_id,instance_id,account_id,expected_parent_call_id,caller_binding_hash,destination_binding_hash),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE INDEX controlled_synthetic_voice_fixture_claim_idx ON controlled_synthetic_voice_fixtures
  (practice_id,instance_id,account_id,caller_binding_hash,destination_binding_hash,expires_at)
  WHERE consumed_at IS NULL;
COMMENT ON TABLE controlled_synthetic_voice_fixtures IS 'Synthetic-only, pre-issued one-use P06 hours fixtures. Caller bindings are HMAC digests; no public control path exists.';

COMMIT;
