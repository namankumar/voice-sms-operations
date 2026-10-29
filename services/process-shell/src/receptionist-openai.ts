import type { CompiledReceptionistPrompt, GptFunctionTool } from "./receptionist-policy.js";

export const RECEPTIONIST_REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const RECEPTIONIST_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe-2025-12-15";
export const RECEPTIONIST_PRIMARY_VAD = Object.freeze({ type: "server_vad" as const, threshold: 0.7, prefixPaddingMs: 300,
  silenceDurationMs: 500, createResponse: false, interruptResponse: true });
const API_BASE = "https://api.openai.com/v1/realtime/calls";

export type OpenAIFetch = (url: string, init: { method: "POST"; headers: Readonly<Record<string, string>>; body?: string; signal: AbortSignal; redirect: "error" }) => Promise<{ status: number }>;
export type SidebandSocket = {
  send(payload: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onMessage(handler: (payload: string | Uint8Array) => void): () => void;
  onError(handler: (error: unknown) => void): () => void;
  onClose(handler: (input: { code: number | null }) => void): () => void;
};
export type SidebandSocketFactory = {
  /** The factory owns Authorization; the adapter does not expose credentials through this port. */
  connect(input: { url: string; signal: AbortSignal; maxPayloadBytes: number }): Promise<SidebandSocket>;
};

export type OpenAIAcceptOutcome =
  | { kind: "accepted"; callId: string }
  | { kind: "rejected"; callId: string; status: number }
  | { kind: "timeout"; callId: string; recovery: "reconcile_before_retry" }
  | { kind: "unknown"; callId: string; recovery: "reconcile_before_retry" };
export type OpenAIControlOutcome =
  | { kind: "completed"; callId: string }
  | { kind: "unknown"; callId: string; recovery: "reconcile_before_retry" };
/** Payloads are delivered only to the internal control callback; this adapter never logs them. */
export type ProtectedSidebandEvent = { callId: string; type: string; eventId: string | null; payload: Record<string, unknown> };
export type ProtectedSidebandClose = { callId: string; code: number | null };
export type SanitizedSidebandError = { callId: string; code: "sideband_connect_timeout" | "sideband_connect_failed" | "sideband_payload_too_large" | "sideband_invalid_event" | "sideband_transport_error" | "sideband_closed" | "sideband_send_failed" | "sideband_send_timeout" | "sideband_send_unknown" };

export interface ReceptionistSidebandControlPort {
  readonly callId: string;
  sendToolOutput(input: { toolCallId: string; output: unknown }): Promise<void>;
  createResponse(input?: { metadata?: Readonly<Record<string, string>>; outputModalities?: readonly ["text"]; requiredPrompt?: CompiledReceptionistPrompt; isolatedPrompt?: CompiledReceptionistPrompt }): Promise<void>;
  updatePrompt(prompt: CompiledReceptionistPrompt): Promise<void>;
  cancelResponse(): Promise<void>;
  close(): void;
}

export class ReceptionistOpenAIAdapter {
  private readonly acceptTimeoutMs: number;
  private readonly sidebandConnectTimeoutMs: number;
  private readonly sidebandSendTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(private readonly options: {
    apiKey: string;
    fetch: OpenAIFetch;
    sideband: SidebandSocketFactory;
    acceptTimeoutMs?: number;
    sidebandConnectTimeoutMs?: number;
    sidebandSendTimeoutMs?: number;
    maxPayloadBytes?: number;
  }) {
    if (options.apiKey.trim().length < 1) throw new Error("openai_api_key_required");
    this.acceptTimeoutMs = boundedTimeout(options.acceptTimeoutMs ?? 8_000, "openai_accept_timeout_invalid");
    this.sidebandConnectTimeoutMs = boundedTimeout(options.sidebandConnectTimeoutMs ?? 5_000, "openai_sideband_timeout_invalid");
    this.sidebandSendTimeoutMs = boundedTimeout(options.sidebandSendTimeoutMs ?? 5_000, "openai_sideband_send_timeout_invalid");
    this.maxPayloadBytes = boundedPayload(options.maxPayloadBytes ?? 64 * 1024);
  }

  async accept(input: { callId: string; prompt: CompiledReceptionistPrompt; voice: string }): Promise<OpenAIAcceptOutcome> {
    const callId = checkedCallId(input.callId);
    const prompt = checkedVoicePrompt(input.prompt);
    const voice = checkedVoice(input.voice);
    const body = JSON.stringify({ type: "realtime", model: RECEPTIONIST_REALTIME_MODEL, instructions: prompt.system,
      audio: { input: { noise_reduction: { type: "near_field" }, transcription: { model: RECEPTIONIST_TRANSCRIPTION_MODEL, language: "en" }, turn_detection: {
        type: RECEPTIONIST_PRIMARY_VAD.type, threshold: RECEPTIONIST_PRIMARY_VAD.threshold, prefix_padding_ms: RECEPTIONIST_PRIMARY_VAD.prefixPaddingMs, silence_duration_ms: RECEPTIONIST_PRIMARY_VAD.silenceDurationMs,
        create_response: RECEPTIONIST_PRIMARY_VAD.createResponse, interrupt_response: RECEPTIONIST_PRIMARY_VAD.interruptResponse,
      } }, output: { voice } }, tools: flattenRealtimeTools(prompt.tools) });
    const outcome = await this.post(`${API_BASE}/${encodeURIComponent(callId)}/accept`, body, this.acceptTimeoutMs);
    if (outcome.kind === "completed" && outcome.status === 200) return { kind: "accepted", callId };
    if (outcome.kind === "completed" && isDefinitiveAcceptRejection(outcome.status)) return { kind: "rejected", callId, status: outcome.status };
    if (outcome.kind === "completed") return { kind: "unknown", callId, recovery: "reconcile_before_retry" };
    return { kind: outcome.kind, callId, recovery: "reconcile_before_retry" };
  }

  async reject(callId: string): Promise<OpenAIControlOutcome> {
    return this.control(checkedCallId(callId), "/reject", JSON.stringify({ status_code: 486 }));
  }

  async hangup(callId: string): Promise<OpenAIControlOutcome> {
    return this.control(checkedCallId(callId), "/hangup");
  }

  async connectSideband(input: { callId: string; onEvent: (event: ProtectedSidebandEvent) => void; onError: (error: SanitizedSidebandError) => void;
    onClose: (event: ProtectedSidebandClose) => void }): Promise<ReceptionistSidebandControlPort> {
    const callId = checkedCallId(input.callId);
    const controller = new AbortController();
    const result = await boundedConnect(this.options.sideband, `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`,
      controller, this.sidebandConnectTimeoutMs, this.maxPayloadBytes);
    if (result.kind !== "connected") {
      input.onError({ callId, code: result.kind === "timeout" ? "sideband_connect_timeout" : "sideband_connect_failed" });
      throw new Error(result.kind === "timeout" ? "openai_sideband_connect_timeout" : "openai_sideband_connect_failed");
    }
    return new OpenAISidebandControlPort(callId, result.socket, this.maxPayloadBytes, this.sidebandSendTimeoutMs, input.onEvent, input.onError, input.onClose);
  }

  private async control(callId: string, suffix: "/reject" | "/hangup", body?: string): Promise<OpenAIControlOutcome> {
    const result = await this.post(`${API_BASE}/${encodeURIComponent(callId)}${suffix}`, body, this.acceptTimeoutMs);
    return result.kind === "completed" && result.status === 200 ? { kind: "completed", callId }
      : { kind: "unknown", callId, recovery: "reconcile_before_retry" };
  }

  private async post(url: string, body: string | undefined, timeoutMs: number): Promise<{ kind: "completed"; status: number } | { kind: "timeout" | "unknown" }> {
    const controller = new AbortController();
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (value: { kind: "completed"; status: number } | { kind: "timeout" | "unknown" }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => { controller.abort(); settle({ kind: "timeout" }); }, timeoutMs);
      this.options.fetch(url, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }), signal: controller.signal }).then(
        (response) => settle({ kind: "completed", status: response.status }),
        () => settle(controller.signal.aborted ? { kind: "timeout" } : { kind: "unknown" }),
      );
    });
  }
}

