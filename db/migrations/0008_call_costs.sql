BEGIN;

CREATE TABLE call_cost_entries (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  case_id text NOT NULL REFERENCES cases(id),
  goal_id text NOT NULL REFERENCES call_goals(id),
  component text NOT NULL CHECK (component IN ('twilio', 'model', 'tool', 'infrastructure')),
  provider text NOT NULL,
  usage_kind text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity >= 0),
  unit text NOT NULL,
  unit_price_micro_usd_per_million bigint NOT NULL CHECK (unit_price_micro_usd_per_million >= 0),
  cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd >= 0),
  pricing_version text NOT NULL,
  source_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (practice_id, source_event_id)
);

CREATE INDEX call_cost_entries_call_idx ON call_cost_entries (practice_id, call_id, occurred_at);

CREATE TABLE call_cost_outcomes (
  practice_id text NOT NULL REFERENCES practices(id),
  call_id text NOT NULL REFERENCES calls(id),
  case_id text NOT NULL REFERENCES cases(id),
  goal_id text NOT NULL REFERENCES call_goals(id),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'caller_hangup', 'provider_ended', 'handoff', 'failed')),
  finalized_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, call_id)
);

CREATE FUNCTION reject_call_cost_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'call_cost_ledger_is_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER call_cost_entries_no_change
  BEFORE UPDATE OR DELETE ON call_cost_entries
  FOR EACH ROW EXECUTE FUNCTION reject_call_cost_change();

CREATE TRIGGER call_cost_outcomes_no_change
  BEFORE UPDATE OR DELETE ON call_cost_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_call_cost_change();

COMMIT;
