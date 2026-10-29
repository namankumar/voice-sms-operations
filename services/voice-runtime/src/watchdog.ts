export type LatencyTreatment =
  | Readonly<{ kind: "silent"; nextCheckAtMs: number | null }>
  | Readonly<{ kind: "processing_cue"; treatmentId: string; assetId: "typing-soft-v1"; processingEventId: string }>
  | Readonly<{ kind: "acknowledgement"; treatmentId: string; claimClass: "non_factual" }>
  | Readonly<{ kind: "progress"; treatmentId: string; operationEvidenceId: string }>
  | Readonly<{ kind: "timeout"; treatmentId: string; recovery: "retry_callback_or_handoff" }>;

export interface LatencyWatchdogOptions {
  readonly acknowledgementAtMs?: number;
  readonly progressAtMs?: number;
  readonly progressIntervalMs?: number;
  readonly timeoutAtMs?: number;
}

export interface LatencyPrediction {
  readonly class: "expected_fast" | "unknown" | "expected_slow";
  readonly predictedAtMs: number;
  readonly source: string;
  readonly expectedP95Ms: number | null;
  readonly operationEvidenceId: string | null;
}

interface TurnGap {
  readonly turnId: string;
  speechEndedAtMs: number | null;
  responseStartedAtMs: number | null;
  acknowledgementIssued: boolean;
  acknowledgementHeard: boolean;
  lastProgressAtMs: number | null;
  operationEvidenceId: string | null;
  timeoutIssued: boolean;
  prediction: LatencyPrediction | null;
  processingCueIssued: boolean;
  sequence: number;
}

function validThreshold(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`latency_watchdog_invalid_${name}`);
}

/** Deterministic gap treatment. It never invents provider progress or factual claims. */
export class LatencyWatchdog {
  private readonly acknowledgementAtMs: number;
  private readonly progressAtMs: number;
  private readonly progressIntervalMs: number;
  private readonly timeoutAtMs: number;
  private readonly turns = new Map<string, TurnGap>();

  constructor(options: LatencyWatchdogOptions = {}) {
    this.acknowledgementAtMs = options.acknowledgementAtMs ?? 700;
    this.progressAtMs = options.progressAtMs ?? 1_500;
    this.progressIntervalMs = options.progressIntervalMs ?? 4_000;
    this.timeoutAtMs = options.timeoutAtMs ?? 12_000;
    validThreshold(this.acknowledgementAtMs, "acknowledgement");
    validThreshold(this.progressAtMs, "progress");
    validThreshold(this.progressIntervalMs, "progress_interval");
    validThreshold(this.timeoutAtMs, "timeout");
    if (this.acknowledgementAtMs >= this.progressAtMs || this.progressAtMs >= this.timeoutAtMs) {
      throw new Error("latency_watchdog_invalid_order");
    }
  }

  startTurn(turnId: string): void {
    if (turnId.length < 3 || this.turns.has(turnId)) throw new Error("latency_watchdog_invalid_turn");
    this.turns.set(turnId, { turnId, speechEndedAtMs: null, responseStartedAtMs: null, acknowledgementIssued: false,
      acknowledgementHeard: false, lastProgressAtMs: null, operationEvidenceId: null, timeoutIssued: false,
      prediction: null, processingCueIssued: false, sequence: 0 });
  }

  speechEnded(turnId: string, atMs: number): void {
    const turn = this.turn(turnId);
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("latency_watchdog_invalid_time");
    if (turn.speechEndedAtMs !== null) return;
    turn.speechEndedAtMs = atMs;
  }

  operationStarted(turnId: string, evidenceId: string): void {
    const turn = this.turn(turnId);
    if (evidenceId.length < 3) throw new Error("latency_watchdog_operation_evidence_required");
    turn.operationEvidenceId = evidenceId;
  }

