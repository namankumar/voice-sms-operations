import type { ConversationScope } from "./conversation-contract.js";
import { parseConversationJobResultForKind, type ClaimedConversationJob, type ConversationJobKind, type ConversationJobResult, type ConversationJobState } from "./conversation-jobs.js";

const effectfulKinds = new Set<ConversationJobKind>(["sms_send", "voice_accept", "voice_recovery"]);

export interface ConversationJobsPort {
  claim(input: { practiceId: string; instanceId: string; now: string; leaseMs: number; kinds?: readonly ConversationJobKind[] }): Promise<ClaimedConversationJob | null>;
  markEffectStarted(input: { scope: ConversationScope; id: string; kind: ConversationJobKind; leaseToken: string; attemptId: string; now: string }): Promise<boolean>;
  complete(input: { scope: ConversationScope; id: string; kind: ConversationJobKind; leaseToken: string; now: string; result: ConversationJobResult }): Promise<boolean>;
}

export type ConversationJobHandlerContext = {
  signal: AbortSignal;
  deadlineAt: string;
};
export type ConversationJobHandler = (job: ClaimedConversationJob, context: ConversationJobHandlerContext) => Promise<ConversationJobResult>;
/** `effect` is valid only when the gate atomically persisted the real dispatch/recovery attempt; authorization alone must omit it. */
export type ConversationJobGateResult = { allowed: true; effect?: { attemptId: string } } | { allowed: false; result: ConversationJobResult };
export type ConversationJobGate = (job: ClaimedConversationJob, context: ConversationJobHandlerContext) => Promise<ConversationJobGateResult>;

/** Safe supplemental evidence retained when a provider operation is known after normal completion cannot record it. */
export type FencedLateJobEvidence = {
  scope: ConversationScope;
  jobId: string;
  kind: ConversationJobKind;
  leaseToken: string;
  observedAt: string;
  result: ConversationJobResult;
};
/**
 * This must append evidence transactionally with a store-side fence on scope, job ID,
 * lease token, and a result digest. It may never resume the provider action or overwrite
 * conversation state; the row is supplemental, not completion authority.
 */
export type FencedLateEvidenceSink = (evidence: FencedLateJobEvidence) => Promise<boolean>;

export type RunOneResult =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "claim_failed" }
  | { kind: "completed"; jobId: string; state: ConversationJobState }
  | { kind: "retry_on_lease_expiry"; jobId: string }
  | { kind: "late_evidence_recorded"; jobId: string }
  | { kind: "late_evidence_unrecorded"; jobId: string };

export type ConversationJobWorkerOptions = {
  jobs: ConversationJobsPort;
  scope: Pick<ConversationScope, "practiceId" | "instanceId">;
  handlers: Partial<Record<ConversationJobKind, ConversationJobHandler>>;
  gate?: ConversationJobGate;
  lateEvidence?: FencedLateEvidenceSink;
  clock?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseMs?: number;
  handlerDeadlineMs?: number;
  idleMs?: number;
  lateEvidenceDrainMs?: number;
  kinds?: readonly ConversationJobKind[];
};

/**
 * One worker processes one scoped lease at a time. Cross-worker/per-thread ordering
 * remains the responsibility of the parent scheduler and the durable store gate.
 */
export class ConversationJobWorker {
  private readonly clock: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly leaseMs: number;
  private readonly handlerDeadlineMs: number;
  private readonly idleMs: number;
  private readonly lateEvidenceDrainMs: number;
  private readonly kinds: readonly ConversationJobKind[] | undefined;
  private active: Promise<RunOneResult> | null = null;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private readonly wakeWaiters = new Set<() => void>();
  private readonly lateEvidenceTasks = new Set<Promise<void>>();

