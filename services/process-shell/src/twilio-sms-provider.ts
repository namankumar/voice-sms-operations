import type { SmsFailureReason, SmsProviderReadResult } from "./sms-dispatcher.js";

export type SmsDeliveryState = "accepted" | "delivered" | "undelivered" | "failed" | "unknown";

export interface SmsProvider {
  submit(input: { transport?: "sms" | "whatsapp"; from: string; to: string; body: string; attemptId: string; signal?: AbortSignal }): Promise<{ providerId: string; accepted: boolean; failureReason?: SmsFailureReason }>;
  read(input: { transport: "sms" | "whatsapp"; providerId: string; signal?: AbortSignal }): Promise<SmsProviderReadResult>;
}

export class SmsProviderAmbiguousError extends Error {
  constructor() { super("twilio_sms_outcome_ambiguous"); this.name = "SmsProviderAmbiguousError"; }
}

export interface TwilioSmsProviderOptions {
  readonly accountSid: string;
  readonly authToken: string;
  readonly from: string;
  readonly whatsappSandboxNumberE164?: string;
  readonly statusCallbackBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const MESSAGE_SID = /^(?:SM|MM)[a-fA-F0-9]{32}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export class TwilioSmsProvider implements SmsProvider {
  private readonly endpoint: string;
  private readonly callbackBase: URL;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: TwilioSmsProviderOptions) {
    if (!/^AC[a-fA-F0-9]{32}$/.test(options.accountSid) || options.authToken.trim().length === 0 || !E164.test(options.from)
      || (options.whatsappSandboxNumberE164 !== undefined && (!E164.test(options.whatsappSandboxNumberE164) || options.whatsappSandboxNumberE164 === options.from))) {
      throw new Error("twilio_sms_configuration_invalid");
    }
    this.callbackBase = callbackBase(options.statusCallbackBaseUrl);
    this.endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("twilio_sms_timeout_invalid");
  }

  async submit(input: { transport?: "sms" | "whatsapp"; from: string; to: string; body: string; attemptId: string; signal?: AbortSignal }): Promise<{ providerId: string; accepted: boolean; failureReason?: SmsFailureReason }> {
    const transport = input.transport ?? (input.from === this.options.from ? "sms" : null);
    if (transport === null || !OPAQUE_ID.test(input.attemptId) || !this.matchesSource(transport, input.from) || !E164.test(input.to) || input.body.trim().length === 0 || Buffer.byteLength(input.body, "utf8") > 8_000) {
      throw new Error("twilio_sms_input_invalid");
    }
    const form = new URLSearchParams({ From: providerAddress(transport, input.from), To: providerAddress(transport, input.to), Body: input.body, StatusCallback: callbackUrl(this.callbackBase, input.attemptId) });
    const response = await this.request(this.endpoint, { method: "POST", headers: {
      authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    }, body: form, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    if ([400, 401, 403, 404, 405, 422].includes(response.status)) {
      const error = await responseJson(response).catch(() => ({}));
      const failureReason = sandboxFailureReason(transport, "code" in error ? error.code : undefined);
      return { providerId: "", accepted: false, ...(failureReason === undefined ? {} : { failureReason }) };
    }
    if (!response.ok) throw new SmsProviderAmbiguousError();
    const payload = await responseJson(response);
    const providerId = messageSid(payload);
    validateResponseBinding(payload, this.options, transport, input);
    return { providerId, accepted: true };
  }

  async read(input: { transport: "sms" | "whatsapp"; providerId: string; signal?: AbortSignal }): Promise<SmsProviderReadResult> {
    if (!MESSAGE_SID.test(input.providerId)) throw new Error("twilio_sms_message_id_invalid");
    const response = await this.request(`${this.endpoint.replace(/Messages\.json$/, `Messages/${encodeURIComponent(input.providerId)}.json`)}`, {
      method: "GET", headers: { authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}` }, ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!response.ok) throw new SmsProviderAmbiguousError();
    const payload = await responseJson(response);
    const returnedProviderId = messageSid(payload);
    if (returnedProviderId !== input.providerId) throw new SmsProviderAmbiguousError();
    validateResponseBinding(payload, this.options, input.transport);
    const state = mapStatus(payload.status, input.transport);
    const failureReason = sandboxFailureReason(input.transport, payload.error_code);
    return failureReason !== undefined && (state === "failed" || state === "undelivered") ? { state, failureReason } : state;
  }

  private async request(url: string, init: RequestInit & { readonly signal?: AbortSignal }): Promise<Response> {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = init.signal === undefined ? deadline : AbortSignal.any([init.signal, deadline]);
    try {
      return await this.fetch(url, { ...init, signal, redirect: "error" });
    } catch {
      throw new SmsProviderAmbiguousError();
    }
  }

  private matchesSource(transport: "sms" | "whatsapp", source: string): boolean {
    return transport === "sms" ? source === this.options.from : source === this.options.whatsappSandboxNumberE164;
  }
}

function callbackBase(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("twilio_sms_callback_base_invalid");
  }
  return url;
}

function callbackUrl(base: URL, attemptId: string): string {
  const url = new URL(base.toString());
  url.searchParams.set("attempt_id", attemptId);
  return url.toString();
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw new SmsProviderAmbiguousError();
  }
}

function messageSid(payload: Record<string, unknown>): string {
  if (typeof payload.sid !== "string" || !MESSAGE_SID.test(payload.sid)) throw new SmsProviderAmbiguousError();
  return payload.sid;
}

function validateResponseBinding(payload: Record<string, unknown>, options: TwilioSmsProviderOptions, transport: "sms" | "whatsapp", expected?: { readonly from: string; readonly to: string }): void {
  const source = transport === "sms" ? options.from : options.whatsappSandboxNumberE164;
  if (source === undefined || payload.account_sid !== options.accountSid || payload.from !== providerAddress(transport, source) || typeof payload.to !== "string" || !E164.test(stripProviderAddress(payload.to)) || payload.to !== providerAddress(transport, stripProviderAddress(payload.to))) {
    throw new SmsProviderAmbiguousError();
  }
  if (expected !== undefined && payload.to !== providerAddress(transport, expected.to)) throw new SmsProviderAmbiguousError();
}

function providerAddress(transport: "sms" | "whatsapp", value: string): string { return transport === "whatsapp" ? `whatsapp:${value}` : value; }
function stripProviderAddress(value: string): string { return value.startsWith("whatsapp:") ? value.slice("whatsapp:".length) : value; }
function sandboxFailureReason(transport: "sms" | "whatsapp", code: unknown): SmsFailureReason | undefined {
  return transport === "whatsapp" && (code === 63015 || code === "63015") ? "sandbox_not_joined" : undefined;
}

function mapStatus(value: unknown, transport: "sms" | "whatsapp"): SmsDeliveryState {
  if (value === "delivered") return "delivered";
  if (value === "undelivered") return "undelivered";
  if (value === "failed" || value === "canceled") return "failed";
  if (value === "read") return transport === "whatsapp" ? "delivered" : "accepted";
  if (["accepted", "queued", "sending", "sent", "scheduled"].includes(String(value))) return "accepted";
  return "unknown";
}
