import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { TwilioHmacRequestValidator } from "@salven/voice-runtime";

export type TrialIntent = "appointment_lookup" | "schedule" | "reschedule" | "referral_status" | "practice_information" | "unknown";
type TrialState = "goal" | "identity_dob" | "identity_zip" | "request_details" | "confirm_action" | "complete";
type HumanRouteCategory = "direct_human" | "new_patient" | "complex_scheduling_or_rescheduling" | "surgery_or_procedure" | "clinical" | "insurance_authorization" | "billing_dispute" | "unsupported" | "uncertain";

interface TrialSession {
  readonly callId: string;
  readonly caller: string;
  state: TrialState;
  intent: TrialIntent;
  dobAttempts: number;
  zipAttempts: number;
  dobVerified: boolean;
  zipVerified: boolean;
  preferenceSelected: boolean;
  goalClarifications: number;
  turns: number;
  maskedTurns: number;
  pendingTurn?: PendingTrialTurn;
  lastContinuation?: TrialContinuation;
  updatedAtMs: number;
}

export interface TrialBrainResult { readonly intent: TrialIntent; readonly reply: string; }
export interface TrialConversationBrain {
  /** Prototype-only conversation input. Every value is synthetic and may be sent to the model. */
  respond(input: { readonly state: TrialState; readonly intent: TrialIntent; readonly utterance: string; readonly objective: string }): Promise<TrialBrainResult>;
  ready?(): Promise<boolean>;
}
export interface TrialEvent {
  readonly type: string;
  readonly callCorrelationId: string;
  readonly state: TrialState;
  readonly turn: number;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}
interface OpenAIResponseBody { readonly output_text?: unknown; readonly output?: ReadonlyArray<{ readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }> }>; }
interface SignedForm { readonly form: Record<string, string>; readonly idempotencyKey: string | null; }
interface CachedReply { readonly status: number; readonly value: string; }
interface InFlightReply { readonly promise: Promise<CachedReply>; readonly resolve: (reply: CachedReply) => void; }
interface TrialConverseResult { readonly intent: TrialIntent; readonly reply: string; readonly authority: "gpt_proposal" | "deterministic_fallback"; }
interface PendingTrialTurn { readonly id: string; readonly kind: "ambiguous_goal" | "preference" | "question"; readonly expectedState: TrialState; readonly startedAtMs: number; readonly result: Promise<TrialConverseResult>; }
interface TrialContinuation { readonly id: string; readonly twiml: string; }
const TRIAL_MODEL_TIMEOUT_MS = 4_200;
const TRIAL_MASK_LIMIT = 2;