  constructor(private readonly options: ConversationJobWorkerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.sleep = options.sleep ?? delay;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.handlerDeadlineMs = options.handlerDeadlineMs ?? 25_000;
    this.idleMs = options.idleMs ?? 250;
    this.lateEvidenceDrainMs = options.lateEvidenceDrainMs ?? 5_000;
    this.kinds = parseWorkerKinds(options.kinds);
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 2 || this.leaseMs > 300_000) throw new Error("conversation_job_worker_lease_invalid");
    if (!Number.isInteger(this.handlerDeadlineMs) || this.handlerDeadlineMs < 1 || this.handlerDeadlineMs >= this.leaseMs) throw new Error("conversation_job_worker_deadline_invalid");
    if (!Number.isInteger(this.idleMs) || this.idleMs < 1 || this.idleMs > 60_000) throw new Error("conversation_job_worker_idle_invalid");
    if (!Number.isInteger(this.lateEvidenceDrainMs) || this.lateEvidenceDrainMs < 1 || this.lateEvidenceDrainMs > 30_000) throw new Error("conversation_job_worker_late_evidence_drain_invalid");
  }

  async runOne(): Promise<RunOneResult> {
    if (this.active !== null) return { kind: "busy" };
    const run = this.runClaimedJob();
    this.active = run;
    try { return await run; }
    finally { if (this.active === run) this.active = null; }
  }

  start(): void {
    if (this.loop !== null) return;
    this.stopping = false;
    this.loop = this.runLoop().finally(() => { this.loop = null; });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
    await this.awaitDrain();
    await this.loop;
    await this.drainLateEvidence();
  }

  async awaitDrain(): Promise<void> {
    while (this.active !== null) await this.active;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const result = await this.runOne();
      if (this.stopping) break;
      if (result.kind === "idle" || result.kind === "busy" || result.kind === "claim_failed" || result.kind === "retry_on_lease_expiry" || result.kind === "late_evidence_unrecorded") await this.waitForWork();
    }
  }

  private async waitForWork(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.wakeWaiters.delete(finish);
        resolve();
      };
      this.wakeWaiters.add(finish);
      void this.sleep(this.idleMs).then(finish, finish);
    });
  }

  private async runClaimedJob(): Promise<RunOneResult> {
    let claimed: ClaimedConversationJob | null;
    try { claimed = await this.options.jobs.claim({ ...this.options.scope, now: this.clock().toISOString(), leaseMs: this.leaseMs,
      ...(this.kinds === undefined ? {} : { kinds: this.kinds }) }); }
    catch { return { kind: "claim_failed" }; }
    if (claimed === null) return { kind: "idle" };
    const handler = this.options.handlers[claimed.kind];
    if (handler === undefined) return { kind: "retry_on_lease_expiry", jobId: claimed.id };

    const invocation = await this.invoke(claimed, handler);
    if (invocation.kind === "result") return this.persistResult(claimed, invocation.result);
    if (effectfulKinds.has(claimed.kind) && invocation.effectStarted && (invocation.kind === "handler_failure" || invocation.kind === "handler_timeout" || invocation.kind === "internal_failure")) {
      return this.persistResult(claimed, invocation.kind === "handler_failure"
        ? { code: "provider_unknown", ...invocation.evidence }
        : { code: "provider_unknown" });
    }
    return { kind: "retry_on_lease_expiry", jobId: claimed.id };
  }

  private async invoke(job: ClaimedConversationJob, handler: ConversationJobHandler): Promise<InvocationResult> {
    const controller = new AbortController();
    let effectStarted = false;
    const deadlineAt = new Date(this.clock().getTime() + this.handlerDeadlineMs).toISOString();
    const handlerPromise = this.runGatedHandler(job, handler, { signal: controller.signal, deadlineAt }, () => { effectStarted = true; })
      .then((result): InvocationResult => ({ kind: "result", result }))
      .catch((error): InvocationResult => error instanceof InternalJobFailure
        ? { kind: "internal_failure", effectStarted }
        : { kind: "handler_failure", effectStarted, evidence: safeProviderEvidence(error) });
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeout = new Promise<InvocationResult>((resolve) => {
      timeoutId = setTimeout(() => { timedOut = true; controller.abort(); resolve({ kind: "handler_timeout", effectStarted }); }, this.handlerDeadlineMs);
    });
    this.trackLateEvidence(handlerPromise.then(async (outcome) => {
      if (timedOut && outcome.kind === "result") await this.persistLateEvidence(job, this.clock().toISOString(), outcome.result);
    }));
    try { return await Promise.race([handlerPromise, timeout]); }
    finally { clearTimeout(timeoutId!); }
  }

  private async runGatedHandler(job: ClaimedConversationJob, handler: ConversationJobHandler, context: ConversationJobHandlerContext, onEffectStarted: () => void): Promise<ConversationJobResult> {
    if (effectfulKinds.has(job.kind) && this.options.gate === undefined) throw new InternalJobFailure();
    let decision: ConversationJobGateResult | undefined;
    if (this.options.gate !== undefined) {
      try { decision = await this.options.gate(job, context); }
      catch { throw new InternalJobFailure(); }
      if (!decision.allowed) return decision.result;
    }
    if (context.signal.aborted || this.clock().getTime() >= Date.parse(context.deadlineAt)) throw new InternalJobFailure();
    if (effectfulKinds.has(job.kind)) {
      if (decision?.allowed !== true || decision.effect === undefined) throw new InternalJobFailure();
      let started: boolean;
      try {
        started = await this.options.jobs.markEffectStarted({ scope: job.scope, id: job.id, kind: job.kind, leaseToken: job.leaseToken, attemptId: decision.effect.attemptId, now: this.clock().toISOString() });
      } catch { throw new InternalJobFailure(); }
      if (!started) throw new InternalJobFailure();
      onEffectStarted();
    }
    if (context.signal.aborted || this.clock().getTime() >= Date.parse(context.deadlineAt)) throw new InternalJobFailure();
    return await handler(job, context);
  }

  private async persistResult(job: ClaimedConversationJob, result: ConversationJobResult): Promise<RunOneResult> {
    const observedAt = this.clock().toISOString();
    try { result = parseConversationJobResultForKind(job.kind, result); }
    catch { return effectfulKinds.has(job.kind) ? this.persistLateEvidence(job, observedAt, result) : { kind: "retry_on_lease_expiry", jobId: job.id }; }
    let completed: boolean;
    try { completed = await this.options.jobs.complete({ scope: job.scope, id: job.id, kind: job.kind, leaseToken: job.leaseToken, now: observedAt, result }); }
    catch {
      if (!effectfulKinds.has(job.kind)) return { kind: "retry_on_lease_expiry", jobId: job.id };
      return this.persistLateEvidence(job, observedAt, result);
    }
    if (completed) return { kind: "completed", jobId: job.id, state: terminalState(result.code) };
    return this.persistLateEvidence(job, observedAt, result);
  }

  private async persistLateEvidence(job: ClaimedConversationJob, observedAt: string, rawResult: unknown): Promise<RunOneResult> {
    let result: ConversationJobResult;
    try { result = parseConversationJobResultForKind(job.kind, rawResult); }
    catch { return { kind: "late_evidence_unrecorded", jobId: job.id }; }
    const evidence: FencedLateJobEvidence = { scope: job.scope, jobId: job.id, kind: job.kind, leaseToken: job.leaseToken, observedAt, result };
    try {
      if (this.options.lateEvidence !== undefined && await this.options.lateEvidence(evidence)) return { kind: "late_evidence_recorded", jobId: job.id };
    } catch { /* The lease remains authoritative; a failed evidence append cannot reopen the provider action. */ }
    return { kind: "late_evidence_unrecorded", jobId: job.id };
  }

  private trackLateEvidence(task: Promise<void>): void {
    this.lateEvidenceTasks.add(task);
    void task.finally(() => { this.lateEvidenceTasks.delete(task); }).catch(() => {});
  }

  private async drainLateEvidence(): Promise<void> {
    const deadline = Date.now() + this.lateEvidenceDrainMs;
    while (this.lateEvidenceTasks.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const tasks = [...this.lateEvidenceTasks];
      await Promise.race([Promise.allSettled(tasks), delay(remaining)]);
    }
  }
}

