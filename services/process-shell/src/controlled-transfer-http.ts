import { scopeOf } from "./conversation-contract.js";
import type { PostgresConversationStore } from "./conversation-store.js";
import type { ControlledTransferCoordinator } from "./controlled-transfer-coordinator.js";
import type { ControlledTestTransferPort, ControlledTransferCallback } from "./controlled-test-transfer.js";
import type { ReceptionistHttpPorts } from "./receptionist-http.js";
import type { VoiceAppInstance } from "./receptionist-policy.js";

/** Called only after carrier signature and account validation by the shared HTTP ingress. */
export function createControlledTransferHttp(options: {
  instance: VoiceAppInstance; store: Pick<PostgresConversationStore, "findVoiceByParent" | "execute">;
  announcementAudio?: (state: import("./conversation-contract.js").Conversation, attempt: import("./controlled-test-transfer.js").ControlledTransferAttempt) => Promise<string | null>;
  coordinator: ControlledTransferCoordinator; transfer: ControlledTestTransferPort; now?: () => Date;
}): NonNullable<ReceptionistHttpPorts["controlledTransfer"]> {
  if (options.instance.mode !== "receptionist" || options.instance.dataMode !== "synthetic_only") throw new Error("controlled_transfer_receptionist_synthetic_only");
  return async ({ path, parameters, token }) => {
    const parentPath = path === "/f3/transfer/serve" || path === "/f3/transfer/dial";
    const parentCallId = parentPath ? parameters.CallSid : parameters.ParentCallSid;
    if (!parentCallId || parameters.AccountSid !== options.instance.accountId) throw new Error("controlled_transfer_http_binding_invalid");
    const current = await options.store.findVoiceByParent({ practiceId: options.instance.practiceId,
      instanceId: options.instance.instanceId, accountId: options.instance.accountId, parentCallId });
    const record = current?.controlledTransfers.find((item) => item.attempt.callbackToken === token);
    if (!current || !record) throw new Error("controlled_transfer_http_stale");
    const scope = scopeOf(current);
    if (parentPath && (parameters.To !== current.admission.destination || parameters.From !== current.admission.contact))
      throw new Error("controlled_transfer_parent_binding_invalid");
    const acceptedParentEnd = path === "/f3/transfer/dial" && parameters.DialCallStatus === "completed"
      && record.outcome === "accepted" && record.acceptance !== null
      && record.attempt.voiceEpoch === current.voiceEpoch && parameters.DialCallSid === record.acceptance.childCallId;
    // This is the one terminal callback that remains valid after staff takes
    // ownership: the accepted child and signed callback token prove the parent
    // has ended. All non-terminal transfer callbacks remain AI-only below.
    if (acceptedParentEnd && current.phase === "disconnected")
      return "<Response><Hangup/></Response>";
    if (acceptedParentEnd && current.phase === "active" && (current.owner === "ai" || current.owner === "staff")) {
      if (!await disconnectAcceptedParent(options, parentCallId, record.attempt.id, token, parameters.DialCallSid!)) throw new Error("controlled_transfer_disconnect_rejected");
      return "<Response><Hangup/></Response>";
    }
    // Once accepted, only the exact completed child callback may close the
    // parent. Other late or replayed statuses cannot re-enter callback logic.
    if (path === "/f3/transfer/dial" && record.outcome === "accepted") {
      if (parameters.DialCallSid !== record.acceptance?.childCallId) throw new Error("controlled_transfer_child_binding_invalid");
      if (record.attempt.voiceEpoch !== current.voiceEpoch || current.phase !== "active") throw new Error("controlled_transfer_http_stale");
      return "<Response/>";
    }
    if (current.owner !== "ai" || current.suppressed || current.emergency !== null) throw new Error("controlled_transfer_http_stale");
    if (current.phase !== "active" || record.attempt.ownerEpoch !== current.ownerEpoch) throw new Error("controlled_transfer_http_stale");
    if (path === "/f3/transfer/serve") {
      if (record.outcome !== null || record.attempt.voiceEpoch !== current.voiceEpoch || record.dispatch === "prepared")
        throw new Error("controlled_transfer_not_dispatched");
      const audio = await options.announcementAudio?.(current, record.attempt);
      if (audio !== undefined && audio !== null) {
        const latest = await options.store.findVoiceByParent({ practiceId: options.instance.practiceId, instanceId: options.instance.instanceId, accountId: options.instance.accountId, parentCallId });
        const next = latest?.controlledTransfers.find(item => item.attempt.id === record.attempt.id), request = latest?.requests.find(item => item.id === record.attempt.requestId);
        if (!latest || latest.owner !== "ai" || latest.phase !== "active" || latest.ownerEpoch !== current.ownerEpoch || latest.voiceEpoch !== current.voiceEpoch
          || latest.inputs.at(-1)?.id !== current.inputs.at(-1)?.id || next?.outcome !== null || request?.revision !== record.attempt.requestRevision) throw new Error("controlled_transfer_audio_stale");
      }
      return options.transfer.renderDial(record.attempt, audio ?? undefined);
    }
    const childCallId = parentPath ? parameters.DialCallSid : parameters.CallSid;
    if (childCallId === parentCallId) throw new Error("controlled_transfer_child_missing");
    const childTo = parentPath ? record.attempt.destinationE164 : parameters.To;
    if (childTo !== record.attempt.destinationE164) throw new Error("controlled_transfer_destination_invalid");
    const receivedAt = (options.now ?? (() => new Date()))().toISOString();
    let callback: ControlledTransferCallback;
    if (!childCallId) {
      const status = parameters.DialCallStatus === "no-answer" ? "no_answer" : parameters.DialCallStatus;
      if (path !== "/f3/transfer/dial" || !["busy", "no_answer", "failed", "canceled"].includes(status ?? ""))
        throw new Error("controlled_transfer_child_missing");
      callback = { kind: "parent_dial_result", parentCallId, token, receivedAt,
        status: status as "busy" | "no_answer" | "failed" | "canceled" };
    } else if (path === "/f3/transfer/screen/decision") {
      callback = { kind: "screening_digits", parentCallId, childCallId, token, receivedAt, digits: parameters.Digits ?? "" };
    } else {
      const raw = path === "/f3/transfer/screen" ? "answered" : parentPath ? parameters.DialCallStatus : parameters.CallStatus;
      const status = raw === "in-progress" ? "answered" : raw === "no-answer" ? "no_answer" : raw;
      if (path === "/f3/transfer/dial" && !["busy", "no_answer", "failed", "canceled", "completed"].includes(status ?? ""))
        throw new Error("controlled_transfer_parent_status_invalid");
      if (!["initiated", "ringing", "answered", "busy", "no_answer", "failed", "canceled", "completed"].includes(status ?? ""))
        throw new Error("controlled_transfer_status_invalid");
      callback = { kind: "call_status", parentCallId, childCallId, token, receivedAt,
        status: status as Extract<ControlledTransferCallback, { kind: "call_status" }>["status"] };
    }
    const result = await options.coordinator.callback({ scope, accountId: parameters.AccountSid!, transferId: record.attempt.id,
      parentCallId, childTo, callback, parentAction: path === "/f3/transfer/dial" });
    if (result.kind === "ignored") throw new Error("controlled_transfer_callback_rejected");
    if (path === "/f3/transfer/status") return "<Response/>";
    if (result.kind === "screening") return result.twiml;
    if (result.kind === "fallback") return parentPath ? result.twiml : "<Response><Hangup/></Response>";
    if (result.kind === "recipient_accepted" && path === "/f3/transfer/dial"
      && parameters.DialCallStatus === "completed" && parameters.DialCallSid === record.acceptance?.childCallId) {
      if (!parameters.DialCallSid || !await disconnectAcceptedParent(options, parentCallId, record.attempt.id, token, parameters.DialCallSid)) throw new Error("controlled_transfer_disconnect_rejected");
      return "<Response><Hangup/></Response>";
    }
    return "<Response/>";
  };
}

async function disconnectAcceptedParent(options: Parameters<typeof createControlledTransferHttp>[0], parentCallId: string, transferId: string,
  token: string, childCallId: string): Promise<boolean> {
  // A heartbeat can advance revision between the terminal callback and its
  // disconnect write. Re-read once; each CAS attempt has a distinct event ID.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await options.store.findVoiceByParent({ practiceId: options.instance.practiceId,
      instanceId: options.instance.instanceId, accountId: options.instance.accountId, parentCallId });
    const record = current?.controlledTransfers.find((item) => item.attempt.id === transferId && item.attempt.callbackToken === token);
    if (current?.phase === "disconnected" && record?.outcome === "accepted" && record.acceptance?.childCallId === childCallId) return true;
    if (!current || current.phase !== "active" || (current.owner !== "ai" && current.owner !== "staff")
      || record?.outcome !== "accepted" || record.acceptance?.childCallId !== childCallId) return false;
    const receipt = await options.store.execute({ scope: scopeOf(current), eventId: `controlled-parent-ended-${transferId}-${current.revision}`,
      expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
      actor: { kind: "provider", id: "twilio-controlled-transfer" }, command: { type: "conversation.disconnect" } });
    if (receipt.accepted) return true;
  }
  return false;
}