/** GPT interprets and speaks throughout the synthetic prototype conversation. */
export class OpenAITrialConversationBrain implements TrialConversationBrain {
  private readonly endpoint: string;
  private readonly model: string;
  constructor(private readonly options: { readonly apiKey: string; readonly projectId?: string; readonly model?: string; readonly fetcher?: typeof fetch; readonly endpoint?: string; readonly timeoutMs?: number }) {
    if (options.apiKey.length < 20) throw new Error("openai_trial_credentials_required");
    this.endpoint = options.endpoint ?? "https://api.openai.com/v1/responses";
    this.model = options.model ?? "gpt-5.4-nano";
    const url = new URL(this.endpoint);
    if (url.protocol !== "https:" || (options.endpoint === undefined && (url.hostname !== "api.openai.com" || url.pathname !== "/v1/responses"))) throw new Error("openai_trial_endpoint_rejected");
  }
  async ready(): Promise<boolean> {
    const url = new URL(this.endpoint); url.pathname = `${url.pathname.replace(/\/responses$/, "")}/models/${encodeURIComponent(this.model)}`;
    try { return (await (this.options.fetcher ?? fetch)(url, { headers: this.headers(), signal: AbortSignal.timeout(this.options.timeoutMs ?? TRIAL_MODEL_TIMEOUT_MS) })).ok; } catch { return false; }
  }
  async respond(input: { readonly state: TrialState; readonly intent: TrialIntent; readonly utterance: string; readonly objective: string }): Promise<TrialBrainResult> {
    const response = await this.request({
      model: this.model, store: false, reasoning: { effort: "none" }, max_output_tokens: 100,
      instructions: "You are the empathetic, concise voice agent for a Synthetic Practice phone prototype using test data. The caller already heard the prototype disclosure. Never repeat the words mock, synthetic, prototype, or demonstration unless directly asked. Follow the supplied objective and respond naturally in one or two short spoken sentences. Answer the caller's question before asking for a decision. Do not say 'I understand' or explain internal policy. Return only JSON with intent set to appointment_lookup, schedule, reschedule, referral_status, practice_information, or unknown and reply set to the exact words to speak. Requests to come earlier, later, or at a different time are reschedule. Only address, location, and directions questions map to practice_information; other public-practice facts are unknown until approved fixtures exist.",
      input: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`openai_trial_http_${response.status}`);
    return parseBrainOutput(responseText(await response.json() as OpenAIResponseBody));
  }
  private async request(body: unknown): Promise<Response> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? TRIAL_MODEL_TIMEOUT_MS);
    try { return await (this.options.fetcher ?? fetch)(this.endpoint, { method: "POST", signal: controller.signal, headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify(body) }); }
    finally { clearTimeout(timer); }
  }
  private headers(): Record<string, string> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.apiKey}` };
    const projectId = this.options.projectId?.trim();
    if (projectId && projectId.toLowerCase() !== "default") headers["OpenAI-Project"] = projectId;
    return headers;
  }
}

export interface SyntheticTrialGateway {
  readonly dependencies: ReadonlyArray<{ readonly name: string; ready(): Promise<boolean> }>;
  inbound(request: IncomingMessage, response: ServerResponse): Promise<void>;
  turn(request: IncomingMessage, response: ServerResponse): Promise<void>;
  continueTurn(request: IncomingMessage, response: ServerResponse): Promise<void>;
  status(request: IncomingMessage, response: ServerResponse): Promise<void>;
}

/** Trial-only PSTN loop. It cannot be enabled without the explicit synthetic-data flag. */
export function createSyntheticTrialGateway(input: { readonly environment: NodeJS.ProcessEnv; readonly brain?: TrialConversationBrain; readonly onEvent?: (event: TrialEvent) => void; readonly now?: () => number }): SyntheticTrialGateway {
  const env = input.environment;
  if (env.SYNTHETIC_DEMO_ONLY !== "true") throw new Error("synthetic_demo_flag_required");
  const publicBaseUrl = httpsBase(required(env, "PUBLIC_BASE_URL"));
  const allowAnyCaller = env.TRIAL_ALLOW_ANY_CALLER === "true";
  const allowedCallers = e164Allowlist(env);
  const trialNumber = e164(required(env, "TRIAL_TWILIO_NUMBER_E164"));
  mockName(required(env, "TRIAL_PATIENT_NAME"));
  const accountSid = required(env, "TWILIO_ACCOUNT_SID");
  const webhookToken = required(env, "TRIAL_WEBHOOK_TOKEN");
  if (webhookToken.length < 32) throw new Error("trial_webhook_token_too_short");
  const validator = new TwilioHmacRequestValidator(required(env, "TWILIO_AUTH_TOKEN"));
  const brain = input.brain ?? new OpenAITrialConversationBrain({ apiKey: required(env, "OPENAI_API_KEY"), ...(env.OPENAI_PROJECT_ID?.trim() ? { projectId: env.OPENAI_PROJECT_ID.trim() } : {}), ...(env.OPENAI_TEXT_MODEL?.trim() ? { model: env.OPENAI_TEXT_MODEL.trim() } : {}) });
  const sessions = new Map<string, TrialSession>();
  const replyCache = new Map<string, CachedReply>();
  const inFlightReplies = new Map<string, InFlightReply>();
  const now = input.now ?? Date.now;
  const eventSink = input.onEvent ?? ((event) => process.stdout.write(`${JSON.stringify({ schemaVersion: "synthetic-trial-event/v1", ...event })}\n`));
  const expectedDob = canonicalDob(required(env, "TRIAL_PATIENT_DOB_SPOKEN"));
  const expectedZip = canonicalZip(required(env, "TRIAL_PATIENT_ZIP"));

  return {
    dependencies: [{ name: "synthetic-trial-openai", ready: () => brain.ready?.() ?? Promise.resolve(true) }],
    async inbound(request, response): Promise<void> {
      let callId = "rejected"; let requestKey: string | null = null;
      try {
        expireSessions(); const signed = await signedForm(request, "/twilio/inbound"); callId = signed.form.CallSid ?? callId; requestKey = signed.idempotencyKey;
        if (await awaitPrior(response, requestKey)) return;
        const caller = e164(field(signed.form, "From")); callId = field(signed.form, "CallSid");
        if (!allowAnyCaller && !allowedCallers.has(caller)) throw new Error("trial_caller_not_allowed");
        const session: TrialSession = { callId, caller, state: "goal", intent: "unknown", dobAttempts: 0, zipAttempts: 0, dobVerified: false, zipVerified: false, preferenceSelected: false, goalClarifications: 0, turns: 0, maskedTurns: 0, updatedAtMs: now() };
        sessions.set(callId, session); emit(session, "call.started", { syntheticOnly: true, gptEnabled: true });
        send(response, signed.idempotencyKey, gather(publicBaseUrl, webhookToken, "Synthetic Practice's automated assistant. This demo uses test information only. How can I help?"));
      } catch (error) {
        emitSystem("webhook.inbound.rejected", callId, safeError(error));
        send(response, requestKey, sayAndHangup("This demonstration is not available from this number."), 403);
      }
    },
    async turn(request, response): Promise<void> {
      let session: TrialSession | undefined; let requestKey: string | null = null;
      try {
        expireSessions(); const signed = await signedForm(request, "/twilio/trial/turn"); requestKey = signed.idempotencyKey;
        if (await awaitPrior(response, requestKey)) return;
        const callId = field(signed.form, "CallSid"); session = sessions.get(callId);
        if (session === undefined || session.caller !== e164(field(signed.form, "From"))) throw new Error("trial_session_not_found");
        session.turns += 1; session.updatedAtMs = now();
        const speech = (signed.form.SpeechResult ?? "").trim();
        emit(session, "turn.received", { speechPresent: speech.length > 0, speechLengthBucket: lengthBucket(speech.length) });
        if (session.turns >= 20) return finish(session, response, requestKey, "I am having trouble completing this call. Please try again.", "turn_limit");
        if (speech.length === 0) return send(response, requestKey, gather(publicBaseUrl, webhookToken, promptFor(session, "I did not hear a response.")));
        const routeCategory = humanRouteCategory(speech);
        if (routeCategory !== null) return mockHumanRoute(session, response, requestKey, routeCategory);
        if (session.pendingTurn !== undefined) return send(response, requestKey, maskedTurn(publicBaseUrl, webhookToken, session.pendingTurn.id, session.pendingTurn.kind));
        if (isPacingRequest(speech)) return send(response, requestKey, gather(publicBaseUrl, webhookToken,
          `Of course. ${promptFor(session, "")}`.trim()));
        if (keywordIntent(speech) === "practice_information") return send(response, requestKey, gather(publicBaseUrl, webhookToken, `${practiceAddressReply()} How else may I help you today?`));
        if (session.state === "goal" && containsPotentialRealPatientData(speech)) return send(response, requestKey, gather(publicBaseUrl, webhookToken, "Please use test information only. How can I help?"));

        if (session.state === "goal") {
          const fallbackIntent = keywordIntent(speech);
          if (fallbackIntent !== "unknown") {
            session.intent = fallbackIntent; session.state = "identity_dob";
            emit(session, "workflow.selected", { intent: fallbackIntent, authority: "deterministic_fast_path" });
            emit(session, "latency.fast_path", { transition: "recognized_goal" });
            return send(response, requestKey, gather(publicBaseUrl, webhookToken, fallbackGoalReply(fallbackIntent)));
          }
          const classification = converse(brain, session, speech,
            "Identify the caller's goal. If it is recognized and patient-specific, return one short acknowledgement and ask exactly one question: What's the date of birth? If it is unclear, reply exactly: Tell me a little more about what you need. Do not list capabilities.",
            fallbackGoalReply(fallbackIntent), fallbackIntent);
          if (session.maskedTurns < TRIAL_MASK_LIMIT) return beginMasked(session, "ambiguous_goal", classification, response, requestKey);
          const classified = await classification;
          if (classified.intent === "unknown") {
            if (session.goalClarifications >= 1) return mockHumanRoute(session, response, requestKey, "uncertain");
            session.goalClarifications += 1;
            return send(response, requestKey, gather(publicBaseUrl, webhookToken, fallbackGoalReply("unknown")));
          }
          if (classified.intent === "practice_information") return send(response, requestKey, gather(publicBaseUrl, webhookToken, `${practiceAddressReply()} How else may I help you today?`));
          session.intent = classified.intent; session.state = "identity_dob"; emit(session, "workflow.selected", { intent: classified.intent, authority: classified.authority });
          return send(response, requestKey, gather(publicBaseUrl, webhookToken, fallbackGoalReply(classified.intent)));
        }
        if (session.state === "identity_dob") {
          if (canonicalDob(speech) !== expectedDob) return identityFailure(session, "date_of_birth", response, requestKey, "That didn't match. Please say the month, day, and year again.");
          session.dobVerified = true; session.state = "identity_zip"; emit(session, "identity.factor.accepted", { factor: "date_of_birth", identityVerified: false });
          emit(session, "latency.fast_path", { transition: "dob_to_zip" });
          return send(response, requestKey, gather(publicBaseUrl, webhookToken, "And the ZIP code?"));
        }
        if (session.state === "identity_zip") {
          if (canonicalZip(speech) !== expectedZip) return identityFailure(session, "postal_code", response, requestKey, "That didn't match. Please say the ZIP code again.");
          session.zipVerified = true; emit(session, "identity.verified", { factorCount: 2, identityVerified: true });
          if (session.intent === "appointment_lookup" || session.intent === "referral_status") {
            emit(session, "latency.fast_path", { transition: "verified_exact_result" });
            return finish(session, response, requestKey, resultFor(session.intent, new Date(now())), "goal_completed");
          }
          session.state = "request_details";
          emit(session, "latency.fast_path", { transition: "verified_to_request_details" });
          return send(response, requestKey, gather(publicBaseUrl, webhookToken, session.intent === "schedule" ? "What day or time works best for the appointment?" : "What day or time should the appointment be moved to?"));
        }
        if (session.state === "request_details") {
          if (isNegative(speech)) return finish(session, response, requestKey, "No appointment change was made.", "caller_cancelled");
          const dateCheck = validateAppointmentPreference(speech, new Date(now()));
          if (dateCheck.kind === "past") {
            emit(session, "request.repaired", { requestType: "appointment_date", reason: "past_date" });
            return send(response, requestKey, gather(publicBaseUrl, webhookToken,
              "I cannot schedule an appointment in the past. Did you mean the next occurrence of that day, or another date?"));
          }
          if (dateCheck.kind === "invalid") {
            emit(session, "request.repaired", { requestType: "appointment_date", reason: "invalid_date" });
            return send(response, requestKey, gather(publicBaseUrl, webhookToken,
              "That date is not valid. Please say the month and day again."));
          }
          const candidate = candidateFor(session.intent, new Date(now()));
          const next = converse(brain, session, speech, `Briefly repeat the caller's preference using "I heard [preference]" without speculating or saying it is available. Present this exact option as the available alternative, then ask whether they would like you to make the change or have questions: ${candidate}`, `I heard your preference. ${candidate} Would you like me to make that change, or is there anything you would like to know first?`, session.intent);
          if (session.maskedTurns < TRIAL_MASK_LIMIT) return beginMasked(session, "preference", next, response, requestKey);
          const completedPreference = await next;
          session.preferenceSelected = true; session.state = "confirm_action";
          return send(response, requestKey, gather(publicBaseUrl, webhookToken, oneQuestionReply(completedPreference.reply)));
        }
        if (session.state === "confirm_action") {
          if (isNegative(speech)) return finish(session, response, requestKey, "No appointment change was made.", "caller_cancelled");
          if (!isAffirmative(speech)) {
            const repair = converse(brain, session, speech, `The caller is considering this option: ${candidateFor(session.intent, new Date(now()))} Answer their question directly using only the available option details. If the requested information is unavailable, say that plainly. Do not ask for confirmation and do not force a yes-or-no answer. End with exactly: Would that be all, or can I help you with anything else?`, `I only have the date, time, and location for this option. Would that be all, or can I help you with anything else?`, session.intent);
            if (session.maskedTurns < TRIAL_MASK_LIMIT) return beginMasked(session, "question", repair, response, requestKey);
            return send(response, requestKey, gather(publicBaseUrl, webhookToken, pendingQuestionReply((await repair).reply)));
          }
          const provider = executeMockAction(session);
          emit(session, "synthetic.action.completed", { intent: session.intent, provider: "intergy-simulator", synthetic: true, readbackVerified: provider.readbackVerified, providerReceiptCorrelationId: correlation(provider.receiptId) });
          emit(session, "latency.fast_path", { transition: "action_to_completion" });
          return finish(session, response, requestKey, resultFor(session.intent, new Date(now())), "goal_completed");
        }
        return finish(session, response, requestKey, "This call is complete.", "already_complete");
      } catch (error) {
        if (session !== undefined) emit(session, "turn.failed", { failureClass: safeError(error) }); else emitSystem("webhook.turn.rejected", "rejected", safeError(error));
        send(response, requestKey, sayAndHangup("I am sorry, but I cannot continue this call. Please try again later. Goodbye."), 403);
      }
    },
    async continueTurn(request, response): Promise<void> {
      let session: TrialSession | undefined; let requestKey: string | null = null;
      try {
        expireSessions(); const signed = await signedForm(request, "/twilio/trial/continue"); requestKey = signed.idempotencyKey;
        if (await awaitPrior(response, requestKey)) return;
        const callId = field(signed.form, "CallSid"); session = sessions.get(callId);
        if (session === undefined || session.caller !== e164(field(signed.form, "From"))) throw new Error("trial_session_not_found");
        const pendingId = new URL(request.url ?? "/twilio/trial/continue", publicBaseUrl).searchParams.get("pending_id") ?? "";
        if (!/^[0-9a-f-]{36}$/.test(pendingId)) throw new Error("trial_pending_id_invalid");
        if (session.lastContinuation?.id === pendingId) return send(response, requestKey, session.lastContinuation.twiml);
        const pending = session.pendingTurn;
        if (pending === undefined || pending.id !== pendingId || pending.expectedState !== session.state) throw new Error("trial_pending_turn_mismatch");
        const result = await pending.result;
        if (session.pendingTurn !== pending) {
          if (session.lastContinuation?.id === pendingId) return send(response, requestKey, session.lastContinuation.twiml);
          throw new Error("trial_pending_turn_superseded");
        }
        let value: string;
        if (pending.kind === "ambiguous_goal") {
          if (result.intent === "unknown") {
            if (session.goalClarifications >= 1) {
              delete session.pendingTurn; session.updatedAtMs = now();
              emit(session, "latency.mask_completed", { kind: pending.kind, durationMs: Math.max(0, now() - pending.startedAtMs), maskNumber: session.maskedTurns });
              return mockHumanRoute(session, response, requestKey, "uncertain");
            }
            session.goalClarifications += 1;
            value = gather(publicBaseUrl, webhookToken, fallbackGoalReply("unknown"));
          }
          else if (result.intent === "practice_information") value = gather(publicBaseUrl, webhookToken, `${practiceAddressReply()} How else may I help you today?`);
          else {
            session.intent = result.intent; session.state = "identity_dob";
            emit(session, "workflow.selected", { intent: result.intent, authority: result.authority });
            value = gather(publicBaseUrl, webhookToken, fallbackGoalReply(result.intent));
          }
        } else if (pending.kind === "preference") {
          session.preferenceSelected = true; session.state = "confirm_action";
          value = gather(publicBaseUrl, webhookToken, oneQuestionReply(result.reply));
        } else value = gather(publicBaseUrl, webhookToken, pendingQuestionReply(result.reply));
        delete session.pendingTurn; session.updatedAtMs = now(); session.lastContinuation = { id: pendingId, twiml: value };
        emit(session, "latency.mask_completed", { kind: pending.kind, durationMs: Math.max(0, now() - pending.startedAtMs), maskNumber: session.maskedTurns });
        return send(response, requestKey, value);
      } catch (error) {
        if (session !== undefined) emit(session, "continuation.failed", { failureClass: safeError(error) }); else emitSystem("webhook.continuation.rejected", "rejected", safeError(error));
        send(response, requestKey, sayAndHangup("I am sorry, but I cannot continue this call. Please try again later. Goodbye."), 403);
      }
    },
    async status(request, response): Promise<void> {
      try {
        const signed = await signedForm(request, "/twilio/trial/status"); const callId = field(signed.form, "CallSid"); const status = field(signed.form, "CallStatus");
        const session = sessions.get(callId);
        if (session !== undefined) { emit(session, "call.status", { status }); if (["completed", "canceled", "failed", "busy", "no-answer"].includes(status)) { emit(session, "call.ended", { status }); sessions.delete(callId); } }
        response.writeHead(204, { "cache-control": "no-store" }); response.end();
      } catch (error) { emitSystem("webhook.status.rejected", "rejected", safeError(error)); response.writeHead(403).end(); }
    },
  };

  async function signedForm(request: IncomingMessage, path: string): Promise<SignedForm> {
    const form = Object.fromEntries(new URLSearchParams(await requestBody(request)).entries()); const signature = request.headers["x-twilio-signature"];
    const requestTarget = new URL(request.url ?? path, publicBaseUrl);
    const expectedBase = new URL(publicBaseUrl);
    if (requestTarget.origin !== expectedBase.origin || requestTarget.pathname !== path) throw new Error("twilio_request_target_rejected");
    const accountMatches = form.AccountSid === accountSid;
    const fixedTrialTupleMatches = accountMatches && typeof form.From === "string" && allowedCallers.has(form.From) && form.To === trialNumber
      && typeof form.CallSid === "string" && form.CallSid.length >= 8;
    if (typeof signature !== "string") {
      const suppliedToken = requestTarget.searchParams.get("trial_token") ?? "";
      const capabilityMatches = secretEqual(suppliedToken, webhookToken);
      if (!accountMatches || (!capabilityMatches && !fixedTrialTupleMatches)) throw new Error("twilio_trial_capability_rejected");
    } else {
      const candidates = new Set([requestTarget.toString(), new URL(path, publicBaseUrl).toString()]);
      const forwardedHost = request.headers["x-forwarded-host"];
      const forwardedProto = request.headers["x-forwarded-proto"];
      if (typeof forwardedHost === "string" && forwardedHost === expectedBase.host && (forwardedProto === "https" || forwardedProto === "http")) candidates.add(`${forwardedProto}://${forwardedHost}${request.url ?? path}`);
      if (expectedBase.protocol === "https:") candidates.add(`https://${expectedBase.hostname}:443${request.url ?? path}`);
      if (![...candidates].some((url) => validator.validate({ signature, url, parameters: form }))) {
        if (!fixedTrialTupleMatches) throw new Error("twilio_signature_mismatch");
        eventSink({ type: "webhook.signature_fallback", callCorrelationId: correlation(form.CallSid!),
          state: "goal", turn: 0, details: { path, reason: "trial_sandbox_signature_incompatible" } });
      }
    }
    const token = request.headers["i-twilio-idempotency-token"];
    return { form, idempotencyKey: typeof token === "string" && token.length > 0 && token.length <= 200 ? `${path}:${token}` : null };
  }
  function executeMockAction(session: TrialSession): { receiptId: string; readbackVerified: true } {
    if (!session.dobVerified || !session.zipVerified || !session.preferenceSelected || session.state !== "confirm_action" || (session.intent !== "schedule" && session.intent !== "reschedule")) throw new Error("trial_mock_state_invalid");
    return { receiptId: `mock-action-${session.callId}-${session.intent}`, readbackVerified: true };
  }
  function identityFailure(session: TrialSession, factor: "date_of_birth" | "postal_code", response: ServerResponse, key: string | null, retry: string): void {
    const attempt = factor === "date_of_birth" ? ++session.dobAttempts : ++session.zipAttempts;
    emit(session, "identity.factor.rejected", { factor, attempt, maxAttempts: 4, identityVerified: false });
    if (attempt >= 4) return finish(session, response, key, "I could not verify those details after four attempts, so I cannot open the record.", "identity_failed");
    emit(session, "latency.fast_path", { transition: factor === "date_of_birth" ? "dob_retry" : "zip_retry" });
    send(response, key, gather(publicBaseUrl, webhookToken, retry));
  }
  function beginMasked(session: TrialSession, kind: PendingTrialTurn["kind"], result: Promise<TrialConverseResult>, response: ServerResponse, key: string | null): void {
    const pending: PendingTrialTurn = { id: randomUUID(), kind, expectedState: session.state, startedAtMs: now(), result };
    session.maskedTurns += 1; session.pendingTurn = pending; session.updatedAtMs = now();
    emit(session, "latency.mask_started", { kind, maskNumber: session.maskedTurns, maskLimit: TRIAL_MASK_LIMIT });
    send(response, key, maskedTurn(publicBaseUrl, webhookToken, pending.id, kind));
  }
  function finish(session: TrialSession, response: ServerResponse, key: string | null, message: string, outcome: string): void {
    session.state = "complete"; session.updatedAtMs = now(); emit(session, "call.completed", { outcome, intent: session.intent, awaitingCarrierTermination: true });
    send(response, key, sayAndHangup(`${message} Goodbye.`));
  }
  function mockHumanRoute(session: TrialSession, response: ServerResponse, key: string | null, category: HumanRouteCategory): void {
    if (session.pendingTurn !== undefined) {
      emit(session, "latency.mask_cancelled", { kind: session.pendingTurn.kind, reason: "human_route" });
      delete session.pendingTurn;
    }
    session.state = "complete";
    emit(session, "handoff.requested", { reason: "demo_human_route", category });
    emit(session, "handoff.unavailable", { reason: "destination_not_configured" });
    emit(session, "call.completed", { outcome: "human_action_required", transferResult: "destination_not_configured", intent: session.intent, awaitingCarrierTermination: true });
    send(response, key, `<Response><Say voice="${TRIAL_TTS_VOICE}" language="en-US">Let me connect you.</Say><Pause length="2"/><Say voice="${TRIAL_TTS_VOICE}" language="en-US">The transfer number isn't set up for this demo yet. Goodbye.</Say><Hangup/></Response>`);
  }
  async function converse(provider: TrialConversationBrain, session: TrialSession, utterance: string, objective: string, fallbackReply: string, fallbackIntent: TrialIntent): Promise<TrialConverseResult> {
    const startedAt = now(); emit(session, "gpt.request.started", { fullSyntheticTurn: true, callerSpeechSent: true });
    try {
      const result = await provider.respond({ state: session.state, intent: session.intent, utterance, objective });
      if (!isTrialIntent(result.intent)) throw new Error("openai_trial_invalid_output");
      if (!validReply(result.reply)) throw new Error("openai_trial_invalid_output");
      emit(session, "gpt.request.completed", { durationMs: Math.max(0, now() - startedAt), proposedIntent: result.intent });
      return { intent: result.intent, reply: result.reply, authority: "gpt_proposal" };
    } catch {
      emit(session, "gpt.request.fallback", { durationMs: Math.max(0, now() - startedAt), fallbackIntent });
      return { intent: fallbackIntent, reply: fallbackReply, authority: "deterministic_fallback" };
    }
  }
  function emit(session: TrialSession, type: string, details: TrialEvent["details"]): void { eventSink({ type, callCorrelationId: correlation(session.callId), state: session.state, turn: session.turns, details }); }
  function emitSystem(type: string, callId: string, failureClass: string): void { eventSink({ type, callCorrelationId: correlation(callId), state: "complete", turn: 0, details: { failureClass } }); }
  function expireSessions(): void { for (const [callId, session] of sessions) if (now() - session.updatedAtMs > 15 * 60_000) { emit(session, "session.expired", { outcome: "abandoned" }); sessions.delete(callId); } }
  async function awaitPrior(response: ServerResponse, key: string | null): Promise<boolean> {
    if (key === null) return false;
    const cached = replyCache.get(key); if (cached !== undefined) { twiml(response, cached.value, cached.status); return true; }
    const existing = inFlightReplies.get(key); if (existing !== undefined) { const reply = await existing.promise; twiml(response, reply.value, reply.status); return true; }
    let resolve!: (reply: CachedReply) => void; const promise = new Promise<CachedReply>((done) => { resolve = done; });
    inFlightReplies.set(key, { promise, resolve }); return false;
  }
  function send(response: ServerResponse, key: string | null, value: string, status = 200): void {
    if (key !== null) { const reply = { value, status }; if (replyCache.size >= 1_000) replyCache.delete(replyCache.keys().next().value as string); replyCache.set(key, reply); inFlightReplies.get(key)?.resolve(reply); inFlightReplies.delete(key); }
    twiml(response, value, status);
  }
}

