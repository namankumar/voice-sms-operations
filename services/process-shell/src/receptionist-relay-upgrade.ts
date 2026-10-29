import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { TwilioHmacRequestValidator } from "@salven/voice-runtime";
import { WebSocketServer, type WebSocket } from "ws";

export interface RelayConnection {
  receive(raw: string): Promise<void>;
  close(): void | Promise<void>;
}

/** Validate against the configured public WSS URL, never caller-supplied proxy headers. */
export function createRelayUpgradeVerifier(publicOrigin: string, authToken: string, stage: "setup" | "audio" = "setup") {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("relay_origin_invalid");
  origin.protocol = "wss:";
  const validator = new TwilioHmacRequestValidator(authToken);
  return (request: Pick<IncomingMessage, "method" | "url" | "headers">): { recoveryId: string } | null => {
    if (request.method !== "GET" || !request.url?.startsWith("/") || request.url.startsWith("//")) return null;
    const url = new URL(request.url, origin);
    const match = url.pathname.match(new RegExp(`^/voice/recovery/relay/([A-Za-z0-9_-]{1,120})/${stage}$`));
    const signature = request.headers["x-twilio-signature"];
    if (!match || url.search || url.hash || typeof signature !== "string" || signature.length > 256) return null;
    if (!validator.validate({ signature, url: url.toString(), parameters: {} })) return null;
    return { recoveryId: match[1]! };
  };
}

/** Signature first, then a bounded setup handshake, then the durable scoped session. */
export function createRelayUpgrade(options: {
  publicOrigin: string;
  authToken: string;
  setup(input: { recoveryId: string; raw: string; socket: WebSocket; signal: AbortSignal; signature: string; publicUrl: string }): Promise<RelayConnection>;
  setupTimeoutMs?: number;
  stage?: "setup" | "audio";
}) {
  const verify = createRelayUpgradeVerifier(options.publicOrigin, options.authToken, options.stage ?? "setup");
  const setupTimeoutMs = options.setupTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(setupTimeoutMs) || setupTimeoutMs < 1 || setupTimeoutMs > 30_000) throw new Error("relay_setup_timeout_invalid");
  const server = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false });
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<void>>();
  let failure: Error | undefined;
  const track = (work: Promise<void>): void => {
    const observed = work.catch(() => { failure ??= new Error("relay_lifecycle_failed"); }).finally(() => pending.delete(observed));
    pending.add(observed);
  };
  let stopped = false;
  return {
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
      const binding = stopped ? null : verify(request);
      if (binding === null) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); socket.destroy(); return; }
      server.handleUpgrade(request, socket, head, (ws) => {
        let session: RelayConnection | null = null;
        let settingUp = false;
        let drainingSetupFrames = false;
        let connectedSeen = false;
        const pendingFrames: string[] = [];
        let closed = false;
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => { controller.abort(); ws.close(1008, "setup_timeout"); }, setupTimeoutMs);
        timer.unref();
        ws.on("error", () => { controller.abort(); ws.close(1011, "transport_error"); });
        ws.on("close", () => { closed = true; controller.abort(); controllers.delete(controller); clearTimeout(timer); if (session) track(Promise.resolve().then(() => session!.close())); });
        ws.on("message", (data, binary) => {
          if (binary) { ws.close(1003, "text_required"); return; }
          const raw = data.toString();
          if (session !== null) {
            if (drainingSetupFrames) {
              let value: Record<string, unknown>;
              try { value = JSON.parse(raw) as Record<string, unknown>; } catch { ws.close(1008, "setup_invalid"); return; }
              if (!["media", "mark", "dtmf", "stop"].includes(String(value.event)) || pendingFrames.length >= 150) { ws.close(1008, "setup_backpressure"); return; }
              pendingFrames.push(raw); return;
            }
            void session.receive(raw).catch(() => ws.close(1011, "turn_failed")); return;
          }
          if (options.stage === "audio") {
            let event: Record<string, unknown>;
            try { event = JSON.parse(raw) as Record<string, unknown>; } catch { ws.close(1008, "setup_invalid"); return; }
            if (event.event === "connected" && !settingUp && !connectedSeen && event.protocol === "Call" && event.version === "1.0.0") { connectedSeen = true; return; }
            if (settingUp && ["media", "mark", "dtmf", "stop"].includes(String(event.event)) && pendingFrames.length < 150) { pendingFrames.push(raw); return; }
          }
          if (settingUp) { ws.close(1008, "setup_pending"); return; }
          settingUp = true;
          track(options.setup({ recoveryId: binding.recoveryId, raw, socket: ws, signal: controller.signal,
            signature: request.headers["x-twilio-signature"] as string, publicUrl: new URL(request.url!, options.publicOrigin.replace(/^https:/, "wss:")).toString() }).then(async (connected) => {
            if (closed || controller.signal.aborted || ws.readyState !== ws.OPEN) { await connected.close(); return; }
            session = connected;
            clearTimeout(timer);
            // Startup media arrived in wire order while provider configuration
            // was pending. Drain it serially so it cannot overflow append
            // backpressure or be overtaken by newly arriving live frames.
            drainingSetupFrames = options.stage === "audio";
            while (pendingFrames.length && !closed && !controller.signal.aborted) await connected.receive(pendingFrames.shift()!);
            drainingSetupFrames = false;
            // Steady-state dispatch above stays independent of semantic/TTS waits.
          }).catch(() => ws.close(1008, "setup_rejected")));
        });
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const controller of controllers) controller.abort();
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      while (pending.size > 0) await Promise.all([...pending]);
      if (failure) throw failure;
    },
  };
}
