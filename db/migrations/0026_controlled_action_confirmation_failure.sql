BEGIN;

CREATE TABLE controlled_action_confirmation_failure_receipts (
  attempt_id text PRIMARY KEY REFERENCES controlled_voice_rendezvous_attempts(id),
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','consumed','inconclusive')),
  request_id text,
  action_receipt_id text,
  owner_epoch integer,
  voice_epoch integer,
  consumed_at timestamptz,
  CHECK ((state = 'pending' AND request_id IS NULL AND action_receipt_id IS NULL AND owner_epoch IS NULL AND voice_epoch IS NULL AND consumed_at IS NULL) OR (state = 'consumed' AND request_id IS NOT NULL AND action_receipt_id IS NOT NULL AND owner_epoch IS NOT NULL AND voice_epoch IS NOT NULL AND consumed_at IS NOT NULL) OR state = 'inconclusive'),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);

CREATE INDEX controlled_action_confirmation_failure_pending_idx ON controlled_action_confirmation_failure_receipts (practice_id,instance_id,attempt_id,expires_at) WHERE state = 'pending';
COMMENT ON TABLE controlled_action_confirmation_failure_receipts IS 'Synthetic-only, default-off E04 committed action confirmation-request failure receipts. No caller content or secrets.';

COMMIT;
