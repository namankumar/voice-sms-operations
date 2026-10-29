import type { ServerResponse } from "node:http";

const perSession = new Map<string, number>();
const perActor = new Map<string, number>();
let openStreams = 0;

/** Shared resource and revocation boundary for both legacy and new staff feeds. */
export async function serveStaffEvents(options: {
  response: ServerResponse;
  sessionId: string;
  actor: string;
  sessionActive(): Promise<boolean>;
  subscribe(listener: (event: Record<string, string | number>) => void): Promise<() => void | Promise<void>>;
  eventName?: string;
  heartbeatMs?: number;
}): Promise<void> {
  const { response } = options;
  if (openStreams >= 128 || (perActor.get(options.actor) ?? 0) >= 16 || (perSession.get(options.sessionId) ?? 0) >= 4) {
    response.writeHead(429, { "Cache-Control": "no-store" }); response.end(); return;
  }
  openStreams += 1;
  perActor.set(options.actor, (perActor.get(options.actor) ?? 0) + 1);
  perSession.set(options.sessionId, (perSession.get(options.sessionId) ?? 0) + 1);
  let closed = false, working = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void | Promise<void>) | undefined;
  const pending: Record<string, string | number>[] = [];
  function decrement(map: Map<string, number>, key: string) { const next = (map.get(key) ?? 1) - 1; if (next > 0) map.set(key, next); else map.delete(key); }
  const close = () => {
    if (closed) return;
    closed = true; pending.length = 0; openStreams -= 1;
    decrement(perActor, options.actor); decrement(perSession, options.sessionId);
    if (heartbeat) clearInterval(heartbeat);
    const cleanup = unsubscribe;
    if (cleanup) void Promise.resolve().then(cleanup).catch(() => {});
    if (!response.writableEnded) response.end();
  };
  response.once("close", close);
  const flush = async () => {
    if (working || closed || !response.headersSent) return;
    working = true;
    try {
      // Recheck immediately before every batch; logout never waits for heartbeat.
      if (!await options.sessionActive()) { close(); return; }
      if (closed) return;
      const batch = pending.splice(0);
      if (batch.length === 0) { if (!response.write(": heartbeat\n\n")) close(); }
      for (const event of batch) {
        if (closed) break;
        if (!response.write(`${options.eventName ? `event: ${options.eventName}\n` : ""}data: ${JSON.stringify(event)}\n\n`)) close();
      }
    } catch { close(); }
    finally { working = false; if (!closed && pending.length) void flush(); }
  };
  try {
    unsubscribe = await options.subscribe((event) => {
      if (closed) return;
      if (pending.length >= 128) { close(); return; }
      pending.push(event); void flush();
    });
    if (closed) { await unsubscribe(); return; }
    if (!await options.sessionActive()) { response.writeHead(401, { "Cache-Control": "no-store" }); close(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
    if (!response.write("event: ready\ndata: {}\n\n")) { close(); return; }
    if (pending.length) void flush();
    heartbeat = setInterval(() => { void flush(); }, options.heartbeatMs ?? 15_000); heartbeat.unref();
  } catch {
    if (!response.headersSent) response.writeHead(503, { "Cache-Control": "no-store" });
    close();
  }
}
