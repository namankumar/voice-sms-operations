import {
  assertCaseCanResolve,
  assertTransition,
  callTransitions,
  caseTransitions,
  goalTransitions,
  verificationTransitions,
  type Call,
  type CallGoal,
  type Case,
  type Capability,
  type VerificationState,
} from "@salven/contracts";

export interface VerificationMemory {
  id: string;
  practiceId: string;
  callId: string;
  capability: Capability;
  requiredAssurance: "none" | "basic" | "strong" | "human";
  state: VerificationState;
  attemptCount: number;
  identityEvidenceIds: readonly string[];
  subjectHash: string | null;
  expiresAt: string | null;
  version: number;
}

export type ActionMemoryState = "pending" | "uncertain" | "handoff_pending" | "directive_pending" | "heard";
export interface ActionMemory {
  id: string;
  practiceId: string;
  callId: string;
  caseId: string;
  goalId: string;
  capability: "appointment.details.read";
  subjectHash: string;
  parameterHash: string;
  protectedRequestEvidenceId: string;
  idempotencyKey: string;
  state: ActionMemoryState;
  receiptEvidenceId: string | null;
  readbackEvidenceId: string | null;
  directiveId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CallTurn {
  id: string; practiceId: string; callId: string; caseId: string; goalId: string;
  sequence: number; actor: "caller" | "agent" | "system";
  kind: "identity" | "directive" | "heard_mark" | "handoff" | "misunderstanding";
  factKeys: readonly string[]; createdAt: string;
}

export interface SpokenDirective {
  id: string; practiceId: string; callId: string; caseId: string; goalId: string; actionId: string;
  protectedContentRef: string;
  contentHash: string;
  state: "pending" | "heard";
  heardMarkEvidenceId: string | null;
  createdAt: string;
}

export interface HandoffBrief {
  verificationState: VerificationState;
  verificationFreshness: "current" | "stale";
  goalKind: CallGoal["kind"];
  goalState: CallGoal["state"];
  safeCollectedFactKeys: readonly string[];
  attemptedActions: readonly { actionId: string; outcome: ActionMemoryState }[];
  urgency: "routine" | "urgent";
  destination: "practice_staff" | "reconciliation_queue" | "callback_queue";
  ownerId: string;
  deadlineAt: string;
}

export interface HandoffMemory {
  id: string; practiceId: string; callId: string; caseId: string; goalId: string;
  reason: string; state: "pending" | "accepted" | "callback_owned"; ownerId: string | null;
  acceptanceEvidenceId: string | null; transferOutcome: "failed" | "no_answer" | null;
  brief: HandoffBrief; createdAt: string;
}

export type WorkflowEvidenceKind =
  | "identity_factor"
  | "action_request"
  | "provider_receipt"
  | "provider_readback"
  | "directive_heard"
  | "handoff_acceptance";

export interface WorkflowEvidence {
  id: string; practiceId: string; callId: string; caseId: string; goalId: string;
  actionId: string | null;
  directiveId: string | null;
  kind: WorkflowEvidenceKind;
  immutableHash: string;
  protectedEvidenceId: string;
  createdAt: string;
}

export interface WorkflowEvent {
  id: string; practiceId: string; callId: string; caseId: string; goalId: string;
  type: string; objectId: string; createdAt: string;
}
export interface WorkflowOutbox {
  id: string; practiceId: string; callId: string; eventId: string; topic: string;
  state: "pending"; createdAt: string;
}

export interface WorkflowSnapshot {
  call: Call;
  case: Case;
  goal: CallGoal;
  verification: VerificationMemory;
  ownerId: string;
  turns: readonly CallTurn[];
  directives: readonly SpokenDirective[];
  actions: readonly ActionMemory[];
  handoffs: readonly HandoffMemory[];
  evidence: readonly WorkflowEvidence[];
  events: readonly WorkflowEvent[];
  outbox: readonly WorkflowOutbox[];
}

export interface WorkflowScope { practiceId: string; callId: string; caseId: string; goalId: string; }
export interface WorkflowCommit { scope: WorkflowScope; expectedCallVersion: number; expectedOwnerId: string; next: WorkflowSnapshot; }
export type CommitResult = { kind: "committed" } | { kind: "stale_or_unowned" };

/** Async aggregate boundary used by both deterministic tests and transactional adapters. */
export interface CallWorkflowRepository {
  create(initial: WorkflowSnapshot): Promise<void>;
  load(scope: WorkflowScope): Promise<WorkflowSnapshot | null>;
  commit(command: WorkflowCommit): Promise<CommitResult>;
}

/** Deterministic process-local adapter. It is test-only and never production durable. */
export class InMemoryCallWorkflowRepository implements CallWorkflowRepository {
  private readonly values = new Map<string, WorkflowSnapshot>();

