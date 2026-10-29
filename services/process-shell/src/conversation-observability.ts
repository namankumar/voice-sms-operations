import { createHmac } from "node:crypto";
import { z } from "zod";

const observationSchema = z.object({
  stage: z.enum(["admission", "greeting", "vad", "interpretation", "tool", "speech", "transfer", "capture", "dispatch", "delivery", "monitor", "recovery", "staff", "evaluation", "disconnect"]),
  result: z.enum(["started", "accepted", "completed", "rejected", "canceled", "timeout", "unknown", "failed", "stale", "unassessable"]),
  channel: z.enum(["voice", "sms"]),
  tier: z.enum(["realtime", "relay", "scripted", "text"]).optional(),
  durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
  admissionStep: z.enum(["store_admit", "sip_binding_create"]).optional(),
  revision: z.number().int().nonnegative().safe().optional(),
  ownerEpoch: z.number().int().nonnegative().safe().optional(),
  reason: z.enum(["signature_invalid", "binding_mismatch", "storage_unavailable", "provider_unavailable", "recovery_handler_failed", "deadline", "ownership_changed", "suppressed", "duplicate", "stale_revision", "caller_disconnected", "input_invalid", "missing_fields", "saved", "no_answer", "transport_lost", "claim_mismatch", "evidence_missing", "capacity_reached"]).optional(),
  recoveryStage: z.enum(["serve", "gather", "complete"]).optional(), recoveryTarget: z.enum(["relay", "scripted"]).optional(),
}).strict();
export type ConversationObservation = z.infer<typeof observationSchema>;
export type ObservationContext = { conversationId: string; instanceId: string; configVersion: string; promptVersion: string };

/** Free-form details belong in encrypted evidence, never the operational sink. */
export function createConversationObserver(options: {
  secret: Buffer;
  sink(line: string): void;
  now?: () => Date;
}) {
  if (options.secret.length < 32) throw new Error("observation_key_invalid");
  const secret = Buffer.from(options.secret);
  const hash = (domain: string, value: string) => createHmac("sha256", secret).update(JSON.stringify([domain, value])).digest("hex");
  return (context: ObservationContext, observation: ConversationObservation): boolean => {
    const parsed = observationSchema.safeParse(observation);
    if (!parsed.success) return false;
    const values = [context.conversationId, context.instanceId, context.configVersion, context.promptVersion];
    if (values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 200)) return false;
    try {
      options.sink(JSON.stringify({ schemaVersion: 1, at: (options.now ?? (() => new Date()))().toISOString(),
        conversation: hash("conversation", context.conversationId), instance: hash("instance", context.instanceId),
        configuration: hash("configuration", context.configVersion), prompt: hash("prompt", context.promptVersion), ...parsed.data }));
      return true;
    } catch { return false; }
  };
}
