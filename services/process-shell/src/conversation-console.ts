import { randomUUID } from "node:crypto";
import type { CommandEnvelope, Conversation, ConversationCommand } from "./conversation-contract.js";
import type { SpeechReview } from "./conversation-monitor.js";
import { requestSourceSummary, type TransitionReceipt } from "./conversation-store.js";
import type { CallerProvidedIdentity } from "./f2-synthetic-practice-store.js";
import type { CallRecordingList } from "./twilio-call-recordings.js";
import type { RecordingTranscriptView } from "./recording-transcript-store.js";

export type ConversationConsoleFilter = "total" | "active_now" | "needs_follow_up" | "connected_to_staff" | "resolved_by_human" | "resolved_by_ai";
export type ConversationConsoleMetricCounts = Readonly<{
  total: number;
  activeNow: number;
  needsFollowUp: number;
  connectedToStaff: number;
  resolvedByHuman: number;
  resolvedByAi: number;
}>;
export type ConversationConsoleHistoryProjection = Readonly<{
  channel: "voice" | "sms";
  availability: "available" | "unavailable";
  earliestRetainedAt: string | null;
  latestRetainedAt: string | null;
  retainedCount: number;
  priorCount: number;
  recent: readonly Readonly<{
    conversationId: string;
    createdAt: string;
    updatedAt: string;
    phase: Conversation["phase"];
    nextStep: string;
    requestSummary: string;
  }>[];
}>;
export type ConversationTranscriptView = readonly RecordingTranscriptView[] | "disabled" | "unavailable";

export type ConversationConsoleInput = {
  rows: readonly Conversation[];
  channel: "voice" | "sms";
  selected: Conversation | null;
  history: readonly { input: CommandEnvelope; receipt: TransitionReceipt }[];
  csrfToken: string;
  actor: string;
  page: number;
  total: number;
  metricCounts?: ConversationConsoleMetricCounts;
  filter?: ConversationConsoleFilter;
  historyProjection?: ConversationConsoleHistoryProjection;
  callerProvidedIdentity?: CallerProvidedIdentity | null;
  recordings?: CallRecordingList | { state: "not_enabled" };
  transcripts?: ConversationTranscriptView;
};

type HistoryEntry = ConversationConsoleInput["history"][number];
export function renderConversationConsole(input: ConversationConsoleInput): { title: string; body: string } {
  const channelName = input.channel === "sms" ? "SMS" : "Voice";
  const selected = input.selected;
  const body = `<style>${CONSOLE_STYLE}</style><div id="conversation-console" class="conversation-console${selected === null ? "" : " has-selection"}" data-conversation-console data-channel="${input.channel}" data-filter="${input.filter ?? "total"}">
    <div class="conversation-workspace">
      <header class="conversation-header">
        <div><span class="eyebrow">Synthetic Practice receptionist</span><h1>${channelName} conversations</h1><p>Current conversation state and staff follow-up.</p></div>
        <div class="console-actor"><span>Signed in as</span><strong>${esc(input.actor)}</strong><span class="console-live-status stale" data-console-live-status role="status" aria-live="polite">Updates delayed</span></div>
      </header>
      <nav class="channel-tabs" aria-label="Conversation channel">
        ${channelLink("voice", input.channel)}${channelLink("sms", input.channel)}
      </nav>
      <main id="conversation-queue" class="conversation-main" data-console-queue>
        ${metricCards(input)}
        <div class="conversation-heading"><div><span class="eyebrow">Receptionist queue</span><h2>${esc(filterHeading(input.channel, input.filter))}</h2></div><div class="queue-context"><span>${input.total} conversation${input.total === 1 ? "" : "s"}</span>${historyCoverage(input)}</div></div>
        ${conversationTable(input.rows, input.channel, input.page, selected?.id ?? null, input.filter)}
        ${pagination(input)}
      </main>
    </div>
    <div id="conversation-panel-region" data-console-panel-region>${selected === null ? "" : conversationPanel(selected, input)}</div>
  </div><script src="/staff/conversations/client.js" defer></script>`;
  return { title: `${channelName} conversations`, body };
}

function channelLink(channel: "voice" | "sms", current: "voice" | "sms"): string {
  const label = channel === "sms" ? "SMS" : "Voice";
  return `<a href="/staff?channel=${channel}"${channel === current ? ' aria-current="page"' : ""}>${label}</a>`;
}

function metricCards(input: ConversationConsoleInput): string {
  if (input.metricCounts === undefined) return "";
  const metrics: ReadonlyArray<{ filter?: ConversationConsoleFilter; count: number; label: string }> = [
    { filter: "total", count: input.metricCounts.total, label: input.channel === "voice" ? "Total calls" : "Total SMS" },
    { filter: "active_now", count: input.metricCounts.activeNow, label: "Active now" },
    { filter: "needs_follow_up", count: input.metricCounts.needsFollowUp, label: "Needs follow-up" },
    { filter: "connected_to_staff", count: input.metricCounts.connectedToStaff, label: "Connected to staff" },
    { filter: "resolved_by_human", count: input.metricCounts.resolvedByHuman, label: "Resolved by human" },
    { filter: "resolved_by_ai", count: input.metricCounts.resolvedByAi, label: "Resolved by AI" },
  ];
  return `<section class="conversation-metrics" aria-label="Conversation filters">${metrics.map((metric) => {
    const selected = metric.filter === (input.filter ?? "total");
    const href = metricHref(input.channel, metric.filter, input.selected?.id);
    return `<a class="conversation-metric${selected ? " selected" : ""}" data-console-filter="${metric.filter ?? "all"}" href="${esc(href)}"${selected ? ' aria-current="page"' : ""}><strong>${metric.count}</strong><span>${esc(metric.label)}</span></a>`;
  }).join("")}</section><p class="metric-context">Connected to staff counts accepted handoffs, including demo recipients. It is separate from request resolution.</p>`;
}

function conversationTable(rows: readonly Conversation[], channel: "voice" | "sms", page: number, selectedId: string | null, filter?: ConversationConsoleFilter): string {
  const content = rows.length === 0
    ? `<div class="conversation-empty"><strong>No matching ${channel === "sms" ? "SMS" : "voice"} conversations.</strong><span>New conversations will appear here.</span></div>`
    : rows.map((conversation) => conversationRow(conversation, channel, page, selectedId === conversation.id, filter)).join("");
  return `<div class="conversation-table" role="table" aria-label="${channel === "sms" ? "SMS" : "Voice"} conversations">
    <div class="conversation-table-head" role="row"><span role="columnheader">Status</span><span role="columnheader">Caller</span><span role="columnheader">Request</span><span role="columnheader">Next step</span><span role="columnheader">Delivery</span><span role="columnheader">Updated</span><span aria-hidden="true"></span></div>
    <div class="conversation-rows">${content}</div>
  </div>`;
}

function conversationRow(conversation: Conversation, channel: "voice" | "sms", page: number, selected: boolean, filter?: ConversationConsoleFilter): string {
  const request = latestRequest(conversation);
  const callerName = request?.name.trim() || "Name not captured";
  const requestText = requestSourceSummary(conversation, request) ?? conversation.inputs.at(-1)?.body ?? "No request captured";
  const href = conversationHref(channel, conversation.id, page, filter);
  return `<a class="conversation-row${selected ? " selected" : ""}" data-conversation-id="${esc(conversation.id)}" role="row" href="${esc(href)}"${selected ? ' aria-current="page"' : ""}>
    <span class="status-cell" role="cell">${conversationStatus(conversation)}</span>
    <span class="caller-cell" role="cell"><strong>${esc(callerName)}</strong><span>${esc(formatPhone(conversation.admission.contact))}</span>${whatsAppSandboxLabel(conversation)}</span>
    <span class="request-cell" role="cell"><strong>${esc(requestStateLabel(request, conversation.admission.mode))}</strong><span>${esc(requestText)}</span></span>
    <span class="owner-cell" role="cell">${esc(nextStep(conversation))}</span>
    <span class="delivery-cell" role="cell">${deliveryBadge(conversation)}</span>
    <time class="updated-cell" role="cell" datetime="${esc(conversation.updatedAt)}" title="${esc(conversation.updatedAt)}">${esc(formatTime(conversation.updatedAt))}</time>
    <span class="row-arrow" aria-hidden="true">›</span>
  </a>`;
}

function controlledTransferBlock(conversation: Conversation): string {
  if (conversation.admission.channel !== "voice") return "";
  const record = conversation.controlledTransfers.at(-1);
  if (record === undefined) {
    return conversation.admission.hours === "demo_closed"
      ? '<section class="panel-section" data-controlled-transfer><span class="eyebrow">Call routing</span><h3>After-hours message</h3><p>No transfer attempted. The call went straight to message capture.</p></section>'
      : "";
  }
  const request = conversation.requests.find((item) => item.id === record.attempt.requestId);
  const status = record.outcome === "accepted" && record.acceptance !== null ? "Demo recipient accepted"
    : record.dispatch === "unknown" ? "Transfer status unknown"
    : record.outcome === "no_answer" ? "No answer"
    : record.outcome === "busy" ? "Line busy"
    : record.outcome === "refused" ? "Not accepted"
    : record.outcome === "late_accept" ? "Recipient did not accept in time"
    : record.outcome === "failed" ? "Transfer failed"
    : record.outcome === "canceled" ? "Transfer canceled"
    : record.attempt.state === "answered" ? "Awaiting recipient acceptance"
    : "Transfer in progress";
  const followUp = request?.state === "needs_callback" ? "Needs callback"
    : request?.state === "completed" ? "Completed with staff evidence" : "Request remains unresolved";
  return '<section class="panel-section" data-controlled-transfer><span class="eyebrow">Latest transfer</span><h3>'
    + esc(status) + '</h3><dl class="conversation-facts">' + fact("Team", words(record.attempt.category))
    + fact("Follow-up", followUp) + '</dl><p>Recipient acceptance is separate from verified staff identity, patient contact, and request resolution.</p></section>';
}

function conversationPanel(conversation: Conversation, input: ConversationConsoleInput): string {
  const closeHref = consoleHref(input.channel, input.page, input.filter);
  const currentStaffOwner = conversation.owner === "staff" && conversation.staffActor === input.actor;
  const notes = input.history.filter(({ input: event, receipt }) => event.command.type === "staff.note" && receipt.accepted);
  return `<aside class="conversation-panel" data-selected-conversation="${esc(conversation.id)}" aria-label="Conversation details">
    <div class="conversation-panel-header">
      <div><span class="eyebrow">${esc(conversationTransportLabel(conversation))} conversation</span><h2>${esc(formatPhone(conversation.admission.contact))}</h2><span class="panel-id">${esc(conversation.id)}</span></div>
      <div class="conversation-panel-header-actions">${conversation.admission.channel === "voice" ? '<a class="conversation-panel-transcript-link" data-transcript-jump href="#recorded-transcript">Transcript</a>' : ""}<a class="conversation-panel-close" href="${esc(closeHref)}" aria-label="Close conversation details">×</a></div>
    </div>
    ${ownershipBlock(conversation, input, currentStaffOwner)}
    ${conversationFacts(conversation)}
    ${identityDetailBlock(conversation, input.callerProvidedIdentity)}
    ${requestBlock(conversation, input)}
    ${controlledTransferBlock(conversation)}
    ${conversation.admission.channel === "voice" ? recordedTranscriptBlock(input.transcripts) : ""}
    ${conversation.admission.channel === "sms" ? messageBlock(conversation, input, currentStaffOwner) : voiceBlock(conversation, input.recordings, input.history)}
    ${simulatedRouteBlock(conversation, input)}
    ${speechReviewBlock(conversation, input)}
    ${evaluationBlock(conversation)}
    ${priorCallsBlock(conversation, input)}
    ${notesBlock(conversation, input.csrfToken, notes)}
    ${historyBlock(conversation, input.history)}
    ${technicalBlock(conversation)}
  </aside>`;
}

