export const REGISTERED_AI_CAPABILITIES = ["office_address", "appointment_details", "appointment_schedule", "appointment_reschedule", "referral_status", "billing_balance"] as const;
export type RegisteredAiCapability = typeof REGISTERED_AI_CAPABILITIES[number];
export type ProtectedDemoCapability = Exclude<RegisteredAiCapability, "office_address">;
export type AppointmentOptionId = "first" | "second";

export interface MockAppointmentOption {
  readonly id: AppointmentOptionId;
  readonly spoken: string;
}

export interface MockPracticeSystem {
  appointmentDetails(): string;
  referralStatus(): string;
  billingBalance(): string;
  rescheduleOptions(): readonly MockAppointmentOption[];
  schedule(option: AppointmentOptionId): string;
  reschedule(option: AppointmentOptionId): string;
}

const BASELINE_APPOINTMENT = "Wednesday, September second at nine thirty in the morning";
const OPTIONS: readonly MockAppointmentOption[] = [
  { id: "first", spoken: "Tuesday, September eighth at ten in the morning" },
  { id: "second", spoken: "Thursday, September tenth at two thirty in the afternoon" },
];

export function createMockPracticeSystem(): MockPracticeSystem {
  let appointment = BASELINE_APPOINTMENT;
  return {
    appointmentDetails: () => `Your appointment is ${appointment}.`,
    referralStatus: () => "Your referral has been received and is under review. The team does not need anything else from you right now.",
    billingBalance: () => "Your current amount owed is one hundred twenty five dollars.",
    rescheduleOptions: () => OPTIONS,
    schedule(option) {
      const selected = OPTIONS.find((candidate) => candidate.id === option);
      if (selected === undefined) throw new Error("mock_appointment_option_invalid");
      appointment = selected.spoken;
      return `Your appointment is scheduled for ${appointment}.`;
    },
    reschedule(option) {
      const selected = OPTIONS.find((candidate) => candidate.id === option);
      if (selected === undefined) throw new Error("mock_appointment_option_invalid");
      appointment = selected.spoken;
      return `Your appointment is now ${appointment}.`;
    },
  };
}

export function protectedCapability(value: string): ProtectedDemoCapability | null {
  const text = normalize(value);
  if (/\b(new patient|first appointment|first visit|never been seen|never visited)\b/.test(text)) return null;
  if (/\b(cancel|canceling|cancellation)\b.*\b(appointment|visit)\b/.test(text)) return null;
  if (/\b(reschedule|rescheduled|move|moving|change|changed|changing|switch|adjust|modify)\b.*\b(appointment|visit)\b|\b(appointment|visit)\b.*\b(reschedule|rescheduled|move|moving|change|changed|changing|switch|adjust|modify)\b/.test(text)) return "appointment_reschedule";
  if (/\b(when|what time|what date|which day|check|look up|find|forgot|remind)\b.*\b(appointment|visit)\b|\b(appointment|visit)\b.*\b(when|time|date|day|details|scheduled for)\b/.test(text)) return "appointment_details";
  if (/\b(schedule|book|make|set up|arrange|get|need|want)\b.*\b(appointment|visit|surgery|procedure)\b|\b(appointment|visit|surgery|procedure)\b.*\b(schedule|book|arrange)\b/.test(text)) return "appointment_schedule";
  if (/\b(referral)\b.*\b(status|check|where|happening|progress|received|receive|review|approved|gone through)\b|\b(status|check|where|happening|progress|received|receive|review|approved|gone through)\b.*\b(referral)\b/.test(text)) return "referral_status";
  if (/\b(amount owed|how much.*owe|what.*owe|do i.*owe|billing balance|account balance|balance due|outstanding balance|current bill|bill amount|payment due|have a balance)\b/.test(text)) return "billing_balance";
  return null;
}

export function isNewPatientRequest(value: string): boolean {
  return /\b(new patient|first appointment|first visit|never been seen|never visited|become a patient)\b/.test(normalize(value));
}

export function appointmentOption(value: string): AppointmentOptionId | null {
  const text = normalize(value);
  if (/\b(second option|second one|second on|second won|option two|option too|option 2|number two|number too|number 2|september tenth|september 10|thursday|thursdays|thurs day|thirst day|third day|thurzday|two thirty|2 30)\b/.test(text)) return "second";
  if (/\b(first option|first one|first on|first won|option one|option won|option 1|number one|number won|number 1|september eighth|september 8|tuesday|tues day|choose day|ten in the morning|10 a m)\b/.test(text)) return "first";
  return null;
}

