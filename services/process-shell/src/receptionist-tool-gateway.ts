import { isReceptionistQuestionSource, isReceptionistCallerExit } from "./receptionist-callback-dialogue.js";
import { z } from "zod";
import { isClearDecline } from "./f2-dialogue-evidence.js";
import { createHash } from "node:crypto";
import { ConversationConflict, scopeOf, type Conversation, type ConversationCommand, type ConversationScope, type CommandEnvelope } from "./conversation-contract.js";
import type { ConversationStore, TransitionReceipt } from "./conversation-store.js";
import { compileDegradedReceptionistPrompt, compileReceptionistPrompt, explicitRecipientCategory, parseReceptionistCaptureProposal, receptionistIntentProposalSchema,
  emergencyResponseDirective, receptionistEmergencyProposalSchema, receptionistDialogueProposalSchema, receptionistPublicFaqProposalSchema, receptionistCallbackAnswerProposalSchema, type ReceptionistAppInstance, type ReceptionistCaptureProposal, type ReceptionistEmergencyDirective,
  type VoiceAppInstance } from "./receptionist-policy.js";
import { resolveReceptionistPublicFaq, type ReceptionistPublicFaqAnswer } from "./receptionist-public-faq.js";

const invocationId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const answerSchema = receptionistCallbackAnswerProposalSchema;
type SemanticProposal = NonNullable<CommandEnvelope["proposal"]>;
export type ReceptionistToolResult =
  | { kind: "dialogue"; dialogue: "explain_purpose" | "clarify_request" | "clarify_message" | "repeat" | "side_question" | "social" | "pause" | "end_call" | "message_recipient" | "callback_timing" | "repair" | "retry"; endingReason?: "explicit_request" | "declined_further_help" | "not_ending"; proposal?: SemanticProposal }
  | { kind: "callback_answer"; answer: "yes" | "no" | "unclear"; replyKind: NonNullable<z.infer<typeof answerSchema>["replyKind"]>; questionId: string; proposal: SemanticProposal }
  | { kind: "accepted"; receipt: { eventId: string; revision: number; requestState: string | null }; directive?: ReceptionistEmergencyDirective; publicFaq?: ReceptionistPublicFaqAnswer; faqUnsupported?: boolean }
  | { kind: "rejected"; code: "tool_not_allowed" | "invalid_arguments" | "source_not_current" | "context_stale" | "question_not_pending" | "confirmation_not_given" | "transition_rejected" | "invocation_conflict" | "public_faq_unavailable" | "stale_revision" };

