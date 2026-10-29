import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { NormalizedAudioChunk, ProviderConnectionContract, TelephonyMediaFrame, TelephonyProvider } from "./ports.js";
import { providerCorrelationId, providerEvent, type ProviderEventSink } from "./provider-events.js";

const TWILIO_CONNECTION_CONTRACT: ProviderConnectionContract = Object.freeze({
  authentication: Object.freeze({ owner: "adapter", credentialsExposedToRuntime: false }),
  reconnect: Object.freeze({ owner: "adapter", policy: "fail_closed", maxAttempts: 0 }),
  resume: Object.freeze({ owner: "adapter", supported: false, continuityTokenExposedToRuntime: false }),
});

export interface TwilioMediaSocket {
  send(payload: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface TwilioRequestValidator {
  validate(input: { readonly signature: string; readonly url: string; readonly parameters: Readonly<Record<string, string>> }): boolean;
}

export interface TwilioRestTransport {
  updateCall(input: { readonly callId: string; readonly form: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<{ readonly status: number; readonly requestId: string | null }>;
}

export interface TwilioCredentials { readonly accountSid: string; readonly authToken: string; }

/** Twilio's request-signature validator. Keep the auth token in the edge process secret store. */
export class TwilioHmacRequestValidator implements TwilioRequestValidator {
  constructor(private readonly authToken: string) { if (authToken.length < 8) throw new Error("twilio_auth_token_required"); }
  validate(input: { readonly signature: string; readonly url: string; readonly parameters: Readonly<Record<string, string>> }): boolean {
    const body = Object.keys(input.parameters).sort().reduce((value, key) => `${value}${key}${input.parameters[key] ?? ""}`, input.url);
    const expected = createHmac("sha1", this.authToken).update(body).digest();
    let received: Buffer;
    try { received = Buffer.from(input.signature, "base64"); } catch { return false; }
    return constantTimeSignatureMatch(expected, received);
  }
}

/** Minimal Twilio Calls REST transport for transfer and terminal teardown. */
export class TwilioHttpRestTransport implements TwilioRestTransport {
  private readonly endpoint: string;
  constructor(
    private readonly credentials: TwilioCredentials,
    private readonly fetcher: typeof fetch = fetch,
    endpoint = "https://api.twilio.com/2010-04-01",
  ) {
    if (!/^AC[a-zA-Z0-9_-]{8,}$/.test(credentials.accountSid) || credentials.authToken.length < 8) throw new Error("twilio_credentials_required");
    this.endpoint = endpoint.replace(/\/$/, "");
  }
  async updateCall(input: { readonly callId: string; readonly form: Readonly<Record<string, string>>; readonly signal?: AbortSignal }): Promise<{ readonly status: number; readonly requestId: string | null }> {
    if (!/^[A-Za-z0-9_-]{8,}$/.test(input.callId)) throw new Error("twilio_invalid_call_id");
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(input.form)) body.set(key, value);
    const response = await this.fetcher(`${this.endpoint}/Accounts/${encodeURIComponent(this.credentials.accountSid)}/Calls/${encodeURIComponent(input.callId)}.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return { status: response.status, requestId: response.headers.get("twilio-request-id") ?? response.headers.get("x-twilio-request-id") };
  }
}

export interface TwilioMediaStart {
  readonly kind: "start";
  readonly callId: string;
  readonly streamId: string;
  readonly accountId: string;
}

export interface TwilioMediaStop { readonly kind: "stop"; readonly callId: string; readonly streamId: string; }
export interface TwilioMediaMark { readonly kind: "mark"; readonly callId: string; readonly streamId: string; readonly markId: string; readonly providerSequenceNumber: number; }
export interface TwilioDtmf { readonly kind: "dtmf"; readonly callId: string; readonly streamId: string; readonly digit: string; readonly providerSequenceNumber: number; }
export type TwilioInboundEvent = TwilioMediaStart | TwilioMediaStop | TwilioMediaMark | TwilioDtmf | { readonly kind: "media"; readonly frame: TelephonyMediaFrame } | { readonly kind: "connected" };

interface BoundStream { readonly streamId: string; readonly socket: TwilioMediaSocket; }
interface StreamAdmission { readonly expectedCallId: string; readonly expiresAtMs: number; }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("twilio_invalid_message");
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error(`twilio_invalid_${field}`);
  return value;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new Error(`twilio_invalid_${field}`);
  return parsed as number;
}

function parseJson(raw: string): Record<string, unknown> {
  if (raw.length === 0 || raw.length > 1_000_000) throw new Error("twilio_invalid_message_size");
  try { return object(JSON.parse(raw)); } catch { throw new Error("twilio_invalid_json"); }
}

/** Protocol adapter for one bidirectional Twilio Media Stream per call. */
export class TwilioMediaStreamsProvider implements TelephonyProvider {
  readonly name = "twilio-media-streams";
  readonly connectionContract = TWILIO_CONNECTION_CONTRACT;
  private readonly streams = new Map<string, BoundStream>();
  private readonly streamCallIds = new Map<string, string>();
  private readonly admissions = new Map<string, StreamAdmission>();

  constructor(
    private readonly rest: TwilioRestTransport | null = null,
    private readonly onEvent: ProviderEventSink = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly expectedAccountSid: string | null = null,
    private readonly diagnosticHashKey: Uint8Array = randomBytes(32),
  ) {}

  private bind(callId: string, streamId: string, socket: TwilioMediaSocket): void {
    if (this.streams.has(callId)) throw new Error("twilio_call_already_bound");
    this.streams.set(string(callId, "call_id"), { streamId: string(streamId, "stream_id"), socket });
    this.emit("stream.bound", callId, { streamIdPresent: true });
  }

  unbind(callId: string): void { this.streams.delete(callId); }

  async sendAudio(callId: string, audio: NormalizedAudioChunk, outputDirectiveId: string, signal: AbortSignal): Promise<void> {
    const binding = this.binding(callId);
    this.assertActive(signal);
    await binding.socket.send(JSON.stringify({ event: "media", streamSid: binding.streamId, media: { payload: Buffer.from(audio.bytes).toString("base64") } }));
    this.assertActive(signal);
    this.emit("audio.sent", callId, { mediaChunkNumber: audio.mediaChunkNumber, outputDirectiveIdPresent: outputDirectiveId.length > 0 });
  }

  async clearAudio(callId: string, signal: AbortSignal): Promise<void> {
    const binding = this.binding(callId);
    this.assertActive(signal);
    await binding.socket.send(JSON.stringify({ event: "clear", streamSid: binding.streamId }));
    this.emit("audio.cleared", callId);
  }

  async sendMark(callId: string, markId: string, signal: AbortSignal): Promise<void> {
    const binding = this.binding(callId);
    this.assertActive(signal);
    await binding.socket.send(JSON.stringify({ event: "mark", streamSid: binding.streamId, mark: { name: string(markId, "mark_id") } }));
    this.emit("mark.sent", callId);
  }

  async closeCall(callId: string): Promise<void> {
    const binding = this.streams.get(callId);
    binding?.socket.close(1000, "call-ended");
    this.streams.delete(callId);
    if (this.rest !== null) {
      const receipt = await this.rest.updateCall({ callId, form: { Status: "completed" } });
      if (receipt.status < 200 || receipt.status >= 300) throw new Error("twilio_close_failed");
    }
    this.emit("call.closed", callId);
  }

  async transferCall(input: { readonly callId: string; readonly destinationE164: string; readonly actionUrl: string;
    readonly statusCallbackUrl: string; readonly screeningUrl: string; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<string | null> {
    if (this.rest === null) throw new Error("twilio_rest_not_configured");
    if (!/^\+[1-9]\d{7,14}$/.test(input.destinationE164)) throw new Error("twilio_invalid_transfer_destination");
    const timeout = input.timeoutSeconds ?? 20;
    if (!Number.isSafeInteger(timeout) || timeout < 5 || timeout > 60) throw new Error("twilio_invalid_transfer_timeout");
    const actionUrl = callbackUrl(input.actionUrl); const statusCallbackUrl = callbackUrl(input.statusCallbackUrl);
    const screeningUrl = callbackUrl(input.screeningUrl);
    const twiml = `<Response><Dial timeout="${timeout}" answerOnBridge="true" action="${xml(actionUrl)}" method="POST"><Number url="${xml(screeningUrl)}" method="POST" statusCallback="${xml(statusCallbackUrl)}" statusCallbackMethod="POST" statusCallbackEvent="answered completed">${input.destinationE164}</Number></Dial></Response>`;
    const receipt = await this.rest.updateCall({ callId: input.callId, form: { Twiml: twiml }, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if (receipt.status < 200 || receipt.status >= 300) throw new Error("twilio_transfer_failed");
    this.emit("transfer.requested", input.callId, { timeoutSeconds: timeout, providerReceiptPresent: receipt.requestId !== null });
    return receipt.requestId;
  }

  parseInbound(raw: string): TwilioInboundEvent {
    const message = parseJson(raw);
    const event = string(message.event, "event");
    if (event === "connected") return { kind: "connected" };
    const sequence = integer(message.sequenceNumber, "sequence_number");
    if (event === "start") throw new Error("twilio_start_requires_authenticated_admission");
    const streamId = string(message.streamSid, "stream_id");
    const callId = this.streamCallIds.get(streamId);
    if (callId === undefined) throw new Error("twilio_stream_not_started");
    if (event === "media") {
      const media = object(message.media);
      return { kind: "media", frame: {
        callId,
        streamId,
        providerMessageSequenceNumber: sequence,
        mediaChunkNumber: integer(media.chunk, "media_chunk"),
        timestampMs: integer(media.timestamp, "media_timestamp"),
        encoding: "audio/pcmu",
        sampleRateHz: 8_000,
        payloadBase64: string(media.payload, "media_payload"),
      } };
    }
    if (event === "mark") return { kind: "mark", callId, streamId, markId: string(object(message.mark).name, "mark_id"), providerSequenceNumber: sequence };
    if (event === "dtmf") return { kind: "dtmf", callId, streamId, digit: string(object(message.dtmf).digit, "dtmf_digit"), providerSequenceNumber: sequence };
    if (event === "stop") { this.streamCallIds.delete(streamId); return { kind: "stop", callId, streamId }; }
    throw new Error("twilio_unsupported_event");
  }

  authorizeUpgrade(input: { readonly validator: TwilioRequestValidator; readonly signature: string; readonly url: string; readonly expectedCallId: string; readonly expiresAtMs: number; readonly parameters?: Readonly<Record<string, string>> }): string {
    const accepted = input.validator.validate({ signature: input.signature, url: input.url, parameters: input.parameters ?? {} });
    if (!accepted) throw new Error("twilio_signature_rejected");
    if (input.expiresAtMs <= this.now() || input.expiresAtMs - this.now() > 60_000) throw new Error("twilio_admission_expiry_invalid");
    const capability = `twilio-admission-${randomUUID()}`;
    this.admissions.set(capability, { expectedCallId: string(input.expectedCallId, "expected_call_id"), expiresAtMs: input.expiresAtMs });
    return capability;
  }

  acceptStart(raw: string, socket: TwilioMediaSocket, admissionCapability: string): TwilioMediaStart {
    const admission = this.admissions.get(admissionCapability);
    this.admissions.delete(admissionCapability);
    if (admission === undefined || admission.expiresAtMs < this.now()) throw new Error("twilio_admission_rejected");
    const message = parseJson(raw);
    if (message.event !== "start") throw new Error("twilio_start_required");
    integer(message.sequenceNumber, "sequence_number");
    const start = object(message.start);
    const callId = string(start.callSid, "call_id");
    const streamId = string(start.streamSid ?? message.streamSid, "stream_id");
    if (start.streamSid !== undefined && message.streamSid !== undefined && start.streamSid !== message.streamSid) throw new Error("twilio_stream_id_mismatch");
    const accountId = string(start.accountSid, "account_id");
    const format = object(start.mediaFormat);
    if (callId !== admission.expectedCallId || this.expectedAccountSid === null || accountId !== this.expectedAccountSid) throw new Error("twilio_admission_binding_mismatch");
    if (format.encoding !== "audio/x-mulaw" || integer(format.sampleRate, "sample_rate") !== 8_000 || integer(format.channels, "channels") !== 1) throw new Error("twilio_unsupported_media_format");
    if (this.streamCallIds.has(streamId)) throw new Error("twilio_stream_already_started");
    this.streamCallIds.set(streamId, callId);
    this.bind(callId, streamId, socket);
    return { kind: "start", callId, streamId, accountId };
  }

  private binding(callId: string): BoundStream { const found = this.streams.get(callId); if (found === undefined) throw new Error("twilio_call_not_bound"); return found; }
  private assertActive(signal: AbortSignal): void { if (signal.aborted) throw new Error("voice_provider_operation_aborted"); }
  private emit(type: string, callId: string, details: Record<string, string | number | boolean | null> = {}): void { this.onEvent(providerEvent("twilio", type, { details: { ...details, callCorrelationId: providerCorrelationId(callId, this.diagnosticHashKey) }, now: this.now })); }
}

function callbackUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== ""
    || value.length > 4_000) throw new Error("twilio_transfer_callback_invalid");
  return parsed.toString();
}
function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Constant-time helper for validators that compare precomputed signature bytes. */
export function constantTimeSignatureMatch(expected: Buffer, received: Buffer): boolean {
  return expected.length === received.length && timingSafeEqual(expected, received);
}
