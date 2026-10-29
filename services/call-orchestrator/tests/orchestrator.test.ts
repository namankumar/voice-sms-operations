import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Call, CallGoal, Case } from "@salven/contracts";
import { CurrentStatePolicyEngine, InMemoryControlPlaneRepository, PermitConsumptionService, PolicyAuthorityService, type Clock, type IdSource } from "@salven/control-plane";
import { deterministicIntergyFixtures, StatefulIntergySimulator, SyntheticExecutionAuthorizationRegistry, type AppointmentReadback } from "@salven/intergy-simulator";

import {
  AppointmentDetailsOrchestrator, DeterministicIdentityService, DeterministicSpokenDirectiveAuthority,
  InMemoryCallWorkflowRepository, hashIdentitySubject, type AcceptedHandoff, type CallWorkflowRepository,
  type AppointmentDetailsGateway, type CommitResult, type IdentityMatch, type ProviderReconciliationPort, type ProtectedDirectiveContentPort,
  type TelephonyHeardReceipt, type WorkflowCommit, type WorkflowScope, type WorkflowSnapshot,
} from "../src/index.js";

class MutableClock implements Clock {
  value = new Date("2030-01-05T08:00:00.000Z");
  now(): Date { return new Date(this.value); }
}
class Ids implements IdSource { private value = 0; next(prefix: string): string { this.value += 1; return `${prefix}-test-${this.value}`; } }
class TrackingRepository implements CallWorkflowRepository {
  readonly inner = new InMemoryCallWorkflowRepository();
  commits = 0;
  create(value: WorkflowSnapshot): Promise<void> { return this.inner.create(value); }
  load(scope: WorkflowScope): Promise<WorkflowSnapshot | null> { return this.inner.load(scope); }
  async commit(command: WorkflowCommit): Promise<CommitResult> { const result = await this.inner.commit(command); if (result.kind === "committed") this.commits += 1; return result; }
}
class ProtectedContent implements ProtectedDirectiveContentPort {
  readonly values = new Map<string, string>();
  async store(input: { directiveId: string; content: string }) { this.values.set(input.directiveId, input.content); return { protectedContentRef: `protected-directive-${input.directiveId}`, contentHash: digest(input.content) }; }
  async retrieve(input: { directiveId: string; protectedContentRef: string }): Promise<string> {
    if (input.protectedContentRef !== `protected-directive-${input.directiveId}`) throw new Error("protected_content_scope_mismatch");
    const value = this.values.get(input.directiveId); if (value === undefined) throw new Error("protected_content_not_found"); return value;
  }
}
class Reconciliation implements ProviderReconciliationPort {
  calls = 0;
  result: Awaited<ReturnType<ProviderReconciliationPort["reconcile"]>> = { kind: "pending" };
  async reconcile(): Promise<Awaited<ReturnType<ProviderReconciliationPort["reconcile"]>>> { this.calls += 1; return this.result; }
}
class HeardAuthority {
  readonly consumed = new Set<string>();
  async verifyAndConsume(candidate: unknown, expected: { practiceId: string; callId: string; goalId: string; directiveId: string }): Promise<TelephonyHeardReceipt | null> {
    const value = candidate as TelephonyHeardReceipt;
    if (value === null || typeof value !== "object" || value.practiceId !== expected.practiceId || value.callId !== expected.callId || value.goalId !== expected.goalId || value.directiveId !== expected.directiveId || this.consumed.has(value.protectedEvidenceId)) return null;
    this.consumed.add(value.protectedEvidenceId);
    return value;
  }
}

