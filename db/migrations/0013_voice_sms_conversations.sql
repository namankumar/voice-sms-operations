BEGIN;

CREATE TABLE voice_sms_contact_policy (
  contact_key text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  suppressed boolean NOT NULL DEFAULT false
);
CREATE TABLE voice_sms_conversations (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  id uuid NOT NULL,
  admission_key text NOT NULL UNIQUE,
  admission_hash text NOT NULL,
  contact_key text NOT NULL REFERENCES voice_sms_contact_policy(contact_key),
  channel text NOT NULL CHECK (channel IN ('voice','sms')),
  revision integer NOT NULL CHECK (revision >= 0),
  protected_state jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,instance_id,id)
);
CREATE INDEX voice_sms_conversations_queue ON voice_sms_conversations(practice_id,instance_id,channel,created_at DESC);
CREATE TABLE voice_sms_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  event_id text NOT NULL,
  command_hash text NOT NULL,
  revision integer NOT NULL,
  protected_receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,instance_id,conversation_id,event_id),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE TABLE voice_sms_dispatch_attempts (
  attempt_id text PRIMARY KEY,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  message_id text NOT NULL,
  provider_account_key text NOT NULL,
  provider_message_id text,
  state text NOT NULL,
  UNIQUE (practice_id,instance_id,conversation_id,message_id),
  UNIQUE (provider_account_key,provider_message_id),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE TABLE voice_sms_recoveries (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  recovery_id text NOT NULL,
  from_epoch integer NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (practice_id,instance_id,conversation_id,recovery_id),
  UNIQUE (practice_id,instance_id,conversation_id,from_epoch),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);

CREATE FUNCTION reject_voice_sms_event_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'voice_sms_events_are_append_only';
END;
$$;
CREATE TRIGGER voice_sms_event_immutable BEFORE UPDATE OR DELETE ON voice_sms_events
  FOR EACH ROW EXECUTE FUNCTION reject_voice_sms_event_change();

COMMIT;
