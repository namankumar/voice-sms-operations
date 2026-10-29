import { z } from "zod";
import type { Conversation } from "./conversation-contract.js";

export const queueFilterSchema = z.enum(["total", "active_now", "needs_follow_up", "connected_to_staff", "resolved_by_human", "resolved_by_ai"]);
export type QueueFilter = z.infer<typeof queueFilterSchema>;

export type QueueMetricCounts = {
  total: number;
  activeNow: number;
  needsFollowUp: number;
  connectedToStaff: number;
  resolvedByHuman: number;
  resolvedByAi: number;
};

export type ConversationQueueProjection = {
  channel: "voice" | "sms";
  filter: QueueFilter;
  page: number;
  pageSize: number;
  total: number;
  metrics: QueueMetricCounts;
  rows: readonly Conversation[];
};

export type ConversationHistoryEntry = {
  conversationId: string;
  createdAt: string;
  updatedAt: string;
  phase: Conversation["phase"];
  nextStep: "needs_follow_up" | "completed" | "unresolved";
  requestSummary: string | null;
};

export type ConversationHistoryProjection = {
  channel: "voice" | "sms";
  availability: "available" | "unavailable";
  unavailableReason: "projection_incomplete" | "snapshot_unavailable" | null;
  earliestRetainedAt: string | null;
  latestRetainedAt: string | null;
  retainedCount: number;
  priorCount: number;
  recent: readonly ConversationHistoryEntry[];
  numberMatchDoesNotEstablishIdentity: true;
};

function hasAiResolutionProof(request: Conversation["requests"][number]): boolean {
  return request.aiResolution !== null && request.aiResolution !== undefined;
}

function isTerminalRequest(request: Conversation["requests"][number]): boolean {
  return request.state === "completed" || request.state === "abandoned" || request.state === "ai_resolved" && hasAiResolutionProof(request);
}

/** Only durable state can place a conversation in an operational filter. */
export function queueStateOf(conversation: Conversation, now = new Date()): {
  needsFollowUp: boolean;
  activeNow: boolean;
  connectedToStaff: boolean;
  resolvedByHuman: boolean;
  resolvedByAi: boolean;
} {
  const reviewNeedsFollowUp = conversation.speechReviews.some((review) => review.verdict !== "clear" && review.correction !== "staff_resolved");
  // Older snapshots can predate the schema invariant. They are not terminal
  // merely because their state label claims AI resolution.
  const malformedAiResolution = conversation.requests.some((request) => request.state === "ai_resolved" && !hasAiResolutionProof(request));
  const requestsTerminal = conversation.requests.length > 0
    && conversation.requests.every(isTerminalRequest);
  const hasOpenRequest = conversation.requests.some((request) => !isTerminalRequest(request));
  // Failed terminal delivery needs staff attention while work remains open.
  // Once every request has a durable outcome, historical carrier evidence must
  // not permanently suppress the corresponding human or AI resolution state.
  const failedDeliveryWithOpenRequest = hasOpenRequest
    && conversation.messages.some((message) => message.state === "failed" || message.state === "undelivered");
  const needsFollowUp = malformedAiResolution || reviewNeedsFollowUp
    || conversation.controlledTransfers.some((item) => item.dispatch === "unknown" && item.outcome === null)
    || conversation.requests.some((request) => request.state === "needs_callback" || request.state === "in_progress")
    || conversation.phase !== "active" && conversation.requests.some((request) => request.state === "draft")
    || conversation.messages.some((message) => message.state === "unknown" && !message.sendHoldReleased)
    || failedDeliveryWithOpenRequest;
  // A mixed agenda required a human outcome, so it belongs to the human bucket.
  // AI resolution requires a durable proof for every request and no human completion.
  const resolvedByHuman = !needsFollowUp && requestsTerminal
    && conversation.requests.some((request) => request.state === "completed" && request.outcome !== null);
  const resolvedByAi = !needsFollowUp && requestsTerminal
    && conversation.requests.some((request) => request.state === "ai_resolved" && hasAiResolutionProof(request))
    && conversation.requests.every((request) => request.state === "abandoned" || request.state === "ai_resolved" && hasAiResolutionProof(request));

  return {
    needsFollowUp,
    activeNow: conversation.admission.channel === "voice" && conversation.phase === "active"
      && conversation.activityLeaseUntil !== null && Date.parse(conversation.activityLeaseUntil) > now.getTime(),
    // Carrier answer alone and receptionist stubs never establish a staff connection.
    // This is accepted demo-recipient evidence, not verified staff identity,
    // reach, request resolution, or a claim that the call remains active.
    connectedToStaff: conversation.admission.channel === "voice"
      && conversation.controlledTransfers.some((item) => item.outcome === "accepted" && item.acceptance !== null),
    resolvedByHuman,
    resolvedByAi,
  };
}

export function queueFilterMatches(state: ReturnType<typeof queueStateOf>, filter: QueueFilter): boolean {
  switch (filter) {
    case "total": return true;
    case "active_now": return state.activeNow;
    case "needs_follow_up": return state.needsFollowUp;
    case "connected_to_staff": return state.connectedToStaff;
    case "resolved_by_human": return state.resolvedByHuman;
    case "resolved_by_ai": return state.resolvedByAi;
  }
}

export function historyNextStep(conversation: Conversation): ConversationHistoryEntry["nextStep"] {
  if (queueStateOf(conversation).needsFollowUp) return "needs_follow_up";
  if (queueStateOf(conversation).resolvedByHuman || queueStateOf(conversation).resolvedByAi) return "completed";
  return "unresolved";
}
