import { createHash } from "node:crypto";

import type { ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { fullAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import type { F2HandoffPort } from "./f2-turn-coordinator.js";
import type { ControlledTransferCoordinator } from "./controlled-transfer-coordinator.js";

/** Full mode uses the same simulated destinations and durable callback queue, never a real phone number. */
export class F2HandoffService implements F2HandoffPort {
  private readonly instance;
  constructor(private readonly options: { store: Pick<ConversationStore, "get" | "execute">; instance: VoiceAppInstance;
    controlledTransfer?: Pick<ControlledTransferCoordinator, "start"> }) {
    this.instance = fullAppInstanceSchema.parse(options.instance);
  }

  async requestHandoff(input: { scope: ConversationScope; requestId: string; sourceId: string; reason: string; signal?: AbortSignal }): Promise<{ accepted: boolean }> {
    throwIfAborted(input.signal);
    const current = await this.options.store.get(input.scope);
    throwIfAborted(input.signal);
    const request = current?.requests.find((item) => item.id === input.requestId);
    if (!current || !request || current.admission.mode !== "full" || current.admission.instanceId !== this.instance.instanceId
      || current.admission.practiceId !== this.instance.practiceId || current.owner !== "ai" || current.phase !== "active"
      || current.suppressed || current.emergency !== null || request.state !== "draft"
      || current.inputs.at(-1)?.id !== input.sourceId || !request.sourceIds.includes(input.sourceId)) return { accepted: false };
    const id = createHash("sha256").update(JSON.stringify([request.id, request.revision, input.sourceId, input.reason])).digest("hex");
    const transfer = current.transfers.find((item) => item.requestId === request.id);
    if (transfer?.state === "trying") return { accepted: true };
    const directMessage = input.reason === "slot_unavailable" || explicitMessageRequest(current.inputs.at(-1)?.body ?? "");
    if (current.admission.channel === "voice" && current.admission.hours === "demo_open" && transfer === undefined && !directMessage) {
      if (this.options.controlledTransfer !== undefined) {
        throwIfAborted(input.signal);
        const result = await this.options.controlledTransfer.start({ scope: input.scope, requestId: request.id, sourceId: input.sourceId });
        throwIfAborted(input.signal);
        // The frozen boolean port represents a confirmed parent redirect, not
        // recipient acceptance. Do not retry pending or unknown redirects via
        // the stub handoff path.
        if (result.kind !== "unavailable") return { accepted: result.kind === "redirected" };
      } else {
      const category = request.category ?? "general_or_uncertain";
      if (request.category === null) return { accepted: false };
      throwIfAborted(input.signal);
      const receipt = await this.options.store.execute({ scope: input.scope, eventId: `f2-handoff-${id}`,
        expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "system", id: "f2-handoff" },
        command: { type: "transfer.start", transferId: `f2-transfer-${id}`, requestId: request.id, requestRevision: request.revision,
        category, stubId: this.instance.routes[category].stubId, timeoutSeconds: this.instance.stubTimeoutSeconds } });
      throwIfAborted(input.signal);
      return { accepted: receipt.accepted };
      }
    }
    const kind = current.admission.channel === "voice" && request.callbackMessageSourceId == null ? "message"
      : !request.name ? "name" : !request.callbackNumber ? "callback_number_entry" : "callback_number";
    if (current.pendingQuestion?.requestId === request.id && current.pendingQuestion.kind === kind) return { accepted: true };
    throwIfAborted(input.signal);
    const receipt = await this.options.store.execute({ scope: input.scope, eventId: `f2-handoff-question-${id}`,
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch, actor: { kind: "system", id: "f2-handoff" },
      command: { type: "question.activate", questionId: `f2-callback-${id}`, requestId: request.id, kind } });
    throwIfAborted(input.signal);
    return { accepted: receipt.accepted };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("f2_operation_aborted");
}

export function explicitMessageRequest(text: string): boolean {
  if (/\b(?:don'?t|do not|not)\s+(?:want to\s+)?(?:leave|take|record|send)\b/i.test(text)) return false;
  return /\b(?:leave|take|record|send)\s+(?:(?:a|the|my)\s+)?(?:voice\s*(?:mail|note)|message)\b/i.test(text);
}