  predict(turnId: string, prediction: LatencyPrediction): void {
    const turn = this.turn(turnId);
    if (prediction.source.length < 3 || !Number.isSafeInteger(prediction.predictedAtMs) || prediction.predictedAtMs < 0
      || prediction.expectedP95Ms !== null && (!Number.isSafeInteger(prediction.expectedP95Ms) || prediction.expectedP95Ms < 0)) {
      throw new Error("latency_watchdog_invalid_prediction");
    }
    if (turn.speechEndedAtMs !== null && prediction.predictedAtMs - turn.speechEndedAtMs > 150) {
      throw new Error("latency_watchdog_prediction_late");
    }
    turn.prediction = Object.freeze({ ...prediction });
    if (prediction.operationEvidenceId !== null) this.operationStarted(turnId, prediction.operationEvidenceId);
  }

  acknowledgementHeard(turnId: string): void { this.turn(turnId).acknowledgementHeard = true; }

  responseAudioStarted(turnId: string, atMs: number): Readonly<{ cancelPendingAcknowledgement: boolean }> {
    const turn = this.turn(turnId);
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("latency_watchdog_invalid_time");
    if (turn.responseStartedAtMs === null) turn.responseStartedAtMs = atMs;
    return { cancelPendingAcknowledgement: turn.acknowledgementIssued && !turn.acknowledgementHeard };
  }

  evaluate(turnId: string, nowMs: number): LatencyTreatment {
    const turn = this.turn(turnId);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("latency_watchdog_invalid_time");
    if (turn.speechEndedAtMs === null || turn.responseStartedAtMs !== null || turn.timeoutIssued) return { kind: "silent", nextCheckAtMs: null };
    const elapsed = nowMs - turn.speechEndedAtMs;
    if (elapsed < 0) throw new Error("latency_watchdog_time_reversed");
    if (elapsed >= this.timeoutAtMs) {
      turn.timeoutIssued = true;
      return { kind: "timeout", treatmentId: this.id(turn, "timeout"), recovery: "retry_callback_or_handoff" };
    }
    if (turn.prediction?.class === "expected_slow" && !turn.processingCueIssued && !turn.acknowledgementIssued) {
      turn.processingCueIssued = true;
      return { kind: "processing_cue", treatmentId: this.id(turn, "processing"), assetId: "typing-soft-v1",
        processingEventId: `${turn.turnId}:generic-processing-started` };
    }
    if (elapsed >= this.progressAtMs && turn.operationEvidenceId !== null
      && (turn.lastProgressAtMs === null || nowMs - turn.lastProgressAtMs >= this.progressIntervalMs)) {
      turn.lastProgressAtMs = nowMs;
      return { kind: "progress", treatmentId: this.id(turn, "progress"), operationEvidenceId: turn.operationEvidenceId };
    }
    if (turn.prediction?.class !== "expected_fast" && elapsed >= this.acknowledgementAtMs && !turn.acknowledgementIssued
      && !turn.processingCueIssued) {
      turn.acknowledgementIssued = true;
      return { kind: "acknowledgement", treatmentId: this.id(turn, "acknowledgement"), claimClass: "non_factual" };
    }
    const next = turn.operationEvidenceId !== null && turn.lastProgressAtMs !== null
      ? Math.min(turn.lastProgressAtMs + this.progressIntervalMs, turn.speechEndedAtMs + this.timeoutAtMs)
      : turn.prediction?.class === "expected_slow" && !turn.processingCueIssued
        ? nowMs
        : turn.prediction?.class === "expected_fast"
          ? turn.speechEndedAtMs + this.timeoutAtMs
          : elapsed < this.acknowledgementAtMs
        ? turn.speechEndedAtMs + this.acknowledgementAtMs
        : elapsed < this.progressAtMs ? turn.speechEndedAtMs + this.progressAtMs : turn.speechEndedAtMs + this.timeoutAtMs;
    return { kind: "silent", nextCheckAtMs: next };
  }

  endTurn(turnId: string): void { this.turns.delete(turnId); }

  private id(turn: TurnGap, kind: string): string { turn.sequence += 1; return `${turn.turnId}:${kind}:${turn.sequence}`; }
  private turn(turnId: string): TurnGap { const turn = this.turns.get(turnId); if (turn === undefined) throw new Error("latency_watchdog_unknown_turn"); return turn; }
}
