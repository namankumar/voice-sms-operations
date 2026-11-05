import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newConversation, type CommandEnvelope } from "../src/conversation-contract.js";
import type { ConversationStore } from "../src/conversation-store.js";
import { createConversationStaffExtension, type CallerProvidedIdentityResolver } from "../src/conversation-staff.js";
import type { PostgresRecordingTranscriptStore } from "../src/recording-transcript-store.js";
import type { PostgresLiveConversationReviewStore } from "../src/live-conversation-review-store.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); } });
function fixture(mode: "receptionist" | "full" = "receptionist") {
  const c = newConversation({ practiceId: "synthetic", instanceId: "reception", configVersion: "v1", mode, accountId: "AC-test", provider: "twilio", channel: "sms", externalId: "SM-test", contact: "+17025550123", destination: "+12025550100", hours: "demo_open" }, randomUUID(), "2026-09-24T12:00:00.000Z");
  let listener: ((change: { conversationId: string; revision: number }) => void) | undefined;
  const unsubscribe = vi.fn(async () => {});
  const store: ConversationStore = {
    getEvent: vi.fn(async () => null),
    admit: vi.fn(async () => c), get: vi.fn(async () => c), count: vi.fn(async () => 1),
    list: vi.fn(async () => [c]), history: vi.fn(async () => []), ready: vi.fn(async () => true), close: vi.fn(async () => {}),
    execute: vi.fn(async (input: CommandEnvelope) => ({ accepted: true, error: null, eventId: input.eventId, state: c, occurredAt: c.updatedAt })),
    subscribe: vi.fn(async (_scope, changed) => { listener = changed; return unsubscribe; }),
  };
  return { c, store, unsubscribe, change: () => listener?.({ conversationId: c.id, revision: 1 }) };
}
async function start(store: ConversationStore, active = async () => true, projection?: Parameters<typeof createConversationStaffExtension>[0]["projection"], resolveCallerProvidedIdentity?: CallerProvidedIdentityResolver,
  onVoiceOwnershipChanged?: Parameters<typeof createConversationStaffExtension>[0]["onVoiceOwnershipChanged"], recordings?: Parameters<typeof createConversationStaffExtension>[0]["recordings"], transcripts?: Pick<PostgresRecordingTranscriptStore, "getByConversation">,
  liveReviews?: Pick<PostgresLiveConversationReviewStore, "list" | "purgeExpired">) {
  const render = vi.fn((view) => ({ title: "Conversations", body: `<p>${view.actor}</p>` }));
  const extension = createConversationStaffExtension({ store, practiceId: "synthetic", instanceId: "reception", render, heartbeatMs: 10,
    ...(projection ? { projection } : {}), ...(resolveCallerProvidedIdentity ? { resolveCallerProvidedIdentity } : {}),
    ...(onVoiceOwnershipChanged ? { onVoiceOwnershipChanged } : {}), ...(recordings ? { recordings } : {}), ...(transcripts ? { transcripts } : {}), ...(liveReviews ? { liveReviews } : {}) });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    let body = ""; for await (const chunk of request) body += String(chunk);
    try {
      await extension.handle({ request, response, url, actor: "demo-staff", sessionId: "session", csrfToken: "csrf", fields: Object.fromEntries(new URLSearchParams(body)), sessionActive: active, renderDocument: (title, content) => `<title>${title}</title>${content}` });
    } catch { response.writeHead(503); response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("address_missing");
  return { base: `http://127.0.0.1:${address.port}`, render, extension };
}
describe("authenticated conversation staff route", () => {
  it("uses the shared scoped projection for filtering and metrics, never a partial-page count", async () => {
    const { c, store } = fixture();
    const metrics = { total: 90, activeNow: 0, needsFollowUp: 1, connectedToStaff: 0, resolvedByHuman: 0, resolvedByAi: 0 };
    const projection = { queryQueue: vi.fn(async (input: { page: number }) => ({ channel: "sms" as const, filter: "needs_follow_up" as const,
      page: Math.min(input.page, 1), pageSize: 25, total: 1, metrics, rows: [c] })),
      queryHistory: vi.fn(async () => ({ channel: "sms" as const, availability: "available" as const, unavailableReason: null, earliestRetainedAt: c.createdAt,
        latestRetainedAt: c.updatedAt, retainedCount: 90, priorCount: 0, recent: [], numberMatchDoesNotEstablishIdentity: true as const })) };
    const { base, render } = await start(store, async () => true, projection);
    expect((await fetch(`${base}/staff?channel=sms&filter=needs_follow_up&page=2&selected=${c.id}&practiceId=attacker`)).status).toBe(200);
    expect(projection.queryQueue).toHaveBeenCalledTimes(1);
    expect(projection.queryQueue).toHaveBeenLastCalledWith({ practiceId: "synthetic", instanceId: "reception", channel: "sms", filter: "needs_follow_up", page: 2, pageSize: 25 });
    expect(store.list).not.toHaveBeenCalled();
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ metricCounts: metrics, total: 1, filter: "needs_follow_up", historyProjection: expect.objectContaining({ retainedCount: 90 }) }));
  });
  it("does not invent filtered results if projections are missing or unavailable", async () => {
    const { store } = fixture(), { base } = await start(store);
    expect((await fetch(`${base}/staff?channel=sms&filter=active_now`)).status).toBe(503);
    expect((await fetch(`${base}/staff?channel=sms&filter=made_up`)).status).toBe(400);
  });
  it("uses fixed tenant scope and the same renderer for page and snapshot", async () => {
    const { c, store } = fixture(), { base, render, extension } = await start(store);
    expect(extension.matches(new URL(`${base}/staff`))).toBe(false);
    expect(extension.matches(new URL(`${base}/staff?channel=sms`))).toBe(true);
    const query = `channel=sms&selected=${c.id}&practiceId=attacker&page=999`;
    expect((await fetch(`${base}/staff?${query}`)).status).toBe(200);
    const snapshot = await fetch(`${base}/staff/conversations/snapshot?${query}`);
    expect(await snapshot.json()).toEqual({ title: "Conversations", body: "<p>demo-staff</p>" });
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ selected: c, page: 1, actor: "demo-staff", csrfToken: "csrf" }));
    expect(store.get).toHaveBeenCalledWith({ practiceId: "synthetic", instanceId: "reception", conversationId: c.id });
    expect((await fetch(`${base}/staff?channel=voice&selected=${c.id}`)).status).toBe(404);
  });
  it("resolves protected identity only for a selected full-mode detail and fails closed when unavailable", async () => {
    const full = fixture("full");
    const resolver = vi.fn<CallerProvidedIdentityResolver>(async () => ({ dateOfBirth: "1980-01-02", zip: "89109", status: "active" }));
    const { base, render } = await start(full.store, async () => true, undefined, resolver);

    expect((await fetch(`${base}/staff?channel=sms`)).status).toBe(200);
    expect(resolver).not.toHaveBeenCalled();
    expect(render).toHaveBeenLastCalledWith(expect.not.objectContaining({ callerProvidedIdentity: expect.anything() }));

    expect((await fetch(`${base}/staff?channel=sms&selected=${full.c.id}`)).status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({ practiceId: "synthetic", instanceId: "reception", conversationId: full.c.id });
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ callerProvidedIdentity: {
      dateOfBirth: "1980-01-02", zip: "89109", status: "active",
    } }));

    const receptionist = fixture();
    const receptionistResolver = vi.fn<CallerProvidedIdentityResolver>(async () => ({ dateOfBirth: "1950-03-04", zip: "89101", status: "active" }));
    const receptionistServer = await start(receptionist.store, async () => true, undefined, receptionistResolver);
    expect((await fetch(`${receptionistServer.base}/staff?channel=sms&selected=${receptionist.c.id}`)).status).toBe(200);
    expect(receptionistResolver).not.toHaveBeenCalled();
    expect(receptionistServer.render).toHaveBeenLastCalledWith(expect.not.objectContaining({ callerProvidedIdentity: expect.anything() }));

    const unavailable = vi.fn<CallerProvidedIdentityResolver>(async () => { throw new Error("protected_store_unavailable"); });
    const unavailableServer = await start(full.store, async () => true, undefined, unavailable);
    expect((await fetch(`${unavailableServer.base}/staff/conversations/snapshot?channel=sms&selected=${full.c.id}`)).status).toBe(200);
    expect(unavailableServer.render).toHaveBeenLastCalledWith(expect.objectContaining({ callerProvidedIdentity: null }));
  });
  it("ignores forged authority and rejects provider or AI-only commands", async () => {
    const { c, store } = fixture(), { base } = await start(store);
    const fields = { type: "staff.note", note: "Called back", eventId: randomUUID(), revision: "0", ownerEpoch: "0", actor: "attacker", practiceId: "attacker" };
    const post = (values: Record<string, string>) => fetch(`${base}/staff/conversations/${c.id}/command`, { method: "POST", body: new URLSearchParams(values), redirect: "manual" });
    expect((await post(fields)).status).toBe(303);
    expect(store.execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: "staff", id: "demo-staff" }, scope: { practiceId: "synthetic", instanceId: "reception", conversationId: c.id }, command: { type: "staff.note", note: "Called back" } }));
    expect((await post({ ...fields, type: "sms.suppression" })).status).toBe(400);
    expect((await post({ ...fields, revision: "NaN" })).status).toBe(400);
    expect(store.execute).toHaveBeenCalledTimes(1);
  });
  it("reports optimistic conflicts instead of silently overwriting", async () => {
    const { c, store } = fixture(), { base } = await start(store);
    vi.mocked(store.execute).mockResolvedValue({ accepted: false, error: "stale_revision", eventId: "event", state: c, occurredAt: c.updatedAt });
    const response = await fetch(`${base}/staff/conversations/${c.id}/command`, { method: "POST", body: new URLSearchParams({ type: "staff.note", note: "Old note", eventId: randomUUID(), revision: "0", ownerEpoch: "0" }) });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "stale_revision", revision: 0 });
  });
  it("notifies the retained voice runtime only after an accepted owner transition", async () => {
    const { c, store } = fixture();
    (c.admission as { channel: "voice" | "sms" }).channel = "voice";
    (c as { ownerEpoch: number }).ownerEpoch = 1;
    const changed = vi.fn(async () => undefined);
    const { base } = await start(store, async () => true, undefined, undefined, changed);
    const response = await fetch(`${base}/staff/conversations/${c.id}/command`, { method: "POST", headers: { accept: "application/json" },
      body: new URLSearchParams({ type: "owner.change", owner: "staff", eventId: randomUUID(), revision: "0", ownerEpoch: "0" }) });
    expect(response.status).toBe(200);
    expect(changed).toHaveBeenCalledWith({ scope: { practiceId: "synthetic", instanceId: "reception", conversationId: c.id }, conversation: c });
  });
  it("acknowledges asynchronous commands without navigation and preserves safe fallback filters", async () => {
    const { c, store } = fixture(), { base } = await start(store);
    const fields = { type: "staff.note", note: "Callback attempt recorded", eventId: randomUUID(), revision: "0", ownerEpoch: "0", filter: "needs_follow_up", page: "2" };
    const response = await fetch(`${base}/staff/conversations/${c.id}/command`, { method: "POST", headers: { accept: "application/json" }, body: new URLSearchParams(fields), redirect: "manual" });
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ accepted: true, eventId: fields.eventId, revision: c.revision });
    const fallback = await fetch(`${base}/staff/conversations/${c.id}/command`, { method: "POST", body: new URLSearchParams({ ...fields, eventId: randomUUID() }), redirect: "manual" });
    expect(fallback.status).toBe(303);
    const location = new URL(fallback.headers.get("location")!, base);
    expect(location.origin).toBe(base);
    expect(location.searchParams.get("filter")).toBe("needs_follow_up");
    expect(location.searchParams.get("page")).toBe("2");
  });
  it("proxies audio only after the selected voice conversation binds the parent call", async () => {
    const { c, store } = fixture();
    const parent = `CA${"1".repeat(32)}`, recording = `RE${"2".repeat(32)}`;
    (c.admission as { channel: "voice" | "sms"; externalId: string }).channel = "voice";
    (c.admission as { externalId: string }).externalId = parent;
    const recordings = { list: vi.fn(async () => ({ state: "available" as const, recordings: [{ id: recording, status: "completed" as const, durationSeconds: 10 }] })),
      audio: vi.fn(async () => ({ state: "available" as const, bytes: new Uint8Array([1, 2, 3]) })) };
    const { base } = await start(store, async () => true, undefined, undefined, undefined, recordings);
    const response = await fetch(`${base}/staff/conversations/${c.id}/recordings/${recording}.mp3`);
    expect(response.status).toBe(200); expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(recordings.audio).toHaveBeenCalledWith({ parentCallId: parent, recordingId: recording });
    expect((await fetch(`${base}/staff/conversations/${c.id}/recordings/https:%2F%2Fattacker.invalid.mp3`)).status).toBe(404);
    expect(recordings.audio).toHaveBeenCalledTimes(1);
  });
  it("always exposes a selected voice transcript state without enabling transcript storage", async () => {
    const { c, store } = fixture();
    (c.admission as { channel: "voice" | "sms" }).channel = "voice";
    const recordings = { list: vi.fn(async () => ({ state: "available" as const, recordings: [] })), audio: vi.fn() };
    const { base, render } = await start(store, async () => true, undefined, undefined, undefined, recordings);
    expect((await fetch(`${base}/staff?channel=voice&selected=${c.id}`)).status).toBe(200);
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ transcripts: "disabled", recordings: { state: "available", recordings: [] } }));

    const transcriptStore = { getByConversation: vi.fn(async () => []) } satisfies Pick<PostgresRecordingTranscriptStore, "getByConversation">;
    const withStore = await start(store, async () => true, undefined, undefined, undefined, undefined, transcriptStore);
    expect((await fetch(`${withStore.base}/staff?channel=voice&selected=${c.id}`)).status).toBe(200);
    expect(transcriptStore.getByConversation).toHaveBeenCalledWith({ practiceId: "synthetic", instanceId: "reception", conversationId: c.id });
    expect(withStore.render).toHaveBeenLastCalledWith(expect.objectContaining({ transcripts: [] }));
  });
  it("reads a live review only through the selected conversation's fixed tenant, account, and call binding", async () => {
    const { c, store } = fixture();
    const accountSid = `AC${"a".repeat(32)}`, callSid = `CA${"b".repeat(32)}`;
    (c.admission as { channel: "voice" | "sms"; accountId: string; externalId: string }).channel = "voice";
    (c.admission as { accountId: string }).accountId = accountSid;
    (c.admission as { externalId: string }).externalId = callSid;
    const liveReviews = { list: vi.fn(async () => []), purgeExpired: vi.fn(async () => 0) } satisfies Pick<PostgresLiveConversationReviewStore, "list" | "purgeExpired">;
    const { base, render } = await start(store, async () => true, undefined, undefined, undefined, undefined, undefined, liveReviews);
    expect((await fetch(`${base}/staff?channel=voice`)).status).toBe(200);
    expect(liveReviews.list).not.toHaveBeenCalled();
    expect((await fetch(`${base}/staff?channel=voice&selected=${c.id}&practiceId=attacker&accountSid=attacker&callSid=attacker`)).status).toBe(200);
    expect(liveReviews.list).toHaveBeenCalledWith({ practiceId: "synthetic", instanceId: "reception", accountSid, callSid });
    expect(liveReviews.purgeExpired).toHaveBeenCalledWith(100);
    expect(render).toHaveBeenLastCalledWith(expect.objectContaining({ liveReview: [] }));

    const unavailable = { list: vi.fn(async () => []), purgeExpired: vi.fn(async () => { throw new Error("review_store_unavailable"); }) } satisfies Pick<PostgresLiveConversationReviewStore, "list" | "purgeExpired">;
    const unavailableServer = await start(store, async () => true, undefined, undefined, undefined, undefined, undefined, unavailable);
    expect((await fetch(`${unavailableServer.base}/staff?channel=voice&selected=${c.id}`)).status).toBe(200);
    expect(unavailableServer.render).toHaveBeenLastCalledWith(expect.objectContaining({ liveReview: "unavailable" }));
  });
  it("streams only identifiers and closes when the session expires", async () => {
    const f = fixture("full"); let active = true;
    const resolver = vi.fn<CallerProvidedIdentityResolver>(async () => ({ dateOfBirth: "1980-01-02", zip: "89109", status: "active" }));
    const { base } = await start(f.store, async () => active, undefined, resolver);
    const response = await fetch(`${base}/staff/conversations/events`);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: ready");
    expect(resolver).not.toHaveBeenCalled();
    f.change();
    const payload = new TextDecoder().decode((await reader.read()).value);
    expect(payload).toContain(f.c.id); expect(payload).not.toContain(f.c.admission.contact);
    expect(payload).not.toContain("1980-01-02"); expect(payload).not.toContain("89109");
    expect(resolver).not.toHaveBeenCalled();
    active = false;
    f.change();
    await vi.waitFor(() => expect(f.unsubscribe).toHaveBeenCalledTimes(1));
    expect((await reader.read()).done).toBe(true);
  });
});
