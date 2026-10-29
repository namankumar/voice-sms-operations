BEGIN;

CREATE TABLE appointment_action_workflows (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  case_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('appointment.schedule', 'appointment.move')),
  parameter_hash text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('completed', 'uncertain', 'routed')),
  receipt_evidence_id text,
  readback_evidence_id text,
  reason_code text,
  protected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, id),
  UNIQUE (practice_id, idempotency_key),
  FOREIGN KEY (practice_id, case_id) REFERENCES cases(practice_id, id)
);

CREATE TABLE adjacent_operation_obligations (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  case_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('records', 'communication', 'reminder', 'backfill')),
  state text NOT NULL,
  owner_id text NOT NULL,
  deadline_at timestamptz NOT NULL,
  source_version integer,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_code text,
  protected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, id),
  FOREIGN KEY (practice_id, case_id) REFERENCES cases(practice_id, id)
);

-- The S4 service currently exposes one aggregate transaction port. This durable
-- snapshot is its backing store until the workflow owner splits the aggregate
-- into row-level command repositories.
CREATE TABLE adjacent_operation_state (
  practice_id text PRIMARY KEY REFERENCES practices(id),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  protected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  state text NOT NULL,
  missing_administrative_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  practice_acceptance text NOT NULL CHECK (practice_acceptance IN ('pending', 'accepted')),
  practice_acceptance_evidence_id text,
  coverage_status text NOT NULL CHECK (coverage_status IN ('verified_covered', 'verified_not_covered', 'unknown', 'stale')),
  coverage_evidence_id text,
  outreach_state text NOT NULL CHECK (outreach_state IN ('not_authorized', 'authorized', 'stopped')),
  outreach_consent_evidence_id text,
  review_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  appointment_verified boolean NOT NULL DEFAULT false,
  appointment_action_id text,
  owner_id text,
  service_level_due_at timestamptz NOT NULL,
  source_hash text NOT NULL,
  protected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, id),
  UNIQUE (practice_id, source_hash)
);

CREATE TABLE instruction_versions (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  workflow_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed', 'approved', 'active', 'superseded', 'rolled_back', 'rejected', 'expired')),
  content_hash text NOT NULL,
  scope_hash text NOT NULL,
  evaluation_passed boolean,
  evaluation_evidence_id text,
  approver_id text,
  approval_receipt_id text,
  effective_from timestamptz NOT NULL,
  expires_at timestamptz,
  capability_count integer NOT NULL CHECK (capability_count >= 0),
  supersedes_version_id text,
  protected_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  command_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, id),
  FOREIGN KEY (practice_id, supersedes_version_id) REFERENCES instruction_versions(practice_id, id),
  CHECK (expires_at IS NULL OR expires_at > effective_from)
);

CREATE TABLE roadmap_event_log (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  event_type text NOT NULL,
  actor_id text,
  outcome text NOT NULL,
  reason_code text,
  parameter_hash text,
  authority_receipt_id text,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (practice_id, id)
);

CREATE TABLE referral_status_commands (
  practice_id text NOT NULL REFERENCES practices(id),
  operation text NOT NULL CHECK (operation IN ('referral.status.read', 'referral.status.transition')),
  referral_id text NOT NULL,
  idempotency_key text NOT NULL,
  parameter_hash text NOT NULL,
  protected_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  state text NOT NULL CHECK (state IN ('in_progress', 'completed', 'uncertain')),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, operation, idempotency_key)
);

CREATE TABLE appointment_retry_verification_receipts (
  practice_id text NOT NULL REFERENCES practices(id),
  id text NOT NULL,
  call_id text NOT NULL,
  patient_id text NOT NULL,
  retry_action_id text NOT NULL,
  retry_of text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('appointment.schedule', 'appointment.move')),
  parameter_hash text NOT NULL,
  verification_session_id text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (practice_id, id),
  UNIQUE (practice_id, retry_action_id),
  FOREIGN KEY (practice_id, verification_session_id, call_id)
    REFERENCES verification_sessions(practice_id, id, call_id),
  CHECK (expires_at > issued_at)
);

COMMENT ON COLUMN appointment_action_workflows.protected_payload IS 'Restricted PHI-bearing action payload. Read only through tenant-scoped repository methods.';
COMMENT ON COLUMN adjacent_operation_state.protected_payload IS 'Restricted workflow snapshot. It is never available to generic projections.';
COMMENT ON COLUMN referrals.protected_payload IS 'Restricted PHI-bearing referral payload. Read only through tenant-scoped repository methods.';
COMMENT ON COLUMN instruction_versions.protected_payload IS 'Restricted adaptation record. Generic events retain hashes only.';
COMMENT ON COLUMN referral_status_commands.protected_result IS 'Restricted status result. Generic events retain opaque references only.';

CREATE INDEX appointment_action_state_idx ON appointment_action_workflows (practice_id, state, updated_at);
CREATE INDEX adjacent_obligation_queue_idx ON adjacent_operation_obligations (practice_id, state, deadline_at);
CREATE INDEX referral_queue_idx ON referrals (practice_id, state, service_level_due_at);
CREATE INDEX instruction_state_idx ON instruction_versions (practice_id, workflow_id, state, updated_at);
CREATE UNIQUE INDEX instruction_versions_one_active_scope_idx
  ON instruction_versions (practice_id, workflow_id, scope_hash)
  WHERE state = 'active';
CREATE UNIQUE INDEX instruction_versions_command_id_idx
  ON instruction_versions (practice_id, command_id)
  WHERE command_id IS NOT NULL;
CREATE INDEX roadmap_event_object_idx ON roadmap_event_log (practice_id, object_type, object_id, occurred_at);
CREATE INDEX referral_status_command_referral_idx ON referral_status_commands (practice_id, referral_id, updated_at);

CREATE FUNCTION reject_roadmap_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'roadmap_event_log_is_append_only';
END;
$$;

CREATE TRIGGER roadmap_event_log_no_update
  BEFORE UPDATE OR DELETE ON roadmap_event_log
  FOR EACH ROW EXECUTE FUNCTION reject_roadmap_event_mutation();

COMMIT;
