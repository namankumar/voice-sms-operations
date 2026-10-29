BEGIN;

CREATE TABLE synthetic_datasets (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  seed_version text NOT NULL,
  seed_hash text NOT NULL,
  clinic_timezone text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','resetting','retired')),
  version integer NOT NULL CHECK (version >= 0),
  protected_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,dataset_id,generation)
);
CREATE UNIQUE INDEX synthetic_dataset_active ON synthetic_datasets(practice_id,dataset_id) WHERE state='active';

CREATE TABLE synthetic_patient_payloads (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  patient_id text NOT NULL,
  identity_fingerprint_hash text NOT NULL,
  protected_payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  PRIMARY KEY (practice_id,dataset_id,generation,patient_id),
  FOREIGN KEY (practice_id,dataset_id,generation) REFERENCES synthetic_datasets(practice_id,dataset_id,generation)
);
CREATE INDEX synthetic_patient_identity ON synthetic_patient_payloads(practice_id,dataset_id,generation,identity_fingerprint_hash);

CREATE TABLE synthetic_slots (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  slot_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  capacity integer NOT NULL CHECK (capacity > 0),
  booked_count integer NOT NULL CHECK (booked_count >= 0 AND booked_count <= capacity),
  protected_payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  PRIMARY KEY (practice_id,dataset_id,generation,slot_id),
  FOREIGN KEY (practice_id,dataset_id,generation) REFERENCES synthetic_datasets(practice_id,dataset_id,generation),
  CHECK (ends_at > starts_at)
);

CREATE TABLE synthetic_appointments (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  appointment_id text NOT NULL,
  patient_id text NOT NULL,
  slot_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled','superseded','canceled')),
  attendance_version integer CHECK (attendance_version >= 0),
  protected_payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  PRIMARY KEY (practice_id,dataset_id,generation,appointment_id),
  FOREIGN KEY (practice_id,dataset_id,generation,patient_id) REFERENCES synthetic_patient_payloads(practice_id,dataset_id,generation,patient_id),
  FOREIGN KEY (practice_id,dataset_id,generation,slot_id) REFERENCES synthetic_slots(practice_id,dataset_id,generation,slot_id)
);

CREATE TABLE synthetic_verifications (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  verification_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch >= 0),
  state text NOT NULL CHECK (state IN ('pending','verified','exhausted','revoked')),
  expires_at timestamptz NOT NULL,
  protected_payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,dataset_id,generation,verification_id),
  FOREIGN KEY (practice_id,dataset_id,generation) REFERENCES synthetic_datasets(practice_id,dataset_id,generation),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE INDEX synthetic_verification_conversation ON synthetic_verifications(practice_id,dataset_id,generation,conversation_id);

CREATE TABLE synthetic_sessions (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  grant_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch >= 0),
  patient_id text NOT NULL,
  factor_evidence_hashes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  protected_payload jsonb NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  PRIMARY KEY (practice_id,dataset_id,generation,grant_id),
  FOREIGN KEY (practice_id,dataset_id,generation,patient_id) REFERENCES synthetic_patient_payloads(practice_id,dataset_id,generation,patient_id),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id)
);
CREATE INDEX synthetic_sessions_active_idx ON synthetic_sessions(practice_id,dataset_id,generation,expires_at) WHERE revoked_at IS NULL;

CREATE TABLE synthetic_actions (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  action_id text NOT NULL,
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  owner_epoch integer NOT NULL CHECK (owner_epoch >= 0),
  patient_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('schedule','reschedule','attendance_confirm')),
  idempotency_key text NOT NULL,
  input_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','authorized','executing','committed','rejected','uncertain','routed','canceled','superseded')),
  authorization_receipt_id text,
  protected_payload jsonb NOT NULL,
  result_hash text,
  readback_hash text,
  expires_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (practice_id,dataset_id,generation,action_id),
  UNIQUE (practice_id,dataset_id,generation,idempotency_key),
  FOREIGN KEY (practice_id,dataset_id,generation,patient_id) REFERENCES synthetic_patient_payloads(practice_id,dataset_id,generation,patient_id),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id),
  CHECK (state <> 'committed' OR (authorization_receipt_id IS NOT NULL AND result_hash IS NOT NULL AND readback_hash IS NOT NULL))
);
CREATE INDEX synthetic_actions_request_idx ON synthetic_actions(practice_id,dataset_id,generation,conversation_id,request_id,request_revision);

CREATE TABLE synthetic_evidence (
  practice_id text NOT NULL,
  dataset_id text NOT NULL,
  generation integer NOT NULL,
  evidence_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('proposal','read','voice_authority','sms_authority','consent')),
  instance_id text NOT NULL,
  conversation_id uuid NOT NULL,
  request_id text NOT NULL,
  request_revision integer NOT NULL CHECK (request_revision >= 0),
  protected_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_by text,
  PRIMARY KEY (practice_id,dataset_id,generation,evidence_id),
  FOREIGN KEY (practice_id,dataset_id,generation) REFERENCES synthetic_datasets(practice_id,dataset_id,generation),
  FOREIGN KEY (practice_id,instance_id,conversation_id) REFERENCES voice_sms_conversations(practice_id,instance_id,id),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE synthetic_datasets IS 'Fictional demo fixtures only. Generation changes retain historical call and action evidence.';
COMMENT ON COLUMN synthetic_patient_payloads.identity_fingerprint_hash IS 'Scoped keyed digest, not raw DOB/ZIP or an unsalted hash. Matches are not unique by design.';
COMMENT ON TABLE synthetic_evidence IS 'Protected typed evidence. Only trusted adapters may create transport authority; model-supplied receipt fields confer no authority.';

CREATE FUNCTION retain_synthetic_action_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'synthetic_evidence_retention_required';
END;
$$;
CREATE TRIGGER synthetic_actions_retain BEFORE DELETE ON synthetic_actions
  FOR EACH ROW EXECUTE FUNCTION retain_synthetic_action_evidence();
CREATE TRIGGER synthetic_evidence_retain BEFORE DELETE ON synthetic_evidence
  FOR EACH ROW EXECUTE FUNCTION retain_synthetic_action_evidence();

COMMIT;
