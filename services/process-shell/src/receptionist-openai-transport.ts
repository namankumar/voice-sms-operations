import OpenAI from "openai";
import WebSocket from "ws";

import type { SidebandSocket, SidebandSocketFactory } from "./receptionist-openai.js";

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_HEADER_BYTES = 16 * 1024;

export type OpenAISidebandWebSocketFactory = (url: string, options: {
  headers: Readonly<Record<string, string>>;
  maxPayload: number;
  followRedirects: false;
}) => WebSocket;

export type OpenAIWebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;
export type VerifiedOpenAIWebhook = Readonly<{ event: Record<string, unknown> }>;

/** Node-only authenticated sideband transport. It never writes credentials to a URL or diagnostic sink. */
export class WsOpenAISidebandSocketFactory implements SidebandSocketFactory {
  private readonly createSocket: OpenAISidebandWebSocketFactory;

  constructor(options: { apiKey: string; createSocket?: OpenAISidebandWebSocketFactory }) {
    if (options.apiKey.trim().length < 1) throw new Error("openai_api_key_required");
    this.apiKey = options.apiKey;
    this.createSocket = options.createSocket ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
  }

  private readonly apiKey: string;

  async connect(input: { url: string; signal: AbortSignal; maxPayloadBytes: number }): Promise<SidebandSocket> {
    checkedSidebandUrl(input.url);
    checkedPayloadBytes(input.maxPayloadBytes, "openai_sideband_payload_limit_invalid");
    if (input.signal.aborted) return Promise.reject(new Error("openai_sideband_operation_aborted"));

    let socket: WebSocket;
    try {
      socket = this.createSocket(input.url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        maxPayload: input.maxPayloadBytes,
        followRedirects: false,
      });
    } catch { throw new Error("openai_sideband_connection_failed"); }
    // Keep late transport errors from becoming an unhandled EventEmitter error.
    socket.on("error", () => undefined);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupConnection = (): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const cleanupLifecycle = (): void => {
        input.signal.removeEventListener("abort", onAbort);
        socket.off("close", onSocketClose);
      };
      const closeSocket = (code: number, reason: string): void => {
        try { socket.close(code, reason); } catch { /* Keep transport failure redacted. */ }
      };
      const complete = (result: "open" | "failed"): void => {
        if (settled) return;
        settled = true;
        cleanupConnection();
        if (result === "open") resolve(new WsSidebandSocket(socket));
        else {
          cleanupLifecycle();
          closeSocket(1011, "connection-failed");
          reject(new Error("openai_sideband_connection_failed"));
        }
      };
      const onOpen = (): void => complete("open");
      const onError = (): void => complete("failed");
      const onSocketClose = (): void => {
        input.signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        cleanupConnection();
        socket.off("close", onSocketClose);
        reject(new Error("openai_sideband_connection_failed"));
      };
      const onAbort = (): void => {
        closeSocket(1000, "aborted");
        if (settled) return;
        settled = true;
        cleanupConnection();
        cleanupLifecycle();
        reject(new Error("openai_sideband_operation_aborted"));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onSocketClose);
    });
  }
}

class WsSidebandSocket implements SidebandSocket {
  constructor(private readonly socket: WebSocket) {}

  send(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(payload, (error) => error === undefined || error === null ? resolve() : reject(new Error("openai_sideband_send_failed")));
    });
  }

  close(code?: number, reason?: string): void {
    try { this.socket.close(code, reason); } catch { /* Transport details stay private. */ }
  }

  onMessage(handler: (payload: string | Uint8Array) => void): () => void {
    const listener = (data: WebSocket.RawData): void => {
      handler(typeof data === "string" ? data : new Uint8Array(normalizeRawData(data)));
    };
    this.socket.on("message", listener);
    return () => this.socket.off("message", listener);
  }

  onError(handler: (error: unknown) => void): () => void {
    const listener = (): void => handler(new Error("openai_sideband_transport_error"));
    this.socket.on("error", listener);
    return () => this.socket.off("error", listener);
  }

  onClose(handler: (input: { code: number | null }) => void): () => void {
    const listener = (code: number): void => handler({ code: Number.isSafeInteger(code) ? code : null });
    this.socket.on("close", listener);
    return () => this.socket.off("close", listener);
  }
}

/** Verifies OpenAI Standard Webhooks against the untouched request body before ingress consumes it. */
export class OpenAIWebhookVerifier {
  private readonly client: OpenAI;
  private readonly maxPayloadBytes: number;

  constructor(options: { webhookSecret: string; maxPayloadBytes?: number }) {
    if (options.webhookSecret.trim().length < 1) throw new Error("openai_webhook_secret_required");
    this.maxPayloadBytes = checkedPayloadBytes(options.maxPayloadBytes ?? 64 * 1024, "openai_webhook_payload_limit_invalid");
    this.client = new OpenAI({ apiKey: "webhook-verifier-only", webhookSecret: options.webhookSecret, maxRetries: 0 });
  }

  async verify(input: { rawBody: string; headers: OpenAIWebhookHeaders }): Promise<VerifiedOpenAIWebhook> {
    if (Buffer.byteLength(input.rawBody, "utf8") > this.maxPayloadBytes) throw new Error("openai_webhook_payload_too_large");
    const headers = checkedWebhookHeaders(input.headers);
    try {
      const event = await this.client.webhooks.unwrap(input.rawBody, headers);
      if (!isRecord(event)) throw new Error("invalid_event");
      return { event };
    } catch { throw new Error("openai_webhook_verification_failed"); }
  }
}

function checkedSidebandUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("openai_sideband_endpoint_rejected"); }
  const keys = [...url.searchParams.keys()];
  const callIds = url.searchParams.getAll("call_id");
  if (url.protocol !== "wss:" || url.hostname !== "api.openai.com" || url.port !== "" || url.username !== "" || url.password !== "" ||
    url.pathname !== "/v1/realtime" || url.hash !== "" || keys.length !== 1 || keys[0] !== "call_id" || callIds.length !== 1 || !/^[A-Za-z0-9_-]{1,200}$/.test(callIds[0] ?? "")) {
    throw new Error("openai_sideband_endpoint_rejected");
  }
}

function checkedPayloadBytes(value: number, errorCode: string): number {
  if (!Number.isSafeInteger(value) || value < 1_024 || value > MAX_PAYLOAD_BYTES) throw new Error(errorCode);
  return value;
}

function normalizeRawData(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  return Buffer.from(data);
}

function checkedWebhookHeaders(headers: OpenAIWebhookHeaders): Record<string, string> {
  const required = new Set(["webhook-id", "webhook-timestamp", "webhook-signature"]);
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!required.has(name)) continue;
    if (typeof rawValue !== "string" || rawValue.trim().length < 1 || Buffer.byteLength(rawValue, "utf8") > MAX_HEADER_BYTES || normalized[name] !== undefined) {
      throw new Error("openai_webhook_headers_invalid");
    }
    normalized[name] = rawValue;
  }
  if ([...required].some((name) => normalized[name] === undefined)) throw new Error("openai_webhook_headers_invalid");
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
