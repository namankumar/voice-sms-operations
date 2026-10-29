import type { ServerResponse } from "node:http";
import { z } from "zod";
import { ConversationConflict, commandSchema, type Conversation, type ConversationScope, type CommandEnvelope } from "./conversation-contract.js";
import type { ConversationStore, PostgresConversationStore, TransitionReceipt } from "./conversation-store.js";
import type { CallerProvidedIdentity } from "./f2-synthetic-practice-store.js";
import { queueFilterSchema } from "./conversation-query.js";
import type { ConversationConsoleInput, ConversationTranscriptView } from "./conversation-console.js";
import type { AuthenticatedStaffExtension } from "./staff-extension.js";
import { serveStaffEvents } from "./staff-events.js";
import { CONVERSATION_CONSOLE_CLIENT_JS } from "./conversation-console-client.js";
import type { CallRecordingList, TwilioCallRecordingsPort } from "./twilio-call-recordings.js";
import type { PostgresRecordingTranscriptStore } from "./recording-transcript-store.js";

export interface ConversationConsoleView {
  rows: readonly Conversation[];
  channel: "voice" | "sms";
  selected: Conversation | null;
  history: readonly { input: CommandEnvelope; receipt: TransitionReceipt }[];
  csrfToken: string;
  actor: string;
  page: number;
  total: number;
  filter?: NonNullable<ConversationConsoleInput["filter"]>;
  metricCounts?: NonNullable<ConversationConsoleInput["metricCounts"]>;
  historyProjection?: NonNullable<ConversationConsoleInput["historyProjection"]>;
  callerProvidedIdentity?: CallerProvidedIdentity | null;
  recordings?: CallRecordingList | { state: "not_enabled" };
  transcripts?: ConversationTranscriptView;
}
export type CallerProvidedIdentityResolver = (scope: ConversationScope) => Promise<CallerProvidedIdentity | null>;
const uuid = z.string().uuid();
const natural = z.coerce.number().int().nonnegative().safe();
const permitted = new Set(["owner.change", "staff.note", "request.claim", "request.complete", "request.callback_attempt", "sms.queue", "sms.release_hold", "monitor.resolve"]);
function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

