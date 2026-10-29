BEGIN;

ALTER TABLE call_goals
  ADD CONSTRAINT call_goals_practice_id_id_call_id_unique
  UNIQUE (practice_id, id, call_id);

ALTER TABLE action_permits
  ADD CONSTRAINT action_permits_practice_id_id_unique
  UNIQUE (practice_id, id);

ALTER TABLE workflow_turns
  ADD COLUMN purpose text NOT NULL DEFAULT 'workflow_step'
    CHECK (purpose IN ('workflow_step', 'side_question', 'goal_change')),
  ADD COLUMN resume_goal_id text,
  ADD COLUMN final_transcript_revision_id text,
  ADD CONSTRAINT workflow_turns_practice_id_id_call_id_unique
    UNIQUE (practice_id, id, call_id),
  ADD CONSTRAINT workflow_turns_resume_goal_fk
    FOREIGN KEY (practice_id, resume_goal_id, call_id)
    REFERENCES call_goals(practice_id, id, call_id);

CREATE TABLE workflow_transcript_revisions (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  turn_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  stability text NOT NULL CHECK (stability IN ('partial', 'final')),
  transcript_hash text NOT NULL CHECK (transcript_hash ~ '^sha256:[a-f0-9]{64}$'),
  payload_class text NOT NULL CHECK (payload_class IN ('none', 'public', 'limited', 'phi')),
  provider_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  UNIQUE (practice_id, id, call_id, turn_id),
  UNIQUE (practice_id, call_id, turn_id, revision),
  UNIQUE (practice_id, call_id, provider_event_id),
  FOREIGN KEY (practice_id, call_id)
    REFERENCES calls(practice_id, id)
);

ALTER TABLE workflow_turns
  ADD CONSTRAINT workflow_turns_final_transcript_revision_fk
  FOREIGN KEY (practice_id, final_transcript_revision_id, call_id, id)
  REFERENCES workflow_transcript_revisions(practice_id, id, call_id, turn_id);

CREATE TABLE knowledge_items (
  id text PRIMARY KEY,
  practice_id text NOT NULL REFERENCES practices(id),
  stable_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  classification text NOT NULL
    CHECK (classification IN ('public', 'verified_patient', 'staff', 'clinical_restricted')),
  status text NOT NULL CHECK (status IN ('draft', 'approved', 'active', 'retired')),
  claim text NOT NULL,
  structured_value jsonb NOT NULL,
  source_ref text NOT NULL,
  answer_boundary text NOT NULL DEFAULT '',
  effective_at timestamptz NOT NULL,
  fresh_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (fresh_until > effective_at),
  UNIQUE (practice_id, stable_key, version),
  UNIQUE (practice_id, id, version)
);

CREATE UNIQUE INDEX knowledge_items_one_active_version_idx
  ON knowledge_items (practice_id, stable_key)
  WHERE status = 'active';

CREATE TABLE knowledge_queries (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  turn_id text NOT NULL,
  transcript_revision integer NOT NULL CHECK (transcript_revision > 0),
  normalized_query_hash text NOT NULL CHECK (normalized_query_hash ~ '^sha256:[a-f0-9]{64}$'),
  mode text NOT NULL CHECK (mode IN ('preloaded', 'speculative', 'on_demand')),
  state text NOT NULL CHECK (state IN ('created', 'retrieving', 'ready', 'consumed', 'superseded', 'cancelled', 'failed', 'stale')),
  information_class_hint text
    CHECK (information_class_hint IS NULL OR information_class_hint IN ('public', 'verified_patient', 'staff', 'clinical_restricted')),
  active_goal_id text,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidates) = 'array'),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practice_id, id),
  FOREIGN KEY (practice_id, call_id)
    REFERENCES calls(practice_id, id),
  FOREIGN KEY (practice_id, call_id, turn_id, transcript_revision)
    REFERENCES workflow_transcript_revisions(practice_id, call_id, turn_id, revision),
  FOREIGN KEY (practice_id, active_goal_id, call_id)
    REFERENCES call_goals(practice_id, id, call_id)
);

