BEGIN;
ALTER TABLE voice_sip_attempts ADD COLUMN close_requested_at timestamptz;
COMMENT ON COLUMN voice_sip_attempts.close_requested_at IS 'Server-authorized one-shot callback close intent; parent disconnect still requires signed carrier evidence.';
COMMIT;