export function matchesDob(actual: string, expected: string): boolean {
  const actualDate = dateFingerprint(actual);
  const expectedDate = dateFingerprint(expected);
  return actualDate !== null && expectedDate !== null && actualDate === expectedDate;
}

export function normalizedDob(value: string): string | null {
  const fingerprint = dateFingerprint(value);
  if (fingerprint === null) return null;
  const [month, day, year] = fingerprint.split("-").map(Number);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dobIncludesYear(value: string): boolean {
  const text = normalize(value);
  return /\b(?:19|20)\d{2}\b/.test(text) || /\b\d{2}\b/.test(text) || /\b(?:nineteen|two thousand|twenty|one thousand|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/.test(text);
}

export function dobMonthDay(value: string): string | null {
  const text = canonicalizeMonth(normalize(value));
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const monthEntry = Object.entries(months).find(([name]) => text.includes(name));
  const groups = text.match(/\d+/g)?.map(Number) ?? [];
  let month = monthEntry?.[1] ?? groups[0] ?? 0;
  const daySegment = monthEntry === undefined ? text : text.slice(text.indexOf(monthEntry[0]) + monthEntry[0].length);
  const spokenParts = spokenDateParts(daySegment);
  if (monthEntry === undefined && groups.length === 0) month = spokenParts[0] ?? 0;
  const day = monthEntry === undefined
    ? groups[1] ?? spokenParts[1] ?? 0
    : groups.find((number) => number >= 1 && number <= 31) ?? spokenParts[0] ?? 0;
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${month} ${day}` : null;
}

export function matchesZip(actual: string, expected: string): boolean {
  return spokenDigits(actual) === spokenDigits(expected);
}

export function normalizedZip(value: string): string | null {
  const digits = spokenDigits(value);
  if (/^\d{5}$/.test(digits)) return digits;
  return correctedFinalZipDigit(value);
}

/** A caller may correct only the final digit of one complete ZIP in the same turn. */
function correctedFinalZipDigit(value: string): string | null {
  const digit = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\\d)";
  const fiveDigits = `(?:\\d{5}|${digit}(?:\\s+${digit}){4})`;
  const match = new RegExp(`^(?<prior>${fiveDigits})\\s+(?:sorry|actually)\\s+(?:the\\s+)?last\\s+digit\\s+(?:is|was)\\s+(?<replacement>${digit})$`).exec(normalize(value));
  if (match?.groups === undefined) return null;
  const prior = spokenDigits(match.groups.prior!);
  const replacement = spokenDigits(match.groups.replacement!);
  return /^\d{5}$/.test(prior) && /^\d$/.test(replacement) ? `${prior.slice(0, -1)}${replacement}` : null;
}

function dateFingerprint(value: string): string | null {
  const text = canonicalizeMonth(normalize(value));
  const compact = text.match(/^([01]\d)([0-3]\d)((?:19|20)\d{2})$/);
  if (compact !== null) {
    const month = Number(compact[1]); const day = Number(compact[2]); const year = Number(compact[3]);
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${month}-${day}-${year}` : null;
  }
  const months: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const monthEntry = Object.entries(months).find(([name]) => text.includes(name));
  let month = monthEntry?.[1] ?? 0;
  const groups = text.match(/\d+/g)?.map(Number) ?? [];
  if (month === 0 && groups.length >= 3) month = groups[0] ?? 0;
  const daySegment = monthEntry === undefined ? text.split(/\b(?:nineteen|two thousand|twenty|one thousand)\b/)[0] ?? "" : text.slice(text.indexOf(monthEntry[0]) + monthEntry[0].length).split(/\b(?:19\d{2}|20\d{2}|nineteen|two thousand|twenty|one thousand)\b/)[0] ?? "";
  const spokenParts = spokenDateParts(daySegment);
  if (month === 0 && groups.length === 0) month = spokenParts[0] ?? 0;
  const spokenDay = monthEntry === undefined && groups.length === 0 ? spokenParts[1] : spokenParts[0];
  const day = spokenDay ?? (monthEntry ? groups.find((number) => number >= 1 && number <= 31) : groups[1]) ?? 0;
  let year = groups.find((number) => number >= 1900 && number <= 2099) ?? 0;
  if (year === 0 && /\bnineteen\b/.test(text)) year = 1900 + yearTail(text.replace(/.*nineteen/, ""));
  if (year === 0 && /\btwo thousand\b/.test(text)) year = 2000 + yearTail(text.replace(/.*two thousand/, ""));
  if (year === 0 && /\bone thousand nine hundred\b/.test(text)) year = 1900 + yearTail(text.replace(/.*one thousand nine hundred/, ""));
  if (year === 0 && /\btwenty\b/.test(text)) year = 2000 + yearTail(text.replace(/.*twenty/, ""));
  if (year === 0 && groups.length >= 2) { const shortYear = groups.at(-1) ?? 0; if (shortYear >= 0 && shortYear <= 99 && shortYear !== day) year = shortYear <= 29 ? 2000 + shortYear : 1900 + shortYear; }
  if (year === 0 && spokenParts.length >= (monthEntry === undefined ? 3 : 2)) { const shortYear = spokenParts.at(-1) ?? 0; if (shortYear >= 30 && shortYear <= 99) year = 1900 + shortYear; }
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2099 ? `${month}-${day}-${year}` : null;
}

function spokenDateParts(value: string): number[] {
  const values: Record<string, number> = { one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6, seven: 7, seventh: 7, eight: 8, eighth: 8, nine: 9, ninth: 9, ten: 10, tenth: 10, eleven: 11, eleventh: 11, twelve: 12, twelfth: 12, thirteen: 13, thirteenth: 13, fourteen: 14, fourteenth: 14, fifteen: 15, fifteenth: 15, sixteen: 16, sixteenth: 16, seventeen: 17, seventeenth: 17, eighteen: 18, eighteenth: 18, nineteen: 19, nineteenth: 19, twenty: 20, twentieth: 20, thirty: 30, thirtieth: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const tokens = normalize(value).split(" ").filter((token) => token !== "the" && token !== "of" && token !== ""); const result: number[] = [];
  for (let index = 0; index < tokens.length; index += 1) { const base = values[tokens[index]!] ?? 0; if ((base === 20 || base === 30) && index + 1 < tokens.length) { const tail = values[tokens[index + 1]!] ?? 0; if (tail >= 1 && tail <= 9) { result.push(base + tail); index += 1; continue; } } if (base > 0) result.push(base); }
  return result;
}

function canonicalizeMonth(value: string): string {
  const aliases: Record<string, string> = { jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july", aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december" };
  return value.split(" ").map((token) => aliases[token] ?? token).join(" ");
}

function yearTail(value: string): number {
  const values: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const words = normalize(value).split(" ");
  const tens = words.reduce((sum, word) => sum + (values[word] ?? 0), 0);
  return Math.min(99, tens);
}

const CJK_DIGIT_GLYPHS: Readonly<Record<string, string>> = {
  "〇": "0", "零": "0", "一": "1", "二": "2", "三": "3",
  "四": "4", "五": "5", "六": "6", "七": "7", "八": "8", "九": "9",
};
const HAS_CJK_DIGIT_GLYPH = /[〇零一二三四五六七八九]/u;
const CJK_DIGIT_SEQUENCE = /^[〇零一二三四五六七八九]+$/u;

function spokenDigits(value: string): string {
  const digits: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
  const trimmed = value.trim();
  if (HAS_CJK_DIGIT_GLYPH.test(trimmed)) {
    // Do not interpret units or mixed text as a ZIP; only map a complete digit glyph sequence.
    if (!CJK_DIGIT_SEQUENCE.test(trimmed)) return "";
    return [...trimmed].map((glyph) => CJK_DIGIT_GLYPHS[glyph]!).join("");
  }
  return normalize(value).split(" ").map((part) => /^\d+$/.test(part) ? part : digits[part] ?? joinedSpokenDigits(part, digits) ?? "").join("").replace(/\D/g, "");
}

/** Accept only a complete concatenation of ASCII digit words; no transliteration or inference. */
function joinedSpokenDigits(value: string, digits: Readonly<Record<string, string>>): string | null {
  let remainder = value, result = "";
  while (remainder.length > 0) {
    const word = Object.keys(digits).find((candidate) => remainder.startsWith(candidate));
    if (word === undefined) return null;
    result += digits[word]!;
    remainder = remainder.slice(word.length);
  }
  return result.length > 0 ? result : null;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/[^a-z0-9]+/g, " ").trim();
}
