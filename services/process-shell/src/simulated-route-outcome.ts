import { createHash } from "node:crypto";

import { simulatedRouteBindingKey, type ConversationScope, type SimulatedRouteOutcome } from "./conversation-contract.js";
import type { ConversationStore, TransitionReceipt } from "./conversation-store.js";

/** Server-owned deterministic demo control; no destination, provider client, or dial path. */
export class SimulatedRouteOutcomeRecorder {
  constructor(private readonly store: Pick<ConversationStore, "get" | "getEvent" | "execute">, private readonly now: () => Date = () => new Date()) {}

  async record(input: { scope: ConversationScope; requestId: string; sourceId: string; requestRevision: number; ownerEpoch: number;
    category: SimulatedRouteOutcome["category"]; outcome: SimulatedRouteOutcome["outcome"]; stillCurrent?: () => boolean }): Promise<TransitionReceipt> {
    const current = await this.store.get(input.scope);
    if (current === null || current.admission.mode !== "receptionist" || current.admission.channel !== "voice") throw new Error("simulated_route_unavailable");
    // The caller supplies the immutable binding observed at route selection. This
    // permits an exact retry after callback capture changes mutable request state.
    const bindingKey = simulatedRouteBindingKey({ practiceId: current.admission.practiceId, instanceId: current.admission.instanceId,
      conversationId: current.id, sourceId: input.sourceId, requestId: input.requestId, requestRevision: input.requestRevision,
      ownerEpoch: input.ownerEpoch, category: input.category, outcome: input.outcome });
    const eventId = `simulated-route-${bindingKey}`;
    const retryEventId = `${eventId}-retry-1`;
    const replay = await this.store.getEvent(input.scope, eventId);
    const retried = await this.store.getEvent(input.scope, retryEventId);
    if (retried !== null) return retried.receipt;
    if (replay !== null) return replay.receipt;
    if (current.phase !== "active" || current.owner !== "ai") throw new Error("simulated_route_unavailable");
    const request = current.requests.find((item) => item.id === input.requestId);
    if (request === undefined || request.state !== "draft" || request.category !== input.category || request.revision !== input.requestRevision
      || current.ownerEpoch !== input.ownerEpoch || !request.sourceIds.includes(input.sourceId)) throw new Error("simulated_route_request_unavailable");
    const supersededIds = new Set(current.simulatedRouteOutcomes.flatMap((item) => item.supersedesId === null ? [] : [item.supersedesId]));
    const currentRoute = current.simulatedRouteOutcomes.find((item) => item.requestId === request.id && !supersededIds.has(item.id));
    const outcome: SimulatedRouteOutcome = {
      id: `sim-route-${createHash("sha256").update(bindingKey).digest("hex").slice(0, 32)}`,
      sourceId: input.sourceId, requestId: request.id, requestRevision: request.revision, ownerEpoch: current.ownerEpoch,
      instanceId: current.admission.instanceId, conversationId: current.id, category: request.category, outcome: input.outcome,
      bindingKey, recordedAt: this.now().toISOString(), supersedesId: currentRoute?.id ?? null,
    };
    const execute = async (state: typeof current, retryEventId: string) => await this.store.execute({ scope: input.scope, eventId: retryEventId, expectedRevision: state.revision,
      expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "system", id: "simulated-route-harness" },
      command: { type: "simulated_route.record", outcome } });
    const original = await execute(current, eventId);
    if (original.accepted || original.error !== "stale_revision") return original;
    const latest = await this.store.get(input.scope);
    if (input.stillCurrent?.() === false || latest === null || !sameRouteTransitionState(current, latest)) return original;
    const latestRequest = latest.requests.find((item) => item.id === input.requestId);
    if (latest.phase !== "active" || latest.owner !== "ai" || latest.ownerEpoch !== input.ownerEpoch
      || latestRequest?.state !== "draft" || latestRequest.revision !== input.requestRevision || latestRequest.category !== input.category
      || !latestRequest.sourceIds.includes(input.sourceId)
      || latest.simulatedRouteOutcomes.some((item) => item.bindingKey === bindingKey)) return original;
    return await execute(latest, retryEventId);
  }
}

function sameRouteTransitionState(before: Awaited<ReturnType<ConversationStore["get"]>>, current: Awaited<ReturnType<ConversationStore["get"]>>): boolean {
  if (before === null || current === null) return false;
  const { revision: _beforeRevision, activityLeaseUntil: _beforeLease, updatedAt: _beforeUpdatedAt, speechReviews: beforeReviews, ...beforeStable } = before;
  const { revision: _currentRevision, activityLeaseUntil: _currentLease, updatedAt: _currentUpdatedAt, speechReviews: currentReviews, ...currentStable } = current;
  return JSON.stringify(beforeStable) === JSON.stringify(currentStable)
    && currentReviews.length >= beforeReviews.length
    && JSON.stringify(currentReviews.slice(0, beforeReviews.length)) === JSON.stringify(beforeReviews)
    && currentReviews.slice(beforeReviews.length).every((review) => review.verdict === "clear" && review.correction === "not_required");
}