const call: Call = { id: "call-test-100", practiceId: "practice-alpha", caseId: "case-test-100", activeGoalId: "goal-test-100", telephonyCallId: "telephony-test-100", traceId: "trace-test-100", state: "active", version: 1, connectedAt: "2030-01-05T08:00:00.000Z", endedAt: null };
const caseValue: Case = { id: call.caseId, practiceId: call.practiceId, ownerId: "owner-test-100", state: "gathering", requestKind: "appointment-details", serviceLevelDueAt: "2030-01-05T09:00:00.000Z", resolutionEvidenceIds: [], version: 2 };
const goal: CallGoal = { id: "goal-test-100", practiceId: call.practiceId, callId: call.id, caseId: caseValue.id, kind: "appointment-details", state: "active", requiredFields: ["appointmentId"], collectedFields: {}, blockerCode: null, version: 1 };
const scope: WorkflowScope = { practiceId: call.practiceId, callId: call.id, caseId: caseValue.id, goalId: goal.id };
const appointment = deterministicIntergyFixtures.appointments[0]!;
const subjectId = "subject-alpha-100";
const appointmentId = "appointment-alpha-100";
const recoveryReadback: AppointmentReadback = { kind: "appointment", providerReadId: "protected-readback-100", practiceId: scope.practiceId, readAt: "2030-01-05T08:01:00.000Z", appointment };

async function build(options: { identity?: IdentityMatch; observeProvider?: (commits: number) => void; neverResolveProvider?: boolean; providerReadDeadlineMs?: number } = {}) {
  const ids = new Ids(); const clock = new MutableClock(); const workflows = new TrackingRepository();
  const control = new InMemoryControlPlaneRepository(); control.seedCase(caseValue);
  const registry = new SyntheticExecutionAuthorizationRegistry();
  const simulator = new StatefulIntergySimulator({ authorizationAuthority: registry, now: () => clock.now() });
  const content = new ProtectedContent(); const reconciliation = new Reconciliation(); const heardReceipts = new HeardAuthority();
  const providerState = { aborted: false };
  const intergy: AppointmentDetailsGateway = { readAppointment: async ({ signal, deadlineAt: _deadlineAt, ...request }) => {
    options.observeProvider?.(workflows.commits);
    signal.addEventListener("abort", () => { providerState.aborted = true; }, { once: true });
    if (options.neverResolveProvider === true) return new Promise(() => undefined);
    return simulator.readAppointment(request);
  } };
  const orchestrator = new AppointmentDetailsOrchestrator({ repository: workflows,
    policy: new PolicyAuthorityService({ repository: control, policy: new CurrentStatePolicyEngine(), clock, ids }),
    permits: new PermitConsumptionService({ repository: control, clock, ids }), authorizationIssuer: registry, intergy, reconciliation,
    identity: new DeterministicIdentityService(ids), identityVerifier: { verify: ({ factor }) => ({ factor, outcome: options.identity ?? "match", protectedEvidenceId: options.identity === "no_match" ? null : `protected-identity-${factor}` }) },
    evidence: { protect: async ({ kind, value }) => ({ protectedEvidenceId: `protected-${kind}-${ids.next("blob")}`, immutableHash: digest(value) }) },
    directiveAuthority: new DeterministicSpokenDirectiveAuthority(ids, content), heardReceipts,
    handoffAcceptance: { verify: (candidate) => { const value = candidate as AcceptedHandoff; return value?.providerReceiptId?.startsWith("accepted-") ? value : null; } },
    clock, ids, ...(options.providerReadDeadlineMs === undefined ? {} : { providerReadDeadlineMs: options.providerReadDeadlineMs }) });
  await orchestrator.start({ call, case: caseValue, goal, ownerId: "worker-test-100" });
  return { orchestrator, workflows, control, simulator, clock, content, reconciliation, heardReceipts, providerState };
}

async function verify(orchestrator: AppointmentDetailsOrchestrator) {
  return orchestrator.submitIdentity({ scope, patientId: subjectId, factors: { date_of_birth: "2030-01-01", phone_last_four: "0100" } });
}
function acceptance(handoffId: string, overrides: Partial<AcceptedHandoff> = {}): AcceptedHandoff {
  return { handoffId, ...scope, ownerId: "staff-test-100", providerReceiptId: "accepted-receipt-100", acceptedAt: "2030-01-05T08:01:00.000Z", ...overrides };
}
function heard(directiveId: string, overrides: Partial<TelephonyHeardReceipt> = {}): TelephonyHeardReceipt {
  return { protectedEvidenceId: `protected-heard-${directiveId}`, immutableHash: digest({ directiveId }), practiceId: scope.practiceId,
    callId: scope.callId, goalId: scope.goalId, directiveId, markId: "mark-test-100", heardAt: "2030-01-05T08:01:00.000Z", ...overrides };
}

