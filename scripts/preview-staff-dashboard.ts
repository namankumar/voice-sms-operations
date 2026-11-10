/** Static preview wrapper around the original staff renderer; fictional state only. */
import { writeFileSync } from "node:fs";
import { admissionSchema, newConversation } from "../services/process-shell/src/conversation-contract.js";
import { renderConversationConsole } from "../services/process-shell/src/conversation-console.js";

const now = "2026-01-15T12:00:00.000Z";
const state = newConversation(admissionSchema.parse({
  practiceId: "practice-synthetic", instanceId: "reception", configVersion: "preview-v1",
  mode: "receptionist", accountId: "AC-synthetic", provider: "twilio", channel: "voice",
  externalId: "synthetic-call", contact: "+12025550101", destination: "+12025550100", hours: "demo_open",
}), "synthetic-conversation", now);
const page = renderConversationConsole({ rows: [state], channel: "voice", selected: state, history: [],
 csrfToken: "static-preview-no-actions", actor: "Example staff", page: 1, total: 1,
 recordings: { state: "not_enabled" }, transcripts: "disabled" });
// CSP does not block ordinary anchor navigation. Keep only in-page links in this static export.
const body = page.body
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<a\b([^>]*?)\s+href="(?!#)[^"]*"([^>]*)>/gi,
    '<a$1 aria-disabled="true" tabindex="-1"$2>')
  .replace(/<form\b/gi, '<form inert aria-disabled="true"');
// Preview-only shell styles. The original renderer expects its private application shell.
// Keep this wrapper self-contained; do not fetch styles, fonts or client scripts.
const previewStyles = `<style>
:root{--ink:#25372c;--sage:#426b50;--line:#d9ddd3;--card:#fffdf8}
*{box-sizing:border-box}body{margin:0;background:#f5f3ec;color:var(--ink);font:15px/1.5 "Trebuchet MS",sans-serif}
h1,h2,h3,p{margin-top:0}h1,h2,h3{font-family:Georgia,serif}h1{font-size:2.8rem;line-height:1.1;margin-bottom:12px}h2{line-height:1.2}
header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin:auto;padding:40px 24px 28px}
main{margin:auto;padding:0 24px 36px}.eyebrow{display:block;font-size:.7rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin-bottom:10px;color:#687068}
a{color:var(--sage)}a[aria-disabled="true"]{cursor:default}form[inert]{opacity:.65}button,input,select,textarea{font:inherit}button{padding:7px 12px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:4px}
section{padding:22px 0;border-bottom:1px solid var(--line)}dl{margin:0}dt{font-size:.7rem;color:#687068}dd{margin:4px 0 0}summary{cursor:pointer}
.preview-notice{margin:0;padding:16px 24px;background:#fff3cd;color:#514216;font:14px/1.5 "Trebuchet MS",sans-serif;min-height:64px}
.preview-page .conversation-panel{top:64px}
@media(max-width:1000px){.preview-page .conversation-panel{top:auto}.preview-notice{padding:14px 18px}}
</style>`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Staff dashboard — synthetic preview</title>${previewStyles}</head><body class="preview-page"><p class="preview-notice">Static preview of the original staff renderer. Fictional data. Actions, recordings, live updates and network access are disabled.</p>${body}</body></html>`;
writeFileSync("staff-preview.html", html.split("\n").map(line => line.trimEnd()).join("\n"));
console.log("Wrote staff-preview.html using the original staff renderer. Open it in your browser.");