function simulatedRouteBlock(conversation: Conversation, input: ConversationConsoleInput): string {
  const supersededIds = new Set(conversation.simulatedRouteOutcomes.flatMap((item) => item.supersedesId === null ? [] : [item.supersedesId]));
  const route = conversation.simulatedRouteOutcomes.find((item) => !supersededIds.has(item.id));
  if (route === undefined) return "";
  const request = conversation.requests.find((item) => item.id === route.requestId);
  const attempts = input.history.filter(({ input: event, receipt }) => receipt.accepted && event.command.type === "request.callback_attempt"
    && event.command.requestId === route.requestId && event.command.outcome !== "failed");
  const latestAttempt = attempts.at(-1)?.input.command;
  const received = "Recorded";
  const assigned = request?.owner ? `Assigned to ${request.owner}` : "Unknown";
  const attempted = latestAttempt === undefined ? "Unknown" : "Recorded";
  const reached = latestAttempt?.type === "request.callback_attempt" && latestAttempt.outcome === "reached" ? "Reached" : "Unknown";
  const resolved = request?.state === "completed" && request.outcome !== null ? "Resolved" : "Unknown";
  const context = conversation.callerContext.length === 0 ? "No caller context retained" : conversation.callerContext.map((item) => item.text).join(" · ");
  return `<section class="panel-section" data-simulated-route-outcome><span class="eyebrow">Synthetic route outcome</span><h3>Simulated only: ${esc(words(route.outcome))}</h3><p>This records the demo route result. It does not establish a real transfer, staff contact, callback attempt, reach, or resolution.</p><dl class="conversation-facts">${fact("Received", received)}${fact("Assigned", assigned)}${fact("Attempted", attempted)}${fact("Reached", reached)}${fact("Resolved", resolved)}${fact("Caller context", context)}</dl></section>`;
}

function identityDetailBlock(conversation: Conversation, identity: CallerProvidedIdentity | null | undefined): string {
  if (conversation.admission.mode !== "full") return "";
  return `<section class="panel-section identity-detail" data-protected-identity-detail><span class="eyebrow">Protected identity detail</span><h3>Caller-provided identity</h3><dl class="conversation-facts">
    ${fact("Caller-provided DOB", identity?.dateOfBirth ?? "Not captured")}
    ${fact("Caller-provided ZIP", identity?.zip ?? "Not captured")}
    ${fact("Demo verification", identity === null || identity === undefined ? "Not captured" : "Passed")}
  </dl><p class="muted">Display-only demo evidence; it does not grant access.</p></section>`;
}

function ownershipBlock(conversation: Conversation, input: ConversationConsoleInput, currentStaffOwner: boolean): string {
  let action = "";
  const deliveryReview = conversation.admission.channel === "sms" && conversation.messages.some((message) => message.state === "unknown" && !message.sendHoldReleased);
  if ((conversation.phase === "active" || deliveryReview) && conversation.owner !== "staff") {
    action = commandForm(conversation, input.csrfToken, "owner.change", `<input type="hidden" name="owner" value="staff"><button type="submit">${conversation.phase === "active" ? "Take over" : "Review delivery"}</button>`);
  } else if (conversation.phase === "active" && currentStaffOwner) {
    action = commandForm(conversation, input.csrfToken, "owner.change", `<input type="hidden" name="owner" value="ai"><button class="quiet" type="submit">Return to AI</button>`);
  }
  const ownershipNote = conversation.owner === "staff" && !currentStaffOwner
    ? `<p class="muted">Only ${esc(conversation.staffActor ?? "the current staff owner")} can return this conversation to AI or send replies.</p>` : "";
  return `<section class="panel-section ownership-section"><div class="section-row"><div><span class="eyebrow">Current owner</span><h3>${esc(ownerLabel(conversation))}</h3></div>${action}</div>${ownershipNote}</section>`;
}

function conversationFacts(conversation: Conversation): string {
  return `<section class="panel-section"><span class="eyebrow">Current state</span><dl class="conversation-facts">
    ${fact("Conversation", phaseLabel(conversation.phase))}
    ${fact("Channel", conversation.admission.channel === "sms" ? "SMS" : "Voice")}
    ${conversation.admission.channel === "sms" ? fact("Message transport", conversationTransportLabel(conversation)) : ""}
    ${fact("Caller", formatPhone(conversation.admission.contact))}
    ${fact("Destination", formatPhone(conversation.admission.destination))}
    ${fact("Hours", words(conversation.admission.hours))}
    ${fact("Mode", words(conversation.admission.mode))}
    ${fact("Provider tier", words(conversation.providerTier))}
    ${pendingQuestionFacts(conversation)}
    ${conversation.admission.channel === "sms" ? fact(`${conversationTransportLabel(conversation)} permission`, conversation.suppressed ? "Suppressed" : "Available") : ""}
    ${fact("Created", formatTime(conversation.createdAt), conversation.createdAt)}
    ${fact("Updated", formatTime(conversation.updatedAt), conversation.updatedAt)}
  </dl></section>`;
}

function messageBlock(conversation: Conversation, input: ConversationConsoleInput, currentStaffOwner: boolean): string {
  const inputs = inputList(conversation);
  const messages = conversation.messages.length === 0 ? `<p class="muted">No outbound messages.</p>` : `<ol class="message-list">${conversation.messages.map((message) => {
    const canRelease = currentStaffOwner && message.state === "unknown" && !message.sendHoldReleased;
    const holdAction = canRelease ? commandForm(conversation, input.csrfToken, "sms.release_hold", `<input type="hidden" name="messageId" value="${esc(message.id)}"><label>Reconciliation note<input name="note" data-draft-key="${esc(`release:${message.id}:note`)}" maxlength="8000" required></label><button type="submit">Release send hold</button>`) : "";
    const warning = message.state === "unknown" ? `<div class="send-warning"><strong>Delivery is unknown.</strong><span>${message.sendHoldReleased ? "The send hold was released by staff." : "New sends stay held until the current staff owner records why it is safe to continue."}</span>${holdAction}</div>`
      : sandboxNotJoinedGuidance(conversation, message);
    return `<li><div class="message-meta"><span>${esc(message.sender === "staff" ? `Staff · ${message.actor}` : `AI · ${message.actor}`)}</span>${messageStateBadge(message.state, message.sendHoldReleased)}</div><p>${esc(message.body)}</p>${warning}<dl class="message-technical">${fact("Message ID", message.id)}${fact("Provider ID", message.providerId ?? "Not assigned")}${fact("Dispatch attempt", message.dispatchAttemptId ?? "Not started")}${fact("Owner epoch", String(message.ownerEpoch))}${fact("Suppression revision", String(message.suppressionRevision))}${fact("Send hold", message.state === "unknown" ? message.sendHoldReleased ? "Released" : "Active" : "Not applicable")}</dl></li>`;
  }).join("")}</ol>`;
  const whatsAppReplyWindow = whatsAppReplyWindowState(conversation);
  const composer = whatsAppReplyWindow === "expired"
    ? `<p class="send-disabled" data-whatsapp-window-expired>WhatsApp Sandbox's 24-hour reply window has expired. Ask the tester to send a new WhatsApp message before replying.</p>`
    : whatsAppReplyWindow === "unavailable"
      ? `<p class="send-disabled" data-whatsapp-window-expired>No recorded WhatsApp Sandbox inbound message is available. Ask the tester to send a new WhatsApp message before replying.</p>`
    : currentStaffOwner && conversation.phase === "active" && !conversation.suppressed
    ? commandForm(conversation, input.csrfToken, "sms.queue", `<input type="hidden" name="messageId" value="${esc(`staff-${conversation.revision + 1}-${conversation.ownerEpoch}`)}"><label>Reply<textarea name="body" data-draft-key="reply:body" maxlength="8000" required></textarea></label><button type="submit">Queue reply</button>`, "reply-form")
    : conversation.suppressed ? `<p class="send-disabled">${esc(conversationTransportLabel(conversation))} replies are unavailable because this contact is suppressed.</p>` : "";
  return `<section class="panel-section"><span class="eyebrow">Conversation</span><h3>Caller input</h3>${inputs}</section><section class="panel-section"><div class="section-row"><div><span class="eyebrow">Messages</span><h3>Delivery</h3></div>${deliveryBadge(conversation)}</div>${messages}${composer}</section>`;
}

function voiceBlock(conversation: Conversation, recordings: ConversationConsoleInput["recordings"], history: readonly HistoryEntry[]): string {
  const recoveries = conversation.recoveries.length === 0 ? "" : `<div class="recovery-list"><span class="eyebrow">Voice recovery</span>${conversation.recoveries.map((recovery) => `<article><strong>${esc(words(recovery.state))}</strong><span>${esc(words(recovery.target))} · epoch ${recovery.fromEpoch}</span><dl class="conversation-facts">${fact("Recovery ID", recovery.id)}${fact("Parent call", recovery.parentCallId)}${fact("Child call", recovery.childCallId)}${fact("Trigger event", recovery.triggerEventId)}${fact("Attachment", recovery.attachmentId ?? "Not attached")}${fact("Created", formatTime(recovery.createdAt), recovery.createdAt)}${fact("Updated", formatTime(recovery.updatedAt), recovery.updatedAt)}</dl></article>`).join("")}</div>`;
  return `${liveVoiceConversationBlock(conversation, history)}<section class="panel-section"><span class="eyebrow">Voice recovery</span>${recoveries || "<p class=\"muted\">No recovery activity.</p>"}</section>${recordingBlock(conversation, recordings)}`;
}

function liveVoiceConversationBlock(conversation: Conversation, history: readonly HistoryEntry[]): string {
  const entries: Array<{ kind: "caller" | "assistant"; text: string; occurredAt: string; index: number }> = [];
  const timestampedCallerIds = new Set<string>();
  for (const [index, entry] of history.entries()) {
    if (!entry.receipt.accepted) continue;
    if (entry.input.command.type === "input.record") {
      timestampedCallerIds.add(entry.input.command.sourceId);
      entries.push({ kind: "caller", text: entry.input.command.body, occurredAt: entry.receipt.occurredAt, index });
    }
    if (entry.input.command.type === "monitor.review") entries.push({ kind: "assistant", text: entry.input.command.review.transcript, occurredAt: entry.receipt.occurredAt, index });
  }
  entries.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.index - right.index);
  const content = entries.length === 0 ? `<p class="muted">No timestamped live conversation evidence is retained.</p>` : `<ol class="live-conversation-list">${entries.map((entry) => `<li class="${entry.kind}"><div><strong>${entry.kind === "caller" ? "Caller input" : "Assistant generated speech"}</strong><time datetime="${esc(entry.occurredAt)}" title="${esc(entry.occurredAt)}">${esc(formatTime(entry.occurredAt))}</time></div><p>${esc(entry.text)}</p>${entry.kind === "assistant" ? "<span>Generated text is not proof that the caller heard it.</span>" : ""}</li>`).join("")}</ol>`;
  const untimed = conversation.inputs.filter((entry) => !timestampedCallerIds.has(entry.id));
  const missing = untimed.length === 0 ? "" : `<section class="untimed-caller-input"><span class="eyebrow">Caller input without retained event timestamp</span><p class="muted">Stored caller input is shown here because its matching history event is unavailable. Its position relative to other events is unknown.</p><ol class="input-list">${untimed.map((entry) => `<li><p>${esc(entry.body)}</p><span class="technical-id">${esc(entry.id)}</span></li>`).join("")}</ol></section>`;
  return `<section class="panel-section"><span class="eyebrow">Live conversation evidence</span><h3>Persisted event order</h3><p class="muted">Caller input and generated assistant speech from retained live-runtime events. This is not heard-audio chronology or proof of playback.</p>${content}${missing}</section>`;
}

