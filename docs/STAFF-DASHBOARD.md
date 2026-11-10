# Original staff dashboard

The staff console is the real server-rendered interface from the voice/SMS system. The renderer and browser client are in [conversation-console.ts](../services/process-shell/src/conversation-console.ts) and [conversation-console-client.ts](../services/process-shell/src/conversation-console-client.ts); [conversation-staff.ts](../services/process-shell/src/conversation-staff.ts) contains the staff handler. This is distinct from the older fixture-only operations-console prototype.

The interface exposes conversation queues, selected conversation state, request ownership, follow-up activity, evidence history, transcript/review projections and links between the call and its operational obligations. The real handler requires its surrounding authenticated gateway and CSRF verification; exporting it does not make an unauthenticated production staff app.

## Inspect without a client system

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dashboard:preview
pnpm dashboard:test
```

Open `staff-preview.html` in a browser, or download the [committed static preview](staff-dashboard-preview.html). The preview invokes the original renderer with a fictional conversation; it is a static presentation: scripts are removed, forms are inert and blocked by CSP, and navigation links are disabled except for in-page anchors. CSP blocks network resources. It does not connect to calls, recordings, customer records, a database or a live gateway. The small preview wrapper is new packaging; it supplies self-contained shell styles that the renderer expects around its output. Those preview styles are not an export of the private application shell, and they do not replace the original dashboard implementation.

The selected original renderer/handler tests use fictional state and local fake ports. Their staff HTTP tests use ephemeral loopback servers only. They check rendering, escaping, ownership/receipt display and scoped requests; they are not production caller, audio, ASR, TTS or model evaluation. See [verification and evidence limits](VERIFICATION.md).

The [dashboard source manifest](STAFF-DASHBOARD-MANIFEST.json) records original dependency files and their sanitized content digests. Practice/staff labels and concrete phone literals have been generalized; no patient data, raw recordings, credentials or deployment settings are included. The original private source remains unchanged.