CREATE TABLE knowledge_accesses (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  query_id text NOT NULL,
  permit_id text,
  route text NOT NULL CHECK (route IN ('practice_fact_pack', 'approved_search', 'intergy_read')),
  returned_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(returned_item_ids) = 'array'),
  outcome text NOT NULL CHECK (outcome IN ('returned', 'empty', 'denied', 'failed')),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  occurred_at timestamptz NOT NULL,
  UNIQUE (practice_id, id),
  FOREIGN KEY (practice_id, query_id)
    REFERENCES knowledge_queries(practice_id, id),
  FOREIGN KEY (practice_id, permit_id)
    REFERENCES action_permits(practice_id, id)
);

CREATE TABLE knowledge_envelopes (
  id text PRIMARY KEY,
  practice_id text NOT NULL,
  call_id text NOT NULL,
  turn_id text NOT NULL,
  transcript_revision integer NOT NULL CHECK (transcript_revision > 0),
  query_id text NOT NULL,
  access_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(access_ids) = 'array'),
  prohibited_claims jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(prohibited_claims) = 'array'),
  digest text NOT NULL CHECK (digest ~ '^sha256:[a-f0-9]{64}$'),
  compiled_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > compiled_at),
  UNIQUE (practice_id, id),
  FOREIGN KEY (practice_id, call_id)
    REFERENCES calls(practice_id, id),
  FOREIGN KEY (practice_id, query_id)
    REFERENCES knowledge_queries(practice_id, id),
  FOREIGN KEY (practice_id, call_id, turn_id, transcript_revision)
    REFERENCES workflow_transcript_revisions(practice_id, call_id, turn_id, revision)
);

CREATE TABLE knowledge_envelope_facts (
  practice_id text NOT NULL,
  envelope_id text NOT NULL,
  fact_id text NOT NULL,
  item_id text NOT NULL,
  item_version integer NOT NULL CHECK (item_version > 0),
  access_id text NOT NULL,
  classification text NOT NULL
    CHECK (classification IN ('public', 'verified_patient', 'staff', 'clinical_restricted')),
  claim text NOT NULL,
  structured_value jsonb NOT NULL,
  source_ref text NOT NULL,
  fresh_until timestamptz NOT NULL,
  answer_boundary text NOT NULL DEFAULT '',
  PRIMARY KEY (practice_id, envelope_id, fact_id),
  FOREIGN KEY (practice_id, envelope_id)
    REFERENCES knowledge_envelopes(practice_id, id),
  FOREIGN KEY (practice_id, item_id, item_version)
    REFERENCES knowledge_items(practice_id, id, version),
  FOREIGN KEY (practice_id, access_id)
    REFERENCES knowledge_accesses(practice_id, id)
);

ALTER TABLE event_log
  ADD COLUMN transcript_revision integer CHECK (transcript_revision IS NULL OR transcript_revision > 0),
  ADD COLUMN knowledge_query_id text,
  ADD COLUMN knowledge_envelope_id text,
  ADD COLUMN retrieval_mode text
    CHECK (retrieval_mode IS NULL OR retrieval_mode IN ('preloaded', 'speculative', 'on_demand'));

CREATE INDEX workflow_transcript_revisions_turn_idx
  ON workflow_transcript_revisions (practice_id, call_id, turn_id, revision DESC);
CREATE INDEX knowledge_queries_turn_idx
  ON knowledge_queries (practice_id, call_id, turn_id, transcript_revision DESC);
CREATE INDEX knowledge_envelopes_turn_idx
  ON knowledge_envelopes (practice_id, call_id, turn_id, transcript_revision DESC);
CREATE INDEX event_log_knowledge_idx
  ON event_log (practice_id, knowledge_query_id, knowledge_envelope_id, occurred_at);

CREATE FUNCTION reject_grounded_evidence_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'grounded_evidence_is_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_transcript_revisions_no_change
  BEFORE UPDATE OR DELETE ON workflow_transcript_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_grounded_evidence_change();
CREATE TRIGGER knowledge_accesses_no_change
  BEFORE UPDATE OR DELETE ON knowledge_accesses
  FOR EACH ROW EXECUTE FUNCTION reject_grounded_evidence_change();
CREATE TRIGGER knowledge_envelopes_no_change
  BEFORE UPDATE OR DELETE ON knowledge_envelopes
  FOR EACH ROW EXECUTE FUNCTION reject_grounded_evidence_change();
CREATE TRIGGER knowledge_envelope_facts_no_change
  BEFORE UPDATE OR DELETE ON knowledge_envelope_facts
  FOR EACH ROW EXECUTE FUNCTION reject_grounded_evidence_change();

COMMIT;