class OpenAISidebandControlPort implements ReceptionistSidebandControlPort {
  private readonly unsubscribeMessage: () => void;
  private readonly unsubscribeError: () => void;
  private readonly unsubscribeClose: () => void;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private closed = false;

  constructor(readonly callId: string, private readonly socket: SidebandSocket, private readonly maxPayloadBytes: number, private readonly sendTimeoutMs: number,
    private readonly onEvent: (event: ProtectedSidebandEvent) => void, private readonly onError: (error: SanitizedSidebandError) => void,
    private readonly onClose: (event: ProtectedSidebandClose) => void) {
    this.closedPromise = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.unsubscribeMessage = socket.onMessage((payload) => this.receive(payload));
    this.unsubscribeError = socket.onError(() => { this.close(); this.onError({ callId: this.callId, code: "sideband_transport_error" }); });
    this.unsubscribeClose = socket.onClose((event) => this.remoteClose(event));
  }

  sendToolOutput(input: { toolCallId: string; output: unknown }): Promise<void> {
    return this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: checkedCallId(input.toolCallId), output: JSON.stringify(input.output) } });
  }
  createResponse(input?: { metadata?: Readonly<Record<string, string>>; outputModalities?: readonly ["text"]; requiredPrompt?: CompiledReceptionistPrompt; isolatedPrompt?: CompiledReceptionistPrompt }): Promise<void> {
    const metadata = checkedResponseMetadata(input?.metadata);
    const requiredPrompt = input?.requiredPrompt === undefined ? undefined : checkedVoicePrompt(input.requiredPrompt);
    const isolatedPrompt = input?.isolatedPrompt === undefined ? undefined : checkedVoicePrompt(input.isolatedPrompt);
    if (requiredPrompt !== undefined && (requiredPrompt.toolChoice !== "required" || requiredPrompt.tools.length === 0)) {
      throw new Error("openai_required_response_tools_missing");
    }
    if (isolatedPrompt !== undefined && (requiredPrompt !== undefined || input?.outputModalities !== undefined
      || isolatedPrompt.responseContext !== "isolated" || isolatedPrompt.toolChoice === "required" || isolatedPrompt.tools.length !== 0)) {
      throw new Error("openai_isolated_response_invalid");
    }
    const response = { ...(metadata === undefined ? {} : { metadata }),
      ...(input?.outputModalities === undefined ? {} : { output_modalities: ["text"] }),
      ...(requiredPrompt === undefined ? {} : { instructions: requiredPrompt.system,
        tools: flattenRealtimeTools(requiredPrompt.tools), tool_choice: "required" }),
      ...(isolatedPrompt === undefined ? {} : { conversation: "none", input: [], instructions: isolatedPrompt.system,
        tools: [], tool_choice: "none" }) };
    return this.send(Object.keys(response).length === 0 ? { type: "response.create" } : { type: "response.create", response });
  }
  updatePrompt(prompt: CompiledReceptionistPrompt): Promise<void> {
    const checked = checkedVoicePrompt(prompt);
    return this.send({ type: "session.update", session: { type: "realtime", instructions: checked.system, tools: flattenRealtimeTools(checked.tools), tool_choice: checked.toolChoice ?? "auto" } });
  }
  async cancelResponse(): Promise<void> {
    await this.send({ type: "response.cancel" });
    await this.send({ type: "output_audio_buffer.clear" });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
    this.unsubscribeMessage(); this.unsubscribeError(); this.unsubscribeClose(); this.socket.close(1000, "sideband-closed");
  }

  private async send(event: unknown): Promise<void> {
    if (this.closed) throw new Error("openai_sideband_closed");
    const payload = JSON.stringify(event);
    if (Buffer.byteLength(payload, "utf8") > this.maxPayloadBytes) {
      this.onError({ callId: this.callId, code: "sideband_payload_too_large" });
      throw new Error("openai_sideband_payload_too_large");
    }
    const outcome = await this.awaitSend(payload);
    if (outcome === "sent" && !this.closed) return;
    this.close();
    if (outcome === "failed") {
      this.onError({ callId: this.callId, code: "sideband_send_failed" });
      throw new Error("openai_sideband_send_failed");
    }
    if (outcome === "timeout") {
      this.onError({ callId: this.callId, code: "sideband_send_timeout" });
      throw new Error("openai_sideband_send_timeout");
    }
    this.onError({ callId: this.callId, code: "sideband_send_unknown" });
    throw new Error("openai_sideband_send_unknown");
  }

  private async awaitSend(payload: string): Promise<"sent" | "failed" | "closed" | "timeout"> {
    let timer: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          if (this.closed) return "closed" as const;
          try { await this.socket.send(payload); return "sent" as const; }
          catch { return "failed" as const; }
        }),
        this.closedPromise.then(() => "closed" as const),
        new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.sendTimeoutMs); }),
      ]);
    } finally { if (timer !== null) clearTimeout(timer); }
  }

  private receive(payload: string | Uint8Array): void {
    const text = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
    if (Buffer.byteLength(text, "utf8") > this.maxPayloadBytes) {
      this.onError({ callId: this.callId, code: "sideband_payload_too_large" });
      this.close();
      return;
    }
    try {
      const value = JSON.parse(text);
      if (!isRecord(value) || typeof value.type !== "string" || value.type.length < 1 || value.type.length > 200) throw new Error("invalid");
      this.onEvent({ callId: this.callId, type: value.type, eventId: typeof value.event_id === "string" && value.event_id.length <= 200 ? value.event_id : null, payload: value });
    } catch { this.onError({ callId: this.callId, code: "sideband_invalid_event" }); }
  }

  private remoteClose(event: { code: number | null }): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveClosed();
    this.unsubscribeMessage(); this.unsubscribeError(); this.unsubscribeClose();
    this.onClose({ callId: this.callId, code: event.code });
  }
}

