BEGIN;

CREATE TABLE voice_sms_threads (
  thread_key text PRIMARY KEY,
  binding_hash text NOT NULL,
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  config_version text NOT NULL,
  provider_account_key text NOT NULL,
  conversation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (practice_id,instance_id,conversation_id)
    REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE INDEX voice_sms_threads_expiry
  ON voice_sms_threads(practice_id,instance_id,expires_at);

CREATE TABLE voice_sms_inbound_events (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  provider_account_key text NOT NULL,
  message_sid text NOT NULL,
  thread_key text NOT NULL REFERENCES voice_sms_threads(thread_key),
  conversation_id uuid NOT NULL,
  payload_hash text NOT NULL,
  num_media integer NOT NULL CHECK (num_media BETWEEN 0 AND 10),
  opt_out_type text CHECK (opt_out_type IN ('STOP','START','HELP')),
  protected_receipt jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,instance_id,provider_account_key,message_sid)
);
CREATE INDEX voice_sms_inbound_events_conversation
  ON voice_sms_inbound_events(practice_id,instance_id,conversation_id,received_at);
COMMENT ON TABLE voice_sms_threads IS 'Scoped SMS thread binding. Caller and destination numbers exist only inside keyed digests.';
COMMENT ON TABLE voice_sms_inbound_events IS 'Practice- and instance-scoped Twilio MessageSid replay binding and encrypted ingress receipt; no plaintext message body.';

COMMIT;