type InvocationResult =
  | { kind: "result"; result: ConversationJobResult }
  | { kind: "handler_failure"; effectStarted: boolean; evidence: ProviderEvidence | undefined }
  | { kind: "handler_timeout"; effectStarted: boolean }
  | { kind: "internal_failure"; effectStarted: boolean };
type ProviderEvidence = { providerId?: string; attemptId?: string; state?: "unknown" };

/** A handler may attach only safe provider identifiers to an otherwise opaque failure. */
export class ProviderJobFailure extends Error {
  constructor(readonly evidence: ProviderEvidence = {}) { super("provider_job_failure"); }
}
class InternalJobFailure extends Error { constructor() { super("conversation_job_internal_failure"); } }

function safeProviderEvidence(error: unknown): ProviderEvidence | undefined {
  return error instanceof ProviderJobFailure ? error.evidence : undefined;
}
function terminalState(code: ConversationJobResult["code"]): Extract<ConversationJobState, "succeeded" | "failed" | "outcome_unknown"> {
  if (code === "provider_unknown") return "outcome_unknown";
  if (code === "provider_failed" || code === "provider_undelivered" || code === "recovery_failed") return "failed";
  return "succeeded";
}
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function parseWorkerKinds(value: readonly ConversationJobKind[] | undefined): readonly ConversationJobKind[] | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set<ConversationJobKind>(["sms_turn", "sms_send", "sms_receipt", "voice_accept", "voice_recovery", "stub_timeout", "post_call_eval"]);
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.size || new Set(value).size !== value.length
    || value.some((kind) => !allowed.has(kind))) throw new Error("conversation_job_worker_kinds_invalid");
  return [...value];
}
