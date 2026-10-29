/** Browser code served by the authenticated staff extension. */
export const CONVERSATION_CONSOLE_CLIENT_JS = String.raw`(() => {
  const ROOT_SELECTOR = "[data-conversation-console]";
  const QUEUE_SELECTOR = "[data-console-queue]";
  const PANEL_SELECTOR = "[data-console-panel-region]";
  const STATUS_SELECTOR = "[data-console-live-status]";
  const MAX_POLL_ATTEMPTS = 8;
  const MAX_DRAFT_CONVERSATIONS = 20;
  const POLL_INTERVAL_MS = 15000;
  const RECONNECT_DELAY_MS = 30000;
  const HIGHLIGHT_MS = 1400;
  const FILTERS = new Set(["total", "active_now", "needs_follow_up", "connected_to_staff", "resolved_by_human", "resolved_by_ai"]);
  let root = document.querySelector(ROOT_SELECTOR);
  if (!(root instanceof HTMLElement)) return;

  const draftsByConversation = new Map();
  let source = null;
  let sseErrors = 0;
  let pollAttempts = 0;
  let pollTimer = null;
  let reconnectTimer = null;
  let inFlight = false;
  let reconcileAgain = false;
  let queuedChangeId = null;

  function currentParams() {
    const page = new URLSearchParams(location.search);
    const filter = page.get("filter");
    return new URLSearchParams({
      channel: page.get("channel") === "voice" ? "voice" : "sms",
      ...(FILTERS.has(filter) ? { filter } : {}),
      ...(page.get("selected") ? { selected: page.get("selected") } : {}),
      page: page.get("page") || "1",
    });
  }

  function snapshotUrl() { return "/staff/conversations/snapshot?" + currentParams().toString(); }
  function eventsUrl() { return "/staff/conversations/events?channel=" + encodeURIComponent(root.dataset.channel || "sms"); }

  function setLive(live) {
    const status = root.querySelector(STATUS_SELECTOR);
    if (!(status instanceof HTMLElement)) return;
    status.textContent = live ? "Live" : "Updates delayed";
    status.classList.toggle("live", live);
    status.classList.toggle("stale", !live);
  }

  function selectedConversationId(region) {
    return region.querySelector("[data-selected-conversation]")?.getAttribute("data-selected-conversation") || null;
  }

  function draftControls(region) {
    return region.querySelectorAll("[data-draft-key]");
  }

  function captureDrafts(region) {
    const conversationId = selectedConversationId(region);
    if (conversationId === null) return;
    const values = draftsByConversation.get(conversationId) || new Map();
    for (const control of draftControls(region)) {
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement) && !(control instanceof HTMLSelectElement)) continue;
      values.set(control.dataset.draftKey, control.value);
    }
    draftsByConversation.delete(conversationId);
    draftsByConversation.set(conversationId, values);
    while (draftsByConversation.size > MAX_DRAFT_CONVERSATIONS) draftsByConversation.delete(draftsByConversation.keys().next().value);
  }

  function focusState(region) {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLTextAreaElement) && !(active instanceof HTMLSelectElement)) return null;
    if (!region.contains(active) || !active.dataset.draftKey) return null;
    return {
      conversationId: selectedConversationId(region),
      key: active.dataset.draftKey,
      selectionStart: "selectionStart" in active ? active.selectionStart : null,
      selectionEnd: "selectionEnd" in active ? active.selectionEnd : null,
    };
  }

  function restoreDrafts(region, focused) {
    const conversationId = selectedConversationId(region);
    const values = conversationId === null ? null : draftsByConversation.get(conversationId);
    for (const control of draftControls(region)) {
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement) && !(control instanceof HTMLSelectElement)) continue;
      const value = values?.get(control.dataset.draftKey);
      if (typeof value === "string") control.value = value;
      if (focused?.conversationId !== conversationId || focused.key !== control.dataset.draftKey) continue;
      control.focus({ preventScroll: true });
      if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && focused.selectionStart !== null && focused.selectionEnd !== null) control.setSelectionRange(focused.selectionStart, focused.selectionEnd);
    }
  }

  function submittedDraftKeys(form) {
    return Array.from(form.querySelectorAll("[data-draft-key]")).map((control) => control.dataset.draftKey).filter(Boolean);
  }

  function clearSubmittedDrafts(conversationId, keys) {
    const values = draftsByConversation.get(conversationId);
    for (const key of keys) values?.delete(key);
    const panel = root.querySelector(PANEL_SELECTOR);
    if (!(panel instanceof HTMLElement) || selectedConversationId(panel) !== conversationId) return;
    for (const control of draftControls(panel)) {
      if (!(control instanceof HTMLInputElement) && !(control instanceof HTMLTextAreaElement) && !(control instanceof HTMLSelectElement)) continue;
      if (keys.includes(control.dataset.draftKey)) control.value = "";
    }
  }

  function formStatus(form, message, failed) {
    let status = form.querySelector("[data-command-form-status]");
    if (!(status instanceof HTMLElement)) {
      status = document.createElement("p");
      status.dataset.commandFormStatus = "";
      status.className = "command-form-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      form.append(status);
    }
    status.textContent = message;
    status.classList.toggle("failed", failed);
  }

  async function submitCommand(form) {
    const action = new URL(form.action, location.href);
    if (action.origin !== location.origin || !/^\/staff\/conversations\/[^/]+\/command$/.test(action.pathname)) return;
    const panel = root.querySelector(PANEL_SELECTOR);
    const conversationId = panel instanceof HTMLElement ? selectedConversationId(panel) : null;
    if (conversationId === null) return;
    const body = new URLSearchParams();
    for (const [key, value] of new FormData(form)) if (typeof value === "string") body.append(key, value);
    const params = currentParams();
    if (params.has("filter")) body.set("filter", params.get("filter"));
    body.set("page", params.get("page") || "1");
    const eventId = body.get("eventId");
    const keys = submittedDraftKeys(form);
    const buttons = Array.from(form.querySelectorAll("button"));
    buttons.forEach((button) => { button.disabled = true; });
    formStatus(form, "Saving…", false);
    try {
      const response = await fetch(action, { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body });
      const contentType = response.headers.get("content-type") || "";
      const payload = contentType.includes("application/json") ? await response.json() : null;
      if (!response.ok || payload?.accepted !== true || payload.eventId !== eventId
        || !Number.isInteger(payload.revision) || payload.revision < 0) throw new Error("conversation_command_rejected");
      clearSubmittedDrafts(conversationId, keys);
      formStatus(form, "Saved", false);
      await reconcile(conversationId);
    } catch {
      formStatus(form, "Could not save. Your entries are still here.", true);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  function parseSnapshot(body) {
    const template = document.createElement("template");
    template.innerHTML = body;
    const nextRoot = template.content.querySelector(ROOT_SELECTOR);
    if (!(nextRoot instanceof HTMLElement)) throw new Error("conversation_snapshot_invalid");
    return nextRoot;
  }

  function highlight(element) {
    if (!(element instanceof HTMLElement)) return;
    element.classList.add("console-region-changed");
    setTimeout(() => element.classList.remove("console-region-changed"), HIGHLIGHT_MS);
  }

  function highlightChanged(queue, panel, conversationId) {
    if (conversationId === null) return;
    highlight(queue.querySelector('[data-conversation-id="' + CSS.escape(conversationId) + '"]'));
    const selected = panel.querySelector("[data-selected-conversation]");
    if (selected?.getAttribute("data-selected-conversation") === conversationId) highlight(selected);
  }

  function replaceRegions(nextRoot, changedConversationId) {
    root = document.querySelector(ROOT_SELECTOR);
    if (!(root instanceof HTMLElement)) throw new Error("conversation_root_missing");
    const currentQueue = root.querySelector(QUEUE_SELECTOR);
    const currentPanel = root.querySelector(PANEL_SELECTOR);
    const nextQueue = nextRoot.querySelector(QUEUE_SELECTOR);
    const nextPanel = nextRoot.querySelector(PANEL_SELECTOR);
    if (!(currentQueue instanceof HTMLElement) || !(currentPanel instanceof HTMLElement) || !(nextQueue instanceof HTMLElement) || !(nextPanel instanceof HTMLElement)) throw new Error("conversation_regions_missing");

    captureDrafts(currentPanel);
    const focused = focusState(currentPanel);
    const currentSelectedId = selectedConversationId(currentPanel);
    const currentSelected = currentPanel.querySelector("[data-selected-conversation]");
    const panelScroll = currentSelected instanceof HTMLElement ? currentSelected.scrollTop : 0;
    const openTechnicalState = currentPanel.querySelector("details.technical-state")?.hasAttribute("open") || false;
    const openTranscriptRecordings = Array.from(currentPanel.querySelectorAll("details[data-transcript-full-text][open]"))
      .map((detail) => detail.closest("[data-transcript-recording-id]")?.getAttribute("data-transcript-recording-id"))
      .filter((recordingId) => typeof recordingId === "string");
    const focusedRow = currentQueue.contains(document.activeElement) ? document.activeElement?.closest("[data-conversation-id]")?.getAttribute("data-conversation-id") : null;
    const windowScroll = window.scrollY;

    if (currentSelectedId !== null && selectedConversationId(nextPanel) === currentSelectedId) {
      for (const audio of currentPanel.querySelectorAll("audio[src]")) {
        const replacement = Array.from(nextPanel.querySelectorAll("audio[src]")).find((next) => next.getAttribute("src") === audio.getAttribute("src"));
        if (replacement) replacement.replaceWith(audio);
      }
    }

    currentQueue.replaceWith(nextQueue);
    currentPanel.replaceWith(nextPanel);
    root.className = nextRoot.className;
    root.dataset.channel = nextRoot.dataset.channel || root.dataset.channel;
    root.dataset.filter = nextRoot.dataset.filter || root.dataset.filter;

    restoreDrafts(nextPanel, focused);
    const nextSelected = nextPanel.querySelector("[data-selected-conversation]");
    if (nextSelected instanceof HTMLElement && selectedConversationId(nextPanel) === currentSelectedId) nextSelected.scrollTop = panelScroll;
    if (openTechnicalState) nextPanel.querySelector("details.technical-state")?.setAttribute("open", "");
    for (const recordingId of openTranscriptRecordings) nextPanel.querySelector('[data-transcript-recording-id="' + CSS.escape(recordingId) + '"] details[data-transcript-full-text]')?.setAttribute("open", "");
    if (focusedRow) nextQueue.querySelector('[data-conversation-id="' + CSS.escape(focusedRow) + '"]')?.focus({ preventScroll: true });
    window.scrollTo({ top: windowScroll, behavior: "instant" });
    highlightChanged(nextQueue, nextPanel, changedConversationId);
  }

  async function reconcile(changedConversationId = null) {
    if (document.hidden) return;
    if (inFlight) {
      reconcileAgain = true;
      if (changedConversationId !== null) queuedChangeId = changedConversationId;
      return;
    }
    inFlight = true;
    try {
      const response = await fetch(snapshotUrl(), { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) throw new Error("conversation_snapshot_unavailable");
      const payload = await response.json();
      if (!payload || typeof payload.title !== "string" || typeof payload.body !== "string") throw new Error("conversation_snapshot_invalid");
      replaceRegions(parseSnapshot(payload.body), changedConversationId);
    } catch {
      setLive(false);
    } finally {
      inFlight = false;
      if (reconcileAgain) {
        const nextChangeId = queuedChangeId;
        reconcileAgain = false;
        queuedChangeId = null;
        void reconcile(nextChangeId);
      }
    }
  }

  function stopSource() {
    if (source !== null) source.close();
    source = null;
  }

  function stopPolling() {
    if (pollTimer !== null) clearInterval(pollTimer);
    pollTimer = null;
    pollAttempts = 0;
  }

  function clearReconnect() {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect(delay = RECONNECT_DELAY_MS) {
    clearReconnect();
    if (document.hidden) return;
    reconnectTimer = setTimeout(connect, delay);
  }

  function startPolling() {
    stopSource();
    stopPolling();
    setLive(false);
    if (document.hidden) return;
    const poll = () => {
      if (document.hidden) { stopPolling(); return; }
      pollAttempts += 1;
      void reconcile();
      if (pollAttempts >= MAX_POLL_ATTEMPTS) { stopPolling(); scheduleReconnect(); }
    };
    poll();
    if (pollAttempts < MAX_POLL_ATTEMPTS) pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  function connect() {
    clearReconnect();
    stopSource();
    setLive(false);
    if (document.hidden) return;
    if (typeof EventSource !== "function") { startPolling(); return; }
    try { source = new EventSource(eventsUrl()); }
    catch { startPolling(); return; }
    source.onopen = () => { sseErrors = 0; };
    source.addEventListener("ready", () => {
      sseErrors = 0;
      stopPolling();
      setLive(true);
      void reconcile();
    });
    source.addEventListener("change", (event) => {
      try {
        const changed = JSON.parse(event.data);
        if (typeof changed.conversationId !== "string" || !Number.isInteger(changed.revision) || changed.revision < 0) return;
        setLive(true);
        void reconcile(changed.conversationId);
      } catch { /* Malformed notifications carry no state; the next valid snapshot remains authoritative. */ }
    });
    source.onerror = () => {
      sseErrors += 1;
      setLive(false);
      stopSource();
      if (sseErrors >= 3) startPolling();
      else scheduleReconnect(Math.min(5000, sseErrors * 1000));
    };
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { setLive(false); stopSource(); stopPolling(); clearReconnect(); }
    else connect();
  });
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !root.contains(form) || form.method.toLowerCase() !== "post") return;
    const action = new URL(form.action, location.href);
    if (action.origin !== location.origin || !/^\/staff\/conversations\/[^/]+\/command$/.test(action.pathname)) return;
    event.preventDefault();
    void submitCommand(form);
  });
  window.addEventListener("pagehide", () => { stopSource(); stopPolling(); clearReconnect(); }, { once: true });
  connect();
})();`;
