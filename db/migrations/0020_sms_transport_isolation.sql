BEGIN;

ALTER TABLE voice_sms_conversations
  ADD COLUMN transport_isolation_version integer NOT NULL DEFAULT 1
  CHECK (transport_isolation_version IN (1, 2));

CREATE INDEX voice_sms_transport_isolation_legacy_text
  ON voice_sms_conversations(created_at, id)
  WHERE channel = 'sms' AND transport_isolation_version = 1;

CREATE TABLE voice_sms_transport_cutover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  completed_at timestamptz NOT NULL
);

-- Fresh databases are safe immediately. Existing text histories require the
-- explicit retirement batch so no legacy authority is silently reused.
INSERT INTO voice_sms_transport_cutover(singleton, completed_at)
  SELECT true, CURRENT_TIMESTAMP
  WHERE NOT EXISTS (
    SELECT 1 FROM voice_sms_conversations
    WHERE channel = 'sms' AND transport_isolation_version = 1
  );

COMMIT;