function recordedTranscriptBlock(rows: ConversationConsoleInput["transcripts"]): string {
  const heading = '<span class="eyebrow">Recorded conversation</span><h3>Full machine transcript</h3><p class="muted">From recorded audio, not generated model text. Speaker labels are not verified identities. The recording covers the AI SIP segment; fallback audio may be missing. Recognition can be imperfect.</p>';
  const section = (state: "available" | "partial" | "pending" | "missing" | "disabled" | "unavailable", content: string) => `<section id="recorded-transcript" class="panel-section recorded-transcript" data-recorded-transcript data-transcript-state="${state}">${heading}${content}</section>`;
  if (rows === undefined || rows === "disabled") return section("disabled", '<p>Automatic transcript processing is disabled for new calls. This selected-call view does not check for or reconstruct historical audio.</p>');
  if (rows === "unavailable") return section("unavailable", '<p>Transcript storage is temporarily unavailable.</p>');
  if (rows.length === 0) return section("missing", '<p>No recording transcript is available for this call. It may be waiting on recording or transcription; this view does not infer why.</p>');
  const overallState = rows.some((row) => row.transcript?.status === "partial") ? "partial"
    : rows.some((row) => row.transcript?.status === "complete" || row.transcript?.status === "no_speech") ? "available"
    : rows.some((row) => row.transcript === null) ? "pending" : "unavailable";
  return section(overallState, rows.map((row) => {
    const t = row.transcript;
    if (t === null) return `<article class="recorded-transcript-entry" data-transcript-recording-id="${esc(row.recordingId)}" data-transcript-entry-state="pending"><h4>Transcript pending</h4><p>Transcript processing or outcome not yet confirmed. No automatic paid retry.</p></article>`;
    const status = t.status === "complete" ? "Transcription finished" : t.status === "no_speech" ? "No speech recognized in recording"
      : t.status === "partial" ? "Partial transcription; review recording" : t.failureCode === "recording_over_limit" ? "Recording exceeds 30-minute transcription limit; not truncated" : "Transcription unavailable; review recording";
    const entryState = t.status === "partial" ? "partial" : t.status === "complete" || t.status === "no_speech" ? "available" : "unavailable";
    const fullText = t.text.trim().length === 0 ? "" : `<details data-transcript-full-text><summary>Full transcript text</summary><p>${esc(t.text)}</p></details>`;
    return `<article class="recorded-transcript-entry" data-transcript-recording-id="${esc(row.recordingId)}" data-transcript-entry-state="${entryState}"><h4>${esc(status)}</h4>${fullText}<ol class="recorded-transcript-segments">${t.segments.map((segment) => `<li data-transcript-segment><div><strong>Speaker ${esc(segment.speaker)}</strong> <span>${segment.start.toFixed(1)}-${segment.end.toFixed(1)}s</span></div><p>${esc(segment.text)}</p></li>`).join("")}</ol></article>`;
  }).join(""));
}

function recordingBlock(conversation: Conversation, recordings: ConversationConsoleInput["recordings"]): string {
  if (recordings === undefined || recordings.state === "not_enabled") return `<section class="panel-section"><span class="eyebrow">Call recording</span><p class="muted">New call recording is currently disabled. This view does not check for or play historical audio.</p></section>`;
  if (recordings.state === "unavailable") return `<section class="panel-section"><span class="eyebrow">Call recording</span><p class="muted">Recording status is temporarily unavailable. Refresh to retry.</p></section>`;
  if (recordings.recordings.length === 0) return `<section class="panel-section"><span class="eyebrow">Call recording</span><p class="muted">No recording is available yet. Twilio may still be processing it.</p></section>`;
  return `<section class="panel-section"><span class="eyebrow">Call recording</span><h3>Twilio-hosted demo audio</h3>${recordings.recordings.map((recording) => recording.status === "completed"
    ? `<audio controls preload="none" src="/staff/conversations/${encodeURIComponent(conversation.id)}/recordings/${recording.id}.mp3">Call recording audio.</audio><p class="muted">${recording.durationSeconds === null ? "Duration unavailable" : `${recording.durationSeconds} seconds`} · Stored and managed by Twilio.</p>`
    : `<p class="muted">Recording ${esc(recording.status)}. Audio is not available yet.</p>`).join("")}</section>`;
}

function inputList(conversation: Conversation): string {
  return conversation.inputs.length === 0 ? `<p class="muted">No caller input recorded.</p>` : `<ol class="input-list">${conversation.inputs.map((entry) => {
    const sequence = "sequence" in entry && typeof entry.sequence === "number" ? ` · sequence ${entry.sequence}` : "";
    const question = "questionId" in entry && typeof entry.questionId === "string" ? ` · question ${esc(entry.questionId)}` : "";
    return `<li><span class="eyebrow">Caller input</span><p>${esc(entry.body)}</p><span class="technical-id">${esc(entry.id)}${sequence}${question}</span></li>`;
  }).join("")}</ol>`;
}

function requestBlock(conversation: Conversation, input: ConversationConsoleInput): string {
  const fullMode = conversation.admission.mode === "full";
  const requests = conversation.requests.length === 0 ? `<p class="muted">${fullMode ? "No request captured." : "No callback request captured."}</p>` : `<ol class="request-list">${conversation.requests.map((request) => {
    let action = "";
    const degradedSource = request.fullProposal !== undefined && conversation.requests.some((item) => item.degradedHandoff?.sourceRequestId === request.id);
    if (!degradedSource && request.state === "needs_callback") {
      action = commandForm(conversation, input.csrfToken, "request.claim", `<input type="hidden" name="requestId" value="${esc(request.id)}"><button type="submit">Claim callback</button>`);
    } else if (request.state === "in_progress" && request.owner === input.actor) {
      const attempt = commandForm(conversation, input.csrfToken, "request.callback_attempt", `<input type="hidden" name="requestId" value="${esc(request.id)}"><label>Attempt outcome<select name="outcome" data-draft-key="${esc(`request:${request.id}:attempt-outcome`)}" required><option value="">Select outcome</option><option value="no_answer">No answer</option><option value="left_message">Left message</option><option value="reached">Reached caller</option><option value="failed">Attempt failed</option></select></label><label>Attempt note<textarea name="note" data-draft-key="${esc(`request:${request.id}:attempt-note`)}" maxlength="8000" required></textarea></label><p>Records staff follow-up only; it does not place an outbound call.</p><button type="submit">Record callback attempt</button>`, "callback-attempt-form");
      const complete = commandForm(conversation, input.csrfToken, "request.complete", `<input type="hidden" name="requestId" value="${esc(request.id)}"><label>Completion outcome<textarea name="outcome" data-draft-key="${esc(`request:${request.id}:completion-outcome`)}" maxlength="8000" required></textarea></label><button type="submit">Complete callback</button>`, "callback-complete-form");
      action = `<div class="request-actions">${attempt}${complete}</div>`;
    }
    const sourceIdsValue: unknown = "sourceIds" in request ? request.sourceIds : undefined;
    const hasSourceIds = Array.isArray(sourceIdsValue);
    const sourceIds = hasSourceIds ? sourceIdsValue.filter((value: unknown): value is string => typeof value === "string") : [];
    const callbackMessage = callbackMessageDetail(conversation, request, sourceIds);
    const messageUpdates = callbackMessageUpdates(conversation, request, input.history)
      .map((update) => fact("Message update", update.body)).join("");
    const proposalRevision = "proposalRevision" in request && typeof request.proposalRevision === "number" ? String(request.proposalRevision) : "Not recorded";
    const proposal = fullMode && request.fullProposal !== undefined ? fullRequestProposalBlock(request.fullProposal) : "";
    const recoveryContext = degradedSource ? `<p class="muted" data-degraded-recovery-context>Original full proposal retained as context; callback work is listed separately.</p>` : "";
    const resolution = hasAiResolution(request) ? aiResolutionBlock(request.aiResolution)
      : request.state === "ai_resolved" ? `<div class="ai-resolution-proof missing" data-ai-resolution-proof-missing><span class="eyebrow">AI resolution proof</span><strong>Proof unavailable</strong><p>This request cannot be treated as resolved without its typed server proof.</p></div>` : "";
    const staffOutcome = request.state === "ai_resolved" ? "" : fact("Outcome", request.outcome ?? "Not completed");
    const summary = requestSourceSummary(conversation, request);
    return `<li data-request-id="${esc(request.id)}"><div class="section-row"><div><strong>${esc(degradedSource ? "Recovery context" : requestStateLabel(request, conversation.admission.mode))}</strong><span>${esc(request.category === null ? "Unclassified" : words(request.category))}</span></div>${action}</div><p>${summary === null ? '<span class="muted">No request text captured.</span>' : esc(summary)}</p>${proposal}${recoveryContext}${resolution}<dl class="conversation-facts">${fact("Request ID", request.id)}${fact("Caller name", request.name || "Not captured")}${fact("Callback number", request.callbackNumber ? formatPhone(request.callbackNumber) : "Not captured")}${fact("Number confirmed", request.callbackConfirmed ? "Yes" : "No")}${fact("Confirmation source", request.confirmationSourceId ?? "Not confirmed")}${fact("Caller message", callbackMessage.body)}${fact("Caller message source", callbackMessage.sourceId)}${messageUpdates}${hasSourceIds ? fact("Source inputs", sourceIds.length > 0 ? sourceIds.join(", ") : "None") : ""}${fact("Proposal revision", proposalRevision)}${fact("Owner", request.owner ?? "Unassigned")}${staffOutcome}${fact("Request revision", String(request.revision))}</dl></li>`;
  }).join("")}</ol>`;
  return `<section class="panel-section"><span class="eyebrow">${fullMode ? "Request agenda" : "Callback work"}</span><h3>Requests</h3>${requests}</section>`;
}

function callbackMessageUpdates(conversation: Conversation, request: Conversation["requests"][number], history: ConversationConsoleInput["history"]): Conversation["inputs"] {
  const original = conversation.inputs.find((entry) => entry.id === request.callbackMessageSourceId && request.sourceIds.includes(entry.id));
  if (original === undefined) return [];
  const acceptedSources = new Set(history.flatMap((entry) => {
    const command = entry.input.command;
    const scope = entry.input.scope;
    return entry.receipt.accepted && command.type === "request.supplement" && command.requestId === request.id
      && scope.conversationId === conversation.id && scope.practiceId === conversation.admission.practiceId
      && scope.instanceId === conversation.admission.instanceId && request.sourceIds.includes(command.sourceEventId)
      ? [command.sourceEventId] : [];
  }));
  return conversation.inputs.filter((entry) => acceptedSources.has(entry.id) && entry.sequence > original.sequence)
    .sort((left, right) => left.sequence - right.sequence);
}

function callbackMessageDetail(conversation: Conversation, request: Conversation["requests"][number], sourceIds: readonly string[]): { body: string; sourceId: string } {
  const sourceId = "callbackMessageSourceId" in request && typeof request.callbackMessageSourceId === "string"
    ? request.callbackMessageSourceId : null;
  if (sourceId === null || !sourceIds.includes(sourceId)) return { body: "Not captured", sourceId: "Not captured" };
  const input = conversation.inputs.find((entry) => entry.id === sourceId);
  return input === undefined ? { body: "Not captured", sourceId: "Not captured" } : { body: input.body, sourceId };
}

type FullRequestProposal = NonNullable<Conversation["requests"][number]["fullProposal"]>;

function fullRequestProposalBlock(proposal: FullRequestProposal): string {
  const task = fullTaskPresentation(proposal.capability);
  return `<div class="full-request-plan" data-full-request-plan data-task-capability="${esc(proposal.capability)}"><span class="eyebrow">${task.executable ? "Registered AI task" : "Registered request path"}</span><strong>${esc(task.label)}</strong><dl class="conversation-facts">${fact("Caller-stated patient status", patientStatusLabel(proposal.patientStatus))}</dl><p>Task selection and caller-stated status do not establish identity or completion.</p></div>`;
}

function fullTaskPresentation(capability: FullRequestProposal["capability"]): { executable: boolean; label: string } {
  switch (capability) {
    case "appointment_details": return { executable: true, label: "Appointment details" };
    case "appointment_schedule": return { executable: true, label: "Schedule appointment" };
    case "appointment_reschedule": return { executable: true, label: "Reschedule appointment" };
    case "appointment_attendance_confirm": return { executable: true, label: "Confirm appointment attendance" };
    case "referral_status": return { executable: true, label: "Referral status" };
    case "billing_balance": return { executable: true, label: "Billing balance" };
    case "office_address": return { executable: true, label: "Office address" };
    case "approved_practice_information": return { executable: true, label: "Approved practice information" };
    case "human_request": return { executable: false, label: "Staff requested" };
    case "clinical": return { executable: false, label: "Clinical request for staff" };
    case "unsupported": return { executable: false, label: "Unsupported request" };
    case "uncertain": return { executable: false, label: "Task not yet determined" };
  }
}