describe("appointment details durable workflow", () => {
  it("server-creates only a pending empty identity session and enforces one goal", async () => {
    const { workflows } = await build(); const saved = (await workflows.load(scope))!;
    expect(saved.verification).toMatchObject({ state: "pending", subjectHash: null, attemptCount: 0, identityEvidenceIds: [] });
    const repository = new InMemoryCallWorkflowRepository();
    await expect(repository.create({ ...saved, call: { ...saved.call, activeGoalId: null } })).rejects.toThrow("active_goal_pointer_mismatch");
  });

  it("rejects expired, evidence-free, and illegal identity transitions", async () => {
    const failed = await build({ identity: "no_match" }); expect(await verify(failed.orchestrator)).toBe("failed");
    await expect(verify(failed.orchestrator)).rejects.toThrow("illegal_verification_transition");
    const expired = await build(); expired.clock.value = new Date("2030-01-05T08:06:00.000Z");
    await expect(verify(expired.orchestrator)).rejects.toThrow("verification_session_expired");
  });

  it.each(["ambiguous", "representative"] as const)("routes %s identity to human review", async (identity) => {
    const { orchestrator, workflows } = await build({ identity });
    expect(await verify(orchestrator)).toBe("human_review");
    expect((await workflows.load(scope))!.handoffs[0]).toMatchObject({ state: "pending" });
  });

  it("rejects a forged verified snapshot without identity evidence provenance", async () => {
    const { workflows } = await build(); const saved = (await workflows.load(scope))!;
    const forged = { ...saved, call: { ...saved.call, version: saved.call.version + 1 }, verification: {
      ...saved.verification, state: "verified" as const, subjectHash: hashIdentitySubject(subjectId),
      identityEvidenceIds: ["forged-evidence-100"], attemptCount: 1, version: 1,
    } };
    await expect(workflows.commit({ scope, expectedCallVersion: saved.call.version, expectedOwnerId: saved.ownerId, next: forged })).rejects.toThrow("verified_identity_evidence_missing_or_invalid");
  });

  it("rejects forged active-to-ended state", async () => {
    const { workflows } = await build(); const saved = (await workflows.load(scope))!;
    const forged = { ...saved, call: { ...saved.call, state: "ended" as const, endedAt: "2030-01-05T08:01:00.000Z", version: saved.call.version + 1 } };
    await expect(workflows.commit({ scope, expectedCallVersion: saved.call.version, expectedOwnerId: saved.ownerId, next: forged })).rejects.toThrow();
  });

  it("validates complete tenant call case and goal scope", async () => {
    const { orchestrator, workflows } = await build();
    await expect(orchestrator.resolve({ scope: { ...scope, caseId: "case-other-100" }, patientId: subjectId, appointmentId })).rejects.toThrow("workflow_scope_mismatch");
    const saved = (await workflows.load(scope))!;
    expect(await workflows.commit({ scope, expectedCallVersion: saved.call.version, expectedOwnerId: "wrong-owner-100", next: { ...saved, call: { ...saved.call, version: saved.call.version + 1 } } })).toEqual({ kind: "stale_or_unowned" });
  });

  it("does not read the provider when current control-plane case state is stale", async () => {
    let providerCalled = false; const { orchestrator, workflows, control } = await build({ observeProvider: () => { providerCalled = true; } });
    await verify(orchestrator); control.seedCase({ ...caseValue, version: caseValue.version + 1 });
    expect(await orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).toMatchObject({ kind: "handoff_pending", reason: "policy_deny" });
    expect(providerCalled).toBe(false); expect((await workflows.load(scope))!.actions[0]?.state).toBe("handoff_pending");
  });

  it("persists action idempotency and protected request before provider read", async () => {
    let commitsAtProvider = 0; const { orchestrator, workflows } = await build({ observeProvider: (commits) => { commitsAtProvider = commits; } });
    await verify(orchestrator); const before = workflows.commits;
    expect((await orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).kind).toBe("directive_pending");
    const saved = (await workflows.load(scope))!; expect(commitsAtProvider).toBeGreaterThan(before);
    expect(saved.actions[0]).toMatchObject({ idempotencyKey: expect.stringMatching(/^idempotency-/), protectedRequestEvidenceId: expect.stringMatching(/^evidence-/) });
  });

  it("requires a consumed scoped telephony receipt before resolving", async () => {
    const { orchestrator, workflows } = await build(); await verify(orchestrator);
    const result = await orchestrator.resolve({ scope, patientId: subjectId, appointmentId });
    expect(result.kind).toBe("directive_pending"); if (result.kind !== "directive_pending") return;
    expect(await orchestrator.acknowledgeTrustedHeardReceipt({ scope, directiveId: result.directive.id, receipt: heard(result.directive.id, { callId: "call-forged-100" }) })).toMatchObject({ kind: "blocked", reason: "trusted_heard_receipt_required" });
    const receipt = heard(result.directive.id);
    expect(await orchestrator.acknowledgeTrustedHeardReceipt({ scope, directiveId: result.directive.id, receipt })).toEqual({ kind: "answered", directiveId: result.directive.id });
    expect(await orchestrator.acknowledgeTrustedHeardReceipt({ scope, directiveId: result.directive.id, receipt })).toMatchObject({ kind: "blocked" });
    const saved = (await workflows.load(scope))!; expect(saved.case.state).toBe("resolved"); expect(saved.case.resolutionEvidenceIds).toHaveLength(3);
  });

  it("does not replay a directive after identity expires or for a different subject", async () => {
    const expired = await build(); await verify(expired.orchestrator);
    expect((await expired.orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).kind).toBe("directive_pending");
    expired.clock.value = new Date("2030-01-05T08:06:00.000Z");
    expect(await expired.orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).toMatchObject({ kind: "handoff_pending", reason: "identity_not_current" });
    expect((await expired.workflows.load(scope))?.actions[0]?.state).toBe("handoff_pending");

    const mismatched = await build(); await verify(mismatched.orchestrator);
    expect((await mismatched.orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).kind).toBe("directive_pending");
    expect(await mismatched.orchestrator.resolve({ scope, patientId: "subject-other-100", appointmentId })).toMatchObject({ kind: "handoff_pending", reason: "identity_not_current" });
  });

  it("ends only after a completed answer", async () => {
    const { orchestrator } = await build(); expect(await orchestrator.endCall(scope)).toBe("blocked");
    await verify(orchestrator); const result = await orchestrator.resolve({ scope, patientId: subjectId, appointmentId });
    expect(await orchestrator.endCall(scope)).toBe("blocked");
    if (result.kind === "directive_pending") await orchestrator.acknowledgeTrustedHeardReceipt({ scope, directiveId: result.directive.id, receipt: heard(result.directive.id) });
    expect(await orchestrator.endCall(scope)).toBe("ended");
  });

  it("keeps handoff pending until scoped staff acceptance exists", async () => {
    const { orchestrator, workflows } = await build();
    const pending = await orchestrator.resolve({ scope, patientId: subjectId, appointmentId });
    expect(pending.kind).toBe("handoff_pending"); if (pending.kind !== "handoff_pending") return;
    expect(await orchestrator.acceptHandoff({ scope, candidate: { forged: true } })).toMatchObject({ kind: "handoff_pending" });
    expect(await orchestrator.acceptHandoff({ scope, candidate: acceptance(pending.handoffId, { caseId: "case-other-100" }) })).toMatchObject({ kind: "handoff_pending" });
    expect(await orchestrator.acceptHandoff({ scope, candidate: acceptance(pending.handoffId) })).toMatchObject({ kind: "handoff_accepted", ownerId: "staff-test-100" });
    expect((await workflows.load(scope))!.call.state).toBe("ending");
  });

  it("records failed provider work as owned uncertain with pending handoff", async () => {
    const { orchestrator, workflows, simulator } = await build(); await verify(orchestrator);
    simulator.injectFailure("appointment.details.read", "timeout_before_response");
    expect(await orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).toMatchObject({ kind: "handoff_pending" });
    expect((await workflows.load(scope))!.actions[0]?.state).toBe("uncertain");
  });

  it("bounds a never-resolving provider read and leaves owned reconciliation state", async () => {
    const { orchestrator, workflows, providerState } = await build({ neverResolveProvider: true, providerReadDeadlineMs: 5 }); await verify(orchestrator);
    expect(await orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).toMatchObject({ kind: "handoff_pending", reason: "intergy_read_deadline_exceeded" });
    const saved = (await workflows.load(scope))!;
    expect(providerState.aborted).toBe(true);
    expect(saved.actions[0]?.state).toBe("uncertain");
    expect(saved.handoffs[0]?.brief).toMatchObject({ destination: "reconciliation_queue", attemptedActions: [{ actionId: saved.actions[0]?.id, outcome: "uncertain" }] });
  });

  it("persists a complete safe brief for explicit and repeated-misunderstanding handoffs", async () => {
    const explicit = await build();
    expect(await explicit.orchestrator.requestHumanSupport(scope)).toMatchObject({ kind: "handoff_pending", reason: "explicit_human_request" });
    expect((await explicit.workflows.load(scope))?.handoffs[0]?.brief).toMatchObject({
      verificationState: "pending", verificationFreshness: "stale", goalKind: "appointment-details", goalState: "active",
      safeCollectedFactKeys: [], attemptedActions: [], urgency: "routine", destination: "practice_staff",
      ownerId: "owner-test-100", deadlineAt: caseValue.serviceLevelDueAt,
    });

    const misunderstood = await build();
    expect(await misunderstood.orchestrator.recordMisunderstanding(scope)).toEqual({ kind: "continue", reason: "misunderstanding_recorded", remainingBeforeHandoff: 1 });
    expect(await misunderstood.orchestrator.recordMisunderstanding(scope)).toMatchObject({ kind: "handoff_pending", reason: "repeated_misunderstanding" });
  });

  it.each(["failed", "no_answer"] as const)("owns callback fallback after transfer %s", async (outcome) => {
    const { orchestrator, workflows } = await build();
    const pending = await orchestrator.requestHumanSupport(scope); if (pending.kind !== "handoff_pending") return;
    const callbackDeadlineAt = "2030-01-05T08:30:00.000Z";
    expect(await orchestrator.recordTransferFallback({ scope, handoffId: pending.handoffId, outcome, callbackOwnerId: "callback-owner-100", callbackDeadlineAt }))
      .toEqual({ kind: "callback_owned", handoffId: pending.handoffId, ownerId: "callback-owner-100", deadlineAt: callbackDeadlineAt, transferOutcome: outcome });
    expect((await workflows.load(scope))?.handoffs[0]).toMatchObject({ state: "callback_owned", transferOutcome: outcome,
      brief: { destination: "callback_queue", ownerId: "callback-owner-100", deadlineAt: callbackDeadlineAt } });
  });

  it("reconciles persisted pending action by idempotency without provider re-execution", async () => {
    let providerCalls = 0; const { orchestrator, workflows, reconciliation } = await build({ observeProvider: () => { providerCalls += 1; } });
    await verify(orchestrator); const before = (await workflows.load(scope))!;
    const requestEvidence = { id: "evidence-request-crash", ...scope, actionId: "action-crash-100", directiveId: null, kind: "action_request" as const,
      immutableHash: digest("request"), protectedEvidenceId: "protected-request-crash", createdAt: "2030-01-05T08:00:00.000Z" };
    const action = { id: "action-crash-100", ...scope, capability: "appointment.details.read" as const, subjectHash: hashIdentitySubject(subjectId),
      parameterHash: digestParameters(appointmentId), protectedRequestEvidenceId: requestEvidence.id, idempotencyKey: "idempotency-crash-100", state: "pending" as const,
      receiptEvidenceId: null, readbackEvidenceId: null, directiveId: null, createdAt: "2030-01-05T08:00:00.000Z", updatedAt: "2030-01-05T08:00:00.000Z" };
    await workflows.commit({ scope, expectedCallVersion: before.call.version, expectedOwnerId: before.ownerId, next: { ...before, call: { ...before.call, version: before.call.version + 1 }, actions: [action], evidence: [...before.evidence, requestEvidence] } });
    reconciliation.result = { kind: "verified", receipt: { protected: "receipt" }, readback: recoveryReadback };
    expect((await orchestrator.recoverAction({ scope, actionId: action.id })).kind).toBe("directive_pending");
    expect(reconciliation.calls).toBe(1); expect(providerCalls).toBe(0); expect((await workflows.load(scope))!.actions).toHaveLength(1);
  });

  it("keeps pending reconciliation owned and sends unverified recovery to handoff", async () => {
    const { orchestrator, workflows, reconciliation } = await build(); await verify(orchestrator);
    const before = (await workflows.load(scope))!;
    const requestEvidence = { id: "evidence-request-owned", ...scope, actionId: "action-owned-100", directiveId: null, kind: "action_request" as const,
      immutableHash: digest("request"), protectedEvidenceId: "protected-request-owned", createdAt: "2030-01-05T08:00:00.000Z" };
    const action = { id: "action-owned-100", ...scope, capability: "appointment.details.read" as const, subjectHash: hashIdentitySubject(subjectId),
      parameterHash: digestParameters(appointmentId), protectedRequestEvidenceId: requestEvidence.id, idempotencyKey: "idempotency-owned-100", state: "uncertain" as const,
      receiptEvidenceId: null, readbackEvidenceId: null, directiveId: null, createdAt: "2030-01-05T08:00:00.000Z", updatedAt: "2030-01-05T08:00:00.000Z" };
    await workflows.commit({ scope, expectedCallVersion: before.call.version, expectedOwnerId: before.ownerId, next: { ...before, call: { ...before.call, version: before.call.version + 1 }, actions: [action], evidence: [...before.evidence, requestEvidence] } });
    expect(await orchestrator.recoverAction({ scope, actionId: action.id })).toEqual({ kind: "owned_pending", actionId: action.id, state: "uncertain" });
    reconciliation.result = { kind: "unverified", reason: "not_found" };
    expect(await orchestrator.recoverAction({ scope, actionId: action.id })).toMatchObject({ kind: "handoff_pending" });
  });

  it("fails closed on minimum necessary mismatch and direct adapter bypass", async () => {
    const { orchestrator, simulator } = await build(); await verify(orchestrator); simulator.injectFailure("appointment.details.read", "mismatch");
    expect(await orchestrator.resolve({ scope, patientId: subjectId, appointmentId })).toMatchObject({ kind: "handoff_pending" });
    expect(() => simulator.readAppointment({ authorization: { forged: true }, idempotencyKey: "direct-bypass-100", parameters: { appointmentId } })).toThrow("authorization_invalid");
  });

  it("persists no patient appointment or spoken-text canaries in aggregate memory", async () => {
    const { orchestrator, workflows, content } = await build(); await verify(orchestrator);
    const result = await orchestrator.resolve({ scope, patientId: subjectId, appointmentId });
    const serialized = JSON.stringify(await workflows.load(scope));
    expect(serialized).not.toContain(subjectId); expect(serialized).not.toContain(appointmentId);
    expect(serialized).not.toContain("Your appointment is scheduled"); expect(content.values.size).toBe(result.kind === "directive_pending" ? 1 : 0);
    expect([...content.values.values()][0]).toBe("Your appointment is scheduled for Thursday, January 10 at 4:00 PM UTC. It will be at the main location.");
    expect([...content.values.values()][0]).not.toContain(appointment.startsAt); expect([...content.values.values()][0]).not.toContain(appointment.locationId);
  });
});

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function digestParameters(appointmentId: string): string {
  const canonical = JSON.stringify({ appointmentId });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
