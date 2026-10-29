BEGIN;

ALTER TABLE policy_decisions
  ADD CONSTRAINT policy_decisions_one_per_request UNIQUE (action_request_id);

ALTER TABLE action_permits
  ADD CONSTRAINT action_permits_one_per_request UNIQUE (action_request_id),
  ADD CONSTRAINT action_permits_one_per_decision UNIQUE (policy_decision_id);

ALTER TABLE cases
  ADD CONSTRAINT cases_practice_id_id_unique UNIQUE (practice_id, id);

ALTER TABLE calls
  ADD CONSTRAINT calls_practice_id_id_unique UNIQUE (practice_id, id),
  ADD CONSTRAINT calls_practice_id_id_case_id_unique UNIQUE (practice_id, id, case_id),
  ADD CONSTRAINT calls_practice_case_fk
    FOREIGN KEY (practice_id, case_id) REFERENCES cases(practice_id, id);

ALTER TABLE call_goals
  ADD CONSTRAINT call_goals_practice_id_id_call_id_case_id_unique
    UNIQUE (practice_id, id, call_id, case_id),
  ADD CONSTRAINT call_goals_practice_call_case_fk
    FOREIGN KEY (practice_id, call_id, case_id) REFERENCES calls(practice_id, id, case_id),
  ADD CONSTRAINT call_goals_practice_case_fk
    FOREIGN KEY (practice_id, case_id) REFERENCES cases(practice_id, id);

ALTER TABLE verification_sessions
  ADD CONSTRAINT verification_sessions_practice_id_id_call_id_unique
    UNIQUE (practice_id, id, call_id),
  ADD CONSTRAINT verification_sessions_practice_call_fk
    FOREIGN KEY (practice_id, call_id) REFERENCES calls(practice_id, id);

CREATE TABLE call_workflows (
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL,
  case_id text NOT NULL,
  goal_id text NOT NULL,
  owner_id text NOT NULL,
  call_version integer NOT NULL CHECK (call_version >= 0),
  snapshot jsonb NOT NULL,
  PRIMARY KEY (practice_id, call_id),
  UNIQUE (practice_id, case_id, goal_id),
  UNIQUE (practice_id, call_id, case_id),
  UNIQUE (practice_id, call_id, goal_id),
  FOREIGN KEY (practice_id, call_id, case_id)
    REFERENCES calls(practice_id, id, case_id),
  FOREIGN KEY (practice_id, goal_id, call_id, case_id)
    REFERENCES call_goals(practice_id, id, call_id, case_id)
);

CREATE TABLE workflow_calls (
  id text PRIMARY KEY REFERENCES calls(id),
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  CHECK (id = call_id),
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_cases (
  id text PRIMARY KEY REFERENCES cases(id),
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id, id)
    REFERENCES call_workflows(practice_id, call_id, case_id)
);

CREATE TABLE workflow_goals (
  id text PRIMARY KEY REFERENCES call_goals(id),
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id, id)
    REFERENCES call_workflows(practice_id, call_id, goal_id)
);

CREATE TABLE workflow_verifications (
  id text PRIMARY KEY REFERENCES verification_sessions(id),
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, id, call_id)
    REFERENCES verification_sessions(practice_id, id, call_id),
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_turns (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_directives (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_actions (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_handoffs (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_evidence (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_events (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE TABLE workflow_outbox (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  payload jsonb NOT NULL,
  FOREIGN KEY (practice_id, call_id)
    REFERENCES call_workflows(practice_id, call_id)
);

CREATE INDEX workflow_turns_call_idx ON workflow_turns (practice_id, call_id);
CREATE INDEX workflow_actions_call_idx ON workflow_actions (practice_id, call_id);
CREATE INDEX workflow_handoffs_call_idx ON workflow_handoffs (practice_id, call_id);
CREATE INDEX workflow_events_call_idx ON workflow_events (practice_id, call_id);
CREATE INDEX workflow_outbox_call_idx ON workflow_outbox (practice_id, call_id);

COMMIT;
