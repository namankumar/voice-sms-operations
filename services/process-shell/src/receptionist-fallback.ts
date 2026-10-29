import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";

import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { receptionistAllowedFacts } from "./receptionist-policy.js";
import type { ReceptionistRecoveryController, RecoveryOutcome } from "./receptionist-recovery.js";

export type FallbackTarget = "relay" | "scripted";
export type FallbackAttachmentInput = {
  scope: ConversationScope;
  recoveryId: string;
  parentCallId: string;
  childCorrelationId: string;
  voiceProfileSha256?: string;
  voiceRenderer?: "callback_media" | "outage_relay" | "outage_scripted";
};
export type ScriptedGatherBinding = { parentCallId: string; capability: string; sourceId: string; emptyAttempts: number };
export interface FallbackTransportAuthenticator {
  verify(input: { target: FallbackTarget; scope: ConversationScope; recoveryId: string; parentCallId: string; capability: string }): Promise<boolean>;
}

/**
 * Renders a recovery destination, rather than creating a provider-side attachment.
 * The durable recovery state records its stable fingerprint after Twilio has requested
 * the callback; retries only reproduce this same TwiML document.
 */
export class ReceptionistFallbackRenderer {
  private readonly baseUrl: URL;
  readonly target: FallbackTarget;

  constructor(private readonly options: {
    target: FallbackTarget;
    publicBaseUrl: string;
    capabilitySecret: string;
    scriptedPrompt: string;
  }) {
    this.target = options.target;
    this.baseUrl = checkedBaseUrl(options.publicBaseUrl);
    if (Buffer.byteLength(options.capabilitySecret, "utf8") < 32) throw new Error("fallback_capability_secret_invalid");
    if (options.scriptedPrompt.trim().length < 1 || options.scriptedPrompt.length > 1_000) throw new Error("fallback_scripted_prompt_invalid");
  }

  render(input: FallbackAttachmentInput, scriptedPrompt = this.options.scriptedPrompt, sourceId?: string, emptyAttempts = 0): { attachmentId: string; twiml: string; callbackUrl: string } {
    this.checked(input);
    if (!Number.isInteger(emptyAttempts) || emptyAttempts < 0 || emptyAttempts > 2) throw new Error("fallback_empty_attempts_invalid");
    const callbackUrl = this.callbackUrl(input, sourceId, emptyAttempts);
    const twiml = this.options.target === "relay" && input.voiceProfileSha256 !== undefined && input.voiceRenderer !== "outage_relay"
      ? `<Response><Connect action="${xml(this.completionUrl(input))}" method="POST"><Stream url="${xml(callbackUrl)}"><Parameter name="capability" value="${xml(this.capability(input))}"/><Parameter name="voice_profile_sha256" value="${xml(input.voiceProfileSha256)}"/></Stream></Connect></Response>`
      : this.options.target === "relay"
      ? `<Response><Connect${scriptedPrompt === "" ? ` action="${xml(this.completionUrl(input))}" method="POST"` : ""}><ConversationRelay${input.voiceRenderer === "outage_relay" ? ' ttsProvider="Amazon" voice="Joanna-Neural"' : ""} speechTimeout="1200" events="speaker-events tokens-played" url="${xml(callbackUrl)}" ${scriptedPrompt ? `welcomeGreeting="${xml(scriptedPrompt)}" welcomeGreetingInterruptible="any"` : ""}><Parameter name="capability" value="${xml(this.capability(input))}"/></ConversationRelay></Connect></Response>`
      : `<Response><Gather input="speech dtmf" action="${xml(callbackUrl)}" method="POST" actionOnEmptyResult="true"><Say${input.voiceRenderer === "outage_scripted" ? ' voice="Polly.Joanna-Neural"' : ""}>${xml(scriptedPrompt)}</Say></Gather></Response>`;
    return { attachmentId: this.attachmentId(input), twiml, callbackUrl };
  }

  private completionUrl(input: FallbackAttachmentInput): string {
    const url = new URL(`/voice/recovery/relay/${input.recoveryId}/complete`, this.baseUrl);
    url.searchParams.set("parent_call_id", input.parentCallId);
    url.searchParams.set("cap", this.capability(input));
    return url.toString();
  }

  /** Composition must additionally validate Twilio's request signature and durable recovery binding. */
  verifyCapability(input: FallbackAttachmentInput & { capability: string }): boolean {
    try {
      this.checked(input);
      return safeEqual(input.capability, this.capability(input));
    } catch { return false; }
  }

  private callbackUrl(input: FallbackAttachmentInput, sourceId?: string, emptyAttempts = 0): string {
    const stage = this.options.target === "relay" ? input.voiceProfileSha256 === undefined || input.voiceRenderer === "outage_relay" ? "setup" : "audio" : "gather";
    const url = new URL(`/voice/recovery/${this.options.target}/${input.recoveryId}/${stage}`, this.baseUrl);
    if (this.options.target === "relay") { url.protocol = "wss:"; }
    else { url.searchParams.set("parent_call_id", input.parentCallId); url.searchParams.set("cap", this.capability(input));
      url.searchParams.set("empty_attempts", String(emptyAttempts)); if (sourceId) url.searchParams.set("source_id", sourceId); }
    return url.toString();
  }

  private attachmentId(input: Omit<FallbackAttachmentInput, "childCorrelationId">): string {
    return `fallback-${this.sign(`attachment|${this.options.target}|${this.binding(input)}`).toString("base64url")}`;
  }

  private capability(input: FallbackAttachmentInput): string {
    return this.sign(`capability|${this.options.target}|${this.binding(input)}|${input.childCorrelationId}`).toString("base64url");
  }

  private sign(value: string): Buffer { return createHmac("sha256", this.options.capabilitySecret).update(value).digest(); }

  private binding(input: Omit<FallbackAttachmentInput, "childCorrelationId">): string {
    return [input.scope.practiceId, input.scope.instanceId, input.scope.conversationId, input.recoveryId, input.parentCallId, ...(input.voiceProfileSha256 === undefined ? [] : [input.voiceProfileSha256]), ...(input.voiceRenderer === undefined ? [] : [input.voiceRenderer])].join("|");
  }

  private checked(input: FallbackAttachmentInput): void {
    if (input.voiceProfileSha256 !== undefined && !/^sha256:[a-f0-9]{64}$/.test(input.voiceProfileSha256)) throw new Error("fallback_profile_invalid");
    if (input.voiceRenderer !== undefined && (input.voiceProfileSha256 === undefined || !["callback_media", "outage_relay", "outage_scripted"].includes(input.voiceRenderer))) throw new Error("fallback_renderer_invalid");
    for (const value of [input.scope.practiceId, input.scope.instanceId, input.scope.conversationId, input.recoveryId, input.parentCallId, input.childCorrelationId]) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error("fallback_binding_invalid");
    }
  }
}

/** Durable text intake shared with the SMS path; it records text, never bridges caller audio. */
export class ConversationScriptedTextSink {
  constructor(private readonly options: { store: Pick<ConversationStore, "get" | "getEvent" | "execute"> }) {}

