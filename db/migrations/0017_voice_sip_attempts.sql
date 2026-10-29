BEGIN;
CREATE TABLE voice_sip_attempts (
  id uuid PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  voice_epoch integer NOT NULL CHECK (voice_epoch >= 0),
  token_hash text NOT NULL UNIQUE,
  project_key text NOT NULL,
  protected_binding jsonb NOT NULL,
  incoming_event_id text,
  provider_call_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  bound_at timestamptz,
  UNIQUE (practice_id,instance_id,conversation_id,voice_epoch),
  UNIQUE (project_key,provider_call_id),
  UNIQUE (project_key,incoming_event_id),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id),
  CHECK ((incoming_event_id IS NULL) = (provider_call_id IS NULL))
);
COMMENT ON COLUMN voice_sip_attempts.protected_binding IS 'Encrypted opaque correlation token and approved provider/configuration binding. No patient facts in SIP headers.';
COMMIT;
