BEGIN;

CREATE TABLE intergy_authorization_uses (
  authorization_id text PRIMARY KEY,
  authorization_hash text NOT NULL,
  practice_id text NOT NULL REFERENCES practices(id),
  operation text NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  mutation_replay_allowed boolean NOT NULL,
  claimed_at timestamptz NOT NULL
);

CREATE TABLE intergy_mutation_executions (
  practice_id text NOT NULL REFERENCES practices(id),
  operation text NOT NULL CHECK (operation IN ('appointment.schedule', 'appointment.move')),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  authorization_id text NOT NULL REFERENCES intergy_authorization_uses(authorization_id),
  state text NOT NULL CHECK (state IN ('in_progress', 'completed', 'uncertain')),
  lease_token text,
  lease_expires_at timestamptz,
  protected_result jsonb,
  protected_error jsonb,
  payload_classification text NOT NULL DEFAULT 'restricted_phi' CHECK (payload_classification = 'restricted_phi'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, operation, idempotency_key),
  CHECK ((state = 'in_progress') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state = 'completed') = (protected_result IS NOT NULL)),
  CHECK (state <> 'uncertain' OR protected_error IS NOT NULL)
);

COMMENT ON COLUMN intergy_mutation_executions.protected_result IS 'AES-256-GCM envelope only. Restricted provider readback and receipt; never expose through generic projections or telemetry.';
COMMENT ON COLUMN intergy_mutation_executions.protected_error IS 'AES-256-GCM envelope only. Restricted provider uncertainty evidence; never expose through generic projections or telemetry.';
CREATE INDEX intergy_execution_state_idx ON intergy_mutation_executions (practice_id, state, updated_at);

COMMIT;