/** The caller of this port supplies authenticated context; only name/arguments come from GPT. */
export class ReceptionistToolGateway {
  constructor(private readonly options:
    | { store: Pick<ConversationStore, "get" | "execute" | "getEvent">; instance: ReceptionistAppInstance; model: string; variant?: "receptionist" }
    | { store: Pick<ConversationStore, "get" | "execute" | "getEvent">; instance: VoiceAppInstance; model: string; variant: "degraded_voice" }) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.model)) throw new Error("receptionist_model_identity_invalid");
  }

  /** Kept as a compatible port; meaning is never inferred without an interpreter. */
  async captureCurrentSourceContact(_input: { scope: ConversationScope; sourceId: string; requestId: string; expectedRevision: number; expectedOwnerEpoch: number }): Promise<ReceptionistToolResult | { kind: "not_applicable" }> {
    return { kind: "not_applicable" };
  }

  async invoke(input: {
    scope: ConversationScope;
    invocationId: string;
    sourceId: string;
    requestId: string;
    expectedRevision: number;
    expectedOwnerEpoch: number;
    name: string;
    arguments: unknown;
    /** Internal diagnostic only; never crosses the model tool-output boundary. */
    deferCallbackConfirmation?: boolean;
    onIntentRejectStage?: (stage: "intent_schema" | "intent_recipient" | "other") => void;
  }): Promise<ReceptionistToolResult> {
    if (!invocationId.safeParse(input.invocationId).success) return { kind: "rejected", code: "invalid_arguments" };
    let normalized: Record<string, string | boolean | number | null>;
    try {
      if (input.name === "propose_receptionist_dialogue") normalized = definedArguments(receptionistDialogueProposalSchema.parse(input.arguments));
      else if (input.name === "propose_receptionist_intent") normalized = definedArguments(receptionistIntentProposalSchema.parse(input.arguments));
      else if (input.name === "propose_receptionist_public_faq") normalized = definedArguments(receptionistPublicFaqProposalSchema.parse(input.arguments));
      else if (input.name === "propose_receptionist_emergency") normalized = definedArguments(receptionistEmergencyProposalSchema.parse(input.arguments));
      else if (input.name === "propose_receptionist_capture") {
        const capture = parseReceptionistCaptureProposal(normalizeReceptionistCaptureArguments(input.arguments, this.options.instance));
        normalized = Object.fromEntries(Object.entries(capture).filter(([, value]) => value !== undefined)) as Record<string, string>;
      } else if (input.name === "propose_callback_answer") normalized = definedArguments(answerSchema.parse(input.arguments));
      else return { kind: "rejected", code: "tool_not_allowed" };
    } catch { if (input.name === "propose_receptionist_intent") emitIntentRejectStage(input, "intent_schema"); return { kind: "rejected", code: "invalid_arguments" }; }
    const eventId = `tool-${input.invocationId}`;
    const prior = await this.options.store.getEvent(input.scope, eventId);
    if (prior) {
      const proposal = prior.input.proposal;
      const command = prior.input.command;
      const bundle = command.type === "request.draft" ? command.sourceEventIds : undefined;
      if (proposal?.inputHash !== proposalHash(input, normalized, bundle, this.options.model, this.options.instance.promptVersion)) return { kind: "rejected", code: "invocation_conflict" };
      const replay = resultForReceipt(prior.receipt, input, normalized, command.type);
      const state = await this.options.store.get(input.scope);
      if (state?.admission.channel === "sms" && input.name === "propose_receptionist_public_faq") return { kind: "rejected", code: "tool_not_allowed" };
      if (replay.kind !== "accepted" || input.name !== "propose_receptionist_public_faq" || command.type !== "request.draft" || command.receptionistPublicFaqTopic === undefined) return replay;
      const publicFaq = resolveReceptionistPublicFaq({ practiceId: input.scope.practiceId, topic: receptionistPublicFaqProposalSchema.parse(input.arguments).topic, asOf: new Date().toISOString() });
      const request = state?.requests.find((item) => item.id === input.requestId);
      const source = state?.inputs.find((item) => item.id === input.sourceId);
      return publicFaq === null || source === undefined
        || request?.receptionistPublicFaq === undefined || !samePublicFaqReference(request.receptionistPublicFaq, publicFaq)
        ? { kind: "rejected", code: "public_faq_unavailable" } : { ...replay, publicFaq, faqUnsupported: normalized.unsupportedPart === true };
    }
    const state = await this.options.store.get(input.scope);
    if (!state || state.ownerEpoch !== input.expectedOwnerEpoch || state.phase !== "active" || state.owner !== "ai" || state.suppressed) return { kind: "rejected", code: "context_stale" };
    if (state.revision !== input.expectedRevision) return { kind: "rejected", code: "stale_revision" };
    let admittedPrompt: ReturnType<typeof compileReceptionistPrompt>;
    try {
      admittedPrompt = this.options.variant === "degraded_voice" ? compileDegradedReceptionistPrompt(this.options.instance, state)
        : compileReceptionistPrompt(this.options.instance, state);
    }
    catch { return { kind: "rejected", code: "context_stale" }; }
    if ((this.options.variant === "degraded_voice" || state.admission.channel === "sms") && input.name === "propose_receptionist_public_faq") {
      return { kind: "rejected", code: "tool_not_allowed" };
    }
    const source = state.inputs.at(-1);
    if (!source || source.id !== input.sourceId) return { kind: "rejected", code: "source_not_current" };
    const semanticVoice = state.admission.mode === "receptionist" && state.admission.channel === "voice";
    const semanticProposal = (): SemanticProposal => ({ invocationId: input.invocationId, tool: input.name, sourceId: source.id,
      model: this.options.model, provider: "openai", promptVersion: this.options.instance.promptVersion, arguments: normalized,
      inputHash: proposalHash(input, normalized, undefined, this.options.model, this.options.instance.promptVersion) });
    if (semanticVoice && !hasRequiredSemanticFields(input.name, normalized)) return { kind: "rejected", code: "invalid_arguments" };
    let captureProposal = input.name === "propose_receptionist_capture" ? parseReceptionistCaptureProposal(normalized) : undefined;
    if (semanticVoice && captureProposal !== undefined && source.questionId !== undefined && source.questionId !== state.pendingQuestion?.id)
      return { kind: "rejected", code: "question_not_pending" };
    if (captureProposal !== undefined) {
      const bounded = semanticVoice
        ? captureForCurrentQuestion(state, input.requestId, source.body, captureProposal, this.options.instance.numberBinding.sourceNumberE164)
        : legacyCaptureForCurrentQuestion(state, input.requestId, source.body, captureProposal, this.options.instance.numberBinding.sourceNumberE164);
      if ("kind" in bounded) return bounded;
      captureProposal = bounded;
    }
    if (!semanticVoice && input.name === "propose_receptionist_intent" && isClearDecline(source.body)) {
      emitIntentRejectStage(input, "other");
      return { kind: "rejected", code: "invalid_arguments" };
    }
    if (input.name === "propose_receptionist_dialogue" && captureProposal === undefined) {
      if (state.admission.channel !== "voice") return { kind: "rejected", code: "tool_not_allowed" };
      const dialogue = receptionistDialogueProposalSchema.parse(input.arguments).kind;
      const endingReason = receptionistDialogueProposalSchema.parse(input.arguments).endingReason;
      if (semanticVoice && (endingReason === undefined || dialogue === "end_call" && endingReason === "not_ending" || dialogue !== "end_call" && endingReason !== "not_ending")) return { kind: "rejected", code: "invalid_arguments" };
      if (!semanticVoice && dialogue === "end_call" && !isReceptionistCallerExit(source.body)) return { kind: "rejected", code: "invalid_arguments" };
      return { kind: "dialogue", dialogue, ...(semanticVoice && endingReason !== undefined ? { endingReason, proposal: semanticProposal() } : {}) };
    }
    if (state.admission.channel === "voice" && input.name === "propose_receptionist_emergency"
      && (semanticVoice ? receptionistEmergencyProposalSchema.parse(input.arguments).basis !== "caller_statement" : !hasCallerUrgencyEvidence(source.body, receptionistEmergencyProposalSchema.parse(input.arguments).classification))) {
      return { kind: "rejected", code: "invalid_arguments" };
    }
    if (state.admission.channel === "voice" && input.name === "propose_receptionist_capture" && captureProposal?.message !== undefined && captureProposal.messageClarity === "unclear") {
      return { kind: "dialogue", dialogue: "clarify_message" };
    }
    const deferUnclearIntentToCallback = state.admission.channel === "voice" && input.name === "propose_receptionist_intent"
      && (semanticVoice ? receptionistIntentProposalSchema.parse(input.arguments).requestMeaning === "unclear" : receptionistIntentProposalSchema.parse(input.arguments).category === "general_or_uncertain" && !isExplicitGeneralOfficeRequest(source.body));
    const requestedRecipientCategory = !semanticVoice && input.name === "propose_receptionist_intent" ? explicitRecipientCategory(source.body) : null;
    if (requestedRecipientCategory !== null
      && receptionistIntentProposalSchema.parse(input.arguments).category !== requestedRecipientCategory) {
      emitIntentRejectStage(input, "intent_recipient");
      return { kind: "rejected", code: "invalid_arguments" };
    }
    if (captureProposal !== undefined && captureWouldConsumeSideQuestionOrExit(state, input.requestId, source, semanticVoice)) {
      return { kind: "rejected", code: "invalid_arguments" };
    }
    const sourceBundle = input.name === "propose_receptionist_intent" || input.name === "propose_receptionist_capture"
      ? sourceBundleFor(state, input.requestId, input.sourceId) : undefined;
    if (sourceBundle === null) return { kind: "rejected", code: "source_not_current" };
    if (this.options.variant === "degraded_voice" && state.requests.find((request) => request.id === input.requestId)?.fullProposal !== undefined) {
      return { kind: "rejected", code: "tool_not_allowed" };
    }
    const inputHash = proposalHash(input, normalized, sourceBundle, this.options.model, this.options.instance.promptVersion);
    const publicFaq = input.name === "propose_receptionist_public_faq"
      ? resolveReceptionistPublicFaq({ practiceId: state.admission.practiceId, topic: receptionistPublicFaqProposalSchema.parse(input.arguments).topic, asOf: new Date().toISOString() })
      : null;
    if (input.name === "propose_receptionist_public_faq" && (publicFaq === null)) {
      return { kind: "rejected", code: "public_faq_unavailable" };
    }
    if (captureProposal !== undefined) {
      const capture = captureProposal!;
      const candidate = capture.callbackNumber;
      const sourceNumber = callbackNumberFromSource(source.body, this.options.instance.numberBinding.sourceNumberE164);
      const optedInCallerNumber = this.options.variant === "degraded_voice"
        ? explicitCallerNumberOptIn(source.body, state.admission.contact) : null;
      if (!semanticVoice && candidate !== undefined && sourceNumber !== candidate && optedInCallerNumber !== candidate) {
        return { kind: "rejected", code: "invalid_arguments" };
      }
      const question = state.pendingQuestion;
      // Bind semantic name proposals to the actual current question/source, not
      // to a second lexical interpretation of the caller's words.
      if (state.admission.channel === "voice" && capture.name !== undefined && question !== null
        && ["message", "name", "callback_number_entry", "callback_number"].includes(question.kind)
        && (question.requestId !== input.requestId || source.questionId !== question.id
          || source.sequence <= question.activatedRevision
          || state.requests.find(request => request.id === input.requestId)?.revision !== question.requestRevision)) {
        return { kind: "rejected", code: "question_not_pending" };
      }
    }
    let command: ConversationCommand;
    let actor: "ai" | "system" = "ai";
    try {
      if (input.name === "propose_receptionist_intent") {
        const proposal = receptionistIntentProposalSchema.parse(input.arguments);
        if (semanticVoice && proposal.requestMeaning === undefined) return { kind: "rejected", code: "invalid_arguments" };
        const existing = state.requests.find(item => item.id === input.requestId);
        if (semanticVoice && proposal.requestMeaning === "new_goal" && existing !== undefined) return { kind: "dialogue", dialogue: "clarify_request" };
        if (semanticVoice && existing?.category && existing.category !== proposal.category && proposal.requestMeaning !== "recipient_correction") return { kind: "rejected", code: "invalid_arguments" };
        const phoneClause = !semanticVoice && state.admission.channel === "voice" ? /\b(?:my\s+(?:(?:callback|phone|telephone)\s+)?number\s+is|my\s+phone\s+is|call\s+me(?:\s+back)?\s+(?:at|on)|reach\s+me\s+(?:at|on))\s+([^!?;]{7,120})/i.exec(source.body) : null;
        const volunteeredNumber = phoneClause === null ? null : callbackNumberFromSource(phoneClause[1]!, this.options.instance.numberBinding.sourceNumberE164);
        command = { type: "request.draft", requestId: input.requestId, sourceEventId: source.id, ...(sourceBundle === undefined ? {} : { originalSourceEventId: sourceBundle[0], sourceEventIds: sourceBundle }),
          ...(deferUnclearIntentToCallback ? {} : { category: proposal.category }),
          ...(volunteeredNumber === null ? {} : { callbackNumber: volunteeredNumber }) };
      } else if (input.name === "propose_receptionist_public_faq") {
        const proposal = receptionistPublicFaqProposalSchema.parse(input.arguments);
        command = { type: "request.draft", requestId: input.requestId, sourceEventId: source.id, receptionistPublicFaqTopic: proposal.topic,
          receptionistPublicFaqReference: publicFaqReference(publicFaq!) };
      } else if (input.name === "propose_receptionist_emergency") {
        const proposal = receptionistEmergencyProposalSchema.parse(input.arguments);
        command = { type: "emergency.assess", sourceEventId: source.id, classification: proposal.classification };
      } else if (captureProposal !== undefined) {
        const proposal = captureProposal!;
        // The protected source retains the caller's message; an AI paraphrase never replaces it.
        const request = state.requests.find((item) => item.id === input.requestId);
        const pendingQuestion = state.pendingQuestion;
        if (pendingQuestion?.requestId === input.requestId
          && ["message", "name", "callback_number_entry", "callback_number"].includes(pendingQuestion.kind)
          && proposal.name === undefined && proposal.message === undefined && proposal.callbackNumber === undefined) {
          return { kind: "rejected", code: "invalid_arguments" };
        }
        if (pendingQuestion?.kind === "message" && pendingQuestion.requestId === input.requestId) {
          if (proposal.message === undefined && proposal.name === undefined && proposal.callbackNumber === undefined) return { kind: "rejected", code: "invalid_arguments" };
          command = proposal.message === undefined
            ? { type: "request.draft", requestId: input.requestId, sourceEventId: source.id,
              ...(proposal.name === undefined ? {} : { name: proposal.name }), ...(proposal.callbackNumber === undefined ? {} : { callbackNumber: proposal.callbackNumber }) }
            : { type: "request.capture_callback_message", requestId: input.requestId, sourceEventId: source.id,
              ...(proposal.name === undefined ? {} : { name: proposal.name }), ...(proposal.callbackNumber === undefined ? {} : { callbackNumber: proposal.callbackNumber }) };
        } else if (state.admission.mode === "receptionist" && state.admission.channel === "voice" && request?.state === "draft"
          && request.callbackMessageSourceId != null && proposal.message !== undefined && pendingQuestion?.requestId === request.id
          && ["name", "callback_number_entry", "callback_number"].includes(pendingQuestion.kind)) {
          if (!semanticVoice && /^(?:yes|yeah|yep|correct|right|that's right|that is correct)[.! ,]*$/i.test(source.body)) return { kind: "rejected", code: "invalid_arguments" };
          const recipientCorrection = semanticVoice ? null : explicitRecipientCategory(source.body);
          if (recipientCorrection !== null && recipientCorrection !== request.category) return { kind: "rejected", code: "invalid_arguments" };
          command = { type: "request.capture_callback_message", requestId: input.requestId, sourceEventId: source.id,
            ...(proposal.name === undefined ? {} : { name: proposal.name }), ...(proposal.callbackNumber === undefined ? {} : { callbackNumber: proposal.callbackNumber }) };
        } else if (request?.state === "needs_callback" && proposal.name === undefined && proposal.callbackNumber === undefined) {
          command = { type: "request.supplement", requestId: input.requestId, sourceEventId: source.id };
        } else if (request?.state === "needs_callback") {
          command = { type: "request.correct_contact", requestId: input.requestId, sourceEventId: source.id,
            ...(proposal.name === undefined ? {} : { name: proposal.name }), ...(proposal.callbackNumber === undefined ? {} : { callbackNumber: proposal.callbackNumber }) };
        } else {
          // This draft branch only persists contact fields. Reject an ignored
          // message-only proposal instead of minting a fieldless draft/reroute.
          if (proposal.name === undefined && proposal.callbackNumber === undefined) return { kind: "rejected", code: "invalid_arguments" };
          command = { type: "request.draft", requestId: input.requestId, sourceEventId: source.id, ...(sourceBundle === undefined ? {} : { originalSourceEventId: sourceBundle[0], sourceEventIds: sourceBundle }),
            ...(proposal.name === undefined ? {} : { name: proposal.name }), ...(proposal.callbackNumber === undefined ? {} : { callbackNumber: proposal.callbackNumber }) };
        }
      } else if (input.name === "propose_callback_answer") {
        const proposal = answerSchema.parse(input.arguments);
        if (!semanticVoice && proposal.answer !== "yes") return { kind: "rejected", code: "confirmation_not_given" };
        const question = state.pendingQuestion;
        if (semanticVoice && (proposal.replyKind === undefined || proposal.proposalQuestionId !== question?.id
          || proposal.answer === "yes" && proposal.replyKind !== "explicit_assent")) return { kind: "rejected", code: "confirmation_not_given" };
        if (question?.kind !== "callback_number" || question.requestId !== input.requestId || question.id !== source.questionId || !question.callbackNumber) return { kind: "rejected", code: "question_not_pending" };
        if (semanticVoice) return input.deferCallbackConfirmation
          ? { kind: "callback_answer", answer: proposal.answer, replyKind: proposal.replyKind!, questionId: question.id, proposal: semanticProposal() }
          : { kind: "rejected", code: "confirmation_not_given" };
        if (proposal.answer !== "yes") return { kind: "rejected", code: "confirmation_not_given" };
        actor = "system";
        command = { type: "request.confirm_callback", requestId: input.requestId, callbackNumber: question.callbackNumber, sourceEventId: source.id };
      } else return { kind: "rejected", code: "tool_not_allowed" };
    } catch { return { kind: "rejected", code: "invalid_arguments" }; }
    try {
      const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId,
        expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, actor: { kind: actor, id: "receptionist-gateway" }, command,
        proposal: { invocationId: input.invocationId, tool: input.name, sourceId: source.id, model: this.options.model, provider: "openai",
          promptVersion: this.options.instance.promptVersion, arguments: normalized, inputHash } });
      const result = resultForReceipt(receipt, input, normalized, command.type);
      return result.kind === "accepted" && publicFaq !== null ? { ...result, publicFaq, faqUnsupported: normalized.unsupportedPart === true } : result;
    } catch (error) {
      if (error instanceof ConversationConflict) return { kind: "rejected", code: error.code === "event_payload_conflict" ? "invocation_conflict" : "transition_rejected" };
      throw error;
    }
  }
}

