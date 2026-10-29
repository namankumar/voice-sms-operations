import { createHmac } from "node:crypto";
import { z } from "zod";
import type { AssessmentUsageSink } from "./receptionist-speech-assessor.js";

const count = z.number().int().nonnegative().safe();
const assessmentResponse = z.object({ usage: z.object({ input_tokens: count, output_tokens: count,
  input_tokens_details: z.object({ cached_tokens: count }).optional(),
}) });

export function createAssessmentUsageObserver(options: { secret: Buffer; sink(line: string): void; now?: () => Date }): AssessmentUsageSink {
  if (!Buffer.isBuffer(options.secret) || options.secret.length < 32) throw new Error("usage_observation_key_invalid");
  const secret = Buffer.from(options.secret);
  const hash = (domain: string, value: string) => createHmac("sha256", secret).update(JSON.stringify([domain, value])).digest("hex");
  return ({ scope, attemptId, model, response }) => {
    if (![scope.conversationId, scope.instanceId, attemptId, model].every((value) => /^[A-Za-z0-9_.:-]{1,200}$/.test(value))) return;
    const parsed = assessmentResponse.safeParse(response);
    const usage = parsed.success ? parsed.data.usage : null;
    const valid = usage !== null && (usage.input_tokens_details?.cached_tokens ?? 0) <= usage.input_tokens;
    try {
      void Promise.resolve(options.sink(JSON.stringify({ schemaVersion: 1, type: "assessment.usage", at: (options.now ?? (() => new Date()))().toISOString(),
        conversation: hash("conversation", scope.conversationId), instance: hash("instance", scope.instanceId),
        source: hash("assessment_attempt", attemptId), model, status: valid ? "reported" : "unknown",
        inputTokens: valid ? usage.input_tokens : null, outputTokens: valid ? usage.output_tokens : null,
        cachedTokens: valid ? usage.input_tokens_details?.cached_tokens ?? null : null }))).catch(() => undefined);
    } catch { /* Observation failure is not an assessment failure. */ }
  };
}
const usageSchema = z.object({
  input_tokens: count,
  output_tokens: count,
  input_token_details: z.object({
    text_tokens: count.optional(),
    audio_tokens: count.optional(),
    cached_tokens: count.optional(),
    cached_tokens_details: z.object({ text_tokens: count.optional(), audio_tokens: count.optional() }).passthrough().optional(),
  }).passthrough().optional(),
  output_token_details: z.object({ text_tokens: count.optional(), audio_tokens: count.optional() }).passthrough().optional(),
}).passthrough();

export type RealtimeUsage = Readonly<{
  kind: "response" | "transcription";
  sourceId: string;
  inputTokens: number;
  outputTokens: number;
  inputTextTokens: number | null;
  inputAudioTokens: number | null;
  cachedTokens: number | null;
  cachedTextTokens: number | null;
  cachedAudioTokens: number | null;
  outputTextTokens: number | null;
  outputAudioTokens: number | null;
  durationSeconds: number | null;
}>;

export function parseRealtimeUsage(payload: Record<string, unknown>): RealtimeUsage | null {
  const response = payload.type === "response.done" && payload.response !== null && typeof payload.response === "object" && !Array.isArray(payload.response)
    ? payload.response as Record<string, unknown> : null;
  const kind = response !== null ? "response" : payload.type === "conversation.item.input_audio_transcription.completed" ? "transcription" : null;
  const sourceId = response === null ? payload.item_id : response.id;
  if (kind === null || typeof sourceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(sourceId)) return null;
  const rawUsage = response === null ? payload.usage : response.usage;
  if (kind === "transcription" && rawUsage !== null && typeof rawUsage === "object" && !Array.isArray(rawUsage)
    && (rawUsage as Record<string, unknown>).type === "duration") {
    const seconds = (rawUsage as Record<string, unknown>).seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) return null;
    return { kind, sourceId, inputTokens: 0, outputTokens: 0, inputTextTokens: null, inputAudioTokens: null, cachedTokens: null,
      cachedTextTokens: null, cachedAudioTokens: null, outputTextTokens: null, outputAudioTokens: null, durationSeconds: seconds };
  }
  const parsed = usageSchema.safeParse(rawUsage);
  if (!parsed.success) return null;
  const usage = parsed.data, input = usage.input_token_details, output = usage.output_token_details;
  return {
    kind, sourceId,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    inputTextTokens: input?.text_tokens ?? null,
    inputAudioTokens: input?.audio_tokens ?? null,
    cachedTokens: input?.cached_tokens ?? null,
    cachedTextTokens: input?.cached_tokens_details?.text_tokens ?? null,
    cachedAudioTokens: input?.cached_tokens_details?.audio_tokens ?? null,
    outputTextTokens: output?.text_tokens ?? null,
    outputAudioTokens: output?.audio_tokens ?? null,
    durationSeconds: null,
  };
}

export function createRealtimeUsageObserver(options: { secret: Buffer; sink(line: string): void; now?: () => Date }) {
  if (!Buffer.isBuffer(options.secret) || options.secret.length < 32) throw new Error("usage_observation_key_invalid");
  const secret = Buffer.from(options.secret);
  const hash = (domain: string, value: string) => createHmac("sha256", secret).update(JSON.stringify([domain, value])).digest("hex");
  return (input: { conversationId: string; instanceId: string; model: string; usage: RealtimeUsage }): boolean => {
    if (![input.conversationId, input.instanceId, input.model].every((value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value))) return false;
    try {
      options.sink(JSON.stringify({ schemaVersion: 1, type: "realtime.usage", at: (options.now ?? (() => new Date()))().toISOString(),
        conversation: hash("conversation", input.conversationId), instance: hash("instance", input.instanceId),
        source: hash(input.usage.kind, input.usage.sourceId), usageKind: input.usage.kind, model: input.model,
        inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens,
        inputTextTokens: input.usage.inputTextTokens, inputAudioTokens: input.usage.inputAudioTokens,
        cachedTokens: input.usage.cachedTokens, cachedTextTokens: input.usage.cachedTextTokens, cachedAudioTokens: input.usage.cachedAudioTokens,
        outputTextTokens: input.usage.outputTextTokens, outputAudioTokens: input.usage.outputAudioTokens,
        durationSeconds: input.usage.durationSeconds }));
      return true;
    } catch { return false; }
  };
}
