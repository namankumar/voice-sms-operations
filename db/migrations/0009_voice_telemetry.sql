BEGIN;

CREATE FUNCTION reject_event_log_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'event_log_is_append_only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER event_log_no_change
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION reject_event_log_change();

CREATE INDEX event_log_call_type_idx ON event_log (practice_id, call_id, event_type, occurred_at DESC);

COMMIT;