function normalizeReceptionistCaptureArguments(value: unknown, instance: { numberBinding: { sourceNumberE164: string } }): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>, callback = input.callbackNumber;
  if (typeof callback !== "string") return value;
  const normalized = normalizeCallbackNumber(callback, instance.numberBinding.sourceNumberE164);
  return normalized === null ? value : { ...input, callbackNumber: normalized };
}

export function callbackNumberFromSource(source: string, configuredNumber: string): string | null {
  const words: Readonly<Record<string, string>> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const spoken = source.toLowerCase().replace(/\b(plus|\+)\b/g, "+").replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (_match, word: string) => words[word]!);
  return normalizeCallbackNumber(spoken.replace(/[^\d+]/g, ""), configuredNumber);
}

function normalizeCallbackNumber(value: string, configuredNumber: string): string | null {
  const compact = value.replace(/[() .-]/g, "");
  if (/^\d{10}$/.test(compact) && configuredNumber.startsWith("+1")) return `+1${compact}`;
  if (/^1\d{10}$/.test(compact) && configuredNumber.startsWith("+1")) return `+${compact}`;
  return /^\+[1-9]\d{7,14}$/.test(compact) ? compact : null;
}
function explicitCallerNumberOptIn(source: string, caller: string): string | null {
  return /^\s*(?:please\s+)?use\s+(?:my\s+caller|this)\s+(?:number|phone)\s*[.!?]*\s*$/i.test(source) ? caller : null;
}
/** A callback field must not consume a side question or an explicit exit as saved intake. */
function captureWouldConsumeSideQuestionOrExit(state: Conversation, requestId: string, source: Conversation["inputs"][number], semantic = false): boolean {
  const question = state.pendingQuestion;
  if (state.admission.mode !== "receptionist" || state.admission.channel !== "voice" || question?.requestId !== requestId
    || !["message", "name", "callback_number_entry"].includes(question.kind)) return false;
  const text = source.body.trim();
  return (!semantic && (isClearDecline(text) || isDirectOfficeQuestion(text) || question.kind === "message" && isCallbackMessageRefusal(text)))
    || question.id !== source.questionId || source.sequence <= question.activatedRevision
    || state.requests.find((request) => request.id === requestId)?.revision !== question.requestRevision;
}