function patientStatusLabel(status: FullRequestProposal["patientStatus"]): string {
  return status === "established" ? "Established" : status === "new" ? "New" : "Unknown";
}

type AiResolution = NonNullable<Conversation["requests"][number]["aiResolution"]>;

function aiResolutionBlock(result: AiResolution): string {
  const facts = result.kind === "read"
    ? fact("Proof kind", "Protected read") + fact("Receipt ID", result.receiptId) + fact("Read kind", words(result.readKind))
      + fact("Receipt hash", result.receiptHash) + fact("Result hash", result.resultHash) + fact("Source version", String(result.sourceVersion))
    : result.kind === "action"
      ? fact("Proof kind", "Committed action") + fact("Receipt ID", result.receiptId) + fact("Operation", words(result.operation))
        + fact("Result hash", result.resultHash) + fact("Readback hash", result.readbackHash) + fact("Resulting version", String(result.resultingVersion))
      : fact("Proof kind", "Pinned knowledge") + fact("Topic", words(result.topic)) + fact("Pack ID", result.packId) + fact("Pack version", result.packVersion)
        + fact("Fact ID", result.factId) + fact("Fact version", result.factVersion) + fact("Source ID", result.sourceId)
        + fact("Source version", result.sourceVersion) + fact("Content hash", result.contentHash);
  return `<div class="ai-resolution-proof" data-ai-resolution-proof data-proof-kind="${esc(result.kind)}"><span class="eyebrow">AI resolution proof</span><dl class="conversation-facts">${facts}</dl><p>Opaque server proof confirms completion; it does not contain patient-facing result values.</p></div>`;
}

function speechReviewBlock(conversation: Conversation, input: ConversationConsoleInput): string {
  if (conversation.admission.channel !== "voice" || conversation.speechReviews.length === 0) return "";
  const timelineReviewIds = new Set(input.history.filter((entry) => entry.receipt.accepted && entry.input.command.type === "monitor.review")
    .map((entry) => entry.input.command.type === "monitor.review" ? entry.input.command.review.id : ""));
  const reviews = [...conversation.speechReviews].reverse().map((review) => {
    const unresolved = review.verdict !== "clear" && review.correction !== "staff_resolved";
    const action = unresolved ? commandForm(conversation, input.csrfToken, "monitor.resolve", `<input type="hidden" name="reviewId" value="${esc(review.id)}"><label>Resolution outcome<textarea name="outcome" data-draft-key="${esc(`monitor:${review.id}:outcome`)}" maxlength="8000" required></textarea></label><button type="submit">Resolve review</button>`, "monitor-resolve-form") : "";
    const generated = timelineReviewIds.has(review.id) ? `<p class="muted">Generated text appears in the chronological conversation evidence above.</p>`
      : `<div class="generated-transcript"><span class="eyebrow">Generated transcript</span><p>${esc(review.transcript)}</p><span>Generated text is not proof that the caller heard it.</span></div>`;
    return `<li class="speech-review${unresolved ? " unresolved" : ""}"><div class="section-row"><div><strong>${esc(reviewVerdictLabel(review.verdict))}</strong><span>${esc(correctionLabel(review.correction))}</span></div><span class="review-state ${unresolved ? "attention" : "settled"}">${unresolved ? "Follow-up needed" : "No follow-up"}</span></div>${generated}<dl class="conversation-facts">${fact("Review reasons", review.reasons.map(reviewReasonLabel).join(", "))}${fact("Review ID", review.id)}${fact("Monitor version", review.version)}${fact("Voice epoch", String(review.voiceEpoch))}${fact("Authority revision", String(review.authorityRevision))}</dl>${action}</li>`;
  }).join("");
  return `<section class="panel-section speech-review-section"><span class="eyebrow">Speech review</span><h3>Generated-response checks</h3><p class="muted">Automated review evidence supports staff judgment; it does not establish a confirmed incident.</p><ol class="speech-review-list">${reviews}</ol></section>`;
}

function reviewVerdictLabel(verdict: SpeechReview["verdict"]): string {
  if (verdict === "clear") return "No unsupported claim found";
  if (verdict === "confirmed") return "Automated review found an unsupported claim";
  if (verdict === "suspected") return "Automated review is inconclusive";
  return "Automated review unavailable";
}

function correctionLabel(correction: SpeechReview["correction"]): string {
  if (correction === "pending") return "Correction pending";
  if (correction === "attempting") return "Correction in progress";
  if (correction === "generated") return "Correction generated; hearing not established";
  if (correction === "unheard") return "Correction was not heard";
  if (correction === "staff_resolved") return "Resolved by staff";
  return "No automatic correction";
}

function reviewReasonLabel(reason: SpeechReview["reasons"][number]): string {
  const labels: Record<SpeechReview["reasons"][number], string> = {
    no_critical_claim: "No critical claim",
    unsupported_saved_claim: "Saved-state claim lacked support",
    unsupported_connection: "Staff-connection claim lacked support",
    unsupported_appointment: "Appointment-change claim lacked support",
    clinical_advice: "Clinical advice detected",
    unsupported_callback_deadline: "Callback deadline lacked support",
    ambiguous_claim: "Claim was ambiguous",
    invalid_source: "Source could not be verified",
    monitor_unavailable: "Monitor unavailable",
    missing_authority: "Authority snapshot unavailable",
  };
  return labels[reason];
}

function evaluationBlock(conversation: Conversation): string {
  if (conversation.evaluations.length === 0) return "";
  const evaluations = [...conversation.evaluations].reverse().map((evaluation, index) => {
    const stateClass = evaluation.state === "failed" || evaluation.verdict === "failed" ? "failed"
      : evaluation.verdict === "passed" ? "passed" : "attention";
    const checks = evaluation.checks === null
      ? `<p class="muted">Quality checks are not available for this record.</p>`
      : `<dl class="evaluation-checks">${evaluationCheckEntries(evaluation.checks).map(([label, result]) => `<div><dt>${esc(label)}</dt><dd class="evaluation-check ${evaluationCheckClass(result)}">${esc(evaluationCheckLabel(result))}</dd></div>`).join("")}</dl>`;
    const failure = evaluation.state === "failed" ? fact("Failure", words(evaluation.failureCode)) : "";
    const unresolved = evaluation.unresolvedRequestCount === null ? "Not calculated" : String(evaluation.unresolvedRequestCount);
    const partial = evaluation.partialDraftCount === null ? "Not calculated" : String(evaluation.partialDraftCount);
    return `<li class="evaluation-record"><span class="eyebrow">${index === 0 ? "Latest review" : "Earlier review"}</span><div class="section-row"><div><strong>${esc(evaluationStateLabel(evaluation.state))}</strong><span>${esc(evaluationVerdictLabel(evaluation.verdict))}</span></div><span class="evaluation-state ${stateClass}">${esc(evaluationVerdictBadge(evaluation))}</span></div>${checks}<dl class="conversation-facts">${fact("Reasons", evaluation.reasons.length === 0 ? "None recorded" : evaluation.reasons.map(evaluationReasonLabel).join(", "))}${fact("Unresolved requests", unresolved)}${fact("Partial drafts", partial)}${failure}${fact("Evaluation ID", evaluation.id)}${fact("Evaluation version", evaluation.version)}${fact("Created from revision", String(evaluation.createdFromRevision))}</dl></li>`;
  }).join("");
  return `<section class="panel-section evaluation-section"><span class="eyebrow">Post-call evaluation</span><h3>Current call quality review</h3><p class="muted">This is a read-only review of recorded evidence. Review completion does not resolve the conversation or any callback request.</p><ol class="evaluation-list">${evaluations}</ol></section>`;
}

type EvaluationRecord = Conversation["evaluations"][number];
type EvaluationChecks = NonNullable<EvaluationRecord["checks"]>;
type EvaluationCheck = NonNullable<EvaluationChecks[keyof EvaluationChecks]>;

function evaluationCheckEntries(checks: EvaluationChecks): ReadonlyArray<readonly [string, EvaluationCheck]> {
  return [
    ["Source preservation", checks.sourcePreservation],
    ["Callback confirmed before capture", checks.callbackBeforeCapture],
    ["Emergency canceled simulated transfer", checks.emergencyCancelsStub],
    ["No simulated staff connection claimed", checks.noRealStubConnection],
    ...(checks.stubFollowupSpeech === undefined ? [] : [["Stub follow-up in model transcript", checks.stubFollowupSpeech] as const]),
    ["Speech monitor", checks.monitor],
    ["Partial requests", checks.partialRequests],
    ["Voice audio quality", checks.voiceAudioQuality],
  ];
}

function evaluationStateLabel(state: EvaluationRecord["state"]): string {
  return state === "pending" ? "Quality review pending" : state === "failed" ? "Quality review failed" : "Quality review completed";
}

function evaluationVerdictLabel(verdict: EvaluationRecord["verdict"]): string {
  return verdict === null ? "Overall verdict not available" : `Overall verdict: ${words(verdict)}`;
}

function evaluationVerdictBadge(evaluation: EvaluationRecord): string {
  if (evaluation.state === "pending") return "Pending";
  if (evaluation.state === "failed") return "Unavailable";
  return evaluation.verdict === "passed" ? "Passed" : evaluation.verdict === "failed" ? "Failed" : "Unassessable";
}

function evaluationCheckLabel(check: EvaluationCheck): string {
  return check === "not_applicable" ? "Not applicable" : words(check);
}

function evaluationCheckClass(check: EvaluationCheck): string {
  return check === "passed" ? "passed" : check === "failed" ? "failed" : "attention";
}

function evaluationReasonLabel(reason: EvaluationRecord["reasons"][number]): string {
  const labels: Record<EvaluationRecord["reasons"][number], string> = {
    source_not_preserved: "Source was not preserved",
    callback_captured_unconfirmed: "Callback was captured before confirmation",
    emergency_transfer_active: "Simulated transfer remained active during emergency handling",
    emergency_intake_active: "Intake remained active during emergency handling",
    stub_connection_claim: "Simulated staff connection was represented as real",
    stub_followup_transcript_missing: "Stub follow-up question was absent from model output",
    stub_followup_transcript_unavailable: "Stub follow-up model output is unavailable",
    monitor_missing: "Speech monitor evidence is missing",
    monitor_critical: "Speech monitor found a critical issue",
    partial_request: "A callback request remains partial",
    history_unavailable: "Conversation history was unavailable",
    no_heard_audio_artifact: "No heard-audio artifact is available",
  };
  return labels[reason];
}

function priorCallsBlock(conversation: Conversation, input: ConversationConsoleInput): string {
  const projection = input.historyProjection;
  if (projection === undefined) return "";
  if (isWhatsAppSandbox(conversation)) {
    return `<section class="panel-section caller-history"><span class="eyebrow">Caller history</span><h3>Recent WhatsApp Sandbox messages from this number</h3><p class="history-unavailable" role="status">Transport-specific history is not available in this view.</p>${phoneMatchDisclaimer()}</section>`;
  }
  const title = input.channel === "voice" ? "Recent calls from this number" : "Recent SMS from this number";
  if (projection.availability === "unavailable" || projection.channel !== input.channel) {
    return `<section class="panel-section caller-history"><span class="eyebrow">Caller history</span><h3>${title}</h3><p class="history-unavailable" role="status">History is temporarily unavailable.</p>${phoneMatchDisclaimer()}</section>`;
  }
  const recent = projection.recent.filter((item) => item.conversationId !== conversation.id).slice(0, 5);
  const list = recent.length === 0
    ? `<p class="muted">No prior ${input.channel === "voice" ? "calls" : "SMS conversations"} from this number.</p>`
    : `<ol class="recent-conversations">${recent.map((item) => `<li><a href="${esc(conversationHref(input.channel, item.conversationId, input.page, input.filter))}"><strong>${esc(item.requestSummary || "No request captured")}</strong><span>${esc(historyPhaseLabel(item.phase))} · ${esc(item.nextStep)}</span><time datetime="${esc(item.createdAt)}" title="${esc(item.createdAt)}">${esc(formatTime(item.createdAt))}</time></a></li>`).join("")}</ol>`;
  const count = projection.priorCount > recent.length ? `<p class="history-count">Showing ${recent.length} of ${projection.priorCount} prior ${input.channel === "voice" ? "calls" : "SMS conversations"}.</p>` : "";
  return `<section class="panel-section caller-history"><span class="eyebrow">Caller history</span><h3>${title}</h3>${historyCoverage(input)}${list}${count}${phoneMatchDisclaimer()}</section>`;
}