  async create(initial: WorkflowSnapshot): Promise<void> {
    assertInitialSnapshot(initial);
    const key = this.key(initial.call.practiceId, initial.call.id);
    if (this.values.has(key)) throw new Error("call_already_exists");
    this.values.set(key, clone(initial));
  }

  async load(scope: WorkflowScope): Promise<WorkflowSnapshot | null> {
    const value = this.values.get(this.key(scope.practiceId, scope.callId));
    if (value === undefined) return null;
    assertScope(value, scope);
    return clone(value);
  }

  async commit(command: WorkflowCommit): Promise<CommitResult> {
    const current = this.values.get(this.key(command.scope.practiceId, command.scope.callId));
    if (current === undefined) return { kind: "stale_or_unowned" };
    assertScope(current, command.scope);
    assertScope(command.next, command.scope);
    if (current.call.version !== command.expectedCallVersion || current.ownerId !== command.expectedOwnerId) return { kind: "stale_or_unowned" };
    assertCommit(current, command.next);
    this.values.set(this.key(command.scope.practiceId, command.scope.callId), clone(command.next));
    return { kind: "committed" };
  }

  private key(practiceId: string, callId: string): string { return `${practiceId}:${callId}`; }
}

export interface SqlResult<T> { rowCount: number; rows: readonly T[]; }
export interface PostgresTransaction { query<T>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<T>>; }
export interface PostgresPool { transaction<T>(run: (tx: PostgresTransaction) => Promise<T>): Promise<T>; }

/** Durable adapter; aggregate, evidence, event, and outbox writes commit in one PostgreSQL transaction. */
export class PostgresCallWorkflowRepository implements CallWorkflowRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(initial: WorkflowSnapshot): Promise<void> {
    assertInitialSnapshot(initial);
    await this.pool.transaction(async (tx) => {
      await this.ensureInitialVerification(tx, initial);
      await this.assertBaseOwnership(tx, initial);
      await this.synchronizeBaseProjection(tx, initial, initial);
      await tx.query(
        `INSERT INTO call_workflows (practice_id, call_id, case_id, goal_id, owner_id, call_version, snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [initial.call.practiceId, initial.call.id, initial.case.id, initial.goal.id, initial.ownerId, initial.call.version, initial],
      );
      await this.persistAggregate(tx, initial);
    });
  }

  private async ensureInitialVerification(tx: PostgresTransaction, value: WorkflowSnapshot): Promise<void> {
    await tx.query(
      `INSERT INTO verification_sessions
       (id,practice_id,call_id,patient_id,capability,required_assurance,state,attempt_count,evidence_ids,expires_at,version)
       SELECT $1,$2,$3,NULL,$4,$5,$6,$7,$8::jsonb,$9,$10
       WHERE EXISTS (SELECT 1 FROM calls WHERE id=$3 AND practice_id=$2)
       ON CONFLICT (id) DO NOTHING`,
      [value.verification.id, value.verification.practiceId, value.verification.callId,
        value.verification.capability, value.verification.requiredAssurance, value.verification.state,
        value.verification.attemptCount, JSON.stringify(value.verification.identityEvidenceIds),
        value.verification.expiresAt, value.verification.version],
    );
  }

  async load(scope: WorkflowScope): Promise<WorkflowSnapshot | null> {
    return this.pool.transaction(async (tx) => {
      const result = await tx.query<{ snapshot: string }>(
        `SELECT snapshot::text AS snapshot FROM call_workflows WHERE practice_id=$1 AND call_id=$2 AND case_id=$3 AND goal_id=$4`,
        [scope.practiceId, scope.callId, scope.caseId, scope.goalId],
      );
      const raw = result.rows[0]?.snapshot;
      const value = raw === undefined ? null : JSON.parse(raw) as WorkflowSnapshot;
      if (value !== null) assertSnapshot(value);
      return value;
    });
  }

  async commit(command: WorkflowCommit): Promise<CommitResult> {
    assertScope(command.next, command.scope);
    return this.pool.transaction(async (tx) => {
      await this.assertBaseOwnership(tx, command.next);
      const existing = await tx.query<{ snapshot: string }>(
        `SELECT snapshot::text AS snapshot FROM call_workflows
         WHERE practice_id=$1 AND call_id=$2 AND case_id=$3 AND goal_id=$4 FOR UPDATE`,
        [command.scope.practiceId, command.scope.callId, command.scope.caseId, command.scope.goalId],
      );
      if (existing.rowCount !== 1) return { kind: "stale_or_unowned" };
      const current = JSON.parse(existing.rows[0]!.snapshot) as WorkflowSnapshot;
      if (current.call.version !== command.expectedCallVersion || current.ownerId !== command.expectedOwnerId) return { kind: "stale_or_unowned" };
      assertCommit(current, command.next);
      await this.synchronizeBaseProjection(tx, current, command.next);
      const updated = await tx.query(
        `UPDATE call_workflows SET owner_id=$1, call_version=$2, snapshot=$3::jsonb
         WHERE practice_id=$4 AND call_id=$5 AND case_id=$6 AND goal_id=$7 AND owner_id=$8 AND call_version=$9`,
        [command.next.ownerId, command.next.call.version, command.next, command.scope.practiceId,
          command.scope.callId, command.scope.caseId, command.scope.goalId, command.expectedOwnerId, command.expectedCallVersion],
      );
      if (updated.rowCount !== 1) return { kind: "stale_or_unowned" };
      await this.persistAggregate(tx, command.next);
      return { kind: "committed" };
    });
  }

  private async assertBaseOwnership(tx: PostgresTransaction, value: WorkflowSnapshot): Promise<void> {
    const owned = await tx.query(
      `SELECT 1 FROM practices p
       JOIN calls c ON c.practice_id=p.id AND c.id=$2 AND c.case_id=$3
       JOIN cases k ON k.practice_id=p.id AND k.id=$3
       JOIN call_goals g ON g.practice_id=p.id AND g.id=$4 AND g.call_id=c.id AND g.case_id=k.id
       JOIN verification_sessions v ON v.practice_id=p.id AND v.id=$5 AND v.call_id=c.id
       WHERE p.id=$1 FOR KEY SHARE OF p,c,k,g,v`,
      [value.call.practiceId, value.call.id, value.case.id, value.goal.id, value.verification.id],
    );
    if (owned.rowCount !== 1) throw new Error("base_workflow_ownership_mismatch");
  }

  private async synchronizeBaseProjection(tx: PostgresTransaction, before: WorkflowSnapshot, next: WorkflowSnapshot): Promise<void> {
    const updates: SqlResult<unknown>[] = [];
    updates.push(await tx.query(
        `UPDATE cases SET owner_id=$1, state=$2, resolution_evidence_ids=$3::jsonb, version=$4, updated_at=now()
         WHERE id=$5 AND practice_id=$6 AND version=$7`,
        [next.case.ownerId, next.case.state, JSON.stringify(next.case.resolutionEvidenceIds), next.case.version,
          before.case.id, before.case.practiceId, before.case.version],
      ));
    updates.push(await tx.query(
        `UPDATE call_goals SET state=$1, required_fields=$2::jsonb, collected_fields=$3::jsonb,
           blocker_code=$4, version=$5, updated_at=now()
         WHERE id=$6 AND practice_id=$7 AND call_id=$8 AND case_id=$9 AND version=$10`,
        [next.goal.state, JSON.stringify(next.goal.requiredFields), JSON.stringify(next.goal.collectedFields),
          next.goal.blockerCode, next.goal.version, before.goal.id, before.goal.practiceId, before.goal.callId,
          before.goal.caseId, before.goal.version],
      ));
    updates.push(await tx.query(
        `UPDATE verification_sessions SET capability=$1, required_assurance=$2, state=$3, attempt_count=$4,
           evidence_ids=$5::jsonb, expires_at=$6, version=$7
         WHERE id=$8 AND practice_id=$9 AND call_id=$10 AND version=$11`,
        [next.verification.capability, next.verification.requiredAssurance, next.verification.state,
          next.verification.attemptCount, JSON.stringify(next.verification.identityEvidenceIds), next.verification.expiresAt,
          next.verification.version, before.verification.id, before.verification.practiceId,
          before.verification.callId, before.verification.version],
      ));
    updates.push(await tx.query(
        `UPDATE calls SET active_goal_id=$1, state=$2, version=$3, connected_at=$4, ended_at=$5
         WHERE id=$6 AND practice_id=$7 AND case_id=$8 AND version=$9`,
        [next.call.activeGoalId, next.call.state, next.call.version, next.call.connectedAt, next.call.endedAt,
          before.call.id, before.call.practiceId, before.call.caseId, before.call.version],
      ));
    if (updates.some((result) => result.rowCount !== 1)) throw new Error("base_projection_version_or_scope_conflict");
  }

  private async persistAggregate(tx: PostgresTransaction, value: WorkflowSnapshot): Promise<void> {
    const objects: readonly [string, string, unknown][] = [
      ["workflow_calls", value.call.id, value.call], ["workflow_cases", value.case.id, value.case],
      ["workflow_goals", value.goal.id, value.goal], ["workflow_verifications", value.verification.id, value.verification],
    ];
    for (const [table, id, payload] of objects) await this.upsertScoped(tx, table, { id, practiceId: value.call.practiceId, callId: value.call.id }, payload);
    await this.upsertRows(tx, "workflow_actions", value.actions);
    await this.upsertRows(tx, "workflow_directives", value.directives);
    await this.upsertRows(tx, "workflow_handoffs", value.handoffs);
    await this.insertImmutableRows(tx, "workflow_turns", value.turns);
    await this.insertImmutableRows(tx, "workflow_evidence", value.evidence);
    await this.insertImmutableRows(tx, "workflow_events", value.events);
    await this.insertImmutableRows(tx, "workflow_outbox", value.outbox);
  }

  private async upsertScoped(tx: PostgresTransaction, table: string, row: { id: string; practiceId: string; callId: string }, payload: unknown): Promise<void> {
    const result = await tx.query(`INSERT INTO ${table} (id, practice_id, call_id, payload) VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload
      WHERE ${table}.practice_id=EXCLUDED.practice_id AND ${table}.call_id=EXCLUDED.call_id RETURNING id`,
    [row.id, row.practiceId, row.callId, payload]);
    if (result.rowCount !== 1) throw new Error(`scoped_${table}_conflict`);
  }

  private async upsertRows(tx: PostgresTransaction, table: string, rows: readonly { id: string; practiceId: string; callId: string }[]): Promise<void> {
    for (const row of rows) await this.upsertScoped(tx, table, row, row);
  }

  private async insertImmutableRows(tx: PostgresTransaction, table: string, rows: readonly { id: string; practiceId: string; callId: string }[]): Promise<void> {
    for (const row of rows) {
      const result = await tx.query(`INSERT INTO ${table} (id, practice_id, call_id, payload) VALUES ($1,$2,$3,$4::jsonb)
        ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload
        WHERE ${table}.practice_id=EXCLUDED.practice_id AND ${table}.call_id=EXCLUDED.call_id AND ${table}.payload=EXCLUDED.payload
        RETURNING id`, [row.id, row.practiceId, row.callId, row]);
      if (result.rowCount !== 1) throw new Error(`immutable_${table}_conflict`);
    }
  }
}

// Deliberately mirrors db/migrations/0003_voice_workflow.sql; the disposable test detects drift.
export const postgresWorkflowSchema = `BEGIN;

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

COMMIT;`;

export function assertScope(value: WorkflowSnapshot, scope: WorkflowScope): void {
  if (value.call.practiceId !== scope.practiceId || value.case.practiceId !== scope.practiceId || value.goal.practiceId !== scope.practiceId || value.verification.practiceId !== scope.practiceId ||
      value.call.id !== scope.callId || value.goal.callId !== scope.callId || value.verification.callId !== scope.callId ||
      value.call.caseId !== scope.caseId || value.case.id !== scope.caseId || value.goal.caseId !== scope.caseId || value.goal.id !== scope.goalId) {
    throw new Error("workflow_scope_mismatch");
  }
}

function assertInitialSnapshot(value: WorkflowSnapshot): void {
  assertSnapshot(value);
  if (value.call.state !== "active" || value.goal.state !== "active" || value.call.activeGoalId !== value.goal.id) throw new Error("initial_active_goal_required");
  if (value.verification.state !== "pending" || value.verification.subjectHash !== null || value.verification.attemptCount !== 0 || value.verification.identityEvidenceIds.length !== 0) {
    throw new Error("server_created_pending_verification_required");
  }
  if (value.turns.length + value.directives.length + value.actions.length + value.handoffs.length + value.evidence.length !== 0) throw new Error("initial_memory_must_be_empty");
}

function assertCommit(before: WorkflowSnapshot, after: WorkflowSnapshot): void {
  assertSnapshot(after);
  assertTransitionIfChanged(callTransitions, before.call.state, after.call.state, "call");
  assertTransitionIfChanged(goalTransitions, before.goal.state, after.goal.state, "goal");
  assertTransitionIfChanged(caseTransitions, before.case.state, after.case.state, "case");
  assertTransitionIfChanged(verificationTransitions, before.verification.state, after.verification.state, "verification");
  if (after.call.version !== before.call.version + 1) throw new Error("call_version_must_increment_once");
  if (after.case.version < before.case.version || after.goal.version < before.goal.version || after.verification.version < before.verification.version) throw new Error("workflow_version_regressed");
  if (after.call.id !== before.call.id || after.call.practiceId !== before.call.practiceId || after.call.caseId !== before.call.caseId ||
      after.case.id !== before.case.id || after.case.practiceId !== before.case.practiceId ||
      after.goal.id !== before.goal.id || after.goal.practiceId !== before.goal.practiceId || after.goal.callId !== before.goal.callId || after.goal.caseId !== before.goal.caseId ||
      after.verification.id !== before.verification.id || after.verification.practiceId !== before.verification.practiceId || after.verification.callId !== before.verification.callId) {
    throw new Error("workflow_identity_is_immutable");
  }
  assertImmutableEvidence(before.evidence, after.evidence);
}

function assertTransitionIfChanged<T extends string>(table: Readonly<Record<T, readonly T[]>>, from: T, to: T, label: string): void {
  if (from === to) return;
  try { assertTransition(table, from, to); } catch { throw new Error(`illegal_${label}_transition`); }
}

function assertSnapshot(value: WorkflowSnapshot): void {
  assertScope(value, { practiceId: value.call.practiceId, callId: value.call.id, caseId: value.case.id, goalId: value.goal.id });
  if (value.goal.state === "active" && value.call.activeGoalId !== value.goal.id) throw new Error("active_goal_pointer_mismatch");
  if (value.goal.state !== "active" && value.call.activeGoalId !== null) throw new Error("terminal_goal_must_be_detached");
  if (value.call.state === "ended" && (value.call.endedAt === null || value.goal.state === "active")) throw new Error("ended_call_requires_completed_outcome");
  const evidence = new Map(value.evidence.map((item) => [item.id, item]));
  for (const item of value.evidence) {
    if (item.protectedEvidenceId.length < 3 || !/^sha256:[a-f0-9]{64}$/.test(item.immutableHash)) throw new Error("protected_evidence_provenance_required");
  }
  if (value.verification.state === "verified") {
    if (value.verification.subjectHash === null || value.verification.identityEvidenceIds.length === 0) throw new Error("verified_identity_requires_evidence");
    for (const id of value.verification.identityEvidenceIds) if (evidence.get(id)?.kind !== "identity_factor") throw new Error("verified_identity_evidence_missing_or_invalid");
  }
  for (const action of value.actions) {
    const request = evidence.get(action.protectedRequestEvidenceId);
    if (request?.kind !== "action_request" || request.actionId !== action.id) throw new Error("action_request_evidence_missing");
    assertActionEvidence(evidence, action.receiptEvidenceId, "provider_receipt", action.id);
    assertActionEvidence(evidence, action.readbackEvidenceId, "provider_readback", action.id);
    if ((action.state === "directive_pending" || action.state === "heard") && (action.receiptEvidenceId === null || action.readbackEvidenceId === null || action.directiveId === null)) throw new Error("completed_action_evidence_missing");
  }
  for (const directive of value.directives) {
    if (directive.protectedContentRef.length < 3 || !directive.contentHash.startsWith("sha256:")) throw new Error("directive_protected_content_required");
    if (directive.state === "heard") {
      const heard = directive.heardMarkEvidenceId === null ? undefined : evidence.get(directive.heardMarkEvidenceId);
      if (heard?.kind !== "directive_heard" || heard.directiveId !== directive.id) throw new Error("directive_heard_evidence_missing");
    }
  }
  for (const handoff of value.handoffs) {
    if (handoff.brief.ownerId.length < 3 || handoff.brief.deadlineAt.length < 10 || handoff.brief.safeCollectedFactKeys.some((key) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key))) throw new Error("handoff_brief_incomplete_or_unsafe");
    if (handoff.state === "callback_owned" && (handoff.ownerId === null || handoff.transferOutcome === null || handoff.brief.destination !== "callback_queue")) throw new Error("callback_handoff_ownership_required");
    if (handoff.state === "accepted") {
      const acceptance = handoff.acceptanceEvidenceId === null ? undefined : evidence.get(handoff.acceptanceEvidenceId);
      if (acceptance?.kind !== "handoff_acceptance") throw new Error("handoff_acceptance_evidence_missing");
    }
  }
  if (value.case.state === "resolved") {
    assertCaseCanResolve(value.case);
    const kinds = new Set(value.case.resolutionEvidenceIds.map((id) => evidence.get(id)?.kind));
    if (!kinds.has("provider_receipt") || !kinds.has("provider_readback") || !kinds.has("directive_heard")) throw new Error("resolved_case_receipt_readback_heard_required");
  }
  for (const item of [...value.turns, ...value.directives, ...value.actions, ...value.handoffs, ...value.evidence, ...value.events]) {
    if (item.practiceId !== value.call.practiceId || item.callId !== value.call.id || item.caseId !== value.case.id || item.goalId !== value.goal.id) throw new Error("nested_workflow_scope_mismatch");
  }
  const eventIds = new Set(value.events.map((item) => item.id));
  for (const item of value.outbox) if (item.practiceId !== value.call.practiceId || item.callId !== value.call.id || !eventIds.has(item.eventId)) throw new Error("outbox_scope_or_event_mismatch");
}

function assertActionEvidence(evidence: ReadonlyMap<string, WorkflowEvidence>, id: string | null, kind: WorkflowEvidenceKind, actionId: string): void {
  if (id === null) return;
  const item = evidence.get(id);
  if (item?.kind !== kind || item.actionId !== actionId) throw new Error("action_evidence_missing_or_invalid");
}

function assertImmutableEvidence(before: readonly WorkflowEvidence[], after: readonly WorkflowEvidence[]): void {
  const next = new Map(after.map((item) => [item.id, canonicalJson(item)]));
  for (const item of before) if (next.get(item.id) !== canonicalJson(item)) throw new Error("immutable_evidence_changed_or_removed");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function clone<T>(value: T): T { return structuredClone(value); }
