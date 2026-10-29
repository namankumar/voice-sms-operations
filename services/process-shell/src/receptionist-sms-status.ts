import { z } from "zod";
import type { ConversationScope } from "./conversation-contract.js";
import { IngressRejected } from "./conversation-ingress.js";
import type { BoundedSmsDispatcher, SmsProviderState } from "./sms-dispatcher.js";

export type SmsDispatchBinding = { scope: ConversationScope; messageId: string; accountId: string; from: string; to: string; transport: "sms" | "whatsapp"; providerId: string | null };
const statusSchema = z.object({ AccountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/), MessageSid: z.string().regex(/^SM[a-fA-F0-9]{32}$/),
  From: z.string(), To: z.string(), ErrorCode: z.string().optional(), MessageStatus: z.enum(["queued", "accepted", "sending", "sent", "delivered", "undelivered", "failed", "read"]) });

/** Invoked only after signature validation; opaque attempt identity binds callbacks to the durable send. */
export function createReceptionistSmsStatusHandler(options: {
  practiceId: string; instanceId: string; accountId: string;
  getDispatchAttempt(input: { practiceId: string; instanceId: string; attemptId: string }): Promise<SmsDispatchBinding | null>;
  dispatcher: Pick<BoundedSmsDispatcher, "recordDeliveryReceipt">;
  onDelivered?(input: { scope: ConversationScope; messageId: string }): Promise<void>;
}) {
  return async (input: { parameters: Readonly<Record<string, string>>; attemptId: string }): Promise<void> => {
    const parsed = statusSchema.safeParse(input.parameters);
    if (!parsed.success || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.attemptId)) throw new IngressRejected(400, "sms_status_invalid");
    const status = parsed.data;
    if (status.AccountSid !== options.accountId) throw new IngressRejected(403, "sms_status_binding_mismatch");
    const binding = await options.getDispatchAttempt({ practiceId: options.practiceId, instanceId: options.instanceId, attemptId: input.attemptId });
    if (binding === null) throw new IngressRejected(404, "sms_attempt_not_found");
    const prefix = binding.transport === "whatsapp" ? "whatsapp:" : "";
    if (binding.scope.practiceId !== options.practiceId || binding.scope.instanceId !== options.instanceId || binding.accountId !== status.AccountSid
      || `${prefix}${binding.from}` !== status.From || `${prefix}${binding.to}` !== status.To || (binding.providerId !== null && binding.providerId !== status.MessageSid)) throw new IngressRejected(403, "sms_status_binding_mismatch");
    // Only WhatsApp read receipts establish delivery; SMS read is not a delivery claim.
    const state: SmsProviderState = status.MessageStatus === "delivered" ? "delivered" : status.MessageStatus === "undelivered" ? "undelivered"
      : status.MessageStatus === "failed" ? "failed" : binding.transport === "whatsapp" && status.MessageStatus === "read" ? "delivered" : "accepted";
    const failureReason = binding.transport === "whatsapp" && status.ErrorCode === "63015" && (state === "failed" || state === "undelivered") ? "sandbox_not_joined" as const : undefined;
    const receipt = await options.dispatcher.recordDeliveryReceipt({ scope: binding.scope, messageId: binding.messageId, providerId: status.MessageSid, state,
      ...(failureReason === undefined ? {} : { failureReason }) });
    if (!receipt.recorded && receipt.disposition !== "stale_terminal") throw new IngressRejected(409, "sms_receipt_not_recorded");
    if (state === "delivered") await options.onDelivered?.({ scope: binding.scope, messageId: binding.messageId });
  };
}