function phoneMatchDisclaimer(): string {
  return `<p class="phone-match-disclaimer">Matched by caller number only, not verified patient history.</p>`;
}

function conversationTransportLabel(conversation: Conversation): string {
  if (conversation.admission.channel === "voice") return "Voice";
  return isWhatsAppSandbox(conversation) ? "WhatsApp Sandbox" : "SMS";
}

function whatsAppSandboxLabel(conversation: Conversation): string {
  return isWhatsAppSandbox(conversation) ? `<span class="transport-label">WhatsApp Sandbox</span>` : "";
}

function isWhatsAppSandbox(conversation: Conversation): boolean {
  return conversation.admission.channel === "sms" && conversation.admission.messageTransport === "whatsapp";
}

function whatsAppReplyWindowState(conversation: Conversation): "open" | "expired" | "unavailable" {
  if (!isWhatsAppSandbox(conversation)) return "open";
  const { lastInboundAt } = conversation;
  if (lastInboundAt === null || lastInboundAt === undefined) return "unavailable";
  const lastInboundMs = Date.parse(lastInboundAt);
  if (Number.isNaN(lastInboundMs)) return "unavailable";
  return Date.now() - lastInboundMs >= 24 * 60 * 60 * 1000 ? "expired" : "open";
}

function historyCoverage(input: ConversationConsoleInput): string {
  const projection = input.historyProjection;
  if (projection === undefined) return "";
  if (projection.availability === "unavailable" || projection.channel !== input.channel) return `<span class="history-coverage unavailable" data-history-coverage>History coverage unavailable</span>`;
  if (projection.earliestRetainedAt === null) return `<span class="history-coverage" data-history-coverage>${input.channel === "voice" ? "No call history yet" : "No SMS history yet"}</span>`;
  const prefix = input.channel === "voice" ? "History available since" : "SMS history available since";
  return `<span class="history-coverage" data-history-coverage>${prefix} <time datetime="${esc(projection.earliestRetainedAt)}" title="${esc(projection.earliestRetainedAt)}">${esc(formatDate(projection.earliestRetainedAt))}</time></span>`;
}

function notesBlock(conversation: Conversation, csrfToken: string, entries: readonly HistoryEntry[]): string {
  const notes = entries.length === 0 ? `<p class="muted">No staff notes.</p>` : `<ol class="notes-list">${[...entries].reverse().map((entry) => {
    const command = entry.input.command;
    const note = command.type === "staff.note" ? command.note : "";
    return `<li><p>${esc(note)}</p><div><strong>${esc(entry.input.actor.id)}</strong><time datetime="${esc(entry.receipt.occurredAt)}" title="${esc(entry.receipt.occurredAt)}">${esc(formatTime(entry.receipt.occurredAt))}</time>${entry.receipt.accepted ? "" : `<span class="history-failed">Rejected · ${esc(entry.receipt.error ?? "Unknown error")}</span>`}</div></li>`;
  }).join("")}</ol>`;
  const composer = commandForm(conversation, csrfToken, "staff.note", `<label>New note<textarea name="note" data-draft-key="staff-note" maxlength="8000" required></textarea></label><button type="submit">Add note</button>`, "note-form");
  return `<section class="panel-section"><span class="eyebrow">Append-only notes</span><h3>Staff notes</h3>${notes}${composer}</section>`;
}

function historyBlock(conversation: Conversation, entries: readonly HistoryEntry[]): string {
  const history = entries.length === 0 ? `<p class="muted">No recorded activity.</p>` : `<ol class="history-list">${[...entries].reverse().map((entry) => {
    const detail = commandDetail(entry.input.command);
    return `<li><div><time datetime="${esc(entry.receipt.occurredAt)}" title="${esc(entry.receipt.occurredAt)}">${esc(formatTime(entry.receipt.occurredAt))}</time><strong>${esc(entry.input.actor.id)}</strong><span>${esc(actorKindLabel(entry.input.actor.kind))}</span></div><p><strong>${esc(commandLabel(entry.input.command, conversation))}</strong>${detail === "" ? "" : `<span>${esc(detail)}</span>`}</p><span class="history-result ${entry.receipt.accepted ? "accepted" : "failed"}">${entry.receipt.accepted ? `Accepted · revision ${entry.receipt.state.revision}` : `Rejected · ${esc(entry.receipt.error ?? "Unknown error")}`}</span></li>`;
  }).join("")}</ol>`;
  return `<section class="panel-section"><span class="eyebrow">Append-only history</span><h3>Activity</h3>${history}</section>`;
}

function technicalBlock(conversation: Conversation): string {
  return `<details class="technical-state"><summary>Technical state</summary><dl class="conversation-facts">
    ${fact("Schema version", String(conversation.schemaVersion))}${fact("Conversation ID", conversation.id)}${fact("External ID", conversation.admission.externalId)}${fact("Practice ID", conversation.admission.practiceId)}${fact("Instance ID", conversation.admission.instanceId)}${fact("Config version", conversation.admission.configVersion)}${fact("Provider", conversation.admission.provider)}${fact("Account ID", conversation.admission.accountId)}${fact("Revision", String(conversation.revision))}${fact("Owner epoch", String(conversation.ownerEpoch))}${fact("Voice epoch", String(conversation.voiceEpoch))}${fact("Suppression revision", String(conversation.suppressionRevision))}
  </dl></details>`;
}

function commandForm(conversation: Conversation, csrfToken: string, type: ConversationCommand["type"], fields: string, className = "command-form"): string {
  const action = `/staff/conversations/${encodeURIComponent(conversation.id)}/command`;
  const eventId = randomUUID();
  return `<form class="${className}" method="post" action="${esc(action)}"><input type="hidden" name="csrf" value="${esc(csrfToken)}"><input type="hidden" name="eventId" value="${esc(eventId)}"><input type="hidden" name="revision" value="${conversation.revision}"><input type="hidden" name="ownerEpoch" value="${conversation.ownerEpoch}"><input type="hidden" name="type" value="${type}">${fields}</form>`;
}

function pagination(input: ConversationConsoleInput): string {
  const previous = input.page > 1 ? `<a href="${esc(consoleHref(input.channel, input.page - 1, input.filter))}">← Previous</a>` : `<span></span>`;
  const next = (input.page - 1) * 25 + input.rows.length < input.total ? `<a href="${esc(consoleHref(input.channel, input.page + 1, input.filter))}">Next →</a>` : `<span></span>`;
  return `<nav class="conversation-pagination" aria-label="Conversation pages">${previous}<span>Page ${input.page} · ${input.total} total</span>${next}</nav>`;
}

function consoleHref(channel: "voice" | "sms", page: number, filter?: ConversationConsoleFilter): string {
  const params = new URLSearchParams({ channel });
  if (filter !== undefined) params.set("filter", filter);
  if (page > 1) params.set("page", String(page));
  return `/staff?${params.toString()}`;
}

function conversationHref(channel: "voice" | "sms", id: string, page: number, filter?: ConversationConsoleFilter): string {
  const params = new URLSearchParams({ channel });
  if (filter !== undefined) params.set("filter", filter);
  params.set("selected", id);
  params.set("page", String(page));
  return `/staff?${params.toString()}`;
}

function metricHref(channel: "voice" | "sms", filter: ConversationConsoleFilter | undefined, selected: string | undefined): string {
  const params = new URLSearchParams({ channel });
  if (filter !== undefined) params.set("filter", filter);
  if (selected !== undefined) params.set("selected", selected);
  return `/staff?${params.toString()}`;
}

function filterHeading(channel: "voice" | "sms", filter: ConversationConsoleFilter | undefined): string {
  const noun = channel === "voice" ? "calls" : "SMS conversations";
  if (filter === "active_now") return `Active ${noun}`;
  if (filter === "needs_follow_up") return `${channel === "voice" ? "Calls" : "SMS"} needing follow-up`;
  if (filter === "connected_to_staff") return `${channel === "voice" ? "Calls" : "SMS"} connected to staff`;
  if (filter === "resolved_by_human") return `${channel === "voice" ? "Calls" : "SMS"} resolved by staff`;
  if (filter === "resolved_by_ai") return `${channel === "voice" ? "Calls" : "SMS"} resolved by AI`;
  return channel === "voice" ? "Voice" : "SMS";
}

function latestRequest(conversation: Conversation): Conversation["requests"][number] | undefined {
  return conversation.requests.find((request) => request.state !== "completed" && request.state !== "ai_resolved" && request.state !== "abandoned")
    ?? [...conversation.requests].reverse().find((request) => request.state !== "abandoned")
    ?? conversation.requests.at(-1);
}

function nextStep(conversation: Conversation): string {
  if (hasUnreleasedUnknownDelivery(conversation) || conversation.messages.some((message) => message.state === "submitting")) return "Check message delivery";
  if (hasFailedDeliveryWithOpenRequest(conversation)) return "Review failed message delivery";
  const request = latestRequest(conversation);
  if (request?.state === "in_progress") return "Complete callback";
  if (request?.state === "needs_callback") return "Call back";
  if (request?.state === "draft") return "Complete message details";
  if (request?.state === "ai_resolved" && !hasAiResolution(request)) return "Review missing resolution proof";
  if (hasUnresolvedSpeechReview(conversation)) return "Review generated speech";
  const requestsTerminal = conversation.requests.length > 0
    && conversation.requests.every((item) => item.state === "completed" || item.state === "abandoned" || hasAiResolution(item));
  if (requestsTerminal) return "No follow-up needed";
  if (conversation.phase === "active") return conversation.owner === "staff" ? "Staff reply" : "AI handling";
  return "Review incomplete conversation";
}

function conversationStatus(conversation: Conversation): string {
  const pending = conversation.requests.find((request) => request.state === "in_progress" || request.state === "needs_callback");
  const missingResolutionProof = conversation.requests.some((request) => request.state === "ai_resolved" && !hasAiResolution(request));
  const unknownDeliveryNeedsReview = hasUnreleasedUnknownDelivery(conversation);
  const failedDeliveryNeedsReview = hasFailedDeliveryWithOpenRequest(conversation);
  const deliveryNeedsReview = unknownDeliveryNeedsReview || failedDeliveryNeedsReview;
  const speechNeedsReview = hasUnresolvedSpeechReview(conversation);
  const requestsTerminal = conversation.requests.length > 0
    && conversation.requests.every((request) => request.state === "completed" || request.state === "abandoned" || hasAiResolution(request));
  const hasOperationalBlocker = missingResolutionProof || deliveryNeedsReview || speechNeedsReview;
  const resolvedByHuman = !hasOperationalBlocker && requestsTerminal && conversation.requests.some((request) => request.state === "completed" && request.outcome !== null);
  const resolvedByAi = !hasOperationalBlocker && requestsTerminal
    && conversation.requests.some(hasAiResolution)
    && conversation.requests.every((request) => request.state === "abandoned" || hasAiResolution(request));
  const label = pending?.state === "in_progress" ? "Callback in progress"
    : pending?.state === "needs_callback" ? "Needs callback"
    : missingResolutionProof ? "Resolution proof unavailable"
    : unknownDeliveryNeedsReview ? "Delivery review needed"
    : failedDeliveryNeedsReview ? "Delivery failed"
    : conversation.requests.some((request) => request.state === "draft") ? "Incomplete message"
    : speechNeedsReview ? "Speech review needed"
    : resolvedByHuman ? "Resolved by human"
    : resolvedByAi ? "Resolved by AI"
    : conversation.owner === "waiting_for_staff" ? "Waiting for staff"
    : conversation.phase !== "active" ? phaseLabel(conversation.phase)
    : conversation.owner === "staff" ? "Staff handling" : "AI handling";
  const tone = pending !== undefined || conversation.requests.some((request) => request.state === "draft") || hasOperationalBlocker || conversation.owner === "waiting_for_staff" ? "attention" : requestsTerminal || conversation.phase !== "active" ? "neutral" : "active";
  return `<span class="state-badge ${tone}">${esc(label)}</span>`;
}

