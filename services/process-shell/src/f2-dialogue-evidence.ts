import { normalizeSyntheticDob, normalizeSyntheticZip } from "./f2-synthetic-practice-contract.js";

export type DialogueSideQuestion = "verification_purpose" | "appointment_type_difference" | "appointment_availability";

/** The model proposes meaning; these checks prevent unsupported field transitions. */
export function sideQuestionFromSpeech(text: string, pendingKind: string | undefined): DialogueSideQuestion | null {
  const words = text.trim().toLowerCase();
  if ((pendingKind === "slot_selection" || pendingKind === "appointment_consent") && asksAboutAvailability(text)) return "appointment_availability";
  if ((pendingKind === "identity_dob" || pendingKind === "identity_zip")
    && /\b(?:why|what for|how come|what do you need|why do you need|why do you want|is (?:that|this|it) (?:necessary|required)|is (?:that|this|it) safe)\b/.test(words)
    && !hasFactorEvidence(text, pendingKind === "identity_dob" ? "date_of_birth" : "zip")) return "verification_purpose";
  if (pendingKind === "request_clarification"
    && /\b(?:what(?:'s| is) the difference|how (?:are|is).{0,30}different|what (?:does|is).{0,25}(?:procedure|office appointment|office visit))\b/.test(words)) {
    return "appointment_type_difference";
  }
  return null;
}

export function asksAboutAvailability(text: string): boolean {
  if (explicitAvailabilityConflict(text)) return true;
  if (/\b(?:first|second)\s+(?:one|option|time|slot)\b.{0,15}\b(?:fine|works|good)\b/i.test(text) || resumesOfferedAppointment(text)) return false;
  return /\b(?:anything|something) else\b|^(?:that's it[,?\s]*)?nothing else[?!.\s]*$|\b(?:any|other|more|different|later|earlier)\b.{0,35}\b(?:openings?|appointments?|times?|dates?|options?|available|availability)\b/i.test(text)
    || /\b(?:what about|how about|do(?:n't)? you have|is there|closer to)\b/i.test(text)
      && /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|week|month|morning|afternoon|later|earlier)\b/i.test(text)
    || asksForAnotherPeriod(text);
}

/** Caller-owned availability evidence, not a selection or a new appointment request. */
export function explicitAvailabilityConflict(text: string): boolean {
  if (!currentAppointmentAvailability(text)) return false;
  // Quoted third-party wording is not the caller's current availability.
  const currentWords = text.replace(/["“][^"”]{0,160}["”]/g, " ");
  const withdrewOffer = /\b(?:i(?:'m| am)|we(?:'re| are))\s+(?:actually\s+)?out of town\b/i.test(currentWords)
    && !/\bnot\s+(?:actually\s+)?out of town\b/i.test(currentWords)
    || /\b(?:that|this|those|these|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:does(?:n't| not)|won't|will not|can't|cannot)\s+work\b/i.test(currentWords)
    || /\b(?:i|we)\s+(?:can't|cannot|can not|won't|will not)\s+(?:make|attend)\b/i.test(currentWords)
    // "I can't take a message" rejects callback intake, not the offered time.
    || /\b(?:i|we)\s+(?:can't|cannot|can not|won't|will not)\s+(?:do|take)\s+(?!(?:(?:a|the|my|that|this|these|those)\s+)?(?:message|callback|call\s*back|voicemail|voice\s*note)\b)(?:(?:that|this|these|those|it)\b|(?:(?:that|this|these|those|the|an?)\s+)?(?:appointment|visit|time|slot|option|date|dates|day|days|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i.test(currentWords)
    || /\b(?:i(?:'m| am)|we(?:'re| are))\s+not available\b/i.test(currentWords);
  return withdrewOffer && (mentionsAnotherPeriod(currentWords) || mentionsAbsoluteDate(currentWords));
}

export function asksForAnotherPeriod(text: string): boolean {
  return currentAppointmentAvailability(text)
    && /\b(?:can|could|would)\s+(?:we|you)\s+(?:do|try|make|offer|have)\b/i.test(text)
    && mentionsAnotherPeriod(text);
}

function currentAppointmentAvailability(text: string): boolean {
  return !explicitDifferentSubject(text) && !/\b(?:another|other|different|new)\s+(?:appointment|visit)\b/i.test(text);
}

function mentionsAnotherPeriod(text: string): boolean {
  return /\b(?:end|middle|mid|late|early)\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(text)
    || /\b(?:another|other|different|later|earlier)\s+(?:date|time|day|week|month|appointment|slot|option|opening)\b/i.test(text);
}

function mentionsAbsoluteDate(text: string): boolean {
  return /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(text);
}

export function isCallbackQuestion(kind: string | undefined): boolean {
  return kind !== undefined && ["name", "message", "callback_number_entry", "callback_number"].includes(kind);
}

/** Whole-turn completion grammar shared by callback recovery and voice closing. */
export function isClearDecline(text: string): boolean {
  const completionOnly = "(?:no(?: thank you| thanks)?|nope|that's all|that is all|that's it|nothing else|i'm all set|i am all set|thank you|thanks|bye|goodbye|okay bye)";
  const normalized = text.trim().toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  // Every phrase must independently mean completion; punctuation may join them.
  return new RegExp(`^${completionOnly}(?: ${completionOnly})*$`).test(normalized);
}

/** Pending message capture needs an affirmative withdrawal, not a courtesy backchannel. */
export function isExplicitCallbackDecline(text: string): boolean {
  if (!isClearDecline(text)) return false;
  const normalized = text.trim().toLowerCase().replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  return !/^(?:thank you|thanks)$/.test(normalized);
}

/** A pending appointment offer is withdrawn only by an explicit request to stop that change. */
export function isExplicitPendingSlotWithdrawal(text: string): boolean {
  if (/\?|["“”]/u.test(text) || asksAboutAvailability(text) || resumesOfferedAppointment(text)) return false;
  const words = text.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  const change = "(?:change|move|reschedule|schedule|book|select|choose|confirm)";
  const stopsChange = new RegExp(`\\b(?:please\\s+)?(?:don't|do not)\\s+${change}\\s+(?:my\\s+)?(?:appointment|visit|it|that)\\b`).test(words)
    || /\b(?:stop|cancel)\s+(?:the\s+)?(?:pending\s+)?(?:change|reschedule|move|booking)\b/.test(words)
    || /\bnever mind\s+(?:the\s+)?(?:change|reschedule|move|booking)\b/.test(words);
  const contradictoryContinuation = new RegExp(`\\b(?:don't|do not)\\s+(?:stop|cancel)\\b.{0,35}\\b${change}\\b`).test(words)
    || new RegExp(`\\b(?:just|please|go ahead(?: and)?)\\s+${change}\\b`).test(words);
  const differentGoal = /\b(?:instead|also)\b.{0,50}\b(?:schedule|reschedule|book|appointment|visit)\b/.test(words)
    || /\b(?:another|different|new)\s+(?:appointment|visit)\b/.test(words);
  const differentPatient = /\b(?:for|schedule|reschedule|book|change|move)\b.{0,24}\b(?:my\s+)?(?:wife|husband|mother|father|mom|dad|son|daughter|friend|patient)\b/.test(words);
  // An explicit clinical-advice clause remains a new caller goal. ASR may omit
  // its punctuation, so bind this only to the narrow advice phrase itself.
  const clinicalAdviceClause = /\b(?:i\s+)?(?:need|want|have)\s+(?:medical|clinical|treatment)\s+(?:advice|guidance|help)\b/i.test(text);
  return stopsChange && !contradictoryContinuation && !differentGoal && !differentPatient && !clinicalAdviceClause;
}

/** A current offer reference can resume scheduling; a message about a choice cannot. */
export function resumesOfferedAppointment(text: string): boolean {
  const simpleChoice = /^(?:the\s+)?(?:first|second|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:one|option|time|slot))?(?:[,.]?\s+(?:please|works(?: for me)?|is fine))?[.!?\s]*$/i.test(text.trim());
  return !explicitDifferentSubject(text) && !/\b(?:tell|message|ask|let)\b.{0,35}\b(?:team|staff|them|know)\b/i.test(text)
    && (simpleChoice || /\b(?:i(?:'ll| will| can| would|’ll|’d)?|let'?s|please)\s+(?:just\s+)?(?:take|book|choose|do|like)\b/i.test(text)
      && /\b(?:first|second|option|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text))
    && !/\b(?:don't|do not|not|neither)\b/i.test(text);
}

function explicitDifferentSubject(text: string): boolean {
  return /\b(?:for my|my)\s+(?:wife|husband|mother|father|mom|dad|son|daughter|friend|patient)\b/i.test(text);
}

export function hasFactorEvidence(text: string, factor: "date_of_birth" | "zip"): boolean {
  return factor === "date_of_birth" ? normalizeSyntheticDob(text) !== null : normalizeSyntheticZip(text) !== null;
}

/** Digits embedded in speech recognition noise are not a ZIP mismatch. */
export function hasIncompleteZipDigits(text: string): boolean {
  if (hasFactorEvidence(text, "zip")) return false;
  const digits = text.replace(/\D/g, "");
  return digits.length > 0 && digits.length < 5;
}

export function firstPersonExistingAppointment(text: string): boolean {
  const words = text.toLowerCase();
  if (/\b(?:my|our)\s+(?:mom|mother|dad|father|wife|husband|partner|child|son|daughter|friend|patient)(?:'s)?\b|\bfor\s+my\s+(?:mom|mother|dad|father|wife|husband|partner|child|son|daughter|friend)\b/.test(words)) return false;
  return /\bmy\s+(?:current\s+|existing\s+|next\s+|upcoming\s+)?(?:appointment|visit)\b|\bwhen\s+(?:am\s+i|is\s+my)\b.{0,45}\b(?:appointment|visit)\b/.test(words);
}

export function officeContactNotVisit(text: string): boolean {
  return /\b(?:call(?:ed|ing)?|rang|phoned|spoke to)\s+(?:the\s+)?office\b/i.test(text)
    && !/\boffice\s+(?:appointment|visit|follow[- ]?up)\b/i.test(text);
}

export function unanchoredPriorReference(text: string): boolean {
  const words = text.trim().toLowerCase();
  return /^(?:(?:the|that|what)\s+)?i\s+(?:said|asked|mentioned)\s+(?:that\s+)?before[.!?]?$|^(?:that|what)\s+i\s+said\s+before[.!?]?$|^same\s+(?:thing(?:\s+as\s+before)?|as\s+before)[.!?]?$/.test(words);
}
