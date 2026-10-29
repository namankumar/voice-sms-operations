BEGIN;

ALTER TABLE voice_sms_jobs
  ADD CONSTRAINT voice_sms_jobs_scope_identity UNIQUE (practice_id, instance_id, conversation_id, id);

CREATE TABLE voice_sms_job_leases (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  job_id text NOT NULL,
  lease_token uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  lease_until timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 1 AND 3),
  PRIMARY KEY (practice_id, instance_id, conversation_id, job_id, lease_token),
  FOREIGN KEY (practice_id, instance_id, conversation_id, job_id)
    REFERENCES voice_sms_jobs(practice_id, instance_id, conversation_id, id)
);

CREATE TABLE voice_sms_job_effects (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  job_id text NOT NULL,
  lease_token uuid NOT NULL,
  attempt_id text NOT NULL,
  started_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id, instance_id, conversation_id, job_id, lease_token),
  FOREIGN KEY (practice_id, instance_id, conversation_id, job_id, lease_token)
    REFERENCES voice_sms_job_leases(practice_id, instance_id, conversation_id, job_id, lease_token)
);
CREATE FUNCTION reject_voice_sms_job_effect_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'voice_sms_job_effect_immutable';
END;
$$;
CREATE TRIGGER voice_sms_job_effect_immutable
  BEFORE UPDATE OR DELETE ON voice_sms_job_effects
  FOR EACH ROW EXECUTE FUNCTION reject_voice_sms_job_effect_mutation();

CREATE TABLE voice_sms_job_evidence (
  practice_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  job_id text NOT NULL,
  lease_token uuid NOT NULL,
  result_digest text NOT NULL,
  observed_at timestamptz NOT NULL,
  protected_result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (practice_id, instance_id, conversation_id, job_id, lease_token, result_digest),
  FOREIGN KEY (practice_id, instance_id, conversation_id, job_id, lease_token)
    REFERENCES voice_sms_job_leases(practice_id, instance_id, conversation_id, job_id, lease_token)
);
CREATE INDEX voice_sms_job_evidence_by_job
  ON voice_sms_job_evidence(practice_id, instance_id, conversation_id, job_id, observed_at, created_at);
CREATE FUNCTION reject_voice_sms_job_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'voice_sms_job_evidence_immutable';
END;
$$;
CREATE TRIGGER voice_sms_job_evidence_immutable
  BEFORE UPDATE OR DELETE ON voice_sms_job_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_voice_sms_job_evidence_mutation();
COMMENT ON TABLE voice_sms_job_leases IS 'Immutable issued lease authority; foreign tokens cannot attach job evidence.';
COMMENT ON TABLE voice_sms_job_effects IS 'Immutable proof that an issued lease crossed an authoritative dispatch/recovery gate, bound to its durable attempt ID, immediately before an external effect.';
COMMENT ON TABLE voice_sms_job_evidence IS 'Supplemental authenticated provider evidence only. It never changes job state or reopens an action.';
COMMENT ON COLUMN voice_sms_job_evidence.protected_result IS 'Authenticated encrypted allowlisted result evidence, never plaintext provider payload.';

COMMIT;
