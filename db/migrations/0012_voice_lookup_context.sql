BEGIN;

CREATE TABLE voice_lookup_context_call_disconnects (
  practice_id text NOT NULL,
  call_id text NOT NULL,
  disconnected_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, call_id),
  FOREIGN KEY (practice_id, call_id) REFERENCES calls(practice_id, id)
);

CREATE TABLE voice_lookup_context_records (
  practice_id text NOT NULL,
  call_id text NOT NULL,
  call_lifecycle_id text NOT NULL,
  id text NOT NULL,
  payload_class text NOT NULL CHECK (payload_class IN ('public', 'patient_specific', 'protected_internal')),
  expires_at timestamptz NOT NULL,
  protected_record jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, id),
  FOREIGN KEY (practice_id, call_id) REFERENCES calls(practice_id, id)
);

CREATE INDEX voice_lookup_context_call_idx
  ON voice_lookup_context_records (practice_id, call_id, call_lifecycle_id, expires_at);

CREATE TABLE voice_lookup_context_deletion_receipts (
  practice_id text NOT NULL,
  call_id text NOT NULL,
  record_id text NOT NULL,
  receipt_id text NOT NULL,
  reason text NOT NULL CHECK (reason = 'retention_expired'),
  deleted_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, receipt_id)
);

COMMIT;
