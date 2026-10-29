import { parseReceptionistCandidateAttemptId } from "./receptionist-voice-candidate.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { IngressRejected, parseSmsAdmission, parseVoiceAdmission, parseWhatsappAdmission } from "./conversation-ingress.js";
import type { InboundSmsAdmission, InboundSmsReceipt } from "./conversation-store.js";
import { voiceAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";

type Form = Readonly<Record<string, string>>;
export type ScriptedGatherBinding = { parentCallId: string; capability: string; sourceId: string; emptyAttempts: number };
export type ControlledTransferHttpPath = "/f3/transfer/serve" | "/f3/transfer/dial" | "/f3/transfer/status" | "/f3/transfer/screen" | "/f3/transfer/screen/decision";
export type ControlledVoiceAdmissionPort = {
  claim(input: { accountId: string; caller: string; destination: string; parentCallId: string }): Promise<{ attemptId: string } | { rejected: true } | null>;
  confirm(input: { attemptId: string; accountId: string; caller: string; destination: string; parentCallId: string; digits: string }): Promise<boolean>;
};
export interface ReceptionistHttpPorts {
  ready(): Promise<boolean>;
  voiceRelease?(): { candidateProfileSha256: string | null; rehearsalProfileSha256: string | null; operatorDemoProfileSha256?: string | null };
  audioAsset?(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  verifyTwilio(request: IncomingMessage, path: string): Promise<Form>;
  admitSms(input: InboundSmsAdmission): Promise<InboundSmsReceipt>;
  smsStatus(input: { parameters: Form; attemptId: string }): Promise<void>;
  voice(input: { kind: "inbound" | "action" | "recover" | "status"; parameters: Form; actionAttemptId?: string; recoveryId?: string; recoveryTarget?: "relay" | "scripted"; recoveryStage?: "serve" | "gather" | "complete"; completion?: { parentCallId: string; capability: string }; gather?: ScriptedGatherBinding }): Promise<string>;
  controlledTransfer?(input: { path: ControlledTransferHttpPath; parameters: Form; token: string }): Promise<string>;
  controlledVoiceAdmission?: ControlledVoiceAdmissionPort;
  openAIWebhook(request: IncomingMessage): Promise<void>;
  staff(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** Dedicated instance router; no route falls through to the existing demo. */
export function createReceptionistHttpHandler(options: {
  instance: VoiceAppInstance;
  threadExpirySeconds: number;
  ports: ReceptionistHttpPorts;
}) {
  const instance = voiceAppInstanceSchema.parse(options.instance);
  if (!Number.isSafeInteger(options.threadExpirySeconds) || options.threadExpirySeconds < 1 || options.threadExpirySeconds > 604_800) throw new Error("sms_thread_expiry_invalid");
  const ports = options.ports;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "https://receptionist.internal");
      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
        const ready = await ports.ready();
        return json(response, ready ? 200 : 503, { service: "vegas-receptionist", mode: "synthetic_only", ready, ...(ports.voiceRelease === undefined ? {} : { voiceRelease: ports.voiceRelease() }) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/voice/audio/") && ports.audioAsset) { if (await ports.audioAsset(request, response)) return; throw new IngressRejected(403, "voice_audio_asset_rejected"); }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(303, { Location: "/staff", "Cache-Control": "no-store" }); response.end(); return;
      }
      if (url.pathname === "/staff" || url.pathname.startsWith("/staff/")) return await ports.staff(request, response);
      if (request.method !== "POST") return json(response, 405, { error: "post_required" });
      if (url.pathname === "/openai/webhook") {
        await ports.openAIWebhook(request);
        return json(response, 200, { accepted: true });
      }
      const controlledPath = ["/f3/transfer/serve", "/f3/transfer/dial", "/f3/transfer/status", "/f3/transfer/screen", "/f3/transfer/screen/decision"].includes(url.pathname)
        ? url.pathname as ControlledTransferHttpPath : null;
      if (controlledPath !== null) {
        if (instance.mode !== "receptionist" || instance.dataMode !== "synthetic_only" || ports.controlledTransfer === undefined) return json(response, 404, { error: "not_found" });
        const tokens = url.searchParams.getAll("token");
        if (tokens.length !== 1 || !/^[A-Za-z0-9_-]{16,128}\.[0-9]{10,13}\.[A-Za-z0-9_-]{43}$/.test(tokens[0]!)) throw new IngressRejected(400, "controlled_transfer_token_invalid");
        const parameters = await ports.verifyTwilio(request, controlledPath);
        if (parameters.AccountSid !== instance.accountId) throw new IngressRejected(403, "account_binding_mismatch");
        return xml(response, await ports.controlledTransfer({ path: controlledPath, parameters, token: tokens[0]! }));
      }
      const recovery = url.pathname.match(/^\/voice\/recovery\/(relay|scripted)\/([A-Za-z0-9_-]{1,120})\/(serve|gather|complete)$/);
      const attempts = url.pathname === "/voice/action" ? url.searchParams.getAll("attempt_id") : [];
      const controlledConfirm = url.pathname === "/voice/controlled/confirm";
      if (!["/sms/inbound", "/whatsapp/inbound", "/sms/status", "/voice/inbound", "/voice/action", "/voice/status", "/voice/controlled/confirm"].includes(url.pathname) && !recovery) return json(response, 404, { error: "not_found" });
      if (url.pathname === "/voice/action" && (attempts.length !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attempts[0]!))) throw new IngressRejected(400, "attempt_id_invalid");
      const parameters = await ports.verifyTwilio(request, url.pathname);
      if (url.pathname === "/sms/inbound" || url.pathname === "/whatsapp/inbound") {
        const transport = url.pathname === "/whatsapp/inbound" ? "whatsapp" : "sms";
        const configuredDestination = transport === "whatsapp" ? instance.numberBinding.whatsappSandboxNumberE164 : instance.numberBinding.sourceNumberE164;
        if (configuredDestination === undefined) throw new IngressRejected(404, "whatsapp_not_configured");
        const sms = transport === "whatsapp" ? parseWhatsappAdmission(parameters, configuredDestination) : parseSmsAdmission(parameters, configuredDestination);
        if (sms.AccountSid !== instance.accountId) throw new IngressRejected(403, "account_binding_mismatch");
        const optOutType = transport === "sms" && "OptOutType" in sms
          && (sms.OptOutType === "STOP" || sms.OptOutType === "START" || sms.OptOutType === "HELP") ? sms.OptOutType : undefined;
        await ports.admitSms({ practiceId: instance.practiceId, instanceId: instance.instanceId, configVersion: instance.configVersion,
          mode: instance.mode, accountId: instance.accountId, provider: "twilio", messageTransport: transport, contact: sms.From, destination: sms.To,
          hours: instance.hours.fixture, messageSid: sms.MessageSid, body: sms.Body, numMedia: sms.NumMedia,
          ...(optOutType === undefined ? {} : { optOutType }), threadExpirySeconds: options.threadExpirySeconds });
        return xml(response, "<Response/>");
      }
      if (url.pathname === "/sms/status") {
        const ids = url.searchParams.getAll("attempt_id");
        if (ids.length !== 1 || !/^[A-Za-z0-9._:-]{1,200}$/.test(ids[0]!)) throw new IngressRejected(400, "attempt_id_invalid");
        await ports.smsStatus({ parameters, attemptId: ids[0]! });
        return xml(response, "<Response/>");
      }
      if (url.pathname === "/voice/status") {
        if (parameters.AccountSid !== instance.accountId || parameters.To !== instance.numberBinding.sourceNumberE164
          || parameters.ParentCallSid !== undefined || !/^CA[a-fA-F0-9]{32}$/.test(parameters.CallSid ?? ""))
          throw new IngressRejected(403, "parent_status_binding_mismatch");
        if (!/^(queued|initiated|ringing|in-progress|completed|canceled|failed|busy|no-answer)$/.test(parameters.CallStatus ?? ""))
          throw new IngressRejected(400, "parent_status_invalid");
        return xml(response, await ports.voice({ kind: "status", parameters }));
      }
      const voice = parseVoiceAdmission(parameters, instance.numberBinding.sourceNumberE164);
      if (voice.AccountSid !== instance.accountId) throw new IngressRejected(403, "account_binding_mismatch");
      if (url.pathname === "/voice/inbound" && ports.controlledVoiceAdmission !== undefined) {
        const challenge = await ports.controlledVoiceAdmission.claim({ accountId: voice.AccountSid, caller: voice.From, destination: voice.To, parentCallId: voice.CallSid });
        if (challenge !== null && "rejected" in challenge) throw new IngressRejected(403, "controlled_candidate_rejected");
        if (challenge !== null) return xml(response, controlledAdmissionGather(challenge.attemptId));
      }
      if (controlledConfirm) {
        const ids = url.searchParams.getAll("attempt_id");
        // Failed legacy full-mode controls historically continue through signed
        // ordinary admission. A selected candidate namespace must never do so.
        const candidateIdentity = (id: string) => id.startsWith("vvc") && parseReceptionistCandidateAttemptId(id).kind !== "legacy";
        if (ids.some(id => candidateIdentity(id) && parseReceptionistCandidateAttemptId(id).kind === "invalid")) throw new IngressRejected(403, "controlled_candidate_rejected");
        const parsedId = ids.length === 1 ? parseReceptionistCandidateAttemptId(ids[0]!) : null;
        const digitCount = parsedId?.kind === "candidate" && parsedId.binding.version === "vvc2" ? 4 : 24;
        if (ports.controlledVoiceAdmission !== undefined && ids.length === 1 && /^[A-Za-z0-9_-]{1,200}$/.test(ids[0]!) && new RegExp(`^\\d{${digitCount}}$`).test(parameters.Digits ?? "")) {
          const confirmed = await ports.controlledVoiceAdmission.confirm({ attemptId: ids[0]!, accountId: voice.AccountSid, caller: voice.From,
            destination: voice.To, parentCallId: voice.CallSid, digits: parameters.Digits! });
          if (confirmed) return xml(response, '<Response><Redirect method="POST">/voice/inbound</Redirect></Response>');
        }
        if (ids.some(candidateIdentity)) throw new IngressRejected(403, "controlled_admission_rejected");
        // Missing/replaced query IDs cannot bypass a call-bound candidate challenge.
        const selected = await ports.controlledVoiceAdmission?.claim({ accountId: voice.AccountSid, caller: voice.From, destination: voice.To, parentCallId: voice.CallSid });
        if (selected != null && ("rejected" in selected || candidateIdentity(selected.attemptId))) throw new IngressRejected(403, "controlled_candidate_rejected");
      }
      let completion: { parentCallId: string; capability: string } | undefined;
      if (recovery?.[3] === "complete") {
        const parent = url.searchParams.getAll("parent_call_id"), cap = url.searchParams.getAll("cap");
        if (recovery[1] !== "relay" || parent.length !== 1 || parent[0] !== voice.CallSid || cap.length !== 1
          || !/^[A-Za-z0-9_-]{32,128}$/.test(cap[0]!)) throw new IngressRejected(400, "relay_completion_binding_invalid");
        completion = { parentCallId: parent[0]!, capability: cap[0]! };
      }
      let gather: ScriptedGatherBinding | undefined;
      if (recovery?.[3] === "gather") {
        const parent = url.searchParams.getAll("parent_call_id"), capability = url.searchParams.getAll("cap"), source = url.searchParams.getAll("source_id");
        const emptyAttempts = url.searchParams.getAll("empty_attempts");
        if (recovery[1] !== "scripted" || parent.length !== 1 || parent[0] !== voice.CallSid || capability.length !== 1
          || !/^[A-Za-z0-9_-]{32,128}$/.test(capability[0]!) || source.length !== 1 || !/^[A-Za-z0-9_-]{1,120}$/.test(source[0]!)
          || emptyAttempts.length > 1 || (emptyAttempts.length === 1 && !/^[012]$/.test(emptyAttempts[0]!))) throw new IngressRejected(400, "gather_binding_invalid");
        gather = { parentCallId: parent[0], capability: capability[0]!, sourceId: source[0]!, emptyAttempts: Number(emptyAttempts[0] ?? "0") };
      }
      const body = await ports.voice({ kind: recovery ? "recover" : url.pathname === "/voice/inbound" || controlledConfirm ? "inbound" : "action", parameters,
        ...(gather === undefined ? {} : { gather }), ...(completion === undefined ? {} : { completion }),
        ...(url.pathname === "/voice/action" ? { actionAttemptId: attempts[0]! } : recovery ? { recoveryTarget: recovery[1] as "relay" | "scripted", recoveryId: recovery[2]!, recoveryStage: recovery[3] as "serve" | "gather" | "complete" } : {}) });
      return xml(response, body);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      if (error instanceof IngressRejected) return json(response, error.status, { error: "ingress_rejected" });
      // Error details may contain provider or caller content; retain them only in protected evidence upstream.
      return json(response, 503, { error: "temporarily_unavailable" });
    }
  };
}

function controlledAdmissionGather(attemptId: string): string {
  // No prompt or secret is emitted: only the operator's pre-supplied DTMF may redeem this call-bound challenge.
  const parsed = parseReceptionistCandidateAttemptId(attemptId);
  const digitCount = parsed.kind === "candidate" && parsed.binding.version === "vvc2" ? 4 : 24;
  return `<Response><Gather input="dtmf" numDigits="${digitCount}" finishOnKey="" timeout="10" actionOnEmptyResult="true" action="/voice/controlled/confirm?attempt_id=${attemptId}" method="POST"/></Response>`;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(value));
}
function xml(response: ServerResponse, body: string): void {
  if (Buffer.byteLength(body, "utf8") > 16_384 || !/^\s*(?:<\?xml[^>]*>\s*)?<Response(?:\s[^>]*)?\s*(?:\/>|>)/.test(body)) throw new Error("voice_response_invalid");
  response.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" }); response.end(body);
}