  async openingPrompt(input: { scope: ConversationScope; recoveryId: string }): Promise<string | null> {
    const state = await this.options.store.get(input.scope);
    const recovery = state?.recoveries.find((item) => item.id === input.recoveryId);
    if (state === null || state.admission.channel !== "voice" || state.phase !== "active" || state.owner !== "ai"
      || recovery?.target !== "scripted" || recovery.fromEpoch + 1 !== state.voiceEpoch
      || (recovery.state === "redirecting" && state.providerTier === "scripted")
      || (recovery.state === "attached" && state.providerTier !== "scripted")
      || (recovery.state !== "redirecting" && recovery.state !== "attached")) return null;
    const action = await this.committedActionAnnouncement(state, recovery.id);
    if (action.kind === "stale") return null;
    if (action.kind === "announcement") return `${action.text} I'm sorry, the live assistant isn't available right now. I can't return to it during this call, but I can take a message for the team. What would you like me to tell them?`;
    return state.admission.mode === "full"
      ? "I'm sorry, the live assistant isn't available right now. I can't return to it during this call, but I can take a message for the team. What would you like me to tell them?"
      : "I'm sorry, the live assistant isn't available right now. I can't return to it during this call, but I can take a message for the team. How can we help?";
  }

  /** Announces only the action frozen in this recovery's accepted trigger receipt. */
  private async committedActionAnnouncement(state: Conversation, recoveryId: string): Promise<{ kind: "not_candidate" } | { kind: "stale" } | { kind: "announcement"; text: string }> {
    const recovery = state.recoveries.find((item) => item.id === recoveryId);
    if (recovery === undefined || recovery.failureDomain !== "openai_provider_or_scope_unknown" || state.pendingQuestion !== null) return { kind: "not_candidate" };
    const candidate = this.currentActionCandidate(state, recovery);
    if (candidate === null) return { kind: "not_candidate" };
    const trigger = await this.options.store.getEvent(scopeOf(state), recovery.triggerEventId);
    if (trigger?.receipt.accepted !== true || trigger.input.command.type !== "voice.recover"
      || trigger.input.command.recoveryId !== recovery.id || trigger.input.command.fromEpoch !== recovery.fromEpoch
      || trigger.receipt.state.ownerEpoch !== state.ownerEpoch || trigger.receipt.state.voiceEpoch !== state.voiceEpoch) return { kind: "stale" };
    const triggered = this.currentActionCandidate(trigger.receipt.state, recovery);
    const current = await this.options.store.get(scopeOf(state));
    const currentRecovery = current?.recoveries.find((item) => item.id === recovery.id);
    const sameRecovery = currentRecovery !== undefined && currentRecovery.fromEpoch === recovery.fromEpoch
      && currentRecovery.target === recovery.target && currentRecovery.state === recovery.state
      && currentRecovery.triggerEventId === recovery.triggerEventId && currentRecovery.failureDomain === recovery.failureDomain;
    const after = current === null || current.ownerEpoch !== state.ownerEpoch || current.voiceEpoch !== state.voiceEpoch
      || current.pendingQuestion !== null || !sameRecovery ? null : this.currentActionCandidate(current, currentRecovery);
    if (triggered === null || after === null || !sameActionCandidate(candidate, triggered) || !sameActionCandidate(candidate, after)) return { kind: "stale" };
    return { kind: "announcement", text: candidate.text };
  }

  private currentActionCandidate(state: Conversation, recovery: Conversation["recoveries"][number]): { sourceId: string; requestId: string; requestRevision: number; receiptId: string; operation: "schedule" | "reschedule" | "attendance_confirm"; resultHash: string; readbackHash: string; resultingVersion: number; text: string } | null {
    if (state.phase !== "active" || state.owner !== "ai" || state.suppressed || state.emergency !== null
      || recovery.fromEpoch + 1 !== state.voiceEpoch || state.ownerEpoch < 1) return null;
    const source = state.inputs.at(-1);
    const actions = source === undefined ? [] : state.requests.filter((request) => request.state === "ai_resolved"
      && request.aiResolution?.kind === "action" && request.sourceIds.includes(source.id));
    const action = actions.length === 1 ? actions[0] : undefined;
    if (source === undefined || action?.aiResolution?.kind !== "action"
      || state.requests.some((request) => request.id !== action.id && !["ai_resolved", "completed", "abandoned"].includes(request.state))) return null;
    const resolution = action.aiResolution;
    const text = resolution.operation === "reschedule" ? "Your appointment has been moved to the time you chose."
      : resolution.operation === "schedule" ? "Your appointment is scheduled for the time you chose."
        : resolution.operation === "attendance_confirm" ? "Your appointment is confirmed." : null;
    return text === null ? null : { sourceId: source.id, requestId: action.id, requestRevision: action.revision, receiptId: resolution.receiptId,
      operation: resolution.operation, resultHash: resolution.resultHash, readbackHash: resolution.readbackHash, resultingVersion: resolution.resultingVersion, text };
  }

  async emptyAttempts(input: { scope: ConversationScope; recoveryId: string }): Promise<number | null> {
    const authority = await this.authority({ ...input, target: "scripted" });
    if (authority === null) return null;
    const current = await this.current(input, authority);
    return current?.recoveries.find((item) => item.id === input.recoveryId)?.scriptedEmptyAttempts ?? null;
  }

  async silencePrompt(input: { scope: ConversationScope; recoveryId: string }): Promise<string | null> {
    const authority = await this.authority({ ...input, target: "scripted" });
    if (authority === null) return null;
    const current = await this.current(input, authority);
    if (current === null || !this.ownsFallbackAgenda(current, input.recoveryId) || this.captureComplete(current, input.recoveryId)) return null;
    return `I didn't catch that. ${this.capturePrompt(current, input.recoveryId)}`;
  }

