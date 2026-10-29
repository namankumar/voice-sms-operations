BEGIN;

CREATE TABLE practices (
  id text PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL,
  policy_ruleset_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cases (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  owner_id text,
  state text NOT NULL,
  request_kind text NOT NULL,
  service_level_due_at timestamptz NOT NULL,
  resolution_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (version >= 0)
);

CREATE TABLE calls (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  case_id text NOT NULL REFERENCES cases(id),
  active_goal_id text,
  telephony_call_id text NOT NULL,
  trace_id text NOT NULL,
  state text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  connected_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, telephony_call_id)
);

CREATE TABLE call_goals (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  case_id text NOT NULL REFERENCES cases(id),
  kind text NOT NULL,
  state text NOT NULL,
  required_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  collected_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocker_code text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE calls
  ADD CONSTRAINT calls_active_goal_fk
  FOREIGN KEY (active_goal_id) REFERENCES call_goals(id);

CREATE TABLE verification_sessions (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  patient_id text,
  capability text NOT NULL,
  required_assurance text NOT NULL,
  state text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE action_requests (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  case_id text NOT NULL REFERENCES cases(id),
  capability text NOT NULL,
  subject_id text,
  parameters jsonb NOT NULL,
  parameter_hash text NOT NULL,
  requested_state_version integer NOT NULL,
  requested_at timestamptz NOT NULL,
  UNIQUE (practice_id, id)
);

CREATE TABLE policy_decisions (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  action_request_id text NOT NULL REFERENCES action_requests(id),
  decision text NOT NULL,
  ruleset_version text NOT NULL,
  reason_codes jsonb NOT NULL,
  obligations jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts_hash text NOT NULL,
  decided_at timestamptz NOT NULL
);

CREATE TABLE action_permits (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  action_request_id text NOT NULL REFERENCES action_requests(id),
  policy_decision_id text NOT NULL REFERENCES policy_decisions(id),
  capability text NOT NULL,
  subject_id text,
  parameter_hash text NOT NULL,
  state_version integer NOT NULL,
  ruleset_version text NOT NULL,
  nonce_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses = 1)
);

CREATE TABLE agent_actions (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  action_request_id text NOT NULL REFERENCES action_requests(id),
  permit_id text NOT NULL REFERENCES action_permits(id),
  state text NOT NULL,
  idempotency_key text NOT NULL,
  provider_kind text NOT NULL,
  provider_request_id text,
  receipt_hash text,
  readback_hash text,
  error_code text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, idempotency_key)
);

CREATE TABLE event_log (
  event_id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  practice_id text NOT NULL REFERENCES practices(id),
  trace_id text NOT NULL,
  call_id text,
  case_id text,
  goal_id text,
  turn_id text,
  actor_type text NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_version integer NOT NULL,
  outcome text NOT NULL,
  latency_ms integer,
  policy_decision_id text,
  action_id text,
  provider_request_id text,
  error_code text,
  payload_class text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX event_log_trace_idx ON event_log (practice_id, trace_id, occurred_at);
CREATE INDEX event_log_case_idx ON event_log (practice_id, case_id, occurred_at);

CREATE TABLE outbox (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  event_id text NOT NULL REFERENCES event_log(event_id),
  topic text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text
);

CREATE TABLE protected_evidence_metadata (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  storage_key text NOT NULL,
  payload_class text NOT NULL,
  retention_until timestamptz NOT NULL,
  legal_hold boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