/** A request for a person instead of leaving a message is not staff-message content. */
export function isCallbackMessageRefusal(source: string): boolean {
  const text = source.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  const declinesMessage = /\b(?:don't|do not|dont|won't|will not|rather not)\b[^.!?]{0,80}\b(?:leave|give|take)\b[^.!?]{0,40}\b(?:a )?(?:message|voicemail)\b/.test(text);
  if (declinesMessage) return true;
  // A caller can dictate a message that asks to speak with a person. That is
  // still message content, unless they actually refuse message-taking.
  if (/\b(?:tell|ask|message|have)\s+(?:the )?(?:team|staff)\b|\bcall me\b/.test(text)) return false;
  return /\b(?:want|need|let me)\b[^.!?]{0,30}\b(?:talk|speak)\b[^.!?]{0,20}\b(?:to|with)\b[^.!?]{0,20}\b(?:a )?(?:person|someone|somebody|human|staff member)\b/.test(text);
}

function isExplicitGeneralOfficeRequest(source: string): boolean {
  return /\b(?:general|front)\s+(?:office|desk|staff)\b|\boffice\s+(?:staff|person)\b/i.test(source);
}

/** Only direct public-office questions leave a callback-message turn nonmutating. */
function isDirectOfficeQuestion(source: string): boolean {
  const text = source.toLowerCase();
  return /\b(?:parking|address|office|offices|location|locations|directions|demo_way|sample_city)\b/.test(text)
    && (/\?/.test(text) || /\b(?:where|what|how|when|can|could|would|do|does|is|are)\b/.test(text));
}

