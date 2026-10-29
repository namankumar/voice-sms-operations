import type { ParentCallPort } from "./receptionist-recovery.js";

const CALL_ID = /^CA[a-fA-F0-9]{32}$/;
const TERMINAL = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

/** Existing inbound parent calls only. No API for outbound creation or arbitrary TwiML exists here. */
export class TwilioParentCallPort implements ParentCallPort {
  private readonly origin: string;
  private readonly timeout: number;
  constructor(private readonly options: {
    accountSid: string; authToken: string; sourceNumber: string; publicOrigin: string;
    timeoutMs?: number; fetch?: typeof fetch;
  }) {
    const origin = new URL(options.publicOrigin);
    if (!/^AC[a-fA-F0-9]{32}$/.test(options.accountSid) || !options.authToken.trim() || !/^\+[1-9]\d{7,14}$/.test(options.sourceNumber)
      || origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("parent_call_configuration_invalid");
    this.origin = origin.origin;
    this.timeout = options.timeoutMs ?? 4000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 10_000) throw new Error("parent_call_timeout_invalid");
  }
  async read(input: { parentCallId: string }): Promise<{ state: "active" | "disconnected" | "unknown" }> {
    if (!CALL_ID.test(input.parentCallId)) return { state: "unknown" };
    const payload = await this.request(input.parentCallId, "GET");
    if (!this.bound(payload, input.parentCallId)) return { state: "unknown" };
    if (TERMINAL.has(String(payload.status))) return { state: "disconnected" };
    return { state: payload.status === "in-progress" ? "active" : "unknown" };
  }
  async redirect(input: Parameters<ParentCallPort["redirect"]>[0]): ReturnType<ParentCallPort["redirect"]> {
    if (!CALL_ID.test(input.parentCallId) || !/^[A-Za-z0-9_-]{1,120}$/.test(input.recoveryId)
      || !["relay", "scripted"].includes(input.target)
      || input.callbackPath !== `/voice/recovery/${input.target}/${input.recoveryId}/serve`) return { state: "unknown" };
    const parent = await this.read({ parentCallId: input.parentCallId });
    if (parent.state !== "active") return { state: parent.state === "disconnected" ? "parent_gone" : "unknown" };
    const payload = await this.request(input.parentCallId, "POST", new URLSearchParams({ Url: `${this.origin}${input.callbackPath}`, Method: "POST" }));
    if (!this.bound(payload, input.parentCallId)) return { state: "unknown" };
    if (TERMINAL.has(String(payload.status))) return { state: "parent_gone" };
    // This confirms provider acceptance of the update, not playback or fallback attachment.
    return { state: payload.status === "in-progress" ? "redirected" : "unknown" };
  }
  async redirectTransfer(input: { parentCallId: string; callbackToken: string }): Promise<{ state: "redirected" | "parent_gone" | "unknown" }> {
    if (!CALL_ID.test(input.parentCallId) || !/^[A-Za-z0-9_-]{16,}\.[0-9]{10,13}\.[A-Za-z0-9_-]{43}$/.test(input.callbackToken)) return { state: "unknown" };
    const parent = await this.read(input);
    if (parent.state !== "active") return { state: parent.state === "disconnected" ? "parent_gone" : "unknown" };
    const target = new URL("/f3/transfer/serve", this.origin);
    target.searchParams.set("token", input.callbackToken);
    const payload = await this.request(input.parentCallId, "POST", new URLSearchParams({ Url: target.toString(), Method: "POST" }));
    if (!this.bound(payload, input.parentCallId)) return { state: "unknown" };
    if (TERMINAL.has(String(payload.status))) return { state: "parent_gone" };
    return { state: payload.status === "in-progress" ? "redirected" : "unknown" };
  }
  private bound(payload: Record<string, unknown> | null, callId: string): payload is Record<string, unknown> {
    return payload !== null && payload.sid === callId && payload.account_sid === this.options.accountSid
      && payload.to === this.options.sourceNumber && payload.direction === "inbound" && payload.parent_call_sid === null
      && typeof payload.from === "string" && /^\+[1-9]\d{7,14}$/.test(payload.from);
  }
  private async request(callId: string, method: "GET" | "POST", body?: URLSearchParams): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = async () => {
      const response = await (this.options.fetch ?? fetch)(`https://api.twilio.com/2010-04-01/Accounts/${this.options.accountSid}/Calls/${callId}.json`, {
        method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`,
          ...(body === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }) },
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok || response.body === null) return null;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 32_768) { void reader.cancel().catch(() => undefined); return null; }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    };
    try {
      return await Promise.race([request(), new Promise<null>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, this.timeout);
      })]);
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  }
}
