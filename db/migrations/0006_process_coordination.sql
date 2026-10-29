BEGIN;

CREATE TABLE process_shell_call_admissions (
  call_id text PRIMARY KEY,
  lifecycle_id text NOT NULL UNIQUE,
  trace_id text NOT NULL,
  case_id text NOT NULL,
  state_version integer NOT NULL CHECK (state_version >= 0),
  goal_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  stream_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX process_shell_call_admissions_expiry_idx ON process_shell_call_admissions (lease_expires_at);

CREATE TABLE process_shell_work_queue (
  id text PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','in_progress','completed','uncertain')),
  lease_token text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'in_progress') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX process_shell_work_claim_idx ON process_shell_work_queue (state, lease_expires_at, created_at);
COMMENT ON COLUMN process_shell_work_queue.payload IS 'AES-256-GCM envelope only; plaintext appointment/referral payloads are prohibited.';

COMMIT;