function hasUnresolvedSpeechReview(conversation: Conversation): boolean {
  return conversation.speechReviews.some((review) => review.verdict !== "clear" && review.correction !== "staff_resolved");
}

function deliveryBadge(conversation: Conversation): string {
  if (hasUnreleasedUnknownDelivery(conversation)) return `<span class="delivery-badge unknown">Delivery unknown · send held</span>`;
  if (hasFailedDeliveryWithOpenRequest(conversation)) return `<span class="delivery-badge failed">Delivery failed · review message</span>`;
  const latest = conversation.messages.at(-1);
  if (latest === undefined) return `<span class="delivery-badge neutral">No messages</span>`;
  return messageStateBadge(latest.state, latest.sendHoldReleased);
}

function hasUnreleasedUnknownDelivery(conversation: Conversation): boolean {
  return conversation.messages.some((message) => message.state === "unknown" && !message.sendHoldReleased);
}

function hasFailedDeliveryWithOpenRequest(conversation: Conversation): boolean {
  return hasOpenRequest(conversation) && conversation.messages.some((message) => message.state === "failed" || message.state === "undelivered");
}

function hasOpenRequest(conversation: Conversation): boolean {
  return conversation.requests.some((request) => request.state !== "completed" && !hasAiResolution(request));
}

function sandboxNotJoinedGuidance(conversation: Conversation, message: Conversation["messages"][number]): string {
  if (!isWhatsAppSandbox(conversation) || !["failed", "undelivered"].includes(message.state) || failureReason(message) !== "sandbox_not_joined") return "";
  if (hasOpenRequest(conversation)) {
    return `<div class="send-warning" data-whatsapp-sandbox-not-joined><strong>Tester is not joined to the WhatsApp Sandbox.</strong><span>Ask the tester to rejoin, then wait for a new WhatsApp message. Do not send an SMS fallback.</span></div>`;
  }
  if (!hasRequestResolutionEvidence(conversation)) {
    return `<div class="send-warning" data-whatsapp-sandbox-not-joined><strong>Tester is not joined to the WhatsApp Sandbox.</strong><span>Ask the tester to rejoin if follow-up is still needed. Do not send an SMS fallback.</span></div>`;
  }
  return `<div class="send-warning" data-whatsapp-sandbox-not-joined><strong>Earlier WhatsApp Sandbox delivery failed because the tester was not joined.</strong><span>The request is resolved; no reply is pending.</span></div>`;
}

function hasRequestResolutionEvidence(conversation: Conversation): boolean {
  return conversation.requests.some((request) => request.state === "completed" || hasAiResolution(request));
}

function failureReason(message: Conversation["messages"][number]): "sandbox_not_joined" | null {
  return message.failureReason === "sandbox_not_joined" ? message.failureReason : null;
}

function messageStateBadge(state: Conversation["messages"][number]["state"], holdReleased: boolean): string {
  const value = state === "queued" ? ["Pending · queued", "pending"]
    : state === "submitting" ? ["Pending · submitting", "pending"]
    : state === "accepted" ? ["Pending · provider accepted", "pending"]
    : state === "delivered" ? ["Delivered", "delivered"]
    : state === "undelivered" ? ["Undelivered", "failed"]
    : state === "unknown" ? [holdReleased ? "Delivery unknown · hold released" : "Delivery unknown · send held", "unknown"]
    : state === "failed" ? ["Send failed", "failed"] : ["Canceled", "neutral"];
  return `<span class="delivery-badge ${value[1]}">${value[0]}</span>`;
}

function commandLabel(command: ConversationCommand, conversation: Conversation): string {
  const transport = conversation.admission.channel === "sms" ? conversationTransportLabel(conversation) : "SMS";
  switch (command.type) {
    case "controlled_transfer.prepare": return "Test recipient transfer prepared";
    case "controlled_transfer.dispatch": return "Test recipient transfer dispatch updated";
    case "controlled_transfer.update": return "Test recipient call progress recorded";
    case "controlled_transfer.finish": return "Test recipient transfer outcome recorded";
    case "controlled_transfer.resume": return "Caller returned to AI message capture";
    case "simulated_route.record": return `Simulated ${words(command.outcome.outcome)} route outcome recorded`;
    case "voice.read_presented": return "Verified answer audio sent";
    case "monitor.review": return "Generated speech reviewed";
    case "monitor.correction_claim": return "Speech correction claimed";
    case "monitor.resolve": return "Speech review resolved by staff";
    case "request.callback_attempt": return "Callback attempt recorded";
    case "evaluation.record": return "Post-call quality evaluation recorded";
    case "evaluation.schedule": return "Post-call quality review " + command.version + " scheduled";
    case "input.record": return "Inbound input recorded";
    case "question.activate": return "Question activated";
    case "question.clear_verified_identity": return "Verified identity question cleared";
    case "question.pause_callback": return "Caller paused callback intake";
    case "clarification.ask": return "Routing clarification asked";
    case "emergency.assess": return "Emergency risk assessed";
    case "transfer.start": return "Simulated transfer started";
    case "transfer.finish": return "Simulated transfer finished";
    case "request.draft": return "Callback request updated";
    case "request.abandon": return "Pending appointment change withdrawn";
    case "request.abandon_callback": return "Callback request withdrawn for resumed scheduling";
    case "request.capture_callback_message": return "Caller callback message captured";
    case "request.confirm_callback": return "Callback number confirmed";
    case "request.confirm_and_capture_callback": return "Callback request confirmed and captured";
    case "request.capture": return "Callback request captured";
    case "request.degraded_callback_handoff": return "Degraded callback handoff created";
    case "request.supplement": return "Callback request supplemented";
    case "request.correct_contact": return "Callback contact corrected";
    case "request.claim": return "Callback request claimed";
    case "request.complete": return "Callback request completed";
    case "request.resolve_ai": return "Request resolved by AI";
    case "staff.note": return "Staff note added";
    case "owner.change": return "Conversation owner changed";
    case "sms.suppression": return `${transport} permission changed`;
    case "sms.inbound_activity": return `${transport} inbound activity recorded`;
    case "sms.queue": return `${transport} queued`;
    case "emergency.sms_instruction": return `${transport} emergency instruction queued`;
    case "sms.dispatch": return `${transport} dispatch started`;
    case "sms.window_expire": return "WhatsApp reply window expired";
    case "sms.receipt": return `${transport} delivery receipt`;
    case "sms.release_hold": return "Unknown-send hold released";
    case "sms.unsupported_media": return command.kind === "media"
      ? `${transport} attachment received without text`
      : `${transport} non-text message received`;
    case "voice.recover": return "Voice recovery claimed";
    case "voice.recovery_state": return "Voice recovery updated";
    case "voice.scripted_no_input": return "Fallback listening retry";
    case "voice.relay_end": return "Caller requested the end of the voice call";
    case "voice.late_evidence": return "Late voice evidence recorded";
    case "conversation.heartbeat": return "Voice activity lease renewed";
    case "conversation.disconnect": return "Conversation disconnected";
  }
}

function commandDetail(command: ConversationCommand): string {
  switch (command.type) {
    case "controlled_transfer.prepare": return `${words(command.attempt.category)} · ${command.attempt.recipientId}`;
    case "controlled_transfer.dispatch": return words(command.state);
    case "controlled_transfer.update": return words(command.attempt.state);
    case "controlled_transfer.finish": return command.outcome === "accepted" ? "Recipient accepted; resolution not confirmed" : words(command.outcome);
    case "controlled_transfer.resume": return "Original request retained";
    case "simulated_route.record": return `${words(command.outcome.category)} · simulated only · ${words(command.outcome.outcome)}`;
    case "voice.read_presented": return `${command.presentation.requestId} · Server playback finished; caller hearing unconfirmed`;
    case "request.resolve_ai": return `${command.requestId} · ${words(command.result.kind)}`;
    case "monitor.review": return `${command.review.id} · ${reviewVerdictLabel(command.review.verdict)} · ${correctionLabel(command.review.correction)}`;
    case "monitor.correction_claim": return command.reviewId;
    case "monitor.resolve": return `${command.reviewId} · ${command.outcome}`;
    case "request.callback_attempt": return `${command.requestId} · ${words(command.outcome)} · ${command.note}`;
    case "evaluation.record": return evaluationCommandDetail(command.result);
    case "evaluation.schedule": return command.version;
    case "input.record": return command.body;
    case "question.activate": return [command.questionId, words(command.kind), command.requestId].filter(Boolean).join(" · ");
    case "question.clear_verified_identity": return `${command.questionId} · ${command.requestId}`;
    case "question.pause_callback": return `${command.questionId} · ${command.requestId}`;
    case "clarification.ask": return "One routing clarification used";
    case "emergency.assess": return `${command.sourceEventId} · ${words(command.classification)}`;
    case "transfer.start": return `${words(command.category)} · ${command.timeoutSeconds} seconds`;
    case "transfer.finish": return words(command.state);
    case "request.draft": {
      const sourceEventId = "sourceEventId" in command && typeof command.sourceEventId === "string" ? command.sourceEventId : undefined;
      return [sourceEventId, command.originalRequest, command.name, command.callbackNumber].filter(Boolean).join(" · ");
    }
    case "request.abandon_callback": return `${command.requestId} → ${command.resumeRequestId}`;
    case "request.abandon": return `${command.requestId} · ${command.sourceEventId}`;
    case "request.capture_callback_message": return `${command.requestId} · ${command.sourceEventId}`;
    case "request.confirm_callback": return `${command.requestId} · ${command.callbackNumber}`;
    case "request.confirm_and_capture_callback": return `${command.requestId} · ${command.callbackNumber} · ${command.sourceEventId}`;
    case "request.capture": case "request.claim": return command.requestId;
    case "request.degraded_callback_handoff": return `${command.sourceRequestId} → ${command.callbackRequestId}`;
    case "request.supplement": return `${command.requestId} · ${command.sourceEventId}`;
    case "request.correct_contact": return [command.requestId, command.sourceEventId, command.name, command.callbackNumber].filter(Boolean).join(" · ");
    case "request.complete": return `${command.requestId} · ${command.outcome}`;
    case "staff.note": return command.note;
    case "owner.change": return ownerValueLabel(command.owner);
    case "sms.suppression": return command.suppressed ? "Suppressed" : "Available";
    case "sms.inbound_activity": return "Inbound message received";
    case "sms.queue": return `${command.messageId} · ${command.body}`;
    case "emergency.sms_instruction": return `${command.messageId} · ${command.sourceEventId}`;
    case "sms.dispatch": return `${command.messageId} · ${command.dispatchAttemptId}`;
    case "sms.window_expire": return command.messageId;
    case "sms.receipt": return `${command.messageId} · ${words(command.state)}${command.providerId ? ` · ${command.providerId}` : ""}`;
    case "sms.release_hold": return `${command.messageId} · ${command.note}`;
    case "sms.unsupported_media": return "";
    case "voice.recover": return `${command.recoveryId} · ${command.parentCallId} → ${command.childCallId}`;
    case "voice.recovery_state": return `${command.recoveryId} · ${words(command.state)}${command.attachmentId ? ` · ${command.attachmentId}` : ""}`;
    case "voice.scripted_no_input": return `${command.recoveryId} · attempt ${command.expectedAttempts + 1} of 3`;
    case "voice.relay_end": return `${command.recoveryId} · ${command.sourceEventId}`;
    case "voice.late_evidence": return `${command.recoveryId} · ${command.providerEventId} · ${words(command.observedState)}`;
    case "conversation.heartbeat": return `Voice epoch ${command.voiceEpoch} · lease until ${formatTime(command.leaseUntil)}`;
    case "conversation.disconnect": return "";
  }
}

