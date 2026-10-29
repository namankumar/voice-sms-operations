BEGIN;

CREATE TABLE controlled_callback_save_failures (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  config_version text NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  question_id text NOT NULL,
  question_activated_revision integer NOT NULL CHECK (question_activated_revision >= 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch >= 0),
  armed_after_revision integer NOT NULL CHECK (armed_after_revision >= 0),
  expires_at timestamptz NOT NULL,
  consumed_source_id text,
  consumed_at timestamptz,
  CHECK ((consumed_source_id IS NULL) = (consumed_at IS NULL)),
  UNIQUE (practice_id, instance_id, conversation_id, request_id),
  FOREIGN KEY (practice_id, instance_id, conversation_id) REFERENCES voice_sms_conversations(practice_id, instance_id, id)
);

CREATE INDEX controlled_callback_save_failures_pending_idx ON controlled_callback_save_failures
  (practice_id, instance_id, conversation_id, request_id, expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE controlled_callback_save_failures IS 'Synthetic-only, default-off P07 controlled pre-write callback-save failures. Stores opaque identifiers and revision fences only.';

COMMIT;
