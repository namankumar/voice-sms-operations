BEGIN;

CREATE TABLE controlled_offer_expiry_receipts (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch >= 0),
  verification_id text NOT NULL,
  offer_ttl_ms integer NOT NULL CHECK (offer_ttl_ms BETWEEN 1000 AND 60000),
  expires_at timestamptz NOT NULL,
  consumed_proposal_id text,
  consumed_at timestamptz,
  presented_at timestamptz,
  presentation_id text,
  presentation_response_id text,
  presentation_output_item_id text,
  CHECK ((consumed_proposal_id IS NULL) = (consumed_at IS NULL)),
  CHECK ((presented_at IS NULL) = (presentation_id IS NULL)),
  CHECK ((presentation_response_id IS NULL) = (presentation_output_item_id IS NULL)),
  CHECK (presented_at IS NULL OR consumed_proposal_id IS NOT NULL),
  UNIQUE (practice_id, instance_id, conversation_id, request_id),
  FOREIGN KEY (practice_id, instance_id, conversation_id) REFERENCES voice_sms_conversations(practice_id, instance_id, id)
);

CREATE INDEX controlled_offer_expiry_pending_idx ON controlled_offer_expiry_receipts
  (practice_id, instance_id, conversation_id, request_id, expires_at)
  WHERE consumed_at IS NULL;

COMMENT ON TABLE controlled_offer_expiry_receipts IS 'Synthetic-only, default-off E02 one-use canonical offer TTL overrides. Stores exact authority fences and opaque receipt identifiers only.';

COMMIT;