function evaluationCommandDetail(evaluation: EvaluationRecord): string {
  const checks = evaluation.checks === null ? "Checks unavailable"
    : evaluationCheckEntries(evaluation.checks).map(([label, result]) => `${label}: ${evaluationCheckLabel(result)}`).join("; ");
  return `${evaluation.id} · ${evaluationStateLabel(evaluation.state)} · ${evaluationVerdictLabel(evaluation.verdict)} · ${checks}`;
}

function fact(label: string, value: string, rawTime?: string): string {
  const content = rawTime === undefined ? esc(value) : `<time datetime="${esc(rawTime)}" title="${esc(rawTime)}">${esc(value)}</time>`;
  return `<div><dt>${esc(label)}</dt><dd>${content}</dd></div>`;
}

function pendingQuestionFacts(conversation: Conversation): string {
  type PendingQuestion = { id: string; kind: string; requestId: string | null; requestRevision: number | null; callbackNumber: string | null; activatedRevision: number };
  const pending = (conversation as Conversation & { pendingQuestion?: PendingQuestion | null }).pendingQuestion;
  if (pending === undefined) return "";
  if (pending === null) return fact("Pending question", "None");
  return fact("Pending question", words(pending.kind)) + fact("Question ID", pending.id) + fact("Question request", pending.requestId ?? "General")
    + fact("Question request revision", pending.requestRevision === null ? "Not applicable" : String(pending.requestRevision))
    + fact("Question callback number", pending.callbackNumber === null ? "Not applicable" : formatPhone(pending.callbackNumber))
    + fact("Question activated revision", String(pending.activatedRevision));
}

function ownerLabel(conversation: Conversation): string {
  return conversation.owner === "staff" ? `Staff · ${conversation.staffActor ?? "Unassigned"}` : ownerValueLabel(conversation.owner);
}

function ownerValueLabel(owner: Conversation["owner"]): string {
  return owner === "ai" ? "AI" : owner === "waiting_for_staff" ? "Waiting for staff" : "Staff";
}

function hasAiResolution(request: Conversation["requests"][number]): request is Conversation["requests"][number] & { state: "ai_resolved"; aiResolution: AiResolution } {
  return request.state === "ai_resolved" && request.aiResolution !== null && request.aiResolution !== undefined;
}

function requestStateLabel(request: Conversation["requests"][number] | undefined, mode: Conversation["admission"]["mode"] = "receptionist"): string {
  const state = request?.state;
  if (state === "ai_resolved") return request !== undefined && hasAiResolution(request) ? "Resolved by AI" : "Resolution proof unavailable";
  if (state === "abandoned") return mode === "receptionist" ? "Callback withdrawn" : "Request withdrawn";
  if (mode === "receptionist") return state === undefined ? "No request" : state === "draft" ? "Received request" : state === "needs_callback" ? "Needs callback" : state === "in_progress" ? "Callback in progress" : "Callback completed";
  return state === undefined ? "No request" : state === "draft" ? "Request open" : state === "needs_callback" ? "Needs callback" : state === "in_progress" ? "Staff follow-up in progress" : "Staff follow-up completed";
}

function phaseLabel(phase: Conversation["phase"]): string {
  return phase === "active" ? "Active" : phase === "disconnected" ? "Disconnected" : "Closed";
}

function historyPhaseLabel(phase: Conversation["phase"]): string {
  return phase === "active" ? "Active conversation" : phase === "disconnected" ? "Disconnected" : "Closed";
}

function actorKindLabel(kind: CommandEnvelope["actor"]["kind"]): string {
  return kind === "ai" ? "AI" : kind === "staff" ? "Staff" : kind === "provider" ? "Provider" : "System";
}