function flattenRealtimeTools(tools: readonly GptFunctionTool[]): Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown> }> {
  // Realtime rejects the Responses-only `strict` option; server tool validation remains authoritative.
  return tools.map((tool) => ({ type: tool.type, name: tool.function.name, description: tool.function.description,
    parameters: tool.function.parameters }));
}
function isDefinitiveAcceptRejection(status: number): status is 400 | 401 | 403 | 404 | 405 | 422 {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 422;
}
function checkedCallId(value: string): string { if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("openai_call_id_invalid"); return value; }
function checkedVoice(value: string): string { if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error("openai_voice_invalid"); return value; }
function checkedVoicePrompt(value: CompiledReceptionistPrompt): CompiledReceptionistPrompt {
  if (value.channel !== "voice" || value.system.trim().length < 1 || value.system.length > 100_000
    || value.responseContext !== undefined && value.responseContext !== "isolated") throw new Error("openai_voice_prompt_invalid");
  return value;
}
function checkedResponseMetadata(value: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 16) throw new Error("openai_response_metadata_invalid");
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || typeof entry !== "string" || entry.length < 1 || entry.length > 512) {
      throw new Error("openai_response_metadata_invalid");
    }
  }
  return Object.fromEntries(entries);
}
function boundedTimeout(value: number, code: string): number { if (!Number.isSafeInteger(value) || value < 250 || value > 30_000) throw new Error(code); return value; }
function boundedPayload(value: number): number { if (!Number.isSafeInteger(value) || value < 1_024 || value > 1_048_576) throw new Error("openai_sideband_payload_limit_invalid"); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function boundedConnect(factory: SidebandSocketFactory, url: string, controller: AbortController, timeoutMs: number, maxPayloadBytes: number): Promise<{ kind: "connected"; socket: SidebandSocket } | { kind: "timeout" | "failed" }> {
  return await new Promise((resolve) => {
    let settled = false;
    const settle = (value: { kind: "connected"; socket: SidebandSocket } | { kind: "timeout" | "failed" }): void => {
      if (settled) { if (value.kind === "connected") value.socket.close(1000, "late-connect"); return; }
      settled = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => { controller.abort(); settle({ kind: "timeout" }); }, timeoutMs);
    factory.connect({ url, signal: controller.signal, maxPayloadBytes }).then((socket) => settle({ kind: "connected", socket }), () => settle({ kind: "failed" }));
  });
}