function samePublicFaqReference(reference: NonNullable<Conversation["requests"][number]["receptionistPublicFaq"]>, answer: ReceptionistPublicFaqAnswer): boolean {
  return reference.topic === answer.topic && reference.packId === answer.packId && reference.packVersion === answer.packVersion
    && reference.factId === answer.factId && reference.factVersion === answer.factVersion && reference.knowledgeSourceId === answer.sourceId
    && reference.knowledgeSourceVersion === answer.sourceVersion && reference.contentHash === answer.contentHash;
}

function publicFaqReference(answer: ReceptionistPublicFaqAnswer) {
  return { packId: answer.packId, packVersion: answer.packVersion, factId: answer.factId, factVersion: answer.factVersion,
    knowledgeSourceId: answer.sourceId, knowledgeSourceVersion: answer.sourceVersion, contentHash: answer.contentHash };
}

function definedArguments(value: object): Record<string, string | boolean | number | null> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Record<string, string | boolean | number | null>;
}

function hasRequiredSemanticFields(name: string, arguments_: Record<string, string | boolean | number | null>): boolean {
  const fields: Record<string, readonly string[]> = {
    propose_receptionist_dialogue: ["endingReason"], propose_receptionist_intent: ["requestMeaning"],
    propose_receptionist_public_faq: ["unsupportedPart"], propose_receptionist_emergency: ["basis"],
    propose_receptionist_capture: ["messageAction", "numberMeaning", "messageClarity"],
    propose_callback_answer: ["replyKind", "proposalQuestionId"],
  };
  return (fields[name] ?? []).every(field => arguments_[field] !== undefined);
}