/** The surrounding staff gateway authenticates the session and verifies POST CSRF. */
export function createConversationStaffExtension(options: {
  store: ConversationStore;
  projection?: Pick<PostgresConversationStore, "queryQueue" | "queryHistory">;
  practiceId: string;
  instanceId: string;
  render(view: ConversationConsoleView): { title: string; body: string };
  resolveCallerProvidedIdentity?: CallerProvidedIdentityResolver;
  /** Invoked only after a durable voice ownership transition commits. */
  onVoiceOwnershipChanged?: (input: { scope: ConversationScope; conversation: Conversation }) => Promise<void> | void;
  heartbeatMs?: number;
  recordings?: Pick<TwilioCallRecordingsPort, "list" | "audio">;
  transcripts?: Pick<PostgresRecordingTranscriptStore, "getByConversation">;
}): AuthenticatedStaffExtension {
  const { store, practiceId, instanceId } = options;
  return {
    matches(url) {
      return (url.pathname === "/staff" && ["voice", "sms"].includes(url.searchParams.get("channel") ?? "")) || url.pathname.startsWith("/staff/conversations/");
    },
    async handle(context) {
      const { request, response, url, actor, csrfToken, fields } = context;
      const audioMatch = url.pathname.match(/^\/staff\/conversations\/([^/]+)\/recordings\/(RE[a-fA-F0-9]{32})\.mp3$/);
      if (audioMatch && request.method === "GET") {
        const conversationId = uuid.safeParse(audioMatch[1]);
        if (!conversationId.success || options.recordings === undefined) return reply(response, 404, { error: "not_found" });
        const conversation = await store.get({ practiceId, instanceId, conversationId: conversationId.data });
        if (conversation === null || conversation.admission.channel !== "voice") return reply(response, 404, { error: "not_found" });
        const audio = await options.recordings.audio({ parentCallId: conversation.admission.externalId, recordingId: audioMatch[2]! });
        if (audio.state !== "available") return reply(response, 404, { error: "not_found" });
        response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.bytes.byteLength), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" });
        response.end(audio.bytes); return;
      }
      if (url.pathname === "/staff/conversations/client.js" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        response.end(CONVERSATION_CONSOLE_CLIENT_JS); return;
      }
      if (url.pathname === "/staff/conversations/events" && request.method === "GET") {
        return serveStaffEvents({ response, sessionId: context.sessionId, actor, sessionActive: context.sessionActive,
          subscribe: (listener) => store.subscribe({ practiceId, instanceId }, listener), eventName: "change", heartbeatMs: options.heartbeatMs ?? 15_000 });
      }
      const match = url.pathname.match(/^\/staff\/conversations\/([^/]+)\/command$/);
      if (match && request.method === "POST") {
        try {
          const conversationId = uuid.parse(match[1]);
          if (!permitted.has(fields.type ?? "")) return reply(response, 400, { error: "command_not_allowed" });
          const commandFields: Record<string, unknown> = { type: fields.type };
          const keys: Record<string, readonly string[]> = {
            "owner.change": ["owner"], "staff.note": ["note"], "request.claim": ["requestId"],
            "request.complete": ["requestId", "outcome"], "sms.queue": ["messageId", "body"], "sms.release_hold": ["messageId", "note"],
            "monitor.resolve": ["reviewId", "outcome"],
            "request.callback_attempt": ["requestId", "outcome", "note"],
          };
          for (const key of keys[fields.type!]!) commandFields[key] = fields[key];
          const receipt = await store.execute({
            scope: { practiceId, instanceId, conversationId }, eventId: uuid.parse(fields.eventId),
            expectedRevision: natural.parse(fields.revision), expectedOwnerEpoch: natural.parse(fields.ownerEpoch),
            actor: { kind: "staff", id: actor }, command: commandSchema.parse(commandFields),
          });
          if (!receipt.accepted) return reply(response, 409, { error: receipt.error, revision: receipt.state.revision });
          if (receipt.state.admission.channel === "voice" && receipt.state.phase === "active" && receipt.state.ownerEpoch > 0
            && receipt.state.owner !== "waiting_for_staff" && commandFields.type === "owner.change") {
            await options.onVoiceOwnershipChanged?.({ scope: { practiceId, instanceId, conversationId }, conversation: receipt.state });
          }
          if (request.headers.accept?.split(",").some((part) => part.trim().split(";")[0] === "application/json")) {
            return reply(response, 200, { accepted: true, eventId: receipt.eventId, revision: receipt.state.revision });
          }
          const params = new URLSearchParams({ channel: receipt.state.admission.channel, selected: conversationId });
          const filter = queueFilterSchema.safeParse(fields.filter);
          if (filter.success) params.set("filter", filter.data);
          const page = Number(fields.page);
          if (Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000) params.set("page", String(page));
          response.writeHead(303, { Location: `/staff?${params}`, "Cache-Control": "no-store" }); response.end();
        } catch (error) {
          if (error instanceof z.ZodError) return reply(response, 400, { error: "invalid_command" });
          if (error instanceof ConversationConflict) return reply(response, error.code === "conversation_not_found" ? 404 : 409, { error: error.code });
          throw error;
        }
        return;
      }
      if (request.method !== "GET" || !["/staff", "/staff/conversations/snapshot"].includes(url.pathname)) return reply(response, 404, { error: "not_found" });
      const channel = url.searchParams.get("channel");
      if (channel !== "voice" && channel !== "sms") return reply(response, 400, { error: "invalid_channel" });
      const requested = Number(url.searchParams.get("page") ?? 1);
      const filter = queueFilterSchema.safeParse(url.searchParams.get("filter") ?? "total");
      if (!filter.success) return reply(response, 400, { error: "invalid_filter" });
      if (filter.data !== "total" && options.projection === undefined) return reply(response, 503, { error: "queue_projection_unavailable" });
      let page = Math.max(1, Number.isSafeInteger(requested) ? Math.min(requested, 1_000_000) : 1);
      let projection;
      try { projection = await options.projection?.queryQueue({ practiceId, instanceId, channel, filter: filter.data, page, pageSize: 25 }); }
      catch { return reply(response, 503, { error: "queue_projection_unavailable" }); }
      const total = projection?.total ?? await store.count({ practiceId, instanceId, channel });
      page = projection?.page ?? Math.min(page, Math.max(1, Math.ceil(total / 25)));
      const rows = projection?.rows ?? await store.list({ practiceId, instanceId, channel, limit: 25, offset: (page - 1) * 25 });
      let selected: Conversation | null = null;
      let history: ConversationConsoleView["history"] = [];
      let historyProjection: ConversationConsoleInput["historyProjection"];
      let callerProvidedIdentity: CallerProvidedIdentity | null | undefined;
      let recordings: ConversationConsoleView["recordings"];
      let transcripts: ConversationConsoleView["transcripts"];
      const selectedId = url.searchParams.get("selected");
      if (selectedId !== null) {
        if (!uuid.safeParse(selectedId).success) return reply(response, 400, { error: "invalid_selection" });
        const scope = { practiceId, instanceId, conversationId: selectedId };
        selected = await store.get(scope);
        if (selected === null || selected.admission.channel !== channel) return reply(response, 404, { error: "not_found" });
        history = await store.history(scope);
        if (options.projection) {
          const result = await options.projection.queryHistory({ scope, channel });
          historyProjection = { ...result, recent: result.recent.map((entry) => ({ ...entry, requestSummary: entry.requestSummary ?? "Request not captured" })) };
        }
        if (selected.admission.mode === "full") {
          callerProvidedIdentity = null;
          try { callerProvidedIdentity = await options.resolveCallerProvidedIdentity?.(scope) ?? null; }
          catch { callerProvidedIdentity = null; }
        }
        if (selected.admission.channel === "voice") {
          recordings = options.recordings === undefined ? { state: "not_enabled" } : await options.recordings.list({ parentCallId: selected.admission.externalId });
          if (options.transcripts === undefined) transcripts = "disabled";
          else {
            try { transcripts = await options.transcripts.getByConversation(scope); }
            catch { transcripts = "unavailable"; }
          }
        }
      }
      const rendered = options.render({ rows, channel, selected, history, csrfToken, actor, page, total, filter: filter.data,
        ...(projection ? { metricCounts: projection.metrics } : {}), ...(historyProjection ? { historyProjection } : {}),
        ...(callerProvidedIdentity !== undefined ? { callerProvidedIdentity } : {}), ...(recordings === undefined ? {} : { recordings }),
        ...(transcripts === undefined ? {} : { transcripts }) });
      if (url.pathname.endsWith("/snapshot")) return reply(response, 200, rendered);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(context.renderDocument(rendered.title, rendered.body));
    },
  };
}