  async noteSilence(input: { scope: ConversationScope; recoveryId: string; sourceId: string; expectedAttempts: number }): Promise<number | null> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(input.sourceId)
      || !Number.isInteger(input.expectedAttempts) || input.expectedAttempts < 0 || input.expectedAttempts > 2) return null;
    const authority = await this.authority({ ...input, target: "scripted" });
    if (authority === null) return null;
    const current = await this.current(input, authority);
    const attempts = current?.recoveries.find((item) => item.id === input.recoveryId)?.scriptedEmptyAttempts;
    if (attempts === undefined || input.expectedAttempts > attempts) return null;
    const eventId = `voice-scripted-empty-${input.recoveryId}-${input.sourceId}`;
    const prior = await this.options.store.getEvent(input.scope, eventId);
    if (prior !== null) return prior.receipt.accepted && attempts > 0 ? attempts : null;
    if (attempts === 3 || input.expectedAttempts < attempts) return attempts;
    const receipt = await this.options.store.execute({ scope: scopeOf(current!), eventId, expectedRevision: current!.revision,
      expectedOwnerEpoch: authority.ownerEpoch, actor: { kind: "provider", id: "twilio-scripted-gather" },
      command: { type: "voice.scripted_no_input", recoveryId: input.recoveryId, expectedAttempts: attempts } });
    return receipt.accepted ? receipt.state.recoveries.find((item) => item.id === input.recoveryId)?.scriptedEmptyAttempts ?? null : null;
  }

  async record(input: { scope: ConversationScope; recoveryId: string; sourceId: string; body: string; target?: FallbackTarget }): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(input.recoveryId) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.sourceId) || input.body.trim().length < 1 || input.body.length > 8_000) return false;
    const authority = await this.authority({ ...input, target: input.target ?? "scripted" });
    if (authority === null) return false;
    return await this.recordWithAuthority(input, authority);
  }

  private async recordWithAuthority(input: { scope: ConversationScope; recoveryId: string; sourceId: string; body: string }, authority: ScriptedCaptureAuthority): Promise<boolean> {
    const current = await this.current(input, authority);
    if (current === null || !this.ownsFallbackAgenda(current, input.recoveryId)) return false;
    const receipt = await this.options.store.execute({ scope: scopeOf(current), eventId: `voice-scripted-input-${input.recoveryId}-${input.sourceId}`,
      expectedRevision: current.revision, expectedOwnerEpoch: authority.ownerEpoch, actor: { kind: "provider", id: "twilio-scripted-gather" },
      command: { type: "input.record", sourceId: input.sourceId, body: input.body.trim(), ...(current.pendingQuestion ? { questionId: current.pendingQuestion.id } : {}) } });
    return receipt.accepted;
  }

  /** Deterministic degraded capture: one field at a time, no model interpretation or success claim before capture. */
  async capture(input: { scope: ConversationScope; recoveryId: string; sourceId: string; body: string }): Promise<{ recorded: boolean; text: string; completed?: boolean; definitiveNoSave?: boolean }> {
    const authority = await this.authority({ ...input, target: "scripted" });
    if (authority === null) return { recorded: false, text: "I am sorry, I could not save that message." };
    const before = await this.current(input, authority);
    if (before === null) return { recorded: false, text: "I am sorry, I could not save that message." };
    if (scriptedBackRequest(input.body)) {
      return { recorded: true, text: "I'm sorry, I can't return to the live assistant during this call. I can still take a message for the team. What would you like me to tell them?" };
    }
    if (before.pendingQuestion !== null && this.callbackRequest(before, input.recoveryId) == null) {
      return { recorded: false, text: "I am sorry, I could not save that message.", definitiveNoSave: true };
    }
    const prepared = await this.prepareCallbackRequest(before, input.recoveryId, authority);
    if (prepared === null || !this.ownsFallbackAgenda(prepared, input.recoveryId)) return { recorded: false, text: "I am sorry, I could not save that message." };
    const prior = before?.inputs.find((item) => item.id === input.sourceId);
    if (prior !== undefined) {
      if (prior.body !== input.body.trim()) return { recorded: false, text: "I could not match that reply. Please try again." };
      if (prior.id !== before.inputs.at(-1)?.id) {
        return { recorded: true, text: this.capturePrompt(before, input.recoveryId), completed: this.captureComplete(before, input.recoveryId) };
      }
      const retried = await this.retryConfirmedCapture(before, input.recoveryId, input.sourceId, authority);
      if (retried !== null) return retried;
    }
    // Do not persist a new caller turn until a failed post-field question has been repaired.
    const repaired = await this.repairMissingQuestion(prepared, input.recoveryId, authority);
    if (repaired !== null) return repaired;
    if (prior !== undefined && (prior.questionId !== before.pendingQuestion?.id || this.captureComplete(before, input.recoveryId))) {
      // A carrier retry must not treat the previous answer as the next field.
      return { recorded: true, text: this.capturePrompt(before, input.recoveryId), completed: this.captureComplete(before, input.recoveryId) };
    }
    const existing = this.callbackRequest(prepared, input.recoveryId);
    if (existing !== undefined && existing !== null && prepared.pendingQuestion === null) {
      const next = this.nextMissingStage(existing);
      if (next !== null) {
        if (next === "message") {
          if (!await this.activateQuestion(prepared, input.recoveryId, existing.id, "message", authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
          if (!await this.recordWithAuthority(input, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
          let current = await this.current(input, authority); if (current === null) return { recorded: false, text: "I am sorry, I could not save that message." };
          if (/\b(emergency|911)\b/i.test(input.body) && !/\b(?:not|isn't|is not|no)\s+(?:an?\s+)?emergency\b/i.test(input.body)) {
            const emergency = await this.options.store.execute({ scope: scopeOf(current), eventId: `voice-scripted-emergency-${input.recoveryId}-${input.sourceId}`,
              expectedRevision: current.revision, expectedOwnerEpoch: authority.ownerEpoch, actor: { kind: "ai", id: "receptionist-scripted-capture" },
              command: { type: "emergency.assess", sourceEventId: input.sourceId, classification: "caller_emergency" } });
            return emergency.accepted ? { recorded: true, text: receptionistAllowedFacts.emergencyInstruction }
              : { recorded: false, text: "I am sorry, I could not save that message." };
          }
          if (explicitMessageRefusal(input.body)) {
            return { recorded: true, text: "I haven't completed a callback message. Thank you for calling Synthetic Practice. Take care.", completed: true };
          }
          if (!await this.command(current, authority, `voice-scripted-message-${input.recoveryId}-${input.sourceId}`, { type: "request.capture_callback_message", requestId: existing.id, sourceEventId: input.sourceId })) return { recorded: false, text: "I am sorry, I could not save that message." };
          current = await this.current(input, authority); if (current === null) return { recorded: false, text: "I am sorry, I could not save that message." };
          const updated = this.callbackRequest(current, input.recoveryId);
          if (updated == null) return { recorded: false, text: "I am sorry, I could not save that message." };
          const following = this.nextMissingStage(updated);
          if (following === null) {
            const captured = await this.command(current, authority, `voice-scripted-capture-${input.recoveryId}`, { type: "request.capture", requestId: updated.id });
            return captured ? { recorded: true, text: this.savedVoiceClosing(current), completed: true }
              : { recorded: false, text: "I am sorry, I could not save that message." };
          }
          if (!await this.activateQuestion(current, input.recoveryId, existing.id, following, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
          const prompted = await this.current(input, authority);
          return prompted === null ? { recorded: false, text: "I am sorry, I could not save that message." }
            : { recorded: true, text: `Thank you. ${this.capturePrompt(prompted, input.recoveryId)}` };
        }
        // The renderer's generic first Gather is not authority to reinterpret
        // an existing request. Keep its words as provenance, then ask exactly
        // for the next missing callback field.
        if (!await this.recordWithAuthority(input, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
        let current = await this.current(input, authority); if (current === null) return { recorded: false, text: "I am sorry, I could not save that message." };
        if (!await this.command(current, authority, `voice-scripted-supplement-${input.recoveryId}-${input.sourceId}`, { type: "request.supplement", requestId: existing.id, sourceEventId: input.sourceId })) return { recorded: false, text: "I am sorry, I could not save that message." };
        current = await this.current(input, authority); if (current === null || !await this.activateQuestion(current, input.recoveryId, existing.id, next, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
        const prompted = await this.current(input, authority);
        return prompted === null ? { recorded: false, text: "I am sorry, I could not save that message." } : { recorded: true, text: this.capturePrompt(prompted, input.recoveryId) };
      }
    }
    if (!await this.recordWithAuthority(input, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
    let state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
    if (/\b(emergency|911)\b/i.test(input.body) && !/\b(?:not|isn't|is not|no)\s+(?:an?\s+)?emergency\b/i.test(input.body)) {
      const emergency = await this.options.store.execute({ scope: scopeOf(state), eventId: `voice-scripted-emergency-${input.recoveryId}-${input.sourceId}`,
        expectedRevision: state.revision, expectedOwnerEpoch: authority.ownerEpoch, actor: { kind: "ai", id: "receptionist-scripted-capture" }, command: { type: "emergency.assess", sourceEventId: input.sourceId, classification: "caller_emergency" } });
      if (emergency.accepted) return { recorded: true, text: receptionistAllowedFacts.emergencyInstruction };
    }
    // A replay reaches this shared path after the message-stage first-turn branch
    // has already recorded the refusal. Keep the terminal disposition idempotent.
    if (state.pendingQuestion?.kind === "message" && explicitMessageRefusal(input.body)) {
      return { recorded: true, text: "I haven't completed a callback message. Thank you for calling Synthetic Practice. Take care.", completed: true };
    }
    const request = this.callbackRequest(state, input.recoveryId);
    if (request === null) return { recorded: false, text: "I am sorry, I could not save that message." };
    const requestId = request?.id ?? `request-${input.recoveryId}`;
    if (!request) {
      if (state.admission.mode === "full" && explicitMessageRefusal(input.body)) {
        return { recorded: true, text: "Thank you for calling Synthetic Practice. Take care.", completed: true };
      }
      const drafted = await this.command(state, authority, `voice-scripted-request-${input.recoveryId}-${input.sourceId}`, { type: "request.draft", requestId, sourceEventId: input.sourceId });
      if (!drafted) return { recorded: false, text: "I am sorry, I could not save that message." };
      state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
      if (!await this.activateQuestion(state, input.recoveryId, requestId, "name", authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
      return { recorded: true, text: "Please say your name." };
    }
    if (!request.name) {
      const name = input.body.trim();
      if (!isName(name)) {
        if (state.pendingQuestion?.kind === "name" && state.pendingQuestion.requestId === request.id && explicitNameRefusal(name)) {
          return { recorded: true, text: "I haven't completed a callback message. Thank you for calling Synthetic Practice. Take care.", completed: true };
        }
        if (!request.sourceIds.includes(input.sourceId) && !await this.command(state, authority, `voice-scripted-supplement-${input.recoveryId}-${input.sourceId}`, { type: "request.supplement", requestId: request.id, sourceEventId: input.sourceId })) return { recorded: false, text: "I am sorry, I could not save that message." };
        return { recorded: true, text: "Please say your name." };
      }
      if (!await this.command(state, authority, `voice-scripted-name-${input.recoveryId}-${input.sourceId}`, { type: "request.draft", requestId: request.id, sourceEventId: input.sourceId, name })) return { recorded: false, text: "I am sorry, I could not save that message." };
      state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
      const updated = this.callbackRequest(state, input.recoveryId);
      if (updated === undefined || updated === null) return { recorded: false, text: "I am sorry, I could not save that message." };
      if (updated.callbackConfirmed) {
        const captured = await this.command(state, authority, `voice-scripted-capture-${input.recoveryId}`, { type: "request.capture", requestId: updated.id });
        return captured ? { recorded: true, text: this.savedVoiceClosing(state), completed: true }
          : { recorded: false, text: "I am sorry, I could not save that message." };
      }
      const next = updated.degradedHandoff == null && state.admission.mode !== "full" ? "message" : "callback_number_entry";
      if (!await this.activateQuestion(state, input.recoveryId, request.id, next, authority)) {
        const repaired = await this.repairMissingQuestion(state, input.recoveryId, authority);
        return repaired ?? { recorded: false, text: "I am sorry, I could not save that message." };
      }
      return { recorded: true, text: next === "message" ? "Please say the message you would like the office to receive." : "Please say the best callback number, including country code." };
    }
    if (request.callbackConfirmed) {
      const captured = await this.command(state, authority, `voice-scripted-capture-${input.recoveryId}`, { type: "request.capture", requestId: request.id });
      return captured ? { recorded: true, text: this.savedVoiceClosing(state), completed: true }
        : { recorded: false, text: "I am sorry, I could not save that message." };
    }
    if (state.pendingQuestion?.kind === "message") {
      if (!await this.command(state, authority, `voice-scripted-message-${input.recoveryId}-${input.sourceId}`, { type: "request.capture_callback_message", requestId: request.id, sourceEventId: input.sourceId })) return { recorded: false, text: "I am sorry, I could not save that message." };
      state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
      if (!await this.activateQuestion(state, input.recoveryId, request.id, "callback_number_entry", authority)) {
        const repaired = await this.repairMissingQuestion(state, input.recoveryId, authority);
        return repaired ?? { recorded: false, text: "I am sorry, I could not save that message." };
      }
      return { recorded: true, text: "Please say the best callback number, including country code." };
    }
    if (!request.callbackNumber) {
      const number = normalizePhone(input.body, state.admission.contact); if (number === null) return { recorded: true, text: "Please say the callback number, or say use my caller number." };
      if (!await this.command(state, authority, `voice-scripted-number-${input.recoveryId}-${input.sourceId}`, { type: "request.draft", requestId: request.id, sourceEventId: input.sourceId, callbackNumber: number })) return { recorded: false, text: "I am sorry, I could not save that message." };
      state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
      if (!await this.activateQuestion(state, input.recoveryId, request.id, "callback_number", authority)) {
        const repaired = await this.repairMissingQuestion(state, input.recoveryId, authority);
        return repaired ?? { recorded: false, text: "I am sorry, I could not save that message." };
      }
      return { recorded: true, text: `Please say yes to confirm ${number}.` };
    }
    if (!request.callbackConfirmed) {
      if (!/^yes[.!]?$/i.test(input.body.trim())) return { recorded: true, text: `Please say yes to confirm ${request.callbackNumber}.` };
      if (!await this.command(state, authority, `voice-scripted-confirm-${input.recoveryId}-${input.sourceId}`, { type: "request.confirm_callback", requestId: request.id, callbackNumber: request.callbackNumber, sourceEventId: input.sourceId })) return { recorded: false, text: "I am sorry, I could not save that message." };
      state = await this.current(input, authority); if (!state) return { recorded: false, text: "I am sorry, I could not save that message." };
      const captured = await this.command(state, authority, `voice-scripted-capture-${input.recoveryId}`, { type: "request.capture", requestId: request.id });
      return captured ? { recorded: true, text: this.savedVoiceClosing(state), completed: true } : { recorded: false, text: "I am sorry, I could not save that message." };
    }
    return { recorded: true, text: "Your message has already been saved." };
  }

  private async command(state: NonNullable<Awaited<ReturnType<ConversationStore["get"]>>>, authority: ScriptedCaptureAuthority, eventId: string, command: Parameters<ConversationStore["execute"]>[0]["command"]): Promise<boolean> {
    if (!this.attached(state, authority)) return false;
    const actor = command.type === "request.capture_callback_message" ? { kind: "ai" as const, id: "receptionist-scripted-capture" } : { kind: "system" as const, id: "receptionist-scripted-capture" };
    const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId, expectedRevision: state.revision, expectedOwnerEpoch: authority.ownerEpoch, actor, command });
    return receipt.accepted;
  }

  private async activateQuestion(state: NonNullable<Awaited<ReturnType<ConversationStore["get"]>>>, recoveryId: string, requestId: string,
    kind: "name" | "message" | "callback_number_entry" | "callback_number", authority: ScriptedCaptureAuthority): Promise<boolean> {
    const suffix = `${kind}-${state.revision}`;
    return this.command(state, authority, `voice-scripted-question-${recoveryId}-${suffix}`, {
      type: "question.activate", questionId: `question-${recoveryId}-${suffix}`, kind, requestId,
    });
  }

  private async repairMissingQuestion(state: NonNullable<Awaited<ReturnType<ConversationStore["get"]>>>, recoveryId: string, authority: ScriptedCaptureAuthority): Promise<{ recorded: boolean; text: string } | null> {
    if (state.pendingQuestion !== null) return null;
    const request = this.callbackRequest(state, recoveryId);
    if (request === undefined || request === null || request.state !== "draft" || request.callbackConfirmed) return null;
    const next = await this.nextStageFromAcceptedField(state, request, recoveryId);
    if (next === null) return null;
    if (!await this.activateQuestion(state, recoveryId, request.id, next, authority)) return { recorded: false, text: "I am sorry, I could not save that message." };
    const repaired = await this.current({ scope: scopeOf(state), recoveryId }, authority);
    return repaired === null ? { recorded: false, text: "I am sorry, I could not save that message." } : { recorded: true, text: this.capturePrompt(repaired, recoveryId) };
  }

  private async nextStageFromAcceptedField(state: NonNullable<Awaited<ReturnType<ConversationStore["get"]>>>, request: Conversation["requests"][number], recoveryId: string): Promise<"name" | "message" | "callback_number_entry" | "callback_number" | null> {
    for (const sourceId of [...request.sourceIds].reverse()) {
      const stages: ReadonlyArray<readonly [string, "name" | "message" | "callback_number_entry" | "callback_number"]> = [
        [`voice-scripted-name-${recoveryId}-${sourceId}`, request.degradedHandoff == null && state.admission.mode !== "full" ? "message" : "callback_number_entry"],
        [`voice-scripted-message-${recoveryId}-${sourceId}`, request.degradedHandoff == null ? "callback_number_entry" : "name"],
        [`voice-scripted-number-${recoveryId}-${sourceId}`, "callback_number"],
      ];
      for (const [eventId, next] of stages) {
        const event = await this.options.store.getEvent(scopeOf(state), eventId);
        const command = event?.input.command;
        if (!event?.receipt.accepted || command === undefined) continue;
        if (command.type === "request.draft" && command.requestId === request.id) return next;
        if (next === "callback_number_entry" && command.type === "request.capture_callback_message" && command.requestId === request.id) return next;
      }
    }
    return null;
  }

  private async authority(input: { scope: ConversationScope; recoveryId: string; target: FallbackTarget }): Promise<ScriptedCaptureAuthority | null> {
    const current = await this.options.store.get(input.scope);
    if (current === null) return null;
    const recovery = current.recoveries.find((item) => item.id === input.recoveryId);
    if (recovery === undefined) return null;
    const trigger = await this.options.store.getEvent(input.scope, recovery.triggerEventId);
    if (trigger === null || !trigger.receipt.accepted || trigger.input.command.type !== "voice.recover"
      || trigger.input.command.recoveryId !== recovery.id || trigger.receipt.state.ownerEpoch !== current.ownerEpoch || recovery.target !== input.target) return null;
    // The accepted recovery receipt is the post-transition owner binding. A
    // later staff takeover and release cannot be adopted by this transport.
    const authority = { recoveryId: input.recoveryId, ownerEpoch: trigger.receipt.state.ownerEpoch, target: input.target };
    return this.attached(current, authority) ? authority : null;
  }

  private async current(input: { scope: ConversationScope; recoveryId: string }, authority: ScriptedCaptureAuthority) {
    const current = await this.options.store.get(input.scope);
    return current !== null && input.recoveryId === authority.recoveryId && this.attached(current, authority) ? current : null;
  }

  private attached(state: Conversation, authority: ScriptedCaptureAuthority): boolean {
    const recovery = state.recoveries.find((item) => item.id === authority.recoveryId);
    return state.phase === "active" && state.admission.channel === "voice" && state.owner === "ai" && state.ownerEpoch === authority.ownerEpoch
      && state.providerTier === authority.target && recovery?.target === authority.target && recovery.state === "attached" && recovery.fromEpoch + 1 === state.voiceEpoch;
  }

  private async prepareCallbackRequest(state: Conversation, recoveryId: string, authority: ScriptedCaptureAuthority): Promise<Conversation | null> {
    const fullDrafts = state.requests.filter((item) => item.state === "draft" && item.fullProposal !== undefined);
    const plainDrafts = state.requests.filter((item) => item.state === "draft" && item.fullProposal === undefined && item.degradedHandoff == null);
    if (fullDrafts.length > 0 && plainDrafts.length > 0) return null;
    const selected = this.callbackRequest(state, recoveryId);
    if (selected !== undefined) return selected === null ? null : state;
    // A pre-existing protected/full question is not callback authority. Do not
    // replace it or consume its next caller turn during degraded capture.
    if (state.pendingQuestion !== null) return null;
    // Completed work stays immutable; it does not prevent a new callback or a
    // polite decline after the recovery prompt offers to take a message.
    if (fullDrafts.length !== 1) return state.requests.every((item) => ["ai_resolved", "completed", "abandoned"].includes(item.state)) ? state : null;
    const source = fullDrafts[0]!;
    if (!await this.command(state, authority, `voice-scripted-handoff-${recoveryId}-${source.id}`, {
      type: "request.degraded_callback_handoff", recoveryId, sourceRequestId: source.id, sourceRequestRevision: source.revision,
      callbackRequestId: `request-${recoveryId}`,
    })) return null;
    const current = await this.current({ scope: scopeOf(state), recoveryId }, authority);
    return current !== null && this.callbackRequest(current, recoveryId) !== null ? current : null;
  }

  /** Returns one adopted plain draft or one server-created handoff; ambiguity is a hard stop. */
  private callbackRequest(state: Conversation, recoveryId: string): Conversation["requests"][number] | undefined | null {
    const handoffs = state.requests.filter((item) => item.degradedHandoff?.recoveryId === recoveryId);
    if (handoffs.length > 1) return null;
    if (handoffs.length === 1) return handoffs[0]!;
    const direct = state.requests.find((item) => item.id === `request-${recoveryId}`);
    if (direct !== undefined) return direct.fullProposal === undefined ? direct : null;
    const plain = state.requests.filter((item) => item.state === "draft" && item.fullProposal === undefined && item.degradedHandoff == null);
    return plain.length === 0 ? undefined : plain.length === 1 ? plain[0]! : null;
  }

  private nextMissingStage(request: Conversation["requests"][number]): "message" | "name" | "callback_number_entry" | "callback_number" | null {
    if (request.degradedHandoff != null && request.callbackMessageSourceId == null) return "message";
    if (!request.name) return "name";
    if (!request.callbackNumber) return "callback_number_entry";
    return request.callbackConfirmed ? null : "callback_number";
  }

  private capturePrompt(state: Conversation, recoveryId: string): string {
    if (state.emergency !== null) return receptionistAllowedFacts.emergencyInstruction;
    const request = this.callbackRequest(state, recoveryId);
    if (request !== undefined && request !== null && request.state === "needs_callback") return state.admission.hours === "demo_closed" ? receptionistAllowedFacts.savedClosed : receptionistAllowedFacts.savedOpen;
    switch (state.pendingQuestion?.kind) {
      case "name": return "Please say your name.";
      case "message": return "Please say the message you would like the office to receive.";
      case "callback_number_entry": return "Please say the best callback number, or enter it on your keypad.";
      case "callback_number": return request !== undefined && request !== null && request.callbackNumber ? `Is ${request.callbackNumber} the best number to reach you?` : "What is the best callback number?";
      default: return "Please tell me how the office can help.";
    }
  }

  private savedVoiceClosing(state: Conversation): string {
    const confirmation = state.admission.hours === "demo_closed" ? receptionistAllowedFacts.savedClosed : receptionistAllowedFacts.savedOpen;
    return `${confirmation} Thank you for calling Synthetic Practice. Goodbye.`;
  }

  private captureComplete(state: Conversation, recoveryId: string): boolean {
    const request = this.callbackRequest(state, recoveryId);
    return request !== undefined && request !== null && request.state !== "draft";
  }

  /** A provider replay may finish only the exact capture that failed after confirmation. */
  private async retryConfirmedCapture(state: Conversation, recoveryId: string, sourceId: string, authority: ScriptedCaptureAuthority): Promise<{ recorded: boolean; text: string; completed?: boolean } | null> {
    const request = this.callbackRequest(state, recoveryId);
    if (request === undefined || request === null || state.pendingQuestion !== null || request.confirmationSourceId !== sourceId
      || request.state !== "draft" || !request.callbackConfirmed || !request.name || !request.originalRequest
      || !/^\+[1-9]\d{7,14}$/.test(request.callbackNumber)) return null;
    const captured = await this.command(state, authority, `voice-scripted-capture-${recoveryId}`, { type: "request.capture", requestId: request.id });
    return captured
      ? { recorded: true, text: this.savedVoiceClosing(state), completed: true }
      : { recorded: false, text: "I am sorry, I could not save that message." };
  }

  /** A scripted recovery may only advance its own callback request, never a full-mode agenda item. */
  private ownsFallbackAgenda(state: Conversation, recoveryId: string): boolean {
    const request = this.callbackRequest(state, recoveryId);
    if (request === null) return false;
    return state.pendingQuestion === null || state.pendingQuestion.requestId === request?.id;
  }
}

type ScriptedCaptureAuthority = Readonly<{ recoveryId: string; ownerEpoch: number; target: FallbackTarget }>;

export class ReceptionistFallbackTransport {
  constructor(private readonly options: {
    renderer: ReceptionistFallbackRenderer;
    recovery: Pick<ReceptionistRecoveryController, "prepareRecovery" | "recordAttachmentEvidence"> & Partial<Pick<ReceptionistRecoveryController, "relayCompletion" | "recordMediaAttachmentEvidence">>;
    authenticator: FallbackTransportAuthenticator;
    candidateProfile?: (scope: ConversationScope) => Promise<string | null>;
    mediaProfile?: (input: { scope: ConversationScope; recoveryId: string }) => Promise<string | null>;
    outageProfile?: (input: { scope: ConversationScope; recoveryId: string }) => Promise<string | null>;
    relayOpeningPrompt?: (input: { scope: ConversationScope; recoveryId: string }) => Promise<string | null | undefined>;
    scriptedText?: Pick<ConversationScriptedTextSink, "capture" | "emptyAttempts" | "noteSilence" | "silencePrompt"> & Partial<Pick<ConversationScriptedTextSink, "openingPrompt">>;
  }) {}

  /** This serves a pure document. Its successful return deliberately leaves recovery redirecting. */
  async serve(input: { scope: ConversationScope; recoveryId: string; parentCallId: string }): Promise<{ kind: "rendered"; twiml: string; attachmentId: string } | RecoveryOutcome> {
    const prepared = await this.options.recovery.prepareRecovery({ ...input, target: this.options.renderer.target });
    if (prepared.kind !== "prepared") return prepared;
    if (prepared.target !== this.options.renderer.target) return { kind: "outcome_unknown", recoveryId: prepared.recoveryId };
    let binding: FallbackAttachmentInput = { scope: input.scope, recoveryId: prepared.recoveryId, parentCallId: prepared.parentCallId, childCorrelationId: prepared.childCorrelationId };
    const candidateProfile = await this.options.candidateProfile?.(input.scope) ?? null;
    const mediaProfile = await this.options.mediaProfile?.({ scope: input.scope, recoveryId: input.recoveryId }) ?? null;
    const outageProfile = await this.options.outageProfile?.({ scope: input.scope, recoveryId: input.recoveryId }) ?? null;
    if (candidateProfile !== null && mediaProfile === null && outageProfile === null) return { kind: "rendered", twiml: "<Response><Hangup/></Response>", attachmentId: `candidate-preserve-end-${input.recoveryId}` };
    if (outageProfile !== null) binding = { ...binding, voiceProfileSha256: outageProfile, voiceRenderer: this.options.renderer.target === "relay" ? "outage_relay" : "outage_scripted" };
    if (mediaProfile !== null) return { kind: "rendered", ...this.options.renderer.render({ ...binding, voiceProfileSha256: mediaProfile }, "") };
    const scriptedPrompt = this.options.renderer.target === "scripted" ? await this.options.scriptedText?.openingPrompt?.({ scope: input.scope, recoveryId: prepared.recoveryId }) : undefined;
    if (this.options.renderer.target === "scripted" && this.options.scriptedText?.openingPrompt !== undefined && scriptedPrompt === null)
      return { kind: "outcome_unknown", recoveryId: prepared.recoveryId };
    const relayPrompt = this.options.renderer.target === "relay" ? await this.options.relayOpeningPrompt?.({ scope: input.scope, recoveryId: prepared.recoveryId }) : undefined;
    if (relayPrompt === null) return { kind: "outcome_unknown", recoveryId: prepared.recoveryId };
    const rendered = this.options.renderer.render(binding, relayPrompt ?? scriptedPrompt ?? undefined, this.options.renderer.target === "scripted" ? initialSourceId(binding) : undefined);
    return { kind: "rendered", twiml: rendered.twiml, attachmentId: rendered.attachmentId };
  }

  /** Call only after the authenticated ConversationRelay websocket delivers its documented `setup` event. */
  async relaySetup(input: Omit<FallbackAttachmentInput, "childCorrelationId"> & { rawSetup: string; signal?: AbortSignal }): Promise<RecoveryOutcome> {
    if (input.signal?.aborted) return { kind: "ignored" };
    if (await this.options.mediaProfile?.({ scope: input.scope, recoveryId: input.recoveryId }) != null) return { kind: "ignored" };
    const setup = relaySetup(input.rawSetup);
    if (setup === null || setup.callSid !== input.parentCallId) return { kind: "ignored" };
    const outageProfile = await this.options.outageProfile?.({ scope: input.scope, recoveryId: input.recoveryId }) ?? null;
    if (await this.options.candidateProfile?.(input.scope) != null && outageProfile === null) return { kind: "ignored" };
    const binding: FallbackAttachmentInput = { ...input, childCorrelationId: await this.childCorrelation(input), ...(outageProfile === null ? {} : { voiceProfileSha256: outageProfile, voiceRenderer: "outage_relay" as const }) };
    if (input.signal?.aborted) return { kind: "ignored" };
    if (this.options.renderer.target !== "relay" || !this.options.renderer.verifyCapability({ ...binding, capability: setup.capability })
      || !await this.options.authenticator.verify({ target: "relay", scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId, capability: setup.capability })) return { kind: "ignored" };
    if (input.signal?.aborted) return { kind: "ignored" };
    return await this.options.recovery.recordAttachmentEvidence({ scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId,
      target: "relay", attachmentId: this.options.renderer.render(binding).attachmentId, ...(input.signal === undefined ? {} : { signal: input.signal }) });
  }

  /** Actual authenticated MediaStreams start, with a distinct one-use durable attachment. */
  async mediaSetup(input: Omit<FallbackAttachmentInput, "childCorrelationId"> & { rawStart: string; expectedAccountId: string; signal?: AbortSignal }): Promise<RecoveryOutcome> {
    if (input.signal?.aborted) return { kind: "ignored" };
    let message: Record<string, unknown>;
    try { message = JSON.parse(input.rawStart) as Record<string, unknown>; } catch { return { kind: "ignored" }; }
    const start = message.start as Record<string, unknown> | undefined;
    const parameters = start?.customParameters as Record<string, unknown> | undefined;
    const format = start?.mediaFormat as Record<string, unknown> | undefined;
    const stream = start?.streamSid;
    if (message.event !== "start" || message.sequenceNumber !== "1" && message.sequenceNumber !== 1 || typeof stream !== "string" || !/^MZ[a-fA-F0-9]{32}$/.test(stream)
      || message.streamSid !== undefined && message.streamSid !== stream || start?.callSid !== input.parentCallId
      || start.accountSid !== input.expectedAccountId || format?.encoding !== "audio/x-mulaw" || format.sampleRate !== 8000 || format.channels !== 1
      || typeof parameters?.capability !== "string") return { kind: "ignored" };
    const profile = await this.options.mediaProfile?.({ scope: input.scope, recoveryId: input.recoveryId });
    if (profile == null || parameters.voice_profile_sha256 !== profile || input.signal?.aborted) return { kind: "ignored" };
    const binding = { ...input, childCorrelationId: await this.childCorrelation(input), voiceProfileSha256: profile };
    if (!this.options.renderer.verifyCapability({ ...binding, capability: parameters.capability })
      || !await this.options.authenticator.verify({ target: "relay", scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId, capability: parameters.capability })
      || input.signal?.aborted) return { kind: "ignored" };
    const attachmentId = `audio-${createHash("sha256").update(JSON.stringify([profile, input.recoveryId, stream, cryptoRandom()])).digest("hex").slice(0,48)}`;
    return await this.options.recovery.recordMediaAttachmentEvidence?.({ scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId,
      target: "relay", attachmentId, ...(input.signal === undefined ? {} : { signal: input.signal }) }) ?? { kind: "ignored" };
  }

  /** Twilio signature is checked by ingress; this adds the exact capability and durable human-end proof. */
  async relayComplete(input: Omit<FallbackAttachmentInput, "childCorrelationId"> & { capability: string }): Promise<{ kind: "caller_ended" | "candidate_failed"; twiml: string } | { kind: "continue"; voiceEpoch: number } | { kind: "ignored" }> {
    if (this.options.renderer.target !== "relay") return { kind: "ignored" };
    const profile = await this.options.candidateProfile?.(input.scope) ?? null;
    const protectedInput = { ...input, ...(profile === null ? {} : { voiceProfileSha256: profile }) };
    const binding = await this.options.recovery.relayCompletion?.(input);
    if (binding == null || !this.options.renderer.verifyCapability({ ...protectedInput, childCorrelationId: binding.childCorrelationId })
      || !await this.options.authenticator.verify({ target: "relay", scope: input.scope, recoveryId: input.recoveryId,
        parentCallId: input.parentCallId, capability: input.capability })) return { kind: "ignored" };
    const finalBinding = await this.options.recovery.relayCompletion?.(input);
    if (finalBinding == null || finalBinding.childCorrelationId !== binding.childCorrelationId || finalBinding.voiceEpoch !== binding.voiceEpoch) return { kind: "ignored" };
    if (profile !== null) return { kind: finalBinding.callerEnded ? "caller_ended" : "candidate_failed", twiml: "<Response><Hangup/></Response>" };
    return finalBinding.callerEnded
      ? { kind: "caller_ended", twiml: "<Response><Say>Thank you for calling Synthetic Practice. Goodbye.</Say><Hangup/></Response>" }
      : { kind: "continue", voiceEpoch: binding.voiceEpoch };
  }

  /** Call only after an authenticated scripted Gather submits non-empty text; it persists that turn before returning. */
  async scriptedGather(input: FallbackAttachmentInput & Omit<ScriptedGatherBinding, "emptyAttempts"> & { speech: string; digits?: string; emptyAttempts?: number }): Promise<RecoveryOutcome | { kind: "rendered"; recovery: RecoveryOutcome; twiml: string; nextSourceId: string }> {
    const outageProfile = await this.options.outageProfile?.({ scope: input.scope, recoveryId: input.recoveryId }) ?? null;
    if (await this.options.candidateProfile?.(input.scope) != null && outageProfile === null) return { kind: "ignored" };
    input = { ...input, ...(outageProfile === null ? {} : { voiceProfileSha256: outageProfile, voiceRenderer: "outage_scripted" as const }) };
    const say = (text: string) => `<Say${outageProfile === null ? "" : ' voice="Polly.Joanna-Neural"'}>${xml(text)}</Say>`;
    const emptyAttempts = input.emptyAttempts ?? 0;
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(input.sourceId) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.capability)
      || !Number.isInteger(emptyAttempts) || emptyAttempts < 0 || emptyAttempts > 2) return { kind: "ignored" };
    if (this.options.renderer.target !== "scripted" || !this.options.renderer.verifyCapability(input) || this.options.scriptedText === undefined
      || !await this.options.authenticator.verify({ target: "scripted", scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId, capability: input.capability })) return { kind: "ignored" };
    const attached = await this.options.recovery.recordAttachmentEvidence({ scope: input.scope, recoveryId: input.recoveryId, parentCallId: input.parentCallId,
      target: "scripted", attachmentId: this.options.renderer.render(input).attachmentId });
    if (attached.kind !== "attached") return attached;
    const currentEmptyAttempts = await this.options.scriptedText.emptyAttempts({ scope: input.scope, recoveryId: input.recoveryId });
    if (currentEmptyAttempts === null) return { kind: "outcome_unknown", recoveryId: input.recoveryId };
    const nextSourceId = `gather-${createHmac("sha256", input.capability).update(input.sourceId).digest("hex").slice(0, 32)}`;
    const noMessageText = "I'm sorry, I couldn't take your message. Please call again when you're ready.";
    if (currentEmptyAttempts === 3) return { kind: "rendered", recovery: attached,
      twiml: `<Response>${say(noMessageText)}<Hangup/></Response>`, nextSourceId };
    const body = input.speech.trim() || input.digits?.trim() || "";
    if (body && currentEmptyAttempts !== emptyAttempts) return { kind: "outcome_unknown", recoveryId: input.recoveryId };
    const captured = body ? await this.options.scriptedText.capture({ scope: input.scope, recoveryId: input.recoveryId, sourceId: input.sourceId, body })
      : { recorded: true, text: "", completed: false };
    if (!captured.recorded) return captured.definitiveNoSave === true
      ? { kind: "rendered", recovery: attached, twiml: `<Response>${say(noMessageText)}<Hangup/></Response>`, nextSourceId }
      : { kind: "outcome_unknown", recoveryId: input.recoveryId };
    const nextEmptyAttempts = body ? await this.options.scriptedText.emptyAttempts({ scope: input.scope, recoveryId: input.recoveryId })
      : await this.options.scriptedText.noteSilence({ scope: input.scope, recoveryId: input.recoveryId, sourceId: input.sourceId, expectedAttempts: emptyAttempts });
    if (nextEmptyAttempts === null) return { kind: "outcome_unknown", recoveryId: input.recoveryId };
    if (nextEmptyAttempts === 3) return { kind: "rendered", recovery: attached,
      twiml: `<Response>${say(noMessageText)}<Hangup/></Response>`, nextSourceId };
    if (captured.completed) return { kind: "rendered", recovery: attached, twiml: `<Response>${say(captured.text)}<Hangup/></Response>`, nextSourceId };
    const retryText = body ? captured.text : await this.options.scriptedText.silencePrompt({ scope: input.scope, recoveryId: input.recoveryId });
    if (retryText === null) return { kind: "outcome_unknown", recoveryId: input.recoveryId };
    const rendered = this.options.renderer.render(input, retryText, nextSourceId, nextEmptyAttempts);
    return { kind: "rendered", recovery: attached, twiml: rendered.twiml, nextSourceId };
  }

  private async childCorrelation(input: Omit<FallbackAttachmentInput, "childCorrelationId">): Promise<string> {
    const prepared = await this.options.recovery.prepareRecovery({ ...input, target: "relay" });
    return prepared.kind === "prepared" && prepared.childCorrelationId ? prepared.childCorrelationId : "invalid";
  }
}

function relaySetup(raw: string): { callSid: string; capability: string } | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const setup = value as { type?: unknown; callSid?: unknown; customParameters?: unknown };
    const parameters = setup.customParameters;
    if (setup.type !== "setup" || typeof setup.callSid !== "string" || parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return null;
    const capability = (parameters as Record<string, unknown>).capability;
    return typeof capability === "string" ? { callSid: setup.callSid, capability } : null;
  } catch { return null; }
}

function checkedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") throw new Error("fallback_public_base_url_invalid");
  return url;
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function xml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!); }
function normalizePhone(value: string, caller: string): string | null {
  if (/\b(?:use|my)\s+(?:caller|this)\s+(?:number|phone)\b/i.test(value)) return caller;
  const words: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const spoken = value.toLowerCase().replace(/\b(plus|\+)\b/g, "+").replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (_, word: string) => words[word]!);
  const digits = spoken.replace(/[^\d+]/g, "");
  const normalized = /^\d{10}$/.test(digits) && caller.startsWith("+1") ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : digits;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
function isName(value: string): boolean {
  return /^[A-Za-z][A-Za-z' -]{0,198}$/.test(value)
    && !/\b(?:i|need|appointment|call|help|message|my)\b/i.test(value);
}
function explicitNameRefusal(value: string): boolean {
  const normalized = value.trim().replace(/[\u2018\u2019]/g, "'");
  if (/[?]|\b(?:why|cancel|never mind|go back|stop|my name is|give me a moment|wait)\b|\bi can\s+(?!not\b)/i.test(normalized)) return false;
  return /^(?:(?:okay|alright|no(?:\s+thanks)?)[,.\s]+)?(?:(?:i'm|i am)\s+sorry[,.\s]+)?i\s+(?:can't|cannot|won't|will not|don't|do not)\s+(?:provide|give|share)\s+(?:a|my)\s+name\b(?:[,.!]\s*(?:(?:i(?:'m| am)|that(?:'s| is)|just)\b[^?]*)?)?$/i.test(normalized);
}
function explicitMessageRefusal(value: string): boolean {
  const normalized = value.replace(/[\u2018\u2019]/g, "'").replace(/[,.!]/g, " ").replace(/\s+/g, " ").trim();
  if (/[?]|\b(?:why|cancel|never mind|go back|stop|give me a moment|wait)\b/i.test(normalized)) return false;
  return /^(?:(?:okay|alright)[,.\s]+)?(?:no\s+(?:message|voicemail)|i\s+(?:don't|do not)\s+(?:have|want(?:\s+to\s+leave)?)\s+(?:a\s+)?message|no(?:\s+thank you|\s+thanks)?(?:[,\s]+that(?:'s|\s+is)\s+all)?)(?:[,.\s]+(?:thank you|thanks))?[.!]?$/i.test(normalized);
}
function scriptedBackRequest(value: string): boolean {
  return /^(?:please\s+)?(?:go back|can (?:we|i) go back|take me back|stop taking (?:a|my) message|never mind,? i (?:don't|do not) want to leave a message)[.!?]?$/i.test(value.trim());
}
function sameActionCandidate(left: { sourceId: string; requestId: string; requestRevision: number; receiptId: string; operation: string; resultHash: string; readbackHash: string; resultingVersion: number }, right: typeof left): boolean {
  return left.sourceId === right.sourceId && left.requestId === right.requestId && left.requestRevision === right.requestRevision
    && left.receiptId === right.receiptId && left.operation === right.operation && left.resultHash === right.resultHash
    && left.readbackHash === right.readbackHash && left.resultingVersion === right.resultingVersion;
}
function initialSourceId(input: FallbackAttachmentInput): string { return `gather-${createHmac("sha256", input.childCorrelationId).update(input.recoveryId).digest("hex").slice(0, 32)}`; }

function cryptoRandom(): string { return randomUUID(); }
