BEGIN;

ALTER TABLE protected_evidence_metadata
  ADD CONSTRAINT protected_evidence_metadata_practice_id_unique UNIQUE (practice_id, id);

ALTER TABLE protected_evidence_blobs
  ADD CONSTRAINT protected_evidence_blobs_practice_metadata_fk
  FOREIGN KEY (practice_id, id)
  REFERENCES protected_evidence_metadata(practice_id, id);

COMMIT;