function parseBrainOutput(value: string): TrialBrainResult {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("openai_trial_invalid_json"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("openai_trial_invalid_output");
  const intent = (parsed as Record<string, unknown>).intent;
  const reply = (parsed as Record<string, unknown>).reply;
  if (!isTrialIntent(intent) || !validReply(reply)) throw new Error("openai_trial_invalid_output");
  return { intent, reply };
}
function isTrialIntent(value: unknown): value is TrialIntent { return value === "appointment_lookup" || value === "schedule" || value === "reschedule" || value === "referral_status" || value === "practice_information" || value === "unknown"; }
function validReply(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 400 && !/[<>]/.test(value); }
function responseText(value: OpenAIResponseBody): string { if (typeof value.output_text === "string") return value.output_text; for (const item of value.output ?? []) for (const content of item.content ?? []) if ((content.type === "output_text" || content.type === "text") && typeof content.text === "string") return content.text; throw new Error("openai_trial_output_missing"); }
function fallbackGoalReply(intent: TrialIntent): string { if (intent === "appointment_lookup" || intent === "schedule" || intent === "reschedule" || intent === "referral_status") return "Sure. What's the date of birth?"; if (intent === "practice_information") return `${practiceAddressReply()} How else may I help you today?`; return "Tell me a little more about what you need."; }
function keywordIntent(value: string): TrialIntent { const text = normalize(value); if (/\b(address|located|location|directions)\b/.test(text)) return "practice_information"; if (/\b(referral|referred)\b/.test(text)) return "referral_status"; if (/\b(move|reschedule|change|earlier|later|different time)\b/.test(text)) return "reschedule"; if (/\b(schedule|book|make)\b/.test(text)) return "schedule"; if (/\b(appointment|time|when)\b/.test(text)) return "appointment_lookup"; return "unknown"; }
function isAffirmative(value: string): boolean { return /^(yes|yeah|yep|confirm|confirmed|please do|that works|go ahead|book it|make the change|do it)$/i.test(normalize(value)); }
function isNegative(value: string): boolean { return /^(no|nope|cancel|stop|do not|don t|never mind|not that one)$/i.test(normalize(value)); }
function isPacingRequest(value: string): boolean { return /\b(?:repeat|say that again|what did you say|slow(?:er| down)|speak slower)\b/i.test(normalize(value)); }
function humanRouteCategory(value: string): HumanRouteCategory | null {
  const text = normalize(value);
  const escalationText = text
    .replace(/\b(?:do not|don t|dont|not|never) (?:(?:need|want|wish) )?(?:you )?(?:to )?(?:speak|talk|connect|transfer)(?: me)? (?:to|with) (?:a )?(?:human|representative|operator|person|someone|staff member)\b/g, "")
    .replace(/\bno need (?:for you )?(?:to )?(?:speak|talk|connect|transfer)(?: me)? (?:to|with) (?:a )?(?:human|representative|operator|person|someone|staff member)\b/g, "")
    .replace(/\b(?:do not|don t|dont|no|not|without) (?:need |want )?(?:a )?(?:human|representative|operator)\b/g, "");
  if (/\b(?:human|representative|operator)\b/.test(escalationText) || /\b(?:speak|talk|connect)(?: me)? (?:to|with) (?:a )?(?:person|someone|staff member)\b/.test(escalationText)) return "direct_human";
  if (/\b(?:new patient|first visit)\b/.test(text)) return "new_patient";
  if (/\b(?:complex|complicated|multiple appointments)\b/.test(text) && /\b(?:schedule|scheduling|reschedule|appointment|appointments)\b/.test(text)) return "complex_scheduling_or_rescheduling";
  if (/\b(?:surgery|procedure)\b/.test(text)) return "surgery_or_procedure";
  if (/\b(?:clinical|emergency|urgent|pain|swollen|swelling|bleeding|numb|numbness|wound|medication|diagnosis|treatment|chest pain|shortness of breath)\b/.test(text)) return "clinical";
  if (/\b(?:insurance|authorization)\b/.test(text)) return "insurance_authorization";
  if (/\b(?:billing|charge)\b/.test(text)) return "billing_dispute";
  if (/\b(?:medical records|records request|fax|lab result)\b/.test(text)) return "unsupported";
  return null;
}
function candidateFor(intent: TrialIntent, now: Date): string { return intent === "schedule" ? `The available appointment is ${futureSlot(now, 2, "ten thirty in the morning")} at the main location.` : `The available time is ${futureSlot(now, 4, "two in the afternoon")} at the main location.`; }
function resultFor(intent: TrialIntent, now: Date): string { if (intent === "appointment_lookup") return `The appointment is ${futureSlot(now, 2, "ten thirty in the morning")} at the main location.`; if (intent === "referral_status") return "The referral was received and is awaiting clinical review. I do not have any further status details yet."; if (intent === "schedule") return `In this demo, the appointment has been scheduled for ${futureSlot(now, 2, "ten thirty in the morning")} at the main location. No clinic system was changed.`; if (intent === "reschedule") return `In this demo, the appointment has been moved to ${futureSlot(now, 4, "two in the afternoon")} at the main location. No clinic system was changed.`; if (intent === "practice_information") return practiceAddressReply(); return "I could not complete that request."; }
function futureSlot(now: Date, weekday: number, spokenTime: string): string { const slot = new Date(now); const days = (weekday - slot.getUTCDay() + 7) % 7 || 7; slot.setUTCDate(slot.getUTCDate() + days); const weekdayName = slot.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }); const monthName = slot.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }); const day = slot.getUTCDate(); const suffix = day % 10 === 1 && day % 100 !== 11 ? "st" : day % 10 === 2 && day % 100 !== 12 ? "nd" : day % 10 === 3 && day % 100 !== 13 ? "rd" : "th"; return `${weekdayName}, ${monthName} ${day}${suffix} at ${spokenTime}`; }
function containsPotentialRealPatientData(value: string): boolean { const text = normalize(value); return /\b(?:my name is|i am named|born|date of birth|social security|member id|policy number)\b/.test(text) || /\b\d{6,}\b/.test(text); }
function practiceAddressReply(): string { return "Synthetic Practice is at 100 Demo Way, Suite 100, Example City, Example State 00000."; }
function promptFor(session: TrialSession, prefix: string): string { if (session.state === "identity_dob") return `${prefix} What's the date of birth?`; if (session.state === "identity_zip") return `${prefix} And the ZIP code?`; if (session.state === "request_details") return `${prefix} Please say a preferred day or time.`; if (session.state === "confirm_action") return `${prefix} You can ask about this option or tell me whether you would like the change.`; return `${prefix} Tell me a little more about what you need.`; }
const TRIAL_TTS_VOICE = "Polly.Joanna-Neural";
function gather(base: URL, webhookToken: string, message: string): string { const action = new URL("/twilio/trial/turn", base); action.searchParams.set("trial_token", webhookToken); return `<Response><Gather input="speech" action="${xml(action.toString())}" method="POST" speechTimeout="auto" actionOnEmptyResult="true"><Say voice="${TRIAL_TTS_VOICE}" language="en-US">${xml(message)}</Say></Gather><Say voice="${TRIAL_TTS_VOICE}" language="en-US">I did not hear a response. Goodbye.</Say><Hangup/></Response>`; }
function maskedTurn(base: URL, webhookToken: string, pendingId: string, kind: PendingTrialTurn["kind"]): string { const action = new URL("/twilio/trial/continue", base); action.searchParams.set("trial_token", webhookToken); action.searchParams.set("pending_id", pendingId); const message = kind === "ambiguous_goal" ? "Okay." : "Let me check that."; return `<Response><Say voice="${TRIAL_TTS_VOICE}" language="en-US">${message}</Say><Redirect method="POST">${xml(action.toString())}</Redirect></Response>`; }
function oneQuestionReply(reply: string): string { const first = reply.indexOf("?"); return first < 0 || reply.indexOf("?", first + 1) < 0 ? reply : reply.slice(0, first + 1).trim(); }
function pendingQuestionReply(reply: string): string { const close = "Would that be all, or can I help you with anything else?"; const withoutOld = reply.replace(/\s*What else would you like to know\??\s*$/i, "").trim(); const answer = withoutOld.endsWith(close) ? withoutOld.slice(0, -close.length).trim() : withoutOld; const declarative = answer.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.includes("?")).join(" ").trim(); return `${declarative || "I do not have more information about that option."} ${close}`; }
function sayAndHangup(message: string): string { return `<Response><Say voice="${TRIAL_TTS_VOICE}" language="en-US">${xml(message)}</Say><Hangup/></Response>`; }
function twiml(response: ServerResponse, value: string, status = 200): void { response.writeHead(status, { "content-type": "text/xml", "cache-control": "no-store" }); response.end(value); }
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
export function canonicalZip(value: string): string { const numeric = value.replace(/\D/g, ""); if (numeric.length === 5) return numeric; const words: Readonly<Record<string, string>> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" }; const spoken = normalize(value).split(" ").map((token) => words[token] ?? "").join(""); return spoken.length === 5 ? spoken : "invalid"; }
export function canonicalDob(value: string): string {
  const raw = value.trim();
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso !== null) return validDob(Number(iso[2]), Number(iso[3]), Number(iso[1]));
  const numeric = raw.match(/^(\d{1,2})[\s/.\-]+(\d{1,2})[\s/.\-]+(\d{2}|\d{4})$/);
  if (numeric !== null) return validDob(Number(numeric[1]), Number(numeric[2]), fourDigitYear(Number(numeric[3])));
  const tokens = normalize(raw).split(" ").filter((token) => token !== "the" && token !== "of");
  const months: Readonly<Record<string, number>> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const monthIndex = tokens.findIndex((token) => months[token] !== undefined);
  if (monthIndex >= 0) return validDob(months[tokens[monthIndex]!]!, ordinalNumber(tokens[monthIndex + 1] ?? ""), spokenYear(tokens.slice(monthIndex + 2)));
  const month = ordinalNumber(tokens[0] ?? ""); const day = ordinalNumber(tokens[1] ?? "");
  return validDob(month, day, spokenYear(tokens.slice(2)));
}
function validDob(month: number, day: number, year: number): string { if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return "invalid"; const date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : "invalid"; }
function fourDigitYear(year: number): number { return year >= 0 && year <= 29 ? 2000 + year : year >= 30 && year <= 99 ? 1900 + year : year; }
function ordinalNumber(token: string): number { const numeric = token.match(/^(\d{1,2})(?:st|nd|rd|th)?$/); if (numeric !== null) return Number(numeric[1]); const values: Readonly<Record<string, number>> = { one: 1, first: 1, won: 1, two: 2, to: 2, too: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20 }; return values[token] ?? 0; }
export type AppointmentDateCheck = { readonly kind: "none" | "valid" | "past" | "invalid"; readonly isoDate?: string };
export function validateAppointmentPreference(value: string, now: Date): AppointmentDateCheck {
  const text = normalize(value);
  if (!text) return { kind: "none" };
  if (/\b(?:last|previous|past|yesterday)\b/.test(text)) return { kind: "past" };
  const months: Readonly<Record<string, number>> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const month = Object.keys(months).find((candidate) => new RegExp(`\\b${candidate}\\b`).test(text));
  if (month === undefined) return { kind: "none" };
  const afterMonth = text.slice(text.indexOf(month) + month.length).trim().split(" ");
  const dayToken = afterMonth.find((token) => /^\d{1,2}(?:st|nd|rd|th)?$/.test(token) || ordinalNumber(token) > 0);
  if (dayToken === undefined) return { kind: "none" };
  const day = ordinalNumber(dayToken);
  const yearToken = afterMonth.find((token) => /^\d{4}$/.test(token));
  const year = yearToken === undefined ? now.getFullYear() : Number(yearToken);
  if (day < 1 || day > 31 || year < 2000 || year > 2100) return { kind: "invalid" };
  const candidate = new Date(year, months[month]! - 1, day);
  if (candidate.getFullYear() !== year || candidate.getMonth() !== months[month]! - 1 || candidate.getDate() !== day) return { kind: "invalid" };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return candidate < today ? { kind: "past", isoDate: localIso(candidate) } : { kind: "valid", isoDate: localIso(candidate) };
}
function localIso(value: Date): string { return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`; }
function spokenYear(tokens: readonly string[]): number { const numeric = tokens.join("").match(/^\d{4}$/); if (numeric !== null) return Number(numeric[0]); const values: Readonly<Record<string, number>> = { zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }; if (tokens.length === 4 && tokens.every((token) => (values[token] ?? 10) <= 9)) return Number(tokens.map((token) => String(values[token])).join("")); const first = values[tokens[0] ?? ""]; if (first === undefined) return 0; const rest = tokens.slice(1).reduce((sum, token) => sum + (values[token] ?? 0), 0); return first >= 17 && first <= 20 ? first * 100 + rest : 0; }
function safeError(error: unknown): string { const code = error instanceof Error ? error.message : "unknown"; return /^([a-z0-9_]+|openai_trial_http_\d{3})$/.test(code) ? code : "unexpected_failure"; }
function field(form: Record<string, string>, name: string): string { const value = form[name]?.trim(); if (value === undefined || value.length === 0 || value.length > 500) throw new Error(`trial_${name}_required`); return value; }
function required(env: NodeJS.ProcessEnv, key: string): string { const value = env[key]?.trim(); if (value === undefined || value.length === 0) throw new Error(`required_configuration_missing:${key}`); return value; }
function secretEqual(left: string, right: string): boolean { const a = createHash("sha256").update(left).digest(); const b = createHash("sha256").update(right).digest(); return timingSafeEqual(a, b); }
function e164(value: string): string { if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error("trial_e164_required"); return value; }
function e164Allowlist(environment: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = environment.TRIAL_ALLOWED_CALLERS_E164?.trim() || required(environment, "TRIAL_ALLOWED_CALLER_E164");
  const values = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0 || values.length > 5) throw new Error("trial_caller_allowlist_invalid");
  return new Set(values.map(e164));
}
function mockName(value: string): string { if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(value)) throw new Error("trial_mock_name_invalid"); return value; }
function httpsBase(value: string): URL { const url = new URL(value); if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("public_base_url_https_required"); return url; }
function correlation(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function lengthBucket(length: number): string { return length === 0 ? "empty" : length <= 20 ? "short" : length <= 100 ? "medium" : "long"; }
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
async function requestBody(request: IncomingMessage): Promise<string> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += value.length; if (size > 64_000) throw new Error("request_too_large"); chunks.push(value); } return Buffer.concat(chunks).toString("utf8"); }
