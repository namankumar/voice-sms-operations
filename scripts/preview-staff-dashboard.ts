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
const body = page.body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Staff dashboard — synthetic preview</title></head><body><p style="padding:12px;font:16px sans-serif;background:#fff3cd">Static preview of the original staff renderer. Fictional data. Actions, recordings, live updates and network access are disabled.</p>${body}</body></html>`;
writeFileSync("staff-preview.html", html.split("\n").map(line => line.trimEnd()).join("\n"));
console.log("Wrote staff-preview.html using the original staff renderer. Open it in your browser.");
