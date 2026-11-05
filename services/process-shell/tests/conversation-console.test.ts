/// <reference lib="dom" />
// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { admissionSchema, applyConversationCommand, conversationSchema, newConversation, scopeOf, simulatedRouteBindingKey,
  type CommandEnvelope, type Conversation, type ConversationCommand } from "../src/conversation-contract.js";
import { CONVERSATION_CONSOLE_CLIENT_JS } from "../src/conversation-console-client.js";
import { renderConversationConsole, type ConversationConsoleInput } from "../src/conversation-console.js";
import { requestSourceSummary, type TransitionReceipt } from "../src/conversation-store.js";

const now = "2026-09-24T17:00:00.000Z";
const metricCounts = { total: 12, activeNow: 3, needsFollowUp: 5, connectedToStaff: 4, resolvedByHuman: 4, resolvedByAi: 2 } as const;

function initial(channel: "voice" | "sms" = "sms", id = "conversation-1"): Conversation {
  return newConversation(admissionSchema.parse({ practiceId: "synthetic", instanceId: "reception", configVersion: "v1", mode: "receptionist",
    accountId: "AC-test", provider: "twilio", channel, externalId: "external-1", contact: "+17025550123", destination: "+12025550100", hours: "demo_open" }), id, now);
}

function whatsappInitial(lastInboundAt: string | null): Conversation {
  const conversation = initial();
  return {
    ...conversation,
    admission: { ...conversation.admission, messageTransport: "whatsapp" },
    lastInboundAt,
    owner: "staff",
    staffActor: "staffExample",
    ownerEpoch: 1,
    revision: 1,
  } as Conversation;
}

function fullInitial(channel: "voice" | "sms" = "voice", id = "full-conversation-1"): Conversation {
  return newConversation(admissionSchema.parse({ practiceId: "synthetic", instanceId: "full", configVersion: "v1", mode: "full",
    accountId: "AC-test", provider: "twilio", channel, externalId: "external-full-1", contact: "+17025550123", destination: "+12025550100", hours: "demo_open" }), id, now);
}

function envelope(state: Conversation, command: ConversationCommand, kind: CommandEnvelope["actor"]["kind"], actor: string, eventId = `event-${state.revision}`): CommandEnvelope {
  return { scope: scopeOf(state), eventId, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind, id: actor }, command };
}

function act(state: Conversation, command: ConversationCommand, kind: CommandEnvelope["actor"]["kind"], actor: string): Conversation {
  return applyConversationCommand(state, envelope(state, command, kind, actor), now);
}

function historyEntry(state: Conversation, command: ConversationCommand, actor: string, occurredAt: string, accepted = true): { input: CommandEnvelope; receipt: TransitionReceipt } {
  const input = envelope(state, command, "staff", actor, `history-${occurredAt}-${actor}`);
  return { input, receipt: { eventId: input.eventId, accepted, error: accepted ? null : "stale_revision", state, occurredAt } };
}

function render(selected: Conversation | null, overrides: Partial<ConversationConsoleInput> = {}) {
  return renderConversationConsole({ rows: selected === null ? [] : [selected], channel: selected?.admission.channel ?? "sms", selected, history: [], csrfToken: "csrf", actor: "staffExample", page: 1, total: selected === null ? 0 : 1, ...overrides });
}

