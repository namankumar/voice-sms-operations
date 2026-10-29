BEGIN;

CREATE TABLE voice_sms_queue_projection (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  contact_key text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('voice','sms')),
  snapshot_revision integer NOT NULL CHECK (snapshot_revision >= 0),
  materialized boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  phase text CHECK (phase IN ('active','disconnected','closed')),
  voice_lease_until timestamptz,
  needs_follow_up boolean NOT NULL,
  connected_to_staff boolean NOT NULL,
  resolved_by_human boolean NOT NULL,
  resolved_by_ai boolean NOT NULL,
  PRIMARY KEY (practice_id, instance_id, conversation_id),
  FOREIGN KEY (practice_id, instance_id, conversation_id)
    REFERENCES voice_sms_conversations(practice_id, instance_id, id)
);
CREATE INDEX voice_sms_queue_projection_page
  ON voice_sms_queue_projection(practice_id, instance_id, channel, created_at DESC, conversation_id DESC);
CREATE INDEX voice_sms_queue_projection_contact_history
  ON voice_sms_queue_projection(practice_id, instance_id, contact_key, channel, created_at DESC, conversation_id DESC);
COMMENT ON TABLE voice_sms_queue_projection IS 'Non-PII queue/history read model. contact_key is an opaque scoped digest, not identity evidence.';

-- Every preexisting conversation receives an explicitly conservative projection.
-- Readiness rejects a database until subsequent writers have materialized current state.
INSERT INTO voice_sms_queue_projection(
  practice_id,instance_id,conversation_id,contact_key,channel,snapshot_revision,materialized,created_at,updated_at,
  phase,voice_lease_until,needs_follow_up,connected_to_staff,resolved_by_human,resolved_by_ai
)
SELECT practice_id,instance_id,id,contact_key,channel,revision,false,created_at,updated_at,NULL,NULL,false,false,false,false
FROM voice_sms_conversations
ON CONFLICT (practice_id,instance_id,conversation_id) DO NOTHING;

COMMIT;