function proposalHash(input: { scope: ConversationScope; invocationId: string; sourceId: string; requestId: string; expectedRevision: number; expectedOwnerEpoch: number; name: string }, normalized: Record<string, string | boolean | number | null>, sourceBundle: readonly string[] | undefined, model: string, promptVersion: string): string {
  return createHash("sha256").update(JSON.stringify([input.scope.practiceId, input.scope.instanceId, input.scope.conversationId,
    input.invocationId, input.sourceId, input.requestId, input.expectedRevision, input.expectedOwnerEpoch, input.name,
    sourceBundle, Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b)), model, promptVersion])).digest("hex");
}

function sourceBundleFor(state: Conversation, requestId: string, sourceId: string): string[] | undefined | null {
  if (state.requests.some((request) => request.id === requestId)) return undefined;
  const referenced = new Set(state.requests.flatMap((request) => request.sourceIds));
  // A previous field answer belongs to the question that elicited it, never to
  // a later request. Unbound fragments may still be bundled in caller order.
  const sources = state.inputs.filter((input) => !referenced.has(input.id) && input.questionId === undefined).map((input) => input.id);
  return sources.length === 0 || sources.length > 8 || sources.at(-1) !== sourceId ? null : sources;
}

function safeResult(receipt: TransitionReceipt, requestId: string): ReceptionistToolResult {
  return receipt.accepted ? { kind: "accepted", receipt: { eventId: receipt.eventId, revision: receipt.state.revision,
    requestState: receipt.state.requests.find((request) => request.id === requestId)?.state ?? null } } : { kind: "rejected",
    code: receipt.error === "stale_revision" ? "stale_revision" : "transition_rejected" };
}

