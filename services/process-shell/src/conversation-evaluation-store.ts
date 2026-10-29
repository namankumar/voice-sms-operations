import { randomUUID } from "node:crypto";
import type { ConversationStore } from "./conversation-store.js";
import type { ConversationEvaluationRecord, EvaluationResultPort } from "./conversation-evaluation.js";

export function createEvaluationPersistence(store: Pick<ConversationStore, "get" | "execute">): EvaluationResultPort {
  async function persist(result: ConversationEvaluationRecord): Promise<ConversationEvaluationRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await store.get(result.scope);
      if (current === null) throw new Error("evaluation_conversation_missing");
      const existing = current.evaluations.find((item) => item.id === result.id);
      if (existing?.state === "completed") {
        if (JSON.stringify(existing) !== JSON.stringify(result)) throw new Error("evaluation_result_conflict");
        return existing;
      }
      // A terminal result can only describe the exact state it evaluated. The worker
      // must release its lease and recompute after any accepted state transition.
      if (result.createdFromRevision !== current.revision) throw new Error("evaluation_source_stale");
      const receipt = await store.execute({ scope: result.scope, eventId: randomUUID(), expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
        actor: { kind: "system", id: "post-conversation-evaluator" }, command: { type: "evaluation.record", result } });
      if (receipt.accepted) return receipt.state.evaluations.find((item) => item.id === result.id)!;
      if (receipt.error !== "stale_revision" && receipt.error !== "stale_owner_epoch") throw new Error("evaluation_result_rejected");
    }
    throw new Error("evaluation_result_conflict");
  }
  return {
    async get({ scope, id }) { return (await store.get(scope))?.evaluations.find((item) => item.id === id) ?? null; },
    complete: persist,
    fail: persist,
  };
}
