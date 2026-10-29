BEGIN;

ALTER TABLE cases
  ADD CONSTRAINT cases_state_valid CHECK (
    state IN ('open', 'gathering', 'acting', 'awaiting_external', 'awaiting_human', 'resolved', 'escalated', 'failed', 'reopened')
  );

ALTER TABLE calls
  ADD CONSTRAINT calls_state_valid CHECK (
    state IN ('connecting', 'active', 'degraded', 'transferring', 'ending', 'ended')
  );

ALTER TABLE call_goals
  ADD CONSTRAINT call_goals_state_valid CHECK (
    state IN ('proposed', 'active', 'achieved', 'blocked', 'superseded', 'abandoned')
  );

ALTER TABLE verification_sessions
  ADD CONSTRAINT verification_sessions_state_valid CHECK (
    state IN ('not_required', 'pending', 'verified', 'failed', 'locked', 'expired')
  ),
  ADD CONSTRAINT verification_sessions_assurance_valid CHECK (
    required_assurance IN ('none', 'basic', 'strong', 'human')
  );

ALTER TABLE policy_decisions
  ADD CONSTRAINT policy_decisions_decision_valid CHECK (
    decision IN ('permit', 'deny', 'human_review')
  );

ALTER TABLE agent_actions
  ADD CONSTRAINT agent_actions_state_valid CHECK (
    state IN (
      'proposed', 'policy_evaluating', 'permitted', 'denied', 'human_review', 'expired',
      'queued', 'executing', 'verifying', 'succeeded', 'uncertain', 'failed', 'cancelled'
    )
  );

ALTER TABLE event_log
  ADD CONSTRAINT event_log_actor_type_valid CHECK (
    actor_type IN ('system', 'model', 'staff', 'caller', 'provider')
  ),
  ADD CONSTRAINT event_log_outcome_valid CHECK (
    outcome IN ('success', 'failure', 'denied', 'uncertain', 'noop')
  ),
  ADD CONSTRAINT event_log_payload_class_valid CHECK (
    payload_class IN ('none', 'public', 'limited', 'phi', 'secret')
  );

ALTER TABLE protected_evidence_metadata
  ADD CONSTRAINT protected_evidence_payload_class_valid CHECK (
    payload_class IN ('limited', 'phi', 'secret')
  );

COMMIT;