function resultForReceipt(receipt: TransitionReceipt, input: { name: string; sourceId: string; requestId: string }, normalized: Record<string, string | boolean | number | null>, commandType: ConversationCommand["type"]): ReceptionistToolResult {
  const result = safeResult(receipt, input.requestId);
  if (result.kind !== "accepted" || input.name !== "propose_receptionist_emergency" || commandType !== "emergency.assess") return result;
  const proposal = receptionistEmergencyProposalSchema.parse(normalized);
  return { ...result, directive: emergencyResponseDirective(receipt.state, input.sourceId, proposal.classification) };
}

function emitIntentRejectStage(input: { onIntentRejectStage?: (stage: "intent_schema" | "intent_recipient" | "other") => void }, stage: "intent_schema" | "intent_recipient" | "other"): void {
  try { input.onIntentRejectStage?.(stage); } catch { /* Diagnostics never affect caller control flow. */ }
}


/** Evidence of caller-declared urgency only. This deliberately does not infer urgency from symptoms. */
export function hasCallerUrgencyEvidence(source: string, classification: "caller_emergency" | "urgent_unclear"): boolean {
  // This validates a generic caller declaration, never infers urgency from symptoms.
  // Meaning still comes from the interpreter; source evidence cannot be a meta-question or a denied claim.
  const clauses = source.toLowerCase().replace(/[’]/g, "'").split(/[.!;]+/);
  return clauses.some((clause) => {
    const text = clause.trim();
    if (!text || /[?"“”]/.test(text) || /^(?:what|why|how|when|where|which|who|do|does|did|is|are|can|could|should|would|will)\b/.test(text)
      || /\b(?:asking|asked|quote|quoted|said|says)\b/.test(text)) return false;
    const positive = text.replace(/\b(?:not|no|isn't|is not|isnt|without)\s+(?:(?:having|an?|any)\s+){0,3}(?:emergency|urgent|urgency)\b/g, "");
    return classification === "caller_emergency" ? /\bemergency\b/.test(positive)
      : /\b(?:emergency|urgent|urgently|immediate(?:ly)?|911)\b/.test(positive);
  });
}


export { isReceptionistCallerExit } from "./receptionist-callback-dialogue.js";


/** Derive permitted writes from the current source/question; model field labels are only proposals. */
function captureForCurrentQuestion(state: Conversation, requestId: string, _source: string, raw: ReceptionistCaptureProposal, _configuredNumber: string): ReceptionistCaptureProposal | Extract<ReceptionistToolResult, { kind: "dialogue" }> {
  const question = state.pendingQuestion, request = state.requests.find(item => item.id === requestId);
  if (state.admission.mode !== "receptionist" || state.admission.channel !== "voice") return raw;
  if (raw.messageAction === undefined || raw.numberMeaning === undefined || raw.messageClarity === undefined) return { kind: "dialogue", dialogue: "repair" };
  const semantic: ReceptionistCaptureProposal = { ...raw };
  if (raw.messageAction === "preserve") { delete semantic.message; delete semantic.messageClarity; }
  else if (raw.message === undefined || raw.messageAction === "replace" && request?.callbackMessageSourceId == null
    || raw.messageAction === "record" && request?.callbackMessageSourceId != null && question?.kind !== "message") return { kind: "dialogue", dialogue: "repair" };
  if (raw.numberMeaning !== "provided") delete semantic.callbackNumber;
  else if (raw.callbackNumber === undefined) return { kind: "dialogue", dialogue: "repair" };
  if (semantic.name === undefined && semantic.message === undefined && semantic.callbackNumber === undefined) return { kind: "dialogue", dialogue: "repair" };
  return semantic;
}

function legacyCaptureForCurrentQuestion(state: Conversation, requestId: string, source: string, raw: ReceptionistCaptureProposal, configuredNumber: string): ReceptionistCaptureProposal | Extract<ReceptionistToolResult, { kind: "dialogue" }> {
  const question = state.pendingQuestion, request = state.requests.find(item => item.id === requestId);
  if (!question || !request) return raw;
  if (raw.message !== undefined && question.kind !== "message") {
    const changedRecipient = explicitRecipientCategory(source);
    if (changedRecipient !== null && changedRecipient !== request.category) return raw;
  }
  const number = callbackNumberFromSource(source, configuredNumber);
  const numberOnly = number !== null && source.toLowerCase().replace(/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|plus)\b|[\d+().,\s-]/g, "").length === 0;
  const ownNumber = number !== null && /\b(?:my\s+(?:(?:callback|phone|telephone)\s+)?number\s+is|my\s+phone\s+is|call\s+me(?:\s+back)?\s+(?:at|on)|reach\s+me\s+(?:at|on))\b/i.test(source);
  const effective: ReceptionistCaptureProposal = { ...raw,
    ...(raw.callbackNumber === undefined && (numberOnly || ownNumber) ? { callbackNumber: number! } : {}),
  };
  // The model owns name meaning. A name-only proposal is contact capture;
  // do not reparse spelling, casing, punctuation, or source/name equality.
  const contactOnly = numberOnly || raw.name !== undefined && raw.message === undefined;
  const messageAllowed = question.kind === "message" ? !contactOnly : explicitMessageCorrection(source) && !contactOnly && !isReceptionistQuestionSource(source);
  if (raw.message !== undefined && !messageAllowed) {
    delete effective.message;
    delete effective.messageClarity;
    if (effective.name === undefined && effective.callbackNumber === undefined) {
      if (request.callbackMessageSourceId == null && question.kind !== "message") return raw;
      return { kind: "dialogue", dialogue: isReceptionistQuestionSource(source) ? "side_question" : "repair" };
    }
  }
  return effective;
}

function explicitMessageCorrection(source: string): boolean {
  const text = source.toLowerCase();
  const change = /\b(?:change|correct|replace|revise|amend|update|correction|instead|actually)\b/.test(text);
  const target = /\b(?:message|note)\b/.test(text)
    || /\b(?:tell|ask|have)\s+(?:(?:the|my|a)\s+)?(?:team|staff|nurse|doctor|office)\b/.test(text)
    || /\b(?:tell|ask)\s+them\b/.test(text) || explicitRecipientCategory(source) !== null;
  return change && target;
}
