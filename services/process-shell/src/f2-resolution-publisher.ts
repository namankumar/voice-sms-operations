import { scopeOf, type AiResolutionResult, type Conversation } from "./conversation-contract.js";
import type { PostgresConversationStore } from "./conversation-store.js";
import type { F2MutationResultPublisher } from "./f2-synthetic-practice-store.js";

/** Publish the queue outcome inside the same transaction as its actual evidence. */
export function createF2ResolutionPublisher(store: Pick<PostgresConversationStore, "executeInTransaction">): {
  action: F2MutationResultPublisher;
} {
  const publish = async (tx: Parameters<F2MutationResultPublisher>[0], conversation: Conversation, requestId: string, sourceId: string | undefined, receiptId: string, result: AiResolutionResult) => {
    const request = conversation.requests.find((item) => item.id === requestId);
    if (!request || !sourceId || !request.sourceIds.includes(sourceId) || !conversation.inputs.some((item) => item.id === sourceId)) throw new Error("f2_resolution_source_missing");
    const published = await store.executeInTransaction(tx, { scope: scopeOf(conversation), eventId: `f2-resolution-${receiptId}`,
      expectedRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch, actor: { kind: "system", id: "f2-evidence-publisher" },
      command: { type: "request.resolve_ai", requestId, requestRevision: request.revision, sourceEventId: sourceId, result } });
    if (!published.accepted) throw new Error("f2_resolution_rejected");
  };
  return {
    action: async (tx, { current, receipt }) => {
      if (receipt.state !== "committed" || receipt.resultHash === null || receipt.readbackHash === null || receipt.resultingAppointmentVersion === null) throw new Error("f2_resolution_commit_missing");
      await publish(tx, current.conversation, current.request.id, receipt.sourceEventId, receipt.id, { kind: "action", receiptId: receipt.id, operation: receipt.operation,
        resultHash: receipt.resultHash, readbackHash: receipt.readbackHash, resultingVersion: receipt.resultingAppointmentVersion });
    },
  };
}
