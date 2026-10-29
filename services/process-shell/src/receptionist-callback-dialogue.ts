import type { Conversation } from "./conversation-contract.js";
import { callbackNumberReadbackQuestion } from "./receptionist-callback-number.js";

export const callbackNameQuestion = "Your name helps the team ask for you. What name should I put with your message?";

export const callbackRecapRetryPrefaces = ["Let me read that back in one sentence: ", "To make sure the details are clear: ", "Please check this complete readback: "] as const;

export function contextualCallbackQuestion(state: Conversation, request: Conversation["requests"][number], kind: "message" | "name" | "callback_number_entry" | "callback_number"): string {
  if (kind === "message") return "I can take a message so the team can call you back. What would you like me to tell them?";
  if (kind === "name") return callbackNameQuestion;
  if (kind === "callback_number_entry") return "What phone number should the team use to call you back about your message?";
  const message = state.inputs.find((source) => source.id === request.callbackMessageSourceId)?.body.trim();
  return (message ? `Before I save it, I have your message as: ${message.replace(/[.!?]+$/, "")}. ` : "Before I save your message, ")
    + callbackNumberReadbackQuestion(request.callbackNumber, request.name);
}

export function receptionistDialogueText(kind: "explain_purpose" | "clarify_request" | "clarify_message" | "repeat" | "side_question" | "social" | "pause" | "end_call" | "message_recipient" | "callback_timing" | "repair" | "retry", state: Conversation, repairAttempt?: number): string {
  if (kind === "pause") return state.requests.some((request) => request.state === "needs_callback" && request.callbackConfirmed)
    ? "Of course. Your message is saved. What would you like help with now?"
    : "Of course. I haven't saved a message. I can keep these details while we talk. What would you like help with instead?";
  if (kind === "end_call") return "Thank you for calling Synthetic Practice. Goodbye.";
  if (kind === "clarify_message") kind = "repair"; // An actual understanding miss shares the bounded repair ladder.
  const question = state.pendingQuestion;
  const request = state.requests.find((item) => item.id === question?.requestId);
  const currentQuestion = request && question && ["message", "name", "callback_number_entry", "callback_number"].includes(question.kind)
    ? contextualCallbackQuestion(state, request, question.kind as "message" | "name" | "callback_number_entry" | "callback_number") : null;
  if (kind === "explain_purpose") {
    if (question?.kind === "name") {
      const attempts = state.inputs.filter(source => source.questionId === question.id).length;
      return attempts >= 3 ? "You can use just your first name for this callback message. What name would you like me to include?"
        : attempts >= 2 ? "The team uses the name on your message to ask for the right person when returning your call. Which name should I include?"
          : "So the team can ask for the right person on a callback, what name would you like on your message?";
    }
    const purpose = question?.kind === "callback_number_entry" ? "The phone number is how the team can reach you about your message."
        : question?.kind === "callback_number" ? "Reading the details back helps catch mistakes before I save the message."
          : "The message tells the team what you'd like help with before they call.";
    return currentQuestion ? `I'm taking a message for the team to return your call. ${purpose} ${currentQuestion}`
      : "I'm Synthetic Practice's automated receptionist. To help you reach the right team, could you tell me what you need?";
  }
  if (kind === "message_recipient") return `Once you confirm it, your message is saved for the Synthetic Practice office team to follow up. ${currentQuestion ?? "I can take a message if you need the team to call you back."}`;
  if (kind === "callback_timing") return `The team can return your call ${state.admission.hours === "demo_closed" ? "during business hours" : "as soon as they can"}; I can't promise a specific time. ${currentQuestion ?? "I can take a message if you need a return call."}`;
  if (kind === "repair" && question) {
    const attempts = repairAttempt ?? state.inputs.filter((source) => source.questionId === question.id).length;
    if (attempts >= 3) {
      const missing = question.kind === "message" ? "a clear message for the team" : question.kind === "name" ? "your name" : question.kind === "callback_number_entry" ? "a usable callback number" : "your agreement to the complete details";
      const alternative = question.kind === "name" ? "spell it or try another name" : question.kind === "callback_number_entry" ? "say the digits separately, including a country code if needed" : "try saying it another way";
      return attempts % 2 === 1
        ? `I still need ${missing}, and your message isn't saved. You can ${alternative}, choose another try, or ask me to end the call. What would you prefer?`
        : `Your message is still unsaved because I need ${missing}. We can try again ${question.kind === "callback_number_entry" ? "with the number in smaller groups" : "in your own words"}, or you can pause or end the call. Which would you like?`;
    }
    if (question.kind === "message") return attempts >= 2 ? "Let's keep the message simple. What would you like the team to call you about?"
        : "I didn't understand the message clearly. So I pass along the right words, could you say it again in your own words?";
    if (question.kind === "name") return attempts >= 2 ? "To get your name right for the callback, could you spell it for me?"
        : "I didn't catch the name. What name should the team ask for when they call you back?";
    if (question.kind === "callback_number_entry") return attempts >= 2 ? "The team needs a complete phone number to return your call. Please say it in smaller groups, including the country code if you use one."
        : "I didn't catch the callback number clearly. Could you say the number again slowly, including a country code if needed?";
    if (question.kind === "callback_number" && currentQuestion) return `I haven't confirmed those details. ${currentQuestion}`;
  }
  if (kind === "repeat" && currentQuestion) return currentQuestion;
  if (kind === "social") return currentQuestion ? `You're welcome. ${currentQuestion}` : "How can I help you reach the office team?";
  if (kind === "side_question") return "I don't have a confirmed answer to that. I can include the question in a message for the office team, or help with confirmed office information.";
  return currentQuestion ?? "To help you reach the right team, could you tell me a little more about what you need?";
}


export function isReceptionistCallerExit(source: string): boolean {
  return /^(?:(?:okay|ok|thanks|thank you)[,.! ]+)*(?:(?:good)?bye|(?:please )?(?:end|stop|hang up)(?: (?:the|this) call)?|i(?:'m| am) done|i(?:'ll| will) call (?:back |again )?later)[.!\s]*$/i.test(source.trim());
}


/** A reason question about the current intake is dialogue even when the model labels it repeat/capture. */
export function callbackIntakePurposeQuery(state: Conversation): boolean {
  const question = state.pendingQuestion, source = state.inputs.at(-1);
  const request = state.requests.find(item => item.id === question?.requestId);
  if (state.admission.channel !== "voice" || question == null || source?.questionId !== question.id
    || source.sequence <= question.activatedRevision || request?.state !== "draft" || request.revision !== question.requestRevision
    || !["message", "name", "callback_number_entry", "callback_number"].includes(question.kind)) return false;
  const text = source.body.trim().toLowerCase();
  const reasonQuestion = /^why\b/.test(text) || /^what\b[^.!?]{0,100}\bfor\b/.test(text);
  if (!reasonQuestion) return false;
  // Resolve anaphora against the actual pending question, not against a list of saved user phrases.
  return /\b(?:name|number|phone|message|details|information|this|that|it)\b/.test(text)
    || /\byou\b[^.!?]{0,60}\b(?:ask|asking|want|need|use|collect|require)\b/.test(text)
    || text.replace(/[^a-z\s]/g, "").trim().split(/\s+/).length <= 2;
}

export function isReceptionistQuestionSource(source: string): boolean {
  return /[?]$/.test(source.trim()) || /^\s*(?:what|why|how|where|when|who|whom|whose|which)\b/i.test(source)
    || /^\s*(?:can|could|would|will|do|does|did|is|are|was|were)\s+(?:you|i|we|they|he|she|it|this|that)\b/i.test(source);
}
