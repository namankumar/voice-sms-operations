import { createHmac } from "node:crypto";

const PROVIDER_DIAGNOSTIC_TYPES = [
  "stream.bound",
  "audio.sent",
  "audio.cleared",
  "mark.sent",
  "call.closed",
  "transfer.requested",
  "session.opened",
  "audio.appended",
  "response.cancelled",
  "session.closed",
  "event.rejected",
  "provider.error",
  "speech.requested",
  "speech.completed",
  "speech.failed",
  "speech.cancelled",
  "event.received",
  "diagnostic.rejected",
] as const;

const REALTIME_EVENT_TYPES = new Set([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio.delta",
]);

const CORRELATION_ID = /^hmac-sha256:[a-f0-9]{64}$/;

export type ProviderDiagnosticType = (typeof PROVIDER_DIAGNOSTIC_TYPES)[number];
export type ProviderDiagnosticValue = string | number | boolean;

/** The only fields permitted to leave a provider adapter as diagnostics. */
export interface ProviderDiagnosticEvent {
  readonly schemaVersion: 1;
  readonly provider: "twilio" | "openai";
  readonly type: ProviderDiagnosticType;
  readonly atMs: number;
  readonly details: Readonly<Record<string, ProviderDiagnosticValue>>;
  readonly redaction: Readonly<{
    policy: "phi_safe_metadata_only";
    mediaExcluded: true;
    transcriptExcluded: true;
    credentialsExcluded: true;
    providerPayloadExcluded: true;
    rawIdentifiersExcluded: true;
  }>;
}

export type ProviderEventSink = (event: ProviderDiagnosticEvent) => void;

export function providerEvent(
  provider: ProviderDiagnosticEvent["provider"],
  type: ProviderDiagnosticType | string,
  input: {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly now?: () => number;
  } = {},
): ProviderDiagnosticEvent {
  const safeType = isDiagnosticType(type) ? type : "diagnostic.rejected";
  return Object.freeze({
    schemaVersion: 1,
    provider,
    type: safeType,
    atMs: safeTimestamp((input.now ?? Date.now)()),
    details: Object.freeze(sanitizeDetails(input.details ?? {})),
    redaction: Object.freeze({
      policy: "phi_safe_metadata_only",
      mediaExcluded: true,
      transcriptExcluded: true,
      credentialsExcluded: true,
      providerPayloadExcluded: true,
      rawIdentifiersExcluded: true,
    }),
  });
}

export function providerCorrelationId(value: string, key: Uint8Array): string {
  return `hmac-sha256:${createHmac("sha256", key).update(value).digest("hex")}`;
}

function isDiagnosticType(value: string): value is ProviderDiagnosticType {
  return (PROVIDER_DIAGNOSTIC_TYPES as readonly string[]).includes(value);
}

function sanitizeDetails(input: Readonly<Record<string, unknown>>): Record<string, ProviderDiagnosticValue> {
  const details: Record<string, ProviderDiagnosticValue> = {};
  copyBoolean(input, details, "modelConfigured");
  copyBoolean(input, details, "voiceConfigured");
  copyBoolean(input, details, "streamIdPresent");
  copyBoolean(input, details, "outputDirectiveIdPresent");
  copyBoolean(input, details, "providerReceiptPresent");
  copyInteger(input, details, "mediaChunkNumber", 0, Number.MAX_SAFE_INTEGER);
  copyInteger(input, details, "durationMs", 0, 60_000);
  copyInteger(input, details, "timeoutSeconds", 1, 600);
  copyInteger(input, details, "characterCount", 0, 4_000);
  copyInteger(input, details, "sourceByteCount", 0, 100_000_000);
  copyInteger(input, details, "frameCount", 0, 1_000_000);
  copyInteger(input, details, "status", 0, 599);
  copyCorrelationId(input, details, "callCorrelationId");
  copyCorrelationId(input, details, "sessionCorrelationId");
  copyCorrelationId(input, details, "requestCorrelationId");
  if (input.reason === "invalid_json") details.reason = input.reason;
  if (typeof input.code === "string" && input.code.length > 0) details.providerError = true;
  if (typeof input.type === "string") details.eventType = REALTIME_EVENT_TYPES.has(input.type) ? input.type : "unrecognized";
  return details;
}

function copyBoolean(input: Readonly<Record<string, unknown>>, output: Record<string, ProviderDiagnosticValue>, key: string): void {
  if (typeof input[key] === "boolean") output[key] = input[key];
}

function copyInteger(input: Readonly<Record<string, unknown>>, output: Record<string, ProviderDiagnosticValue>, key: string, minimum: number, maximum: number): void {
  const value = input[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum) output[key] = value;
}

function copyCorrelationId(input: Readonly<Record<string, unknown>>, output: Record<string, ProviderDiagnosticValue>, key: string): void {
  const value = input[key];
  if (typeof value === "string" && CORRELATION_ID.test(value)) output[key] = value;
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
