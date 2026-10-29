BEGIN;

ALTER TABLE process_shell_call_admissions
  ADD COLUMN practice_id text;

DELETE FROM process_shell_call_admissions
WHERE lease_expires_at <= now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM process_shell_call_admissions WHERE practice_id IS NULL) THEN
    RAISE EXCEPTION 'voice admission drain required before tenant-binding migration';
  END IF;
END $$;

ALTER TABLE process_shell_call_admissions
  ALTER COLUMN practice_id SET NOT NULL;

CREATE TABLE voice_control_sessions (
  practice_id text NOT NULL,
  call_id text NOT NULL,
  lifecycle_id text NOT NULL,
  case_id text NOT NULL,
  goal_id text NOT NULL,
  state_version integer NOT NULL CHECK (state_version >= 0),
  active_turn_id text,
  pending_context_id text,
  pending_context_hash text,
  protected_memory jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, call_id),
  UNIQUE (call_id, lifecycle_id)
);

CREATE TABLE voice_authority_consumptions (
  authority_kind text NOT NULL CHECK (authority_kind IN ('directive','mark','terminal','workflow_heard')),
  receipt_hash text NOT NULL,
  nonce_hash text NOT NULL,
  call_ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authority_kind, receipt_hash),
  UNIQUE (authority_kind, nonce_hash)
);

CREATE INDEX voice_authority_consumptions_expiry_idx ON voice_authority_consumptions (expires_at);
CREATE TABLE protected_evidence_blobs (
  id text PRIMARY KEY REFERENCES protected_evidence_metadata(id),
  practice_id text NOT NULL,
  call_ref text NOT NULL,
  case_ref text NOT NULL,
  goal_ref text NOT NULL,
  evidence_kind text NOT NULL,
  directive_ref text,
  immutable_hash text NOT NULL,
  protected_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX protected_evidence_blobs_scope_idx ON protected_evidence_blobs (practice_id, call_ref, evidence_kind);
COMMENT ON COLUMN protected_evidence_blobs.protected_payload IS 'AES-256-GCM envelope only. Plain patient facts, provider results, directives, and transcripts are prohibited.';
COMMENT ON COLUMN voice_control_sessions.protected_memory IS 'AES-256-GCM envelope only. Plain transcripts, identity factors, patient facts, and summaries are prohibited.';

CREATE TABLE intergy_execution_authorizations (
  token_hash text PRIMARY KEY,
  authorization_id text NOT NULL UNIQUE,
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  case_id text NOT NULL REFERENCES cases(id),
  state_version integer NOT NULL CHECK (state_version >= 0),
  capability text NOT NULL,
  protected_authorization jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intergy_execution_authorizations_expiry_idx ON intergy_execution_authorizations (expires_at);
COMMENT ON COLUMN intergy_execution_authorizations.protected_authorization IS 'AES-256-GCM envelope only. Plain patient and permit scope is prohibited.';

COMMIT;