function words(value: string): string {
  return value.split("_").map((part) => part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(date);
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

const CONSOLE_STYLE = `
.conversation-console{--console-panel:460px;min-height:100vh}.conversation-workspace{min-width:0;transition:margin-right 160ms ease}.conversation-console.has-selection .conversation-workspace{margin-right:var(--console-panel)}
.conversation-header{max-width:1120px}.conversation-header p{margin:0;color:#5d665f}.console-actor{display:grid;gap:4px;text-align:right;font:700 .78rem/1.3 "Trebuchet MS",sans-serif}.console-actor>span{color:#687068;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em}.console-live-status{display:inline-flex;align-items:center;justify-self:end;gap:6px;margin-top:5px;font-weight:700;text-transform:none!important;letter-spacing:.02em!important}.console-live-status:before{content:"";width:6px;height:6px;border-radius:50%;background:#a06a28}.console-live-status.live:before{background:#3f7655}.console-live-status.live{color:#3f7655}
.channel-tabs{display:flex;gap:6px;max-width:1120px;margin:0 auto;padding:0 24px 26px}.channel-tabs a{border:1px solid var(--line);color:var(--ink);padding:9px 16px;text-decoration:none;font:700 .78rem/1 "Trebuchet MS",sans-serif}.channel-tabs a[aria-current="page"]{background:var(--ink);border-color:var(--ink);color:white}.channel-tabs a:focus-visible,.conversation-panel-close:focus-visible{outline:3px solid #315b46;outline-offset:3px}
.conversation-main{max-width:1120px}.conversation-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-bottom:8px}.conversation-metric{display:grid;gap:7px;min-width:0;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink);padding:14px 12px;text-decoration:none;box-shadow:0 8px 24px #473f320c}.conversation-metric strong{font:700 1.55rem/1 Georgia,serif}.conversation-metric span{font:700 .69rem/1.25 "Trebuchet MS",sans-serif}.conversation-metric:hover,.conversation-metric.selected{border-color:#68866f;background:#edf3e8}.conversation-metric.selected{box-shadow:inset 0 -3px #3f7655}.conversation-metric:focus-visible{outline:3px solid #315b46;outline-offset:2px}.metric-context{margin:0 0 24px;color:#687068;font:400 .7rem/1.4 "Trebuchet MS",sans-serif}.conversation-heading{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid var(--line);margin-bottom:18px}.conversation-heading h2{font-size:2rem;margin:.2rem 0 .8rem}.queue-context{display:grid;justify-items:end;gap:4px;color:#5d665f;font:400 .72rem/1.35 "Trebuchet MS",sans-serif;padding-bottom:.9rem}.history-coverage{color:#5d665f;font:400 .7rem/1.35 "Trebuchet MS",sans-serif}.history-coverage.unavailable,.history-unavailable{color:#8d3429}
.conversation-table{overflow:auto;border:1px solid var(--line);border-radius:4px;background:var(--card);box-shadow:0 18px 50px #473f3212}.conversation-table-head,.conversation-row{display:grid;grid-template-columns:125px minmax(130px,1fr) minmax(180px,1.5fr) minmax(100px,.8fr) 130px 100px 14px;gap:10px;align-items:center;min-width:880px;padding:13px 14px}.conversation-table-head{background:#e7e1d5;border-bottom:1px solid var(--line);color:#61675f;font:700 .68rem/1 "Trebuchet MS",sans-serif;letter-spacing:.09em;text-transform:uppercase}.conversation-row{min-height:76px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;font:400 .78rem/1.35 "Trebuchet MS",sans-serif}.conversation-row:last-child{border-bottom:0}.conversation-row:hover,.conversation-row.selected{background:#edf3e8}.conversation-row:focus-visible{outline:3px solid #315b46;outline-offset:-3px}.caller-cell,.request-cell{display:grid;gap:4px;min-width:0}.caller-cell strong,.request-cell strong{font-family:inherit}.caller-cell span,.request-cell span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#5d665f}.caller-cell .transport-label{color:#315b46;font-weight:700}.conversation-row time{font-size:.72rem}.row-arrow{font:1.4rem/1 Georgia,serif;color:var(--sage)}
.console-region-changed{animation:console-region-changed 1400ms ease-out}@keyframes console-region-changed{0%{box-shadow:inset 4px 0 #3f7655;background:#e1eee0}100%{box-shadow:inset 0 0 transparent;background:transparent}}
.state-badge,.delivery-badge{display:inline-flex;width:max-content;max-width:100%;border:1px solid #9caf9e;border-radius:999px;padding:6px 8px;background:#edf3ea;color:#335e46;font:700 .67rem/1.1 "Trebuchet MS",sans-serif;letter-spacing:.02em}.state-badge.attention,.delivery-badge.pending{border-color:#d0a761;background:#fbefd6;color:#795315}.delivery-badge.failed{border-color:#d19b91;background:#f8e6e1;color:#8d3429}.delivery-badge.unknown{border-color:#c38b3c;background:#fff0d3;color:#724d16}.delivery-badge.delivered{border-color:#8fb49b;background:#e8f2e9;color:#315b46}.state-badge.neutral,.delivery-badge.neutral{border-color:#bbb6aa;background:#f0ede5;color:#5f635e}
.conversation-empty{display:grid;gap:6px;padding:36px;font-family:"Trebuchet MS",sans-serif}.conversation-empty span{color:#687068}.conversation-pagination{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px;margin-top:18px;font:700 .78rem/1 "Trebuchet MS",sans-serif}.conversation-pagination a{color:var(--ink);text-decoration:none}.conversation-pagination a:last-child{text-align:right}.conversation-pagination a:hover{text-decoration:underline}
.conversation-panel{position:fixed;z-index:10;inset:0 0 0 auto;width:var(--console-panel);max-width:100vw;overflow:auto;background:var(--card);border:0;border-left:1px solid var(--line);border-radius:0;padding:24px;box-shadow:none}.conversation-panel-header{display:flex;justify-content:space-between;gap:16px;align-items:start;border-bottom:1px solid var(--line);padding-bottom:18px;margin-bottom:0}.conversation-panel-header h2{font-size:1.55rem;line-height:1.1;margin:5px 0}.panel-id,.technical-id{display:block;color:#747a73;font:400 .68rem/1.35 "Trebuchet MS",sans-serif;overflow-wrap:anywhere}.conversation-panel-header-actions{display:flex;align-items:center;gap:14px}.conversation-panel-transcript-link{color:var(--ink);font:700 .72rem/1 "Trebuchet MS",sans-serif;text-decoration:underline;text-underline-offset:3px}.conversation-panel-close{color:var(--ink);font:2rem/1 Georgia,serif;text-decoration:none}
.panel-section{border-bottom:1px solid var(--line);padding:20px 0}.panel-section h3{margin:5px 0 0}.section-row{display:flex;justify-content:space-between;align-items:start;gap:14px}.section-row>div{display:grid;gap:4px}.section-row>div>span{color:#687068;font-size:.75rem}.conversation-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;margin-top:16px}.conversation-facts dd{overflow-wrap:anywhere}.command-form{margin:0;flex:0 0 auto}.command-form button{white-space:nowrap}.muted{color:#687068;font-size:.75rem;line-height:1.45}.send-disabled{border-left:3px solid var(--red);background:#f8e6e1;color:#7d342b;padding:12px;font-size:.78rem}
.command-form-status{margin:0;color:#315b46;font:700 .68rem/1.4 "Trebuchet MS",sans-serif}.command-form-status.failed{color:#8d3429}
.message-list,.input-list,.request-list,.notes-list,.history-list,.live-conversation-list{list-style:none;margin:14px 0 0;padding:0}.message-list>li,.input-list>li,.request-list>li{border-top:1px solid var(--line);padding:16px 0}.message-list>li:first-child,.input-list>li:first-child,.request-list>li:first-child{border-top:0;padding-top:0}.live-conversation-list li{border-top:1px solid var(--line);padding:12px 0}.live-conversation-list li:first-child{border-top:0;padding-top:0}.live-conversation-list li>div{display:flex;justify-content:space-between;gap:12px;color:#687068;font:700 .7rem/1.3 "Trebuchet MS",sans-serif}.live-conversation-list li>p{margin:6px 0;font-size:.87rem;line-height:1.5;overflow-wrap:anywhere}.live-conversation-list li>span{display:block;color:#687068;font:400 .67rem/1.35 "Trebuchet MS",sans-serif}.live-conversation-list li.assistant{border-left:2px solid var(--sage);padding-left:10px}.recorded-transcript-entry{border-top:1px solid var(--line);padding:14px 0}.recorded-transcript-entry:first-of-type{border-top:0;padding-top:0}.recorded-transcript-entry h4{margin:0;font:700 .82rem/1.35 "Trebuchet MS",sans-serif}.recorded-transcript-entry>p{color:#687068;font:400 .75rem/1.45 "Trebuchet MS",sans-serif}.recorded-transcript-segments{list-style:none;margin:12px 0;padding:0}.recorded-transcript-segments li{border-top:1px solid var(--line);padding:10px 0}.recorded-transcript-segments li:first-child{border-top:0;padding-top:0}.recorded-transcript-segments li>div{display:flex;justify-content:space-between;gap:12px;color:#687068;font:700 .7rem/1.3 "Trebuchet MS",sans-serif}.recorded-transcript-segments li>p{margin:6px 0 0;font:400 .87rem/1.5 "Trebuchet MS",sans-serif;overflow-wrap:anywhere}.recorded-transcript details{margin-top:12px;border-top:1px solid var(--line);padding-top:12px}.recorded-transcript summary{cursor:pointer;font:700 .75rem/1.35 "Trebuchet MS",sans-serif}.recorded-transcript details>p{margin:10px 0 0;white-space:pre-wrap;font:400 .84rem/1.5 "Trebuchet MS",sans-serif;overflow-wrap:anywhere}.message-meta{display:flex;justify-content:space-between;gap:12px;align-items:center}.message-meta>span{font-size:.72rem;color:#687068}.message-list p,.input-list p,.request-list p{font-size:.87rem;line-height:1.5;overflow-wrap:anywhere}.message-technical{display:grid;gap:5px;margin-top:10px}.message-technical>div{display:grid;grid-template-columns:105px 1fr;gap:10px}.message-technical dt,.message-technical dd{font-size:.65rem}.send-warning{display:grid;gap:8px;border-left:3px solid var(--amber);background:#fff4dc;padding:12px;font:400 .75rem/1.4 "Trebuchet MS",sans-serif}.send-warning form{display:grid;gap:8px}.send-warning label,.reply-form label,.note-form label,.request-list label{display:grid;gap:6px;font-size:.72rem;font-weight:700}.send-warning input,textarea{width:100%;padding:10px;border:1px solid var(--line);background:white;border-radius:2px;font:400 .85rem/1.4 "Trebuchet MS",sans-serif}textarea{min-height:84px;resize:vertical}.reply-form,.note-form{display:grid;gap:10px;border-top:1px solid var(--line);margin-top:16px;padding-top:16px}.reply-form button,.note-form button,.send-warning button{justify-self:start}
.recovery-list{display:grid;gap:8px;margin-top:18px}.recovery-list article{display:grid;grid-template-columns:1fr auto;gap:4px 10px;border-top:1px solid var(--line);padding-top:9px;font:400 .72rem/1.35 "Trebuchet MS",sans-serif}.recovery-list article>span{color:#687068}.recovery-list article dl{grid-column:1/-1}.request-list .command-form{display:grid;gap:8px;max-width:220px}.request-list .conversation-facts{margin-bottom:5px}.request-actions{display:grid;gap:12px;width:220px}.callback-attempt-form,.callback-complete-form{display:grid;gap:8px;border:1px solid var(--line);padding:12px}.callback-attempt-form label,.callback-complete-form label{display:grid;gap:6px;font:700 .7rem/1.3 "Trebuchet MS",sans-serif}.callback-attempt-form select,.callback-attempt-form textarea,.callback-complete-form textarea{width:100%;border:1px solid var(--line);border-radius:2px;background:white;padding:9px;font:400 .78rem/1.4 "Trebuchet MS",sans-serif}.callback-attempt-form p{margin:0;color:#687068;font:400 .66rem/1.4 "Trebuchet MS",sans-serif}.callback-attempt-form button,.callback-complete-form button{justify-self:start}.callback-complete-form{border-left:3px solid var(--sage)}
.full-request-plan{display:grid;gap:6px;margin:13px 0 2px;border-left:3px solid var(--sage);background:#f0ede5;padding:12px}.full-request-plan>strong{font:700 .88rem/1.3 "Trebuchet MS",sans-serif}.full-request-plan .conversation-facts{margin:5px 0 0}.full-request-plan>p{margin:3px 0 0;color:#687068;font:400 .67rem/1.4 "Trebuchet MS",sans-serif}
.ai-resolution-proof{display:grid;gap:6px;margin:10px 0 2px;border-left:3px solid #3f7655;background:#e8f2e9;padding:12px}.ai-resolution-proof .conversation-facts{margin:5px 0 0}.ai-resolution-proof>p{margin:3px 0 0;color:#4f6256;font:400 .67rem/1.4 "Trebuchet MS",sans-serif}
.ai-resolution-proof.missing{border-left-color:#c38b3c;background:#fff0d3}.ai-resolution-proof.missing>strong{font:700 .8rem/1.3 "Trebuchet MS",sans-serif}.ai-resolution-proof.missing>p{color:#724d16}
.speech-review-list{list-style:none;margin:14px 0 0;padding:0}.speech-review{border-top:1px solid var(--line);padding:16px 0}.speech-review:first-child{border-top:0;padding-top:0}.speech-review.unresolved{border-left:3px solid #c38b3c;padding-left:12px}.review-state{border:1px solid #9caf9e;border-radius:999px;padding:5px 8px;font:700 .65rem/1 "Trebuchet MS",sans-serif;white-space:nowrap}.review-state.attention{border-color:#d0a761;background:#fbefd6;color:#795315}.review-state.settled{background:#edf3ea;color:#335e46}.generated-transcript{display:grid;gap:5px;margin-top:13px;background:#f0ede5;padding:12px}.generated-transcript p{margin:0;font:400 .82rem/1.5 "Trebuchet MS",sans-serif;overflow-wrap:anywhere}.generated-transcript>span:last-child{color:#687068;font:400 .67rem/1.35 "Trebuchet MS",sans-serif}.monitor-resolve-form{display:grid;gap:9px;margin-top:14px}.monitor-resolve-form label{display:grid;gap:6px;font:700 .72rem/1.3 "Trebuchet MS",sans-serif}.monitor-resolve-form button{justify-self:start}
.evaluation-list{list-style:none;margin:14px 0 0;padding:0}.evaluation-record{border-top:1px solid var(--line);padding:16px 0}.evaluation-record:first-child{border-top:0;padding-top:0}.evaluation-state,.evaluation-check{display:inline-flex;width:max-content;max-width:100%;border:1px solid #bbb6aa;border-radius:999px;padding:5px 8px;font:700 .65rem/1 "Trebuchet MS",sans-serif}.evaluation-state.passed,.evaluation-check.passed{border-color:#8fb49b;background:#e8f2e9;color:#315b46}.evaluation-state.failed,.evaluation-check.failed{border-color:#d19b91;background:#f8e6e1;color:#8d3429}.evaluation-state.attention,.evaluation-check.attention{border-color:#d0a761;background:#fbefd6;color:#795315}.evaluation-checks{display:grid;gap:8px;margin:14px 0 0}.evaluation-checks>div{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e7e1d5;padding-bottom:8px}.evaluation-checks dt{font:400 .72rem/1.35 "Trebuchet MS",sans-serif}.evaluation-checks dd{margin:0;flex:0 0 auto}
.notes-list li{border-left:2px solid var(--sage);padding:0 0 16px 13px}.notes-list p{font-size:.82rem;line-height:1.45;margin:0 0 6px;overflow-wrap:anywhere}.notes-list div{display:flex;gap:9px;flex-wrap:wrap;color:#687068;font:400 .68rem/1.3 "Trebuchet MS",sans-serif}.recent-conversations{list-style:none;margin:12px 0 0;padding:0}.recent-conversations li{border-bottom:1px solid var(--line)}.recent-conversations li:last-child{border-bottom:0}.recent-conversations a{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:11px 0;color:var(--ink);text-decoration:none}.recent-conversations a:hover strong{text-decoration:underline}.recent-conversations strong,.recent-conversations span,.recent-conversations time{font-family:"Trebuchet MS",sans-serif}.recent-conversations strong{overflow-wrap:anywhere;font-size:.8rem}.recent-conversations span{grid-column:1;color:#687068;font-size:.68rem}.recent-conversations time{grid-column:2;grid-row:1/3;color:#687068;font-size:.65rem}.caller-history>.history-coverage{display:block;margin-top:7px}.history-count,.phone-match-disclaimer{color:#687068;font:400 .68rem/1.4 "Trebuchet MS",sans-serif}.phone-match-disclaimer{border-left:2px solid var(--sage);padding-left:9px}.history-list{display:grid;gap:0}.history-list li{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 12px;border-top:1px solid var(--line);padding:12px 0;font:400 .7rem/1.4 "Trebuchet MS",sans-serif}.history-list li>div{display:grid;align-content:start;gap:2px;color:#687068}.history-list li>p{display:grid;gap:3px;margin:0;overflow-wrap:anywhere}.history-list li>p strong{font-family:inherit}.history-list li>p span{color:#4f5852}.history-result{grid-column:2}.history-result.accepted{color:#315b46}.history-result.failed,.history-failed{color:#8d3429}.technical-state{margin:0;border-top:0;padding:18px 0}.technical-state summary{margin:0}.technical-state[open] summary{margin-bottom:16px}
@media(max-width:1000px){.conversation-console.has-selection .conversation-workspace{margin-right:0}.conversation-panel{position:relative;inset:auto;width:auto;max-width:none;max-height:none;border:1px solid var(--line);margin:0 18px 42px}.conversation-main{padding-bottom:28px}.conversation-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:720px){.conversation-header{padding:34px 18px 22px;gap:1rem;align-items:start;flex-direction:column}.conversation-header h1{font-size:2.65rem}.console-actor{display:flex;gap:7px;text-align:left;font-size:.7rem;white-space:nowrap}.console-live-status{margin:0 0 0 8px}.channel-tabs{padding:0 18px 22px}.conversation-main{padding:0 18px 28px}.conversation-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.conversation-heading{align-items:start;flex-direction:column}.queue-context{justify-items:start;padding:0 0 .8rem}.conversation-table{overflow:visible}.conversation-table-head{display:none}.conversation-row{grid-template-columns:minmax(0,1fr) auto;gap:8px;min-width:0;padding:15px}.conversation-row .status-cell{grid-column:1;grid-row:1}.conversation-row .updated-cell{grid-column:2;grid-row:1;text-align:right}.conversation-row .caller-cell{grid-column:1/-1;grid-row:2}.conversation-row .request-cell{grid-column:1/-1;grid-row:3;border-top:1px solid var(--line);padding-top:9px}.conversation-row .owner-cell{grid-column:1;grid-row:4;color:#5d665f}.conversation-row .delivery-cell{grid-column:2;grid-row:4;justify-self:end}.conversation-row .row-arrow{display:none}.caller-cell span,.request-cell span{white-space:normal}.conversation-panel{margin:0;border-width:1px 0 0;padding:18px}.conversation-facts{grid-template-columns:1fr}.section-row{align-items:start}.request-list .section-row{display:grid}.request-actions{width:100%;max-width:none}.message-meta{align-items:start;flex-direction:column}.history-list li{grid-template-columns:1fr}.history-result{grid-column:1}.recent-conversations a{grid-template-columns:1fr}.recent-conversations time{grid-column:1;grid-row:auto}.conversation-pagination{grid-template-columns:1fr auto 1fr}}
@media(prefers-reduced-motion:reduce){.conversation-workspace{transition:none}.console-region-changed{animation:none;box-shadow:inset 4px 0 #3f7655;background:#e8f2e9}}
`;