describe("conversation console renderer", () => {
  it("keeps a resolved scheduling request as the row context after a later callback withdrawal", () => {
    const conversation = conversationSchema.parse({ ...fullInitial("voice", "withdrawn-callback"), phase: "disconnected", inputs: [
      { id: "schedule-source", body: "Change my appointment.", sequence: 1 },
      { id: "callback-source", body: "Leave a message.", sequence: 2 },
    ], requests: [{
      id: "schedule", revision: 1, category: "scheduling", originalRequest: "Change my appointment.", name: "", callbackNumber: "",
      callbackConfirmed: false, confirmationSourceId: null, callbackMessageSourceId: null, owner: null, outcome: null, sourceIds: ["schedule-source"], proposalRevision: 1,
      fullProposal: { capability: "appointment_reschedule", patientStatus: "established", schedulingKind: "office_visit", knowledgeTopic: "not_applicable" },
      aiResolution: { kind: "action", receiptId: "action-1", operation: "reschedule", resultHash: `sha256:${"a".repeat(64)}`,
        readbackHash: `sha256:${"b".repeat(64)}`, resultingVersion: 1 }, state: "ai_resolved",
    }, {
      id: "callback", revision: 1, category: "general_or_uncertain", originalRequest: "Leave a message.", name: "", callbackNumber: "",
      callbackConfirmed: false, confirmationSourceId: null, callbackMessageSourceId: null, owner: null, outcome: null, sourceIds: ["callback-source"], proposalRevision: 2,
      fullProposal: { capability: "human_request", patientStatus: "unknown", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable" }, aiResolution: null, state: "abandoned",
    }] });
    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    const row = document.querySelector('[data-conversation-id="withdrawn-callback"]');
    expect(row?.querySelector(".request-cell")?.textContent).toContain("Resolved by AI");
    expect(row?.querySelector(".request-cell")?.textContent).toContain("No saved caller message");
    expect(row?.querySelector(".owner-cell")?.textContent).toBe("No follow-up needed");
  });

  it("renders timestamped caller and generated assistant evidence in chronological order without duplicating caller input", () => {
    const conversation = initial("voice");
    const review = { scope: scopeOf(conversation), id: "review-timeline", version: "monitor-v1", responseId: "response-timeline", outputItemId: "output-timeline",
      voiceEpoch: 0, authorityRevision: 0, transcript: "I can help with &lt;details&gt;.", verdict: "clear" as const, reasons: [], claims: [], correction: "not_required" as const };
    const caller = envelope(conversation, { type: "input.record", sourceId: "caller-timeline", body: '<img src=x onerror="alert(1)"> I need help.' }, "provider", "twilio", "caller-timeline-event");
    const assistant = envelope(conversation, { type: "monitor.review", review }, "system", "speech-monitor", "assistant-timeline-event");
    const history = [
      { input: assistant, receipt: { eventId: assistant.eventId, accepted: true, error: null, state: conversation, occurredAt: "2026-09-24T17:01:00.000Z" } },
      { input: caller, receipt: { eventId: caller.eventId, accepted: true, error: null, state: conversation, occurredAt: "2026-09-24T17:00:00.000Z" } },
    ] satisfies ConversationConsoleInput["history"];
    const document = new DOMParser().parseFromString(render(conversation, { history }).body, "text/html");
    const rows = Array.from(document.querySelectorAll(".live-conversation-list li"));
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["Caller input", "Assistant generated speech"]);
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual(['<img src=x onerror="alert(1)"> I need help.', "I can help with &lt;details&gt;."]);
    expect(rows[1]?.textContent).toContain("Generated text is not proof that the caller heard it.");
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll(".input-list")).toHaveLength(0);
  });

  it("renders scoped retained live events separately from recordings with delivery evidence", () => {
    const conversation = initial("voice");
    const stream = { streamSid: `MZ${"a".repeat(32)}`, reservationId: "gpt-live-primary", sourceCommit: "a".repeat(40), model: "gpt-live", deploymentId: "deployment-1" };
    const binding = { practiceId: "synthetic", instanceId: "reception", accountSid: `AC${"b".repeat(32)}`, callSid: `CA${"c".repeat(32)}` };
    const base = { binding, reviewState: "complete" as const, stream, payload: { type: "test" }, serverReceivedAt: "2026-09-24T17:00:01.000Z" };
    const liveReview = [
      { ...base, eventId: "caller", appendOrdinal: 1, occurredAt: "2026-09-24T17:00:00.000Z", kind: "caller_transcript" as const, speaker: "caller" as const, text: "Please call me & confirm." },
      { ...base, eventId: "assistant", appendOrdinal: 2, occurredAt: "2026-09-24T17:00:02.000Z", kind: "assistant_transcript" as const, speaker: "assistant" as const, text: "I can help.", delivery: { state: "played" as const, timingPrecision: "exact" as const, markId: "mark-1", playedAt: "2026-09-24T17:00:02.000Z" } },
      { ...base, eventId: "saved", appendOrdinal: 3, occurredAt: "2026-09-24T17:00:03.000Z", kind: "save_receipt" as const, speaker: "system" as const, text: null, actionEvidence: { type: "save_receipt", saved: false, requestId: "request-1" } },
      { ...base, eventId: "closing", appendOrdinal: 4, occurredAt: "2026-09-24T17:00:04.000Z", kind: "closing" as const, speaker: "system" as const, text: "Your message was saved." },
      { ...base, eventId: "carrier-mark", appendOrdinal: 5, occurredAt: "2026-09-24T17:00:05.000Z", kind: "live_event" as const, speaker: "system" as const, text: null,
        carrierPlayback: { type: "carrier_playback/v1" as const, action: "mark_ack" as const, byteBoundary: { totalOutputBytes: 1600, playedMarkBytes: 1600, clearedThroughBytes: 0, lastNonFFByteEnd: 1440 }, carrierMark: { name: "mark-1", acknowledged: true } } },
    ] satisfies NonNullable<ConversationConsoleInput["liveReview"]>;
    const document = new DOMParser().parseFromString(render(conversation, { liveReview }).body, "text/html");
    const review = document.querySelector("[data-live-call-review]")!;
    expect(review.textContent).toContain("Not recorded audio.");
    expect(Array.from(review.querySelectorAll("strong")).map((node) => node.textContent)).toEqual(["Caller", "Assistant", "Save result", "Closing", "Live event"]);
    expect(review.textContent).toContain("Carrier playback marked · exact timing");
    expect(review.textContent).toContain("Event retained without displayable text.");
    expect(review.textContent).toContain("SavedNo");
    expect(review.textContent).toContain("Requestrequest-1");
    expect(review.textContent).toContain("Carrier transport receipt only; this does not establish handset hearing.");
    expect(review.textContent).toContain("Carrier mark acknowledged");
    expect(review.textContent).toContain("Played-mark bytes1600");
    expect(review.querySelector("audio")).toBeNull();
  });

  it("does not backfill a missing live review from legacy runtime history", () => {
    const conversation = initial("voice");
    const review = { scope: scopeOf(conversation), id: "legacy-review", version: "monitor-v1", responseId: "response-legacy", outputItemId: "output-legacy",
      voiceEpoch: 0, authorityRevision: 0, transcript: "Legacy generated text.", verdict: "clear" as const, reasons: [], claims: [], correction: "not_required" as const };
    const assistant = envelope(conversation, { type: "monitor.review", review }, "system", "speech-monitor", "legacy-event");
    const history = [{ input: assistant, receipt: { eventId: assistant.eventId, accepted: true, error: null, state: conversation, occurredAt: "2026-09-24T17:00:00.000Z" } }];
    const document = new DOMParser().parseFromString(render(conversation, { history, liveReview: "not_retained" }).body, "text/html");
    const retained = document.querySelector("[data-live-call-review]")!;
    expect(retained.textContent).toContain("Historical assistant text was not backfilled.");
    expect(retained.textContent).not.toContain("Legacy generated text.");
    expect(document.querySelector(".panel-section .eyebrow")?.textContent).not.toBe("Live conversation evidence");
  });

  it("groups adjacent same-speaker transcript deltas without normalizing text or crossing stream boundaries", () => {
    const conversation = initial("voice");
    const binding = { practiceId: "synthetic", instanceId: "reception", accountSid: `AC${"a".repeat(32)}`, callSid: `CA${"b".repeat(32)}` };
    const primary = { streamSid: `MZ${"c".repeat(32)}`, reservationId: "gpt-live-primary", sourceCommit: "a".repeat(40), model: "gpt-live", deploymentId: "deployment-1" };
    const returned = { ...primary, streamSid: `MZ${"d".repeat(32)}`, reservationId: "gpt-live-return" };
    const event = { binding, reviewState: "complete" as const, serverReceivedAt: "2026-09-24T17:00:01.000Z" };
    const review = [
      { ...event, eventId: "hello", appendOrdinal: 1, occurredAt: "2026-09-24T17:00:00.000Z", kind: "caller_transcript" as const, speaker: "caller" as const, text: "Hello", stream: primary, payload: { type: "session.input_transcript.delta" } },
      { ...event, eventId: "space", appendOrdinal: 2, occurredAt: "2026-09-24T17:00:01.000Z", kind: "caller_transcript" as const, speaker: "caller" as const, text: " ", stream: primary, payload: { type: "session.input_transcript.delta" } },
      { ...event, eventId: "there", appendOrdinal: 3, occurredAt: "2026-09-24T17:00:02.000Z", kind: "caller_transcript" as const, speaker: "caller" as const, text: "there", stream: primary, payload: { type: "session.input_transcript.delta" } },
      { ...event, eventId: "assistant", appendOrdinal: 4, occurredAt: "2026-09-24T17:00:03.000Z", kind: "assistant_transcript" as const, speaker: "assistant" as const, text: "Thanks", stream: primary, payload: { type: "session.output_transcript.delta" }, delivery: { state: "generated" as const, timingPrecision: "unavailable" as const } },
      { ...event, eventId: "return", appendOrdinal: 5, occurredAt: "2026-09-24T17:00:04.000Z", kind: "caller_transcript" as const, speaker: "caller" as const, text: " again", stream: returned, payload: { type: "session.input_transcript.delta" } },
      { ...event, eventId: "carrier", appendOrdinal: 6, occurredAt: "2026-09-24T17:00:05.000Z", kind: "live_event" as const, speaker: "system" as const, text: null, stream: returned, payload: { type: "carrier_mark" } },
    ] satisfies NonNullable<ConversationConsoleInput["liveReview"]>;
    const document = new DOMParser().parseFromString(render(conversation, { liveReview: review }).body, "text/html");
    const rows = Array.from(document.querySelectorAll("[data-live-call-review-event]"));
    expect(rows).toHaveLength(4);
    expect(rows[0]?.querySelector("p")?.textContent).toBe("Hello there");
    expect(rows[0]?.getAttribute("data-live-call-review-ordinals")).toBe("1,2,3");
    expect(rows[1]?.querySelector("p")?.textContent).toBe("Thanks");
    expect(rows[2]?.querySelector("p")?.textContent).toBe(" again");
    expect(rows[3]?.textContent).toContain("Live event");
  });

  it("shows a simulated route outcome without claiming staff reach, resolution, or a saved callback", () => {
    const conversation = conversationSchema.parse({ ...initial("voice"), callerContext: [{ sourceId: "intake", text: "Billing question for staff.", historical: true, verified: false }],
      simulatedRouteOutcomes: [{ id: "route-1", sourceId: "intake", requestId: "request-1", requestRevision: 1, ownerEpoch: 0,
        instanceId: "reception", conversationId: "conversation-1", category: "billing_or_insurance", outcome: "no_answer",
        bindingKey: `sim-route:${"a".repeat(64)}`, recordedAt: now, supersedesId: null }] });
    const html = render(conversation).body;
    expect(html).toContain("Simulated only: No Answer");
    expect(html).toContain("Assigned</dt><dd>Unknown");
    expect(html).toContain("Reached</dt><dd>Unknown");
    expect(html).toContain("Billing question for staff.");
    expect(html).toContain("does not establish a real transfer");
    expect(html).not.toContain(`sim-route:${"a".repeat(64)}`);
  });

  it("separates staff assignment, callback attempt, caller reach, and explicit completion after a simulated route", () => {
    const conversation = conversationSchema.parse({ ...initial("voice"), requests: [{ id: "request-1", revision: 1, category: "billing_or_insurance",
      originalRequest: "Billing question.", name: "Casey", callbackNumber: "+17025550123", callbackConfirmed: true, confirmationSourceId: "intake", callbackMessageSourceId: "intake",
      owner: "staffExample", outcome: "Staff resolved billing request.", sourceIds: ["intake"], proposalRevision: 1, aiResolution: null, state: "completed" }],
      simulatedRouteOutcomes: [{ id: "route-1", sourceId: "intake", requestId: "request-1", requestRevision: 1, ownerEpoch: 0, instanceId: "reception", conversationId: "conversation-1",
        category: "billing_or_insurance", outcome: "no_answer", bindingKey: `sim-route:${"b".repeat(64)}`, recordedAt: now, supersedesId: null }] });
    const attempt: ConversationCommand = { type: "request.callback_attempt", requestId: "request-1", outcome: "reached", note: "Reached caller." };
    const html = render(conversation, { history: [historyEntry(conversation, attempt, "staffExample", now)] }).body;
    expect(html).toContain("Assigned</dt><dd>Assigned to staffExample");
    expect(html).toContain("Attempted</dt><dd>Recorded");
    expect(html).toContain("Reached</dt><dd>Reached");
    expect(html).toContain("Resolved</dt><dd>Resolved");
  });

  it("projects active simulated-route stages from the current request after capture, claim, attempt, and completion revisions", () => {
    let conversation = initial("voice", "simulated-lifecycle");
    conversation = act(conversation, { type: "input.record", sourceId: "route-source", body: "Please call me about my bill." }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "route-request", sourceEventId: "route-source", category: "billing_or_insurance", name: "Casey", callbackNumber: "+17025550123" }, "ai", "receptionist");
    const request = conversation.requests[0]!;
    const route = { id: "simulated-lifecycle-route", sourceId: "route-source", requestId: request.id, requestRevision: request.revision, ownerEpoch: conversation.ownerEpoch,
      instanceId: conversation.admission.instanceId, conversationId: conversation.id, category: "billing_or_insurance" as const, outcome: "no_answer" as const,
      bindingKey: simulatedRouteBindingKey({ practiceId: conversation.admission.practiceId, instanceId: conversation.admission.instanceId, conversationId: conversation.id,
        sourceId: "route-source", requestId: request.id, requestRevision: request.revision, ownerEpoch: conversation.ownerEpoch, category: "billing_or_insurance", outcome: "no_answer" }), recordedAt: now, supersedesId: null };
    conversation = act(conversation, { type: "simulated_route.record", outcome: route }, "system", "simulated-route-harness");
    conversation = act(conversation, { type: "question.activate", questionId: "confirm", kind: "callback_number", requestId: request.id }, "system", "receptionist");
    conversation = act(conversation, { type: "input.record", sourceId: "confirm-source", questionId: "confirm", body: "Yes" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.confirm_callback", requestId: request.id, callbackNumber: "+17025550123", sourceEventId: "confirm-source" }, "system", "receptionist");
    conversation = act(conversation, { type: "request.capture", requestId: request.id }, "ai", "receptionist");
    conversation = act(conversation, { type: "request.claim", requestId: request.id }, "staff", "staffExample");
    const attempt: ConversationCommand = { type: "request.callback_attempt", requestId: request.id, outcome: "reached", note: "Reached caller." };
    const attemptInput = envelope(conversation, attempt, "staff", "staffExample", "attempt-reached");
    conversation = applyConversationCommand(conversation, attemptInput, now);
    conversation = act(conversation, { type: "request.complete", requestId: request.id, outcome: "Confirmed billing follow-up." }, "staff", "staffExample");
    expect(conversation.requests[0]?.revision).toBeGreaterThan(route.requestRevision);
    const html = render(conversation, { history: [{ input: attemptInput, receipt: { eventId: attemptInput.eventId, accepted: true, error: null, state: conversation, occurredAt: now } }] }).body;
    expect(html).toContain("Assigned</dt><dd>Assigned to staffExample");
    expect(html).toContain("Attempted</dt><dd>Recorded");
    expect(html).toContain("Reached</dt><dd>Reached");
    expect(html).toContain("Resolved</dt><dd>Resolved");
  });

  it("describes disabled recording as current capture state without claiming historical audio is absent", () => {
    const html = render(initial("voice")).body;
    expect(html).toContain("New call recording is currently disabled.");
    expect(html).toContain("does not check for or play historical audio");
    expect(html).not.toContain("Recording was not enabled for this demo call.");
  });

  it("keeps stored caller input when its retained history event has been paged away", () => {
    const conversation = { ...initial("voice"), inputs: [{ id: "retained-state-only", body: '<b>Caller input</b>', sequence: 1 }] } as Conversation;
    const html = render(conversation, { history: [] }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.body.textContent).toContain("Caller input without retained event timestamp");
    expect(document.body.textContent).toContain("Stored caller input is shown here because its matching history event is unavailable.");
    expect(document.body.textContent).toContain("<b>Caller input</b>");
    expect(document.querySelectorAll("b")).toHaveLength(0);
    expect(document.body.textContent).toContain("Persisted event order");
    expect(document.body.textContent).not.toContain("Chronological conversation");
  });

  it("shows complete recorded text and speaker timestamps without treating text as HTML", () => {
    const conversation = fullInitial();
    const text = 'Hello <script>alert(1)</script>\nPlease move my appointment.';
    const result = render(conversation, { transcripts: [{ recordingId: "RE-test", state: "complete", transcript: {
      scope: scopeOf(conversation), recordingId: "RE-test", source: "twilio_recording", model: "gpt-4o-transcribe-diarize",
      status: "complete", text, failureCode: null, segments: [
        { speaker: "A", start: 0, end: 2, text: 'Hello <script>alert(1)</script>' },
        { speaker: "B", start: 2.5, end: 4, text: "Please move my appointment." },
      ],
    } }] });
    const document = new DOMParser().parseFromString(result.body, "text/html");
    expect(document.body.textContent).toContain("Full machine transcript");
    expect(document.body.textContent).toContain("Speaker A");
    expect(document.body.textContent).toContain("2.5-4.0s");
    expect(document.body.textContent).toContain(text);
    expect(document.querySelectorAll("script:not([src])").length).toBe(0);
    expect(document.body.textContent).toContain("fallback audio may be missing");
    expect(document.querySelector('[data-recorded-transcript]')?.getAttribute("data-transcript-state")).toBe("available");
    expect(document.querySelectorAll('[data-transcript-segment]')).toHaveLength(2);
    expect(document.querySelector('[data-transcript-full-text]')?.tagName).toBe("DETAILS");
    expect(result.body.indexOf("data-transcript-full-text")).toBeLessThan(result.body.indexOf("data-transcript-segment"));
  });

  it("keeps disabled, missing, pending, partial, and unavailable transcript states distinct", () => {
    const disabled = render(fullInitial()).body;
    expect(disabled).toContain('data-transcript-state="disabled"');
    expect(disabled).toContain("Automatic transcript processing is disabled for new calls");
    expect(disabled).not.toContain("Recording and transcription are disabled");
    const missing = render(fullInitial(), { transcripts: [] }).body;
    expect(missing).toContain('data-transcript-state="missing"');
    expect(missing).toContain("does not infer why");
    const pending = render(fullInitial(), { transcripts: [{ recordingId: "RE-pending", state: "claimed", transcript: null }] }).body;
    expect(pending).toContain('data-transcript-state="pending"');
    expect(pending).toContain("Transcript processing or outcome not yet confirmed");
    const partial = render(fullInitial(), { transcripts: [{ recordingId: "RE-partial", state: "partial", transcript: {
      scope: scopeOf(fullInitial()), recordingId: "RE-partial", source: "twilio_recording", model: "gpt-4o-transcribe-diarize", status: "partial", text: "Only this part.", failureCode: null,
      segments: [{ speaker: "A", start: 0, end: 1, text: "Only this part." }],
    } }] }).body;
    expect(partial).toContain('data-transcript-state="partial"');
    expect(partial).toContain("Partial transcription; review recording");
    expect(partial).toContain("data-transcript-full-text");
    const failed = render(fullInitial(), { transcripts: [{ recordingId: "RE-failed", state: "failed", transcript: {
      scope: scopeOf(fullInitial()), recordingId: "RE-failed", source: "twilio_recording", model: "gpt-4o-transcribe-diarize", status: "failed", text: "", failureCode: "transcription_request_ambiguous", segments: [],
    } }] }).body;
    expect(failed).toContain('data-transcript-state="unavailable"');
    expect(failed).toContain("Transcription unavailable; review recording");
    expect(failed).not.toContain("data-transcript-full-text");
    expect(failed).not.toContain("Full transcript text");
    const unavailable = render(fullInitial(), { transcripts: "unavailable" }).body;
    expect(unavailable).toContain('data-transcript-state="unavailable"');
    expect(unavailable).toContain("Transcript storage is temporarily unavailable");
    expect(render(initial("sms"), { transcripts: [] }).body).not.toContain("Full machine transcript");
  });

  it("keeps current staff work first while providing a keyboard-reachable transcript jump in selected voice detail", () => {
    const conversation = initial("voice");
    const html = render(conversation, { transcripts: [] }).body;
    expect(html).toContain('data-transcript-jump href="#recorded-transcript">Transcript</a>');
    expect(html).toContain('<section id="recorded-transcript"');
    expect(html.indexOf('data-transcript-jump')).toBeLessThan(html.indexOf('id="recorded-transcript"'));
    expect(html.indexOf('id="recorded-transcript"')).toBeGreaterThan(html.indexOf("Current state"));
    expect(html.indexOf('id="recorded-transcript"')).toBeGreaterThan(html.indexOf("No callback request captured."));
    expect(render(initial("sms"), { transcripts: [] }).body).not.toContain("data-transcript-jump");
  });

  it("keeps a degraded full proposal as context and exposes only its callback handoff", () => {
    const base = fullInitial();
    const conversation = { ...base, requests: [
      { id: "full-source", revision: 1, category: null, originalRequest: "I need appointment details", name: "Ada", callbackNumber: "", callbackConfirmed: false,
        confirmationSourceId: null, owner: null, outcome: null, sourceIds: ["caller"], proposalRevision: 1, aiResolution: null,
        fullProposal: { capability: "appointment_details" as const, patientStatus: "established" as const, schedulingKind: "not_applicable" as const, knowledgeTopic: "not_applicable" as const }, state: "draft" as const },
      { id: "callback", revision: 1, category: null, originalRequest: "I need appointment details", name: "Ada", callbackNumber: "+17025550123", callbackConfirmed: true,
        confirmationSourceId: "confirmed", owner: null, outcome: null, sourceIds: ["caller"], proposalRevision: 2, aiResolution: null,
        degradedHandoff: { recoveryId: "recovery", sourceRequestId: "full-source", sourceRequestRevision: 1 }, state: "needs_callback" as const },
    ] } as Conversation;
    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(document.querySelector('[data-request-id="full-source"] [data-degraded-recovery-context]')?.textContent).toContain("retained as context");
    expect(document.querySelectorAll('[data-request-id="full-source"] button').length).toBe(0);
    expect(document.querySelectorAll('[data-request-id="callback"] button').length).toBe(1);
    expect(document.querySelector('[data-request-id="callback"] button')?.textContent).toBe("Claim callback");
  });

  it("keeps source reconstruction out of staff request copy when no dedicated message was saved", () => {
    let conversation = initial();
    conversation = act(conversation, { type: "input.record", sourceId: "greeting", body: "Hi" }, "provider", "twilio");
    conversation = act(conversation, { type: "input.record", sourceId: "need", body: "I need to move my appointment" }, "provider", "twilio");
    conversation = act(conversation, { type: "input.record", sourceId: "preference", body: "Thursday would be best" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "preference",
      originalSourceEventId: "greeting", sourceEventIds: ["greeting", "need", "preference"] }, "ai", "assistant");
    expect(conversation.requests[0]?.originalRequest).toBe("Hi");

    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(document.querySelector(".request-cell span")?.textContent).toBe("No saved caller message");
    expect(document.querySelector('[data-request-id="request"] > p')?.textContent).toBe("No saved caller message.");
  });

  it("bounds the sourced projection, orders inputs by sequence, and excludes unrelated or prompted answers", () => {
    let conversation = initial();
    for (let index = 0; index < 6; index += 1) {
      conversation = act(conversation, { type: "input.record", sourceId: `fragment-${index}`,
        body: `${index}: ${"detail ".repeat(30)}` }, "provider", "twilio");
    }
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "fragment-5",
      originalSourceEventId: "fragment-0", sourceEventIds: Array.from({ length: 6 }, (_, index) => `fragment-${index}`) }, "ai", "assistant");
    conversation = act(conversation, { type: "input.record", sourceId: "unrelated", body: "Different request" }, "provider", "twilio");
    conversation = act(conversation, { type: "question.activate", questionId: "identity-question", kind: "name", requestId: "request" }, "system", "runtime");
    conversation = act(conversation, { type: "input.record", sourceId: "answer", questionId: "identity-question", body: "Sensitive answer" }, "provider", "twilio");

    const request = { ...conversation.requests[0]!, sourceIds: ["fragment-5", "fragment-3", "fragment-2", "fragment-1", "fragment-0", "fragment-4", "fragment-5", "answer"] };
    const summary = requestSourceSummary(conversation, request)!;
    expect(summary.length).toBeLessThanOrEqual(500);
    expect(summary).toMatch(/^0: .* · 1: .* · \[2 earlier messages omitted\] · 4: .* · 5: /);
    expect(summary).not.toContain("Different request");
    expect(summary).not.toContain("Sensitive answer");
    expect(summary.match(/5:/g)).toHaveLength(1);
    expect(conversation.requests[0]?.originalRequest).toBe(`0: ${"detail ".repeat(30)}`.trim());
  });
  it("keeps a prompted original request visible after an unprompted supplement", () => {
    let conversation = initial();
    conversation = act(conversation, { type: "question.activate", questionId: "general-question", kind: "general" }, "system", "runtime");
    conversation = act(conversation, { type: "input.record", sourceId: "prompted-original", questionId: "general-question",
      body: "Please move my appointment" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "prompted-original" }, "ai", "assistant");
    conversation = act(conversation, { type: "input.record", sourceId: "supplement", body: "Thursday would be best" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.supplement", requestId: "request", sourceEventId: "supplement" }, "ai", "assistant");

    expect(requestSourceSummary(conversation, conversation.requests[0])).toBe("Please move my appointment · Thursday would be best");
    expect(conversation.requests[0]?.originalRequest).toBe("Please move my appointment");
  });

  it("does not surface raw caller input as a staff message when no dedicated message was saved", () => {
    let conversation = initial();
    conversation = act(conversation, { type: "input.record", sourceId: "request-source", body: "Please take a message" }, "provider", "twilio");
    conversation = act(conversation, { type: "input.record", sourceId: "callback-message", body: '<img src=x onerror="alert(1)"> Call me after lunch.' }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "request-source",
      sourceEventIds: ["request-source", "callback-message"] }, "ai", "assistant");
    conversation = { ...conversation, requests: conversation.requests.map((request) => ({ ...request, callbackMessageSourceId: "callback-message" })) } as Conversation;

    const html = render(conversation).body;
    const request = new DOMParser().parseFromString(html, "text/html").querySelector('[data-request-id="request"]')!;
    expect(request.textContent).toContain("Caller messageNot captured");
    expect(request.textContent).toContain("Caller message sourceNot captured");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("shows the saved message meaning to staff without falling back to raw dictation", () => {
    const raw = "Um, January, sorry, I need to move my January visit to February.";
    const message = "Please move my January visit to February.";
    let conversation = initial("voice");
    conversation = act(conversation, { type: "input.record", sourceId: "request-source", body: "Please take a message." }, "provider", "twilio");
    conversation = act(conversation, { type: "input.record", sourceId: "message-source", body: raw }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "request-source", sourceEventIds: ["request-source", "message-source"], name: "Pat Example", callbackNumber: "+12025550147" }, "ai", "assistant");
    conversation = conversationSchema.parse({ ...conversation, requests: [{ ...conversation.requests[0]!, callbackMessageSourceId: "message-source", callbackMessageText: message, state: "needs_callback", callbackConfirmed: true, confirmationSourceId: "request-source" }] });
    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    const facts = document.querySelector('[data-request-id="request"] .conversation-facts')!.textContent;
    expect(facts).toContain(message); expect(facts).toContain("Pat Example"); expect(facts).toContain("(202) 555-0147"); expect(facts).toContain("message-source");
    expect(conversation.inputs.find(input => input.id === "message-source")?.body).toBe(raw);
    const legacy = structuredClone(conversation); delete legacy.requests[0]!.callbackMessageText;
    const legacyFacts = new DOMParser().parseFromString(render(legacy).body, "text/html").querySelector('[data-request-id="request"] .conversation-facts')!.textContent;
    expect(legacyFacts).toContain("Caller messageNot captured");
    expect(legacyFacts).not.toContain(raw);
  });

  it("does not project source-bound message amendments into staff request copy", () => {
    let conversation = fullInitial();
    conversation = act(conversation, { type: "input.record", sourceId: "original", body: "Please call about January." }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "original" }, "ai", "assistant");
    conversation = { ...conversation, requests: [{ ...conversation.requests[0]!, callbackMessageSourceId: "original" }] };
    const history: ConversationConsoleInput["history"][number][] = [];
    for (const [sourceEventId, body] of [["correction", "Actually, middle of February, not January."], ["addition", "<script>Call after two.</script>"]] as const) {
      conversation = act(conversation, { type: "input.record", sourceId: sourceEventId, body }, "provider", "twilio");
      const command = { type: "request.supplement" as const, requestId: "request", sourceEventId };
      history.push(historyEntry(conversation, command, "assistant", now));
      conversation = act(conversation, command, "ai", "assistant");
    }
    const html = render(conversation, { history: [history[1]!, history[0]!, history[0]!] }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const facts = document.querySelector('[data-request-id="request"] .conversation-facts')!;
    expect(facts.textContent).toContain("Caller messageNot captured");
    const updates = Array.from(facts.querySelectorAll("dt")).filter((node) => node.textContent === "Message update")
      .map((node) => node.nextElementSibling?.textContent);
    expect(updates).toEqual([]);
    expect(facts.querySelector("script")).toBeNull();

    const wrongRequest = { ...history[0]!, input: { ...history[0]!.input, command: { ...history[0]!.input.command, requestId: "other" } } } as typeof history[number];
    const wrongScope = { ...history[0]!, input: { ...history[0]!.input, scope: { ...history[0]!.input.scope, conversationId: "other" } } };
    const rejected = { ...history[0]!, receipt: { ...history[0]!.receipt, accepted: false } };
    const filtered = render(conversation, { history: [wrongRequest, wrongScope, rejected] }).body;
    expect(filtered).not.toContain("<dt>Message update</dt>");
    const unbound = { ...conversation, requests: [{ ...conversation.requests[0]!, sourceIds: ["original"] }] };
    expect(render(unbound, { history }).body).not.toContain("<dt>Message update</dt>");
  });

  it("does not render absent or dangling caller-message provenance", () => {
    let conversation = initial();
    conversation = act(conversation, { type: "input.record", sourceId: "request-source", body: "Please take a message" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "request-source" }, "ai", "assistant");
    const request = conversation.requests[0]!;
    // A stale persisted snapshot must not make the console invent caller content.
    conversation = { ...conversation, requests: [
      { ...request, id: "absent", callbackMessageSourceId: null },
      { ...request, id: "dangling", sourceIds: [...request.sourceIds, "missing-callback-message"], callbackMessageSourceId: "missing-callback-message" },
    ] } as Conversation;

    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    for (const id of ["absent", "dangling"]) {
      const facts = document.querySelector(`[data-request-id="${id}"] .conversation-facts`)?.textContent;
      expect(facts).toContain("Caller messageNot captured");
      expect(facts).toContain("Caller message sourceNot captured");
    }
  });

  it("records callback capture actions with their request and input sources", () => {
    const conversation = initial();
    const history = [
      historyEntry(conversation, { type: "request.capture_callback_message", requestId: "request-1", sourceEventId: "message-input-1" }, "assistant", "2026-09-24T17:01:00.000Z"),
      historyEntry(conversation, { type: "request.confirm_and_capture_callback", requestId: "request-1", callbackNumber: "+17025550123", sourceEventId: "confirmation-input-1" }, "runtime", "2026-09-24T17:02:00.000Z"),
    ];

    const activity = new DOMParser().parseFromString(render(conversation, { history }).body, "text/html").querySelector(".history-list")?.textContent;
    expect(activity).toContain("Caller callback message capturedrequest-1 · message-input-1");
    expect(activity).toContain("Callback request confirmed and capturedrequest-1 · +17025550123 · confirmation-input-1");
  });

  it("labels WhatsApp Sandbox separately and gates replies only on its durable inbound timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    try {
      const fresh = whatsappInitial("2026-09-23T18:00:01.000Z");
      const historyProjection = { channel: "sms" as const, availability: "available" as const, earliestRetainedAt: now,
        latestRetainedAt: now, retainedCount: 1, priorCount: 1, recent: [{ conversationId: "sms-history", createdAt: now,
          updatedAt: now, phase: "closed" as const, nextStep: "No follow-up needed", requestSummary: "SMS history must not appear" }] };
      const freshDocument = new DOMParser().parseFromString(render(fresh, { historyProjection }).body, "text/html");

      expect(freshDocument.querySelector('[data-conversation-id="conversation-1"] .transport-label')?.textContent).toBe("WhatsApp Sandbox");
      expect(freshDocument.querySelector(".conversation-panel-header .eyebrow")?.textContent).toBe("WhatsApp Sandbox conversation");
      expect(freshDocument.querySelector(".conversation-facts")?.textContent).toContain("Message transportWhatsApp Sandbox");
      expect(freshDocument.querySelector('[data-whatsapp-window-expired]')).toBeNull();
      expect(freshDocument.querySelector('textarea[name="body"]')).not.toBeNull();
      expect(freshDocument.querySelector(".caller-history")?.textContent).toContain("Transport-specific history is not available in this view.");
      expect(freshDocument.querySelector(".caller-history")?.textContent).not.toContain("SMS history must not appear");

      const aiOwned = { ...fresh, owner: "ai", staffActor: null, ownerEpoch: 0, revision: 0 } as Conversation;
      let notJoined = act(aiOwned, { type: "input.record", sourceId: "source", body: "Please call me" }, "provider", "twilio");
      notJoined = act(notJoined, { type: "request.draft", requestId: "request", sourceEventId: "source", name: "Caller", callbackNumber: "+17025550123" }, "ai", "assistant");
      notJoined = act(notJoined, { type: "question.activate", questionId: "callback-confirmation", kind: "callback_number", requestId: "request" }, "system", "runtime");
      notJoined = act(notJoined, { type: "input.record", sourceId: "confirmation", questionId: "callback-confirmation", body: "Yes" }, "provider", "twilio");
      notJoined = act(notJoined, { type: "request.confirm_callback", requestId: "request", callbackNumber: "+17025550123", sourceEventId: "confirmation" }, "system", "runtime");
      notJoined = act(notJoined, { type: "request.capture", requestId: "request" }, "ai", "assistant");
      notJoined = act(notJoined, { type: "owner.change", owner: "staff" }, "staff", "staffExample");
      notJoined = act(notJoined, { type: "sms.queue", messageId: "not-joined", body: "We received your request." }, "staff", "staffExample");
      notJoined = act(notJoined, { type: "sms.dispatch", messageId: "not-joined", dispatchAttemptId: "not-joined-attempt", expectedSuppressionRevision: notJoined.suppressionRevision }, "system", "dispatcher");
      notJoined = act(notJoined, { type: "sms.receipt", messageId: "not-joined", state: "undelivered", providerId: "SM-not-joined", failureReason: "sandbox_not_joined" }, "provider", "twilio");
      const notJoinedDocument = new DOMParser().parseFromString(render(notJoined).body, "text/html");
      expect(notJoinedDocument.querySelector("[data-whatsapp-sandbox-not-joined]")?.textContent).toContain("Ask the tester to rejoin");
      expect(notJoinedDocument.querySelector("[data-whatsapp-sandbox-not-joined]")?.textContent).toContain("Do not send an SMS fallback");
      const claimedNotJoined = act(notJoined, { type: "request.claim", requestId: "request" }, "staff", "staffExample");
      const resolvedNotJoined = act(claimedNotJoined, { type: "request.complete", requestId: "request", outcome: "Resolved without a reply." }, "staff", "staffExample");
      const resolvedNotJoinedDocument = new DOMParser().parseFromString(render(resolvedNotJoined).body, "text/html");
      expect(resolvedNotJoinedDocument.querySelector("[data-whatsapp-sandbox-not-joined]")?.textContent).toContain("The request is resolved; no reply is pending.");

      let noRequestNotJoined = act(aiOwned, { type: "sms.queue", messageId: "greeting", body: "Welcome." }, "ai", "assistant");
      noRequestNotJoined = act(noRequestNotJoined, { type: "sms.dispatch", messageId: "greeting", dispatchAttemptId: "greeting-attempt", expectedSuppressionRevision: noRequestNotJoined.suppressionRevision }, "system", "dispatcher");
      noRequestNotJoined = act(noRequestNotJoined, { type: "sms.receipt", messageId: "greeting", state: "undelivered", providerId: "SM-greeting", failureReason: "sandbox_not_joined" }, "provider", "twilio");
      const noRequestDocument = new DOMParser().parseFromString(render(noRequestNotJoined).body, "text/html");
      expect(noRequestDocument.querySelector("[data-whatsapp-sandbox-not-joined]")?.textContent).toContain("if follow-up is still needed");
      expect(noRequestDocument.querySelector("[data-whatsapp-sandbox-not-joined]")?.textContent).not.toContain("The request is resolved");

      const activity = [
        historyEntry(fresh, { type: "sms.inbound_activity" }, "twilio", "2026-09-24T17:00:01.000Z"),
        historyEntry(fresh, { type: "sms.queue", messageId: "queued", body: "Reply" }, "staffExample", "2026-09-24T17:00:02.000Z"),
        historyEntry(fresh, { type: "sms.receipt", messageId: "queued", state: "failed" }, "twilio", "2026-09-24T17:00:03.000Z"),
        historyEntry(fresh, { type: "sms.unsupported_media", sourceId: "media", kind: "media", mediaCount: 1 }, "twilio", "2026-09-24T17:00:04.000Z"),
        historyEntry(fresh, { type: "sms.unsupported_media", sourceId: "non-text", kind: "non_text", mediaCount: 0 }, "twilio", "2026-09-24T17:00:05.000Z"),
      ];
      const activityDocument = new DOMParser().parseFromString(render(fresh, { history: activity }).body, "text/html");
      expect(activityDocument.querySelector(".history-list")?.textContent).toContain("WhatsApp Sandbox inbound activity recorded");
      expect(activityDocument.querySelector(".history-list")?.textContent).toContain("WhatsApp Sandbox queued");
      expect(activityDocument.querySelector(".history-list")?.textContent).toContain("WhatsApp Sandbox delivery receipt");
      expect(activityDocument.querySelector(".history-list")?.textContent).toContain("WhatsApp Sandbox attachment received without text");
      expect(activityDocument.querySelector(".history-list")?.textContent).toContain("WhatsApp Sandbox non-text message received");
      expect(activityDocument.querySelector(".history-list")?.textContent).not.toContain("media playback");

      const suppressed = { ...fresh, suppressed: true } as Conversation;
      const suppressedDocument = new DOMParser().parseFromString(render(suppressed).body, "text/html");
      expect(suppressedDocument.querySelector(".send-disabled")?.textContent).toBe("WhatsApp Sandbox replies are unavailable because this contact is suppressed.");
      expect(suppressedDocument.querySelector(".send-disabled")?.textContent).not.toContain("SMS replies");

      const expired = { ...fresh, lastInboundAt: "2026-09-23T17:00:00.000Z", updatedAt: now } as Conversation;
      const expiredDocument = new DOMParser().parseFromString(render(expired).body, "text/html");
      expect(expiredDocument.querySelector('[data-whatsapp-window-expired]')?.textContent).toContain("24-hour reply window has expired");
      expect(expiredDocument.querySelector('[data-whatsapp-window-expired]')?.textContent).toContain("Ask the tester to send a new WhatsApp message");
      expect(expiredDocument.querySelector('textarea[name="body"]')).toBeNull();

      const missingInbound = whatsappInitial(null);
      const missingDocument = new DOMParser().parseFromString(render(missingInbound).body, "text/html");
      expect(missingDocument.querySelector('[data-whatsapp-window-expired]')?.textContent).toContain("No recorded WhatsApp Sandbox inbound message");
      expect(missingDocument.querySelector('textarea[name="body"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers delivery review on an expired AI thread without reopening its composer", () => {
    let c = act(initial(), { type: "sms.queue", messageId: "held", body: "Reply" }, "ai", "agent");
    c = act(c, { type: "sms.dispatch", messageId: "held", dispatchAttemptId: "attempt", expectedSuppressionRevision: c.suppressionRevision }, "system", "dispatcher");
    c = act(c, { type: "sms.receipt", messageId: "held", state: "unknown" }, "provider", "twilio");
    c = act(c, { type: "conversation.disconnect" }, "system", "expiry");
    expect(render(c).body).toContain("Review delivery");
    c = act(c, { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    const body = render(c).body;
    expect(body).toContain("Release send hold");
    expect(body).not.toContain('name="type" value="sms.queue"');
    expect(body).not.toContain("Return to AI</button>");
  });
  it("keeps an unresolved callback visible after hangup and labels the next step", () => {
    const conversation = initial("voice");
    conversation.phase = "disconnected";
    conversation.requests.push({ id: "request", revision: 1, category: "scheduling", originalRequest: "Please call me", name: "Caller", callbackNumber: "+17025550123", callbackConfirmed: true, confirmationSourceId: "turn", owner: null, outcome: null, sourceIds: ["turn"], proposalRevision: 1, state: "needs_callback" });
    const html = render(conversation).body;
    const table = new DOMParser().parseFromString(html, "text/html").querySelector("[data-console-queue]")!;
    expect(table.textContent).toContain("Needs callback");
    expect(table.textContent).toContain("Next step");
    expect(table.textContent).toContain("Call back");
    expect(table.querySelector(".state-badge")?.textContent).not.toBe("Disconnected");
  });

  it("renders server-projected metric filters with selected, page, and panel URL continuity", () => {
    const conversation = initial("voice");
    const html = render(conversation, { page: 3, total: 12, metricCounts, filter: "needs_follow_up" }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const cards = Array.from(document.querySelectorAll<HTMLAnchorElement>("[data-console-filter]"));

    expect(cards).toHaveLength(6);
    expect(cards.map((card) => [card.dataset.consoleFilter, card.querySelector("strong")?.textContent, card.querySelector("span")?.textContent])).toEqual([
      ["total", "12", "Total calls"],
      ["active_now", "3", "Active now"],
      ["needs_follow_up", "5", "Needs follow-up"],
      ["connected_to_staff", "4", "Connected to staff"],
      ["resolved_by_human", "4", "Resolved by human"],
      ["resolved_by_ai", "2", "Resolved by AI"],
    ]);
    expect(document.querySelector('[data-console-filter="needs_follow_up"]')?.getAttribute("aria-current")).toBe("page");
    expect(document.querySelector('[data-console-filter="total"]')?.getAttribute("href")).toBe("/staff?channel=voice&filter=total&selected=conversation-1");
    expect(document.querySelector('[data-conversation-id="conversation-1"]')?.getAttribute("href")).toBe("/staff?channel=voice&filter=needs_follow_up&selected=conversation-1&page=3");
    expect(document.querySelector(".conversation-panel-close")?.getAttribute("href")).toBe("/staff?channel=voice&filter=needs_follow_up&page=3");
    expect(document.querySelector(".conversation-pagination a")?.getAttribute("href")).toBe("/staff?channel=voice&filter=needs_follow_up&page=2");
    expect(document.querySelector(".metric-context")?.textContent).toContain("accepted handoffs");
    expect(document.querySelector(".metric-context")?.textContent).toContain("separate from request resolution");
  });

  it("renders independent registered tasks and caller-stated status from full-mode request proposals", () => {
    let conversation = fullInitial();
    conversation = act(conversation, { type: "input.record", sourceId: "source-appointment", body: "When is my next appointment?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-appointment", sourceEventId: "source-appointment",
      fullProposal: { capability: "appointment_details", patientStatus: "established", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable" } }, "ai", "assistant");
    conversation = act(conversation, { type: "input.record", sourceId: "source-balance", body: "What is my balance?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-balance", sourceEventId: "source-balance",
      fullProposal: { capability: "billing_balance", patientStatus: "new", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable" } }, "ai", "assistant");

    const html = render(conversation, { metricCounts, filter: "active_now" }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const appointment = document.querySelector('[data-request-id="request-appointment"]')!;
    const balance = document.querySelector('[data-request-id="request-balance"]')!;

    expect(document.querySelectorAll("[data-console-filter]")).toHaveLength(6);
    expect(document.querySelector('[data-console-filter="active_now"]')?.getAttribute("aria-current")).toBe("page");
    expect(Array.from(document.querySelectorAll(".panel-section > .eyebrow")).map((node) => node.textContent)).toContain("Request agenda");
    expect(document.querySelectorAll("[data-full-request-plan]")).toHaveLength(2);
    expect(appointment.querySelector("[data-full-request-plan]")?.textContent).toContain("Registered AI task");
    expect(appointment.textContent).toContain("Appointment details");
    expect(appointment.textContent).toContain("Caller-stated patient statusEstablished");
    expect(appointment.textContent).not.toContain("Billing balance");
    expect(appointment.textContent).not.toContain("Caller-stated patient statusNew");
    expect(balance.textContent).toContain("Billing balance");
    expect(balance.textContent).toContain("Caller-stated patient statusNew");
    expect(balance.textContent).not.toContain("Appointment details");
    expect(appointment.querySelector(".section-row strong")?.textContent).toBe("Request open");
    expect(balance.querySelector(".section-row strong")?.textContent).toBe("Request open");
    expect(`${appointment.textContent}${balance.textContent}`).not.toMatch(/\b(?:DOB|ZIP|verified|authenticated|resolved)\b/i);
  });

  it("renders only injected caller-provided identity in the selected full-mode detail", () => {
    const conversation = fullInitial();
    const html = render(conversation, { callerProvidedIdentity: { dateOfBirth: `<script>alert("dob")</script>`, zip: `89<101`, status: "historical" } }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const detail = document.querySelector("[data-protected-identity-detail]")!;

    expect(detail.textContent).toContain('Caller-provided DOB<script>alert("dob")</script>');
    expect(detail.textContent).toContain("Caller-provided ZIP89<101");
    expect(detail.textContent).toContain("Demo verificationPassed");
    expect(detail.textContent).toContain("does not grant access");
    expect(document.querySelector("[data-console-queue]")?.textContent).not.toContain("89<101");
    const activity = Array.from(document.querySelectorAll(".panel-section")).find((section) => section.querySelector("h3")?.textContent === "Activity");
    expect(activity?.textContent).not.toContain("89<101");
    expect(activity?.textContent).not.toContain('alert("dob")');
    expect(html).not.toContain('<script>alert("dob")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;dob&quot;)&lt;/script&gt;");

    const unavailable = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(Array.from(unavailable.querySelectorAll("[data-protected-identity-detail] dd"), (node) => node.textContent)).toEqual(["Not captured", "Not captured", "Not captured"]);

    const receptionist = render(initial(), { callerProvidedIdentity: { dateOfBirth: "1950-03-04", zip: "89101", status: "active" } }).body;
    expect(receptionist).not.toContain("data-protected-identity-detail");
    expect(receptionist).not.toContain("1950-03-04");
    expect(receptionist).not.toContain("89101");
  });

  it("uses an explicit staff completion outcome to resolve a full-mode callback", () => {
    let conversation = fullInitial();
    conversation = act(conversation, { type: "input.record", sourceId: "source-appointment", body: "When is my next appointment?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-appointment", sourceEventId: "source-appointment", name: "Caller",
      callbackNumber: "+17025550123", fullProposal: { capability: "appointment_details", patientStatus: "established", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable" } }, "ai", "assistant");
    conversation = act(conversation, { type: "question.activate", questionId: "question-callback", kind: "callback_number", requestId: "request-appointment" }, "system", "runtime");
    conversation = act(conversation, { type: "input.record", sourceId: "source-confirmation", body: "Yes", questionId: "question-callback" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.confirm_callback", requestId: "request-appointment", callbackNumber: "+17025550123", sourceEventId: "source-confirmation" }, "system", "runtime");
    conversation = act(conversation, { type: "request.capture", requestId: "request-appointment" }, "ai", "assistant");
    conversation = act(conversation, { type: "request.claim", requestId: "request-appointment" }, "staff", "staffExample");
    conversation = act(conversation, { type: "request.complete", requestId: "request-appointment", outcome: "Caller reached for staff follow-up." }, "staff", "staffExample");
    conversation = act(conversation, { type: "conversation.disconnect" }, "system", "runtime");

    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    const request = document.querySelector('[data-request-id="request-appointment"]')!;
    expect(document.querySelector(".state-badge")?.textContent).toBe("Resolved by human");
    expect(document.querySelector(".owner-cell")?.textContent).toBe("No follow-up needed");
    expect(request.querySelector(".section-row strong")?.textContent).toBe("Staff follow-up completed");
    expect(request.textContent).not.toMatch(/\bresolved\b/i);
  });

  it("renders exact typed proof for independently AI-resolved requests without inventing result values", () => {
    let conversation = fullInitial();
    conversation = act(conversation, { type: "input.record", sourceId: "source-read", body: "When is my next appointment?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-read", sourceEventId: "source-read", fullProposal: {
      capability: "appointment_details", patientStatus: "established", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable",
    } }, "ai", "assistant");
    conversation = act(conversation, { type: "request.resolve_ai", requestId: "request-read", requestRevision: conversation.requests[0]!.revision,
      sourceEventId: "source-read", result: { kind: "read", receiptId: "read-receipt-1", readKind: "appointment_details",
        receiptHash: `sha256:${"a".repeat(64)}`, resultHash: `sha256:${"b".repeat(64)}`, sourceVersion: 7 } }, "system", "publisher");

    conversation = act(conversation, { type: "input.record", sourceId: "source-action", body: "Please schedule an office visit." }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-action", sourceEventId: "source-action", fullProposal: {
      capability: "appointment_schedule", patientStatus: "established", schedulingKind: "office_visit", knowledgeTopic: "not_applicable",
    } }, "ai", "assistant");
    conversation = act(conversation, { type: "request.resolve_ai", requestId: "request-action", requestRevision: conversation.requests[1]!.revision,
      sourceEventId: "source-action", result: { kind: "action", receiptId: "action-receipt-1", operation: "schedule",
        resultHash: `sha256:${"c".repeat(64)}`, readbackHash: `sha256:${"d".repeat(64)}`, resultingVersion: 3 } }, "system", "publisher");

    conversation = act(conversation, { type: "input.record", sourceId: "source-knowledge", body: "What is the office address?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-knowledge", sourceEventId: "source-knowledge", fullProposal: {
      capability: "office_address", patientStatus: "unknown", schedulingKind: "not_applicable", knowledgeTopic: "address",
    } }, "ai", "assistant");
    conversation = act(conversation, { type: "request.resolve_ai", requestId: "request-knowledge", requestRevision: conversation.requests[2]!.revision,
      sourceEventId: "source-knowledge", result: { kind: "knowledge", topic: "address", packId: "practice-pack", packVersion: "pack-v3",
        factId: "practice-address", factVersion: "fact-v2", sourceId: "approved-practice", sourceVersion: "source-v4",
        contentHash: `sha256:${"e".repeat(64)}` } }, "system", "publisher");

    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(document.querySelector(".state-badge")?.textContent).toBe("Resolved by AI");
    expect(document.querySelector(".owner-cell")?.textContent).toBe("No follow-up needed");
    const requests = Array.from(document.querySelectorAll<HTMLElement>("[data-request-id]"));
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.querySelector(".section-row strong")?.textContent)).toEqual(["Resolved by AI", "Resolved by AI", "Resolved by AI"]);
    expect(document.querySelectorAll("[data-ai-resolution-proof]")).toHaveLength(3);
    expect(document.querySelector('[data-proof-kind="read"]')?.textContent).toContain("read-receipt-1");
    expect(document.querySelector('[data-proof-kind="read"]')?.textContent).toContain(`sha256:${"a".repeat(64)}`);
    expect(document.querySelector('[data-proof-kind="action"]')?.textContent).toContain("action-receipt-1");
    expect(document.querySelector('[data-proof-kind="action"]')?.textContent).toContain(`sha256:${"d".repeat(64)}`);
    expect(document.querySelector('[data-proof-kind="knowledge"]')?.textContent).toContain("practice-pack");
    expect(document.querySelector('[data-proof-kind="knowledge"]')?.textContent).toContain("source-v4");
    expect(requests.flatMap((request) => Array.from(request.querySelectorAll("dt"), (node) => node.textContent))).not.toContain("Outcome");
    expect(document.querySelector(".conversation-panel")?.textContent).not.toMatch(/\b(?:appointment date|balance due|verified patient)\b/i);

    const speechBlocked = { ...conversation, speechReviews: [{
      scope: scopeOf(conversation), id: "speech-review-ai-resolution", version: "monitor-v1", responseId: "response-ai-resolution",
      outputItemId: "output-ai-resolution", voiceEpoch: conversation.voiceEpoch, authorityRevision: conversation.revision,
      transcript: "Your request is complete.", verdict: "confirmed" as const, reasons: ["unsupported_appointment" as const], claims: [], correction: "generated" as const,
    }] } as Conversation;
    const blockedDocument = new DOMParser().parseFromString(render(speechBlocked).body, "text/html");
    expect(blockedDocument.querySelector(".state-badge")?.textContent).toBe("Speech review needed");
    expect(blockedDocument.querySelector(".owner-cell")?.textContent).toBe("Review generated speech");
  });

  it("fails closed when a persisted AI-resolved request has no typed proof", () => {
    let conversation = fullInitial();
    conversation = act(conversation, { type: "input.record", sourceId: "source-read", body: "When is my next appointment?" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-read", sourceEventId: "source-read", fullProposal: {
      capability: "appointment_details", patientStatus: "established", schedulingKind: "not_applicable", knowledgeTopic: "not_applicable",
    } }, "ai", "assistant");
    conversation = { ...conversation, requests: conversation.requests.map((request) => ({ ...request, state: "ai_resolved" as const, aiResolution: null })) };

    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(document.querySelector(".state-badge")?.textContent).toBe("Resolution proof unavailable");
    expect(document.querySelector(".owner-cell")?.textContent).toBe("Review missing resolution proof");
    expect(document.querySelector('[data-request-id="request-read"] .section-row strong')?.textContent).toBe("Resolution proof unavailable");
    expect(document.querySelector("[data-ai-resolution-proof]")).toBeNull();
    expect(document.querySelector("[data-ai-resolution-proof-missing]")?.textContent).toContain("cannot be treated as resolved");
  });

  it("labels an unconfirmed receptionist draft as a received request", () => {
    let conversation = initial("voice");
    conversation = act(conversation, { type: "input.record", sourceId: "source-callback", body: "Please call me back." }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request-callback", sourceEventId: "source-callback" }, "ai", "assistant");
    const document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    const request = document.querySelector('[data-request-id="request-callback"]')!;

    expect(Array.from(document.querySelectorAll(".panel-section > .eyebrow")).map((node) => node.textContent)).toContain("Callback work");
    expect(request.querySelector(".section-row strong")?.textContent).toBe("Received request");
    expect(document.querySelector("[data-full-request-plan]")).toBeNull();
    expect(document.body.textContent).not.toContain("Registered AI task");
    expect(document.body.textContent).not.toContain("Caller-stated patient status");
  });

  it("does not offer a phantom next page when page two contains only result 26", () => {
    const document = new DOMParser().parseFromString(render(initial("voice"), { page: 2, total: 26 }).body, "text/html");
    const pagination = document.querySelector(".conversation-pagination")!;

    expect(pagination.textContent).toContain("Page 2 · 26 total");
    expect(pagination.textContent).not.toContain("Next");
    expect(pagination.querySelectorAll("a")).toHaveLength(1);
    expect(pagination.querySelector("a")?.textContent).toContain("Previous");
  });

  it("renders explicit channel history coverage and at most five phone-number matches in clinic time", () => {
    const conversation = initial("voice");
    const recent = Array.from({ length: 6 }, (_, index) => ({
      conversationId: `prior-${index + 1}`,
      createdAt: `2026-03-0${index + 1}T18:00:00.000Z`,
      updatedAt: `2026-03-0${index + 1}T18:05:00.000Z`,
      phase: "disconnected" as const,
      nextStep: "No follow-up needed",
      requestSummary: index === 0 ? `<img src=x onerror=alert(1)>` : `Prior request ${index + 1}`,
    }));
    const html = render(conversation, { page: 2, filter: "resolved_by_human", historyProjection: {
      channel: "voice", availability: "available", earliestRetainedAt: "2026-03-08T07:30:00.000Z", latestRetainedAt: now,
      retainedCount: 7, priorCount: 6, recent,
    } }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const history = document.querySelector(".caller-history")!;

    expect(document.querySelector("[data-console-queue] [data-history-coverage]")?.textContent).toBe("History available since Mar 7, 2026");
    expect(history.textContent).toContain("Recent calls from this number");
    expect(history.textContent).toContain("Showing 5 of 6 prior calls.");
    expect(history.textContent).toContain("Matched by caller number only, not verified patient history.");
    expect(history.querySelectorAll(".recent-conversations li")).toHaveLength(5);
    expect(history.querySelector("a")?.getAttribute("href")).toBe("/staff?channel=voice&filter=resolved_by_human&selected=prior-1&page=2");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");

    expect(render(conversation, { historyProjection: { channel: "voice", availability: "available", earliestRetainedAt: null,
      latestRetainedAt: null, retainedCount: 0, priorCount: 0, recent: [] } }).body).toContain("No call history yet");
    const smsHistory = new DOMParser().parseFromString(render(initial("sms"), { historyProjection: { channel: "sms", availability: "available", earliestRetainedAt: now,
      latestRetainedAt: now, retainedCount: 1, priorCount: 0, recent: [] } }).body, "text/html");
    expect(smsHistory.querySelector("[data-history-coverage]")?.textContent).toBe("SMS history available since Sep 24, 2026");
    expect(render(conversation, { historyProjection: { channel: "voice", availability: "unavailable", earliestRetainedAt: null,
      latestRetainedAt: null, retainedCount: 0, priorCount: 0, recent: [] } }).body).toContain("History is temporarily unavailable.");
  });

  it("shows generated speech reviews as evidence and requires an outcome for unresolved staff review", () => {
    const base = initial("voice");
    const review = {
      scope: scopeOf(base),
      id: "speech-review-1", version: "monitor-v1", responseId: "response-1", outputItemId: "output-1", voiceEpoch: 1, authorityRevision: 4,
      transcript: `<script>alert("heard")</script> Your appointment is changed.`, verdict: "confirmed" as const,
      reasons: ["unsupported_appointment" as const], claims: [], correction: "generated" as const,
    };
    const conversation = { ...base, speechReviews: [review] } as Conversation;
    const html = render(conversation).body;

    expect(html).toContain("Generated-response checks");
    expect(html).toContain("Automated review found an unsupported claim");
    expect(html).toContain("Correction generated; hearing not established");
    expect(html).toContain("Generated text is not proof that the caller heard it.");
    expect(html).toContain("Appointment-change claim lacked support");
    expect(html).not.toContain('<script>alert("heard")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;heard&quot;)&lt;/script&gt;");
    expect(html).not.toContain("Confirmed incident");
    expect(html).not.toContain("Suspected incident");
    expect(html).toContain('name="type" value="monitor.resolve"');
    expect(html).toContain('name="reviewId" value="speech-review-1"');
    expect(html).toContain('name="outcome"');
    expect(html).toContain('data-draft-key="monitor:speech-review-1:outcome"');

    const resolved = { ...conversation, speechReviews: [{ ...review, correction: "staff_resolved" as const }] } as Conversation;
    expect(render(resolved).body).not.toContain('name="type" value="monitor.resolve"');
    const history = [historyEntry(resolved, { type: "monitor.resolve", reviewId: review.id, outcome: "Staff reviewed the generated response." }, "staffExample", now)];
    expect(render(resolved, { history }).body).toContain("speech-review-1 · Staff reviewed the generated response.");
  });

  it("shows read-only post-call evaluations without treating unassessable or completed as resolved", () => {
    const base = initial("voice");
    const pending: Extract<Conversation["evaluations"][number], { state: "pending" }> = {
      id: "evaluation-pending", version: "eval-r1", scope: scopeOf(base), createdFromRevision: 3,
      state: "pending", verdict: null, reasons: [], checks: null, unresolvedRequestCount: null, partialDraftCount: null,
    };
    const failed: Extract<Conversation["evaluations"][number], { state: "failed" }> = {
      id: "evaluation-failed", version: "eval-r1", scope: scopeOf(base), createdFromRevision: 4,
      state: "failed", verdict: null, reasons: ["history_unavailable"], checks: null,
      unresolvedRequestCount: null, partialDraftCount: null, failureCode: "history_read_failed",
    };
    const completed: Extract<Conversation["evaluations"][number], { state: "completed" }> = {
      id: `evaluation-<script>alert("review")</script>`, version: "eval-r2", scope: scopeOf(base), createdFromRevision: 5,
      state: "completed", verdict: "unassessable", reasons: ["no_heard_audio_artifact", "stub_followup_transcript_unavailable"],
      checks: { sourcePreservation: "passed", callbackBeforeCapture: "not_applicable", emergencyCancelsStub: "not_applicable",
        noRealStubConnection: "passed", stubFollowupSpeech: "unassessable", monitor: "unassessable", partialRequests: "passed", voiceAudioQuality: "unassessable" },
      unresolvedRequestCount: 1, partialDraftCount: 0,
    };
    const conversation = { ...base, phase: "disconnected" as const, evaluations: [pending, failed, completed],
      requests: [{ id: "callback-1", revision: 2, category: "scheduling" as const, originalRequest: "Please call me back", name: "Caller",
        callbackNumber: "+17025550123", callbackConfirmed: true, confirmationSourceId: "source-1", owner: null, outcome: null,
        sourceIds: ["source-1"], proposalRevision: 1, state: "needs_callback" as const }] } satisfies Conversation;
    const command = envelope(conversation, { type: "evaluation.record", result: completed }, "system", "evaluation-worker", "evaluation-event");
    const history = [{ input: command, receipt: { eventId: command.eventId, accepted: true, error: null, state: conversation,
      occurredAt: "2026-09-24T18:30:00.000Z" } },
      historyEntry(conversation, { type: "evaluation.schedule", version: "eval-r2" }, "evaluation-scheduler", "2026-09-24T18:31:00.000Z"),
    ] satisfies ConversationConsoleInput["history"];
    const html = render(conversation, { history }).body;
    const document = new DOMParser().parseFromString(html, "text/html");
    const evaluation = document.querySelector(".evaluation-section")!;

    expect(evaluation.querySelector("h3")?.textContent).toBe("Current call quality review");
    expect(evaluation.querySelectorAll(".evaluation-record")).toHaveLength(3);
    expect(evaluation.querySelector(".evaluation-record")?.textContent).toContain("Latest review");
    expect(evaluation.querySelectorAll(".evaluation-record")[1]?.textContent).toContain("Earlier review");
    expect(evaluation.querySelector(".evaluation-record")?.textContent).toContain("eval-r2");
    expect(evaluation.querySelectorAll(".evaluation-record")[1]?.textContent).toContain("eval-r1");
    expect(evaluation.textContent).toContain("Quality review completed");
    expect(evaluation.textContent).toContain("Quality review failed");
    expect(evaluation.textContent).toContain("Quality review pending");
    expect(evaluation.textContent).toContain("Overall verdict: Unassessable");
    expect(evaluation.querySelector(".evaluation-state")?.textContent).toBe("Unassessable");
    expect(evaluation.querySelector(".evaluation-state")?.classList.contains("attention")).toBe(true);
    expect(evaluation.querySelector(".evaluation-state")?.classList.contains("passed")).toBe(false);
    expect(evaluation.textContent).toContain("Voice audio quality");
    expect(evaluation.textContent).toContain("Stub follow-up in model transcript");
    expect(evaluation.textContent).toContain("Stub follow-up model output is unavailable");
    expect(evaluation.textContent).toContain("No heard-audio artifact is available");
    expect(evaluation.textContent).toContain("History Read Failed");
    expect(evaluation.textContent).toContain("Review completion does not resolve the conversation or any callback request.");
    expect(document.querySelector("[data-console-queue]")?.textContent).toContain("Needs callback");
    expect(html).not.toContain('<script>alert("review")</script>');
    expect(html).toContain("evaluation-&lt;script&gt;alert(&quot;review&quot;)&lt;/script&gt;");
    expect(html).not.toContain('name="type" value="evaluation.record"');
    expect(html).toContain("Post-call quality evaluation recorded");
    expect(html).toContain("Post-call quality review eval-r2 scheduled");
    expect(html).toContain("Quality review completed · Overall verdict: Unassessable");
    expect(html).toContain("Source preservation: Passed");
    expect(html).toContain("Voice audio quality: Unassessable");
    expect(html).toContain("evaluation-worker");
    expect(html).toContain('datetime="2026-09-24T18:30:00.000Z"');
  });

  it("escapes caller text, identifiers, actors, tokens, and generated URL attributes", () => {
    const base = initial("sms", `conversation\"><script>alert(1)</script>`);
    const conversation = { ...base, revision: 2,
      inputs: [{ id: "source", body: `<img src=x onerror=alert(1)> & \"quoted\"`, sequence: 1 }],
      requests: [{ id: "request", revision: 1, category: null, originalRequest: `<svg onload=alert(2)>`, name: `Pat \"onclick=alert(3)`, callbackNumber: "+17025550123", callbackConfirmed: false,
        confirmationSourceId: null, owner: null, outcome: null, sourceIds: ["source"], proposalRevision: 2, state: "draft" }] } as unknown as Conversation;
    const result = render(conversation, { actor: `<img src=x>`, csrfToken: `\"><script>csrf()</script>`, page: 2 });

    expect(result.body).not.toContain("<script>");
    expect(result.body).not.toContain("<img");
    expect(result.body).not.toContain("<svg");
    expect(result.body).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
    expect(result.body).toContain("selected=conversation%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E&amp;page=2");
    expect(result.body).toContain("action=\"/staff/conversations/conversation%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E/command\"");
    expect(result.body).toContain("value=\"&quot;&gt;&lt;script&gt;csrf()&lt;/script&gt;\"");
    expect(result.body).toContain("source · sequence 1");
    expect(result.body).toContain("Proposal revision");
  });

  it("shows ownership controls and the SMS reply composer only to the current staff owner", () => {
    const aiOwned = initial();
    const aiHtml = render(aiOwned).body;
    expect(aiHtml).toContain(">Take over<");
    expect(aiHtml).not.toContain("name=\"body\"");
    expect(aiHtml).not.toContain(">Return to AI<");

    const staffOwned = act(aiOwned, { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    const ownerHtml = render(staffOwned).body;
    expect(ownerHtml).toContain(">Return to AI<");
    expect(ownerHtml).toContain("name=\"body\"");
    expect(ownerHtml).toContain(">Queue reply<");
    for (const name of ["csrf", "eventId", "revision", "ownerEpoch", "type", "messageId"]) expect(ownerHtml).toContain(`name=\"${name}\"`);
    expect(ownerHtml).not.toContain("name=\"actor\"");
    expect(ownerHtml).not.toContain("name=\"scope\"");
    const eventIds = [...ownerHtml.matchAll(/name="eventId" value="([0-9a-f-]+)"/g)].map((match) => match[1]);
    expect(eventIds.length).toBeGreaterThan(1);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    for (const eventId of eventIds) expect(eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const otherStaffHtml = render(staffOwned, { actor: "other-staff" }).body;
    expect(otherStaffHtml).not.toContain(">Return to AI<");
    expect(otherStaffHtml).not.toContain(">Take over<");
    expect(otherStaffHtml).not.toContain("name=\"body\"");
    expect(otherStaffHtml).toContain("Only staffExample can return this conversation to AI or send replies.");

    const voiceOwned = act(initial("voice"), { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    expect(render(voiceOwned).body).not.toContain(">Queue reply<");
  });

  it("shows unknown delivery as a send hold, not a resolution, and gates release to the current owner", () => {
    let conversation = act(initial(), { type: "sms.queue", messageId: "message-1", body: "We received your request." }, "ai", "assistant");
    conversation = act(conversation, { type: "sms.dispatch", messageId: "message-1", dispatchAttemptId: "attempt-1", expectedSuppressionRevision: 0 }, "system", "dispatcher");
    conversation = act(conversation, { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    conversation = act(conversation, { type: "sms.receipt", messageId: "message-1", state: "unknown" }, "system", "dispatcher");

    const held = render(conversation).body;
    expect(held).toContain("Delivery unknown · send held");
    expect(new DOMParser().parseFromString(held, "text/html").querySelector(".state-badge")?.textContent).toBe("Delivery review needed");
    expect(held).toContain("New sends stay held");
    expect(held).toContain("name=\"note\"");
    expect(held).toContain("name=\"messageId\" value=\"message-1\"");
    expect(held).toContain("name=\"type\" value=\"sms.release_hold\"");
    expect(held).not.toContain("Resolved");

    const notOwner = render(conversation, { actor: "other" }).body;
    expect(notOwner).toContain("Delivery unknown · send held");
    expect(notOwner).not.toContain(">Release send hold<");

    conversation = act(conversation, { type: "sms.release_hold", messageId: "message-1", note: "Provider readback unavailable; continue after review." }, "staff", "staffExample");
    const released = render(conversation).body;
    expect(released).toContain("Delivery unknown · hold released");
    expect(released).not.toContain(">Release send hold<");
  });

  it("surfaces an earlier failed SMS delivery while work remains open without poisoning terminal resolution", () => {
    let conversation = act(initial(), { type: "input.record", sourceId: "source", body: "Please call me" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.draft", requestId: "request", sourceEventId: "source", name: "Caller", callbackNumber: "+17025550123" }, "ai", "assistant");
    conversation = act(conversation, { type: "sms.queue", messageId: "failed-reply", body: "We will call you." }, "ai", "assistant");
    conversation = act(conversation, { type: "sms.dispatch", messageId: "failed-reply", dispatchAttemptId: "failed-attempt", expectedSuppressionRevision: conversation.suppressionRevision }, "system", "dispatcher");
    conversation = act(conversation, { type: "sms.receipt", messageId: "failed-reply", state: "failed" }, "provider", "twilio");
    conversation = act(conversation, { type: "sms.queue", messageId: "delivered-reply", body: "Please expect our call." }, "ai", "assistant");
    conversation = act(conversation, { type: "sms.dispatch", messageId: "delivered-reply", dispatchAttemptId: "delivered-attempt", expectedSuppressionRevision: conversation.suppressionRevision }, "system", "dispatcher");
    conversation = act(conversation, { type: "sms.receipt", messageId: "delivered-reply", state: "delivered", providerId: "SM-delivered" }, "provider", "twilio");

    let document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    const row = document.querySelector('[data-conversation-id="conversation-1"]')!;
    expect(row.querySelector(".state-badge")?.textContent).toBe("Delivery failed");
    expect(row.querySelector(".owner-cell")?.textContent).toBe("Review failed message delivery");
    expect(row.querySelector(".delivery-cell")?.textContent).toBe("Delivery failed · review message");
    expect(row.textContent).not.toContain("Incomplete message");

    conversation = act(conversation, { type: "question.activate", questionId: "question", kind: "callback_number", requestId: "request" }, "system", "runtime");
    conversation = act(conversation, { type: "input.record", sourceId: "answer", questionId: "question", body: "Yes" }, "provider", "twilio");
    conversation = act(conversation, { type: "request.confirm_callback", requestId: "request", callbackNumber: "+17025550123", sourceEventId: "answer" }, "system", "runtime");
    conversation = act(conversation, { type: "request.capture", requestId: "request" }, "ai", "assistant");
    conversation = act(conversation, { type: "request.claim", requestId: "request" }, "staff", "staffExample");
    conversation = act(conversation, { type: "request.complete", requestId: "request", outcome: "Reached caller and confirmed next step." }, "staff", "staffExample");

    document = new DOMParser().parseFromString(render(conversation).body, "text/html");
    expect(document.querySelector(".state-badge")?.textContent).toBe("Resolved by human");
    expect(document.querySelector(".owner-cell")?.textContent).toBe("No follow-up needed");
    expect(document.querySelector(".delivery-cell")?.textContent).toBe("Delivered");
  });

  it("preserves every note and history entry with timestamp, actor, and acceptance result", () => {
    const conversation = initial();
    const history = [
      historyEntry(conversation, { type: "staff.note", note: "First note stays visible." }, "staffExample", "2026-09-24T17:01:00.000Z"),
      historyEntry(conversation, { type: "staff.note", note: "Second note is appended, not substituted." }, "maria", "2026-09-24T17:02:00.000Z"),
      historyEntry(conversation, { type: "staff.note", note: "Rejected note remains activity only." }, "maria", "2026-09-24T17:02:30.000Z", false),
      historyEntry(conversation, { type: "owner.change", owner: "staff" }, "maria", "2026-09-24T17:03:00.000Z", false),
    ];
    const html = render(conversation, { history }).body;

    expect(html.match(/First note stays visible\./g)).toHaveLength(2);
    expect(html.match(/Second note is appended, not substituted\./g)).toHaveLength(2);
    expect(html.match(/Rejected note remains activity only\./g)).toHaveLength(1);
    for (const timestamp of ["2026-09-24T17:01:00.000Z", "2026-09-24T17:02:00.000Z", "2026-09-24T17:02:30.000Z", "2026-09-24T17:03:00.000Z"]) expect(html).toContain(`datetime=\"${timestamp}\"`);
    expect(html).toContain("staffExample");
    expect(html).toContain("maria");
    expect(html).toContain("Rejected · stale_revision");
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.querySelector(".notes-list li:first-child p")?.textContent).toBe("Second note is appended, not substituted.");
    expect(document.querySelector(".history-list li:first-child p strong")?.textContent).toBe("Conversation owner changed");
    expect(html).toContain("name=\"type\" value=\"staff.note\"");
    expect(html).toContain("name=\"note\"");
    expect(html).toContain(">Add note<");
  });

  it("renders separate owner-only callback-attempt and completion commands", () => {
    const base = initial();
    let conversation = { ...base, revision: 4,
      inputs: [{ id: "request-source", body: "Please call me back", sequence: 1 }, { id: "confirmation", body: "Yes", sequence: 3 }],
      requests: [{ id: "callback-1", revision: 3, category: null, originalRequest: "Please call me back", name: "Caller", callbackNumber: "+17025550123", callbackConfirmed: true,
        confirmationSourceId: "confirmation", owner: null, outcome: null, sourceIds: ["request-source"], proposalRevision: 2, state: "needs_callback" }] } as unknown as Conversation;
    const claimHtml = render(conversation).body;
    expect(claimHtml).toContain("name=\"type\" value=\"request.claim\"");
    expect(claimHtml).toContain("name=\"requestId\" value=\"callback-1\"");

    conversation = { ...conversation, revision: 5, requests: conversation.requests.map((request) => ({ ...request, revision: request.revision + 1, owner: "staffExample", state: "in_progress" })) } as unknown as Conversation;
    const completeHtml = render(conversation).body;
    expect(completeHtml).toContain('name="type" value="request.callback_attempt"');
    expect(completeHtml).toContain('name="requestId" value="callback-1"');
    for (const outcome of ["no_answer", "left_message", "reached", "failed"]) expect(completeHtml).toContain(`value="${outcome}"`);
    expect(completeHtml).toContain('name="note"');
    expect(completeHtml).toContain('data-draft-key="request:callback-1:attempt-note"');
    expect(completeHtml).toContain("Records staff follow-up only; it does not place an outbound call.");
    expect(completeHtml).toContain(">Record callback attempt<");
    expect(completeHtml).toContain("name=\"type\" value=\"request.complete\"");
    expect(completeHtml).toContain("name=\"outcome\"");
    expect(completeHtml).toContain('data-draft-key="request:callback-1:completion-outcome"');
    expect(completeHtml).toContain(">Complete callback<");
    const otherActor = render(conversation, { actor: "other" }).body;
    expect(otherActor).not.toContain('name="type" value="request.callback_attempt"');
    expect(otherActor).not.toContain('name="type" value="request.complete"');
  });

  it("keeps every callback-attempt outcome and note in attributed event history only", () => {
    const conversation = initial("voice");
    const history = [
      historyEntry(conversation, { type: "request.callback_attempt", requestId: "callback-1", outcome: "no_answer", note: "Rang without answer." }, "staffExample", "2026-09-24T18:01:00.000Z"),
      historyEntry(conversation, { type: "request.callback_attempt", requestId: "callback-1", outcome: "left_message", note: "Left the office callback number." }, "maria", "2026-09-24T18:12:00.000Z"),
    ];
    const html = render(conversation, { history }).body;

    expect(html.match(/Callback attempt recorded/g)).toHaveLength(2);
    expect(html).toContain("callback-1 · No Answer · Rang without answer.");
    expect(html).toContain("callback-1 · Left Message · Left the office callback number.");
    expect(html).toContain('datetime="2026-09-24T18:01:00.000Z"');
    expect(html).toContain('datetime="2026-09-24T18:12:00.000Z"');
    expect(html).toContain("staffExample");
    expect(html).toContain("maria");
    expect(html.match(/Rang without answer\./g)).toHaveLength(1);
    expect(html.match(/Left the office callback number\./g)).toHaveLength(1);
    expect(html).toContain("No staff notes.");
  });

  it("renders supplemental and corrected callback events from the parent contract", () => {
    const conversation = initial();
    const base = envelope(conversation, { type: "request.capture", requestId: "callback-1" }, "ai", "receptionist", "future-event");
    const commands = [
      { type: "question.activate", questionId: "question-1", kind: "callback_number", requestId: "callback-1" },
      { type: "request.supplement", requestId: "callback-1", sourceEventId: "source-2" },
      { type: "request.correct_contact", requestId: "callback-1", sourceEventId: "source-3", name: "Updated caller", callbackNumber: "+17025550124" },
    ];
    const history = commands.map((command, index) => ({
      input: { ...base, eventId: `future-event-${index}`, command },
      receipt: { eventId: `future-event-${index}`, accepted: true, error: null, state: conversation, occurredAt: `2026-09-24T17:0${index + 4}:00.000Z` },
    })) as unknown as ConversationConsoleInput["history"];
    const html = render(conversation, { history }).body;

    expect(html).toContain("Question activated");
    expect(html).toContain("question-1 · Callback Number · callback-1");
    expect(html).toContain("Callback request supplemented");
    expect(html).toContain("callback-1 · source-2");
    expect(html).toContain("Callback contact corrected");
    expect(html).toContain("callback-1 · source-3 · Updated caller · +17025550124");
  });

  it("renders pending-question and question-bound input state from the latest parent contract", () => {
    const conversation = { ...initial(), pendingQuestion: { id: "question-1", kind: "callback_number", requestId: "callback-1", requestRevision: 2,
      callbackNumber: "+17025550123", activatedRevision: 3 }, inputs: [{ id: "answer-1", body: "Yes", sequence: 4, questionId: "question-1" }] } as unknown as Conversation;
    const html = render(conversation).body;

    expect(html).toContain("Pending question");
    expect(html).toContain("Callback Number");
    expect(html).toContain("Question ID");
    expect(html).toContain("Question request revision");
    expect(html).toContain("answer-1 · sequence 4 · question question-1");
  });

  it("keeps the table usable beside a right full-height dock with an explicit close route", () => {
    const conversation = initial();
    const html = render(conversation, { page: 3, total: 21 }).body;

    expect(html).toContain("conversation-console has-selection");
    expect(html).toContain('id="conversation-console"');
    expect(html).toContain("data-conversation-console");
    expect(html).toContain('id="conversation-queue"');
    expect(html).toContain("data-console-queue");
    expect(html).toContain('id="conversation-panel-region"');
    expect(html).toContain("data-console-panel-region");
    expect(html).toContain("data-console-live-status");
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain("conversation-table");
    expect(html).toContain('<aside class="conversation-panel"');
    expect(html).toContain("position:fixed");
    expect(html).toContain("inset:0 0 0 auto");
    expect(html).toContain("margin-right:var(--console-panel)");
    expect(html).toContain("@media(max-width:1000px)");
    expect(html).toContain(".conversation-table-head{display:none}");
    expect(html).toContain(".conversation-row .request-cell{grid-column:1/-1");
    expect(html).toContain('class="conversation-panel-close" href="/staff?channel=sms&amp;page=3" aria-label="Close conversation details"');
    expect(html).not.toContain("Intergy");
  });

  it("matches the named SSE payload contract and preserves independent-region state", () => {
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("/staff/conversations/snapshot?");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("/staff/conversations/events?channel=");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('const MAX_POLL_ATTEMPTS = 8');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('"connected_to_staff", "resolved_by_human", "resolved_by_ai"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('...(FILTERS.has(filter) ? { filter } : {})');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('document.addEventListener("visibilitychange"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('source.addEventListener("ready"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('source.addEventListener("change"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('typeof changed.conversationId !== "string" || !Number.isInteger(changed.revision) || changed.revision < 0');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("void reconcile(changed.conversationId)");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("source.onmessage");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("changed.id");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("currentQueue.replaceWith(nextQueue)");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("currentPanel.replaceWith(nextPanel)");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("const draftsByConversation = new Map()");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("draftsByConversation.get(conversationId)");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("localStorage");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("sessionStorage");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('element.classList.add("console-region-changed")');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("nextSelected.scrollTop = panelScroll");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('document.addEventListener("submit"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('accept: "application/json"');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("payload?.accepted !== true");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("clearSubmittedDrafts(conversationId, keys)");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain('body.set("page", params.get("page") || "1")');
    expect(CONVERSATION_CONSOLE_CLIENT_JS).toContain("Could not save. Your entries are still here.");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("document.body");
    expect(CONVERSATION_CONSOLE_CLIENT_JS).not.toContain("location.reload");
  });

  it("reconciles ready and exact named change events while retaining a removed composer draft", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) { FakeEventSource.instances.push(this); }
      addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      }
      emit(name: string, payload: unknown): void {
        for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data: JSON.stringify(payload) }));
      }
      close(): void {}
    }
    const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
    let staffOwned = act(initial(), { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    const aiOwned = act(staffOwned, { type: "owner.change", owner: "ai" }, "staff", "staffExample");
    staffOwned = act(aiOwned, { type: "owner.change", owner: "staff" }, "staff", "staffExample");
    const filtered = { filter: "needs_follow_up", metricCounts } as const;
    let snapshot = render(staffOwned, filtered);
    let rejectCommand = false;
    const fetchMock = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => ({
      ok: !rejectCommand,
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "application/json" : null },
      json: async () => rejectCommand ? { error: "stale_revision" } : snapshot,
    }));
    vi.useFakeTimers();
    window.history.replaceState({}, "", "/staff?channel=sms&filter=needs_follow_up&selected=conversation-1&page=1");
    document.body.innerHTML = snapshot.body;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
    Object.defineProperty(window, "fetch", { configurable: true, value: fetchMock });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(window, "CSS", { configurable: true, value: { escape: (value: string) => value.replaceAll('"', '\\"') } });

    window.eval(CONVERSATION_CONSOLE_CLIENT_JS);
    const stream = FakeEventSource.instances.at(-1)!;
    expect(stream.url).toBe("/staff/conversations/events?channel=sms");
    expect(stream.listeners.has("ready")).toBe(true);
    expect(stream.listeners.has("change")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    stream.emit("ready", {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/staff/conversations/snapshot?channel=sms&filter=needs_follow_up&selected=conversation-1&page=1");
    expect(document.querySelector("[data-console-live-status]")?.textContent).toBe("Live");
    const reply = document.querySelector<HTMLTextAreaElement>('[data-draft-key="reply:body"]')!;
    reply.value = "Keep this draft";

    snapshot = render(aiOwned, filtered);
    stream.emit("change", { conversationId: "conversation-1", revision: aiOwned.revision });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-conversation-id="conversation-1"]')?.classList.contains("console-region-changed")).toBe(true);
    expect(document.querySelector('[data-draft-key="reply:body"]')).toBeNull();

    stream.emit("change", { id: "conversation-1", revision: aiOwned.revision });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    snapshot = render(staffOwned, filtered);
    stream.emit("change", { conversationId: "conversation-1", revision: staffOwned.revision });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.querySelector<HTMLTextAreaElement>('[data-draft-key="reply:body"]')?.value).toBe("Keep this draft");
    expect(document.querySelector('[data-selected-conversation="conversation-1"]')?.classList.contains("console-region-changed")).toBe(true);

    rejectCommand = true;
    const note = document.querySelector<HTMLTextAreaElement>('[data-draft-key="staff-note"]')!;
    note.value = "Keep this failed command draft";
    const form = note.closest("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, options] = fetchMock.mock.calls.at(-1)!;
    expect(options?.method).toBe("POST");
    expect(options?.headers).toMatchObject({ accept: "application/json" });
    expect(String(options?.body)).toContain("filter=needs_follow_up");
    expect(String(options?.body)).toContain("page=1");
    expect(note.value).toBe("Keep this failed command draft");
    expect(form.querySelector('[data-command-form-status]')?.textContent).toBe("Could not save. Your entries are still here.");
    expect(location.search).toBe("?channel=sms&filter=needs_follow_up&selected=conversation-1&page=1");

    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders a short changed-region highlight with a reduced-motion fallback", () => {
    const html = render(initial()).body;
    expect(html).toContain(".console-region-changed{animation:console-region-changed 1400ms ease-out}");
    expect(html).toContain("@media(prefers-reduced-motion:reduce)");
    expect(html).toContain(".console-region-changed{animation:none;");
  });
});
