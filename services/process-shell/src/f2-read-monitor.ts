import { z } from "zod";

const identifier = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const protectedText = z.string().trim().min(1).max(500);
const assertion = z.enum(["asserted", "uncertain"]);

const appointmentValueSchema = z.object({
  appointments: z.array(z.object({
    appointmentId: identifier,
    slotId: identifier,
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    appointmentType: protectedText,
    location: protectedText,
    version: revision,
    attendanceConfirmed: z.boolean(),
  }).strict()).max(8),
}).strict();

const authorityBase = {
  directiveId: identifier,
  requestId: identifier,
  requestRevision: revision,
  ownerEpoch: revision,
  voiceEpoch: revision,
  receiptId: identifier,
  receiptHash: sha256,
  resultHash: sha256,
  sourceVersion: revision,
} as const;

/** Protected values travel only on the server-side response binding, never in assessor input. */
export const protectedReadSpeechAuthoritySchema = z.discriminatedUnion("readKind", [
  z.object({ ...authorityBase, readKind: z.literal("appointment_details"), value: appointmentValueSchema,
    timeZone: z.literal("UTC") }).strict(),
  z.object({ ...authorityBase, readKind: z.literal("referral_status"),
    value: z.object({ status: protectedText }).strict() }).strict(),
  z.object({ ...authorityBase, readKind: z.literal("billing_balance"),
    value: z.object({ amount: z.string().regex(/^\d{1,8}(?:\.\d{1,2})?$/), currency: z.literal("USD"), label: protectedText }).strict() }).strict(),
]);
export type ProtectedReadSpeechAuthority = z.infer<typeof protectedReadSpeechAuthoritySchema>;
export type ProtectedReadKind = ProtectedReadSpeechAuthority["readKind"];

/** The assessor identifies source text and kind only; it cannot propose a value to compare. */
export const protectedReadSpeechClaimSchema = z.object({
  kind: z.literal("protected_read"),
  quote: z.string().min(1).max(2_000),
  requestId: identifier.nullable(),
  assertion,
  readKind: z.enum(["appointment_details", "referral_status", "billing_balance"]),
}).strict();
export type ProtectedReadSpeechClaim = z.infer<typeof protectedReadSpeechClaimSchema>;

export const protectedReadReviewSchema = z.object({
  directiveId: identifier,
  requestId: identifier,
  requestRevision: revision,
  receiptId: identifier,
  receiptHash: sha256,
  resultHash: sha256,
  sourceVersion: revision,
  readKind: z.enum(["appointment_details", "referral_status", "billing_balance"]),
  status: z.enum(["matched", "mismatch", "uncertain", "unassessable"]),
  reason: z.enum(["matched", "value_mismatch", "value_unparseable", "claim_uncertain", "claim_missing", "ambiguous_claims", "invalid_source", "invalid_authority"]),
}).strict();
export type ProtectedReadReview = z.infer<typeof protectedReadReviewSchema>;

/** Server drain is presentation evidence only. It deliberately cannot represent hearing or resolution. */
export const voiceReadPresentationReceiptSchema = z.object({
  id: identifier,
  directiveId: identifier,
  requestId: identifier,
  requestRevision: revision,
  ownerEpoch: revision,
  voiceEpoch: revision,
  responseId: identifier,
  outputItemId: identifier,
  reviewId: identifier,
  receiptId: identifier,
  transportEvidenceId: identifier,
  state: z.literal("server_drained"),
  hearing: z.literal("unknown"),
  observedAt: z.string().datetime(),
}).strict();
export type VoiceReadPresentationReceipt = z.infer<typeof voiceReadPresentationReceiptSchema>;

export function compareProtectedReadSpeech(input: {
  transcript: string;
  authority: ProtectedReadSpeechAuthority;
  claims: readonly ProtectedReadSpeechClaim[];
}): ProtectedReadReview {
  const authority = protectedReadSpeechAuthoritySchema.parse(input.authority);
  const reference = authorityReference(authority);
  const claims = input.claims.map((claim) => protectedReadSpeechClaimSchema.parse(claim));
  if (claims.length === 0) return protectedReadReviewSchema.parse({ ...reference, status: "unassessable", reason: "claim_missing" });
  if (claims.length !== 1) return protectedReadReviewSchema.parse({ ...reference, status: "unassessable", reason: "ambiguous_claims" });
  const claim = claims[0]!;
  if (!input.transcript.includes(claim.quote) || claim.requestId !== null && claim.requestId !== authority.requestId
    || claim.readKind !== authority.readKind) {
    return protectedReadReviewSchema.parse({ ...reference, status: "unassessable", reason: "invalid_source" });
  }
  if (claim.assertion === "uncertain") return protectedReadReviewSchema.parse({ ...reference, status: "uncertain", reason: "claim_uncertain" });
  const comparison = compareValues(authority, claim.quote);
  if (comparison === "unassessable") {
    return protectedReadReviewSchema.parse({ ...reference, status: "unassessable", reason: "value_unparseable" });
  }
  return comparison === "matched"
    ? protectedReadReviewSchema.parse({ ...reference, status: "matched", reason: "matched" })
    : protectedReadReviewSchema.parse({ ...reference, status: "mismatch", reason: "value_mismatch" });
}

export function protectedReadCorrection(authority: ProtectedReadSpeechAuthority): string {
  const checked = protectedReadSpeechAuthoritySchema.parse(authority);
  if (checked.readKind === "billing_balance") {
    return `I need to correct that: the verified test balance is $${money(checked.value.amount)} ${checked.value.currency}.`;
  }
  if (checked.readKind === "referral_status") {
    return `I need to correct that: the verified test referral status is ${sentenceFragment(checked.value.status)}.`;
  }
  const appointments = checked.value.appointments.map((appointment) => {
    const startsAt = new Intl.DateTimeFormat("en-US", { timeZone: checked.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(appointment.startsAt));
    return `${startsAt} at ${appointment.location}`;
  });
  return `I need to correct that: the verified test ${appointments.length === 1 ? "appointment is" : "appointments are"} ${appointments.join("; ")}.`;
}

/** Server-derived wording keeps every protected read on the same speech authority path. */
export function protectedVoiceReadAnswer(authority: ProtectedReadSpeechAuthority): string {
  const checked = protectedReadSpeechAuthoritySchema.parse(authority);
  if (checked.readKind === "referral_status") return `Your referral is ${spokenReferralStatus(checked.value.status)}.`;
  if (checked.readKind === "billing_balance") return `Your current balance is $${money(checked.value.amount)}.`;
  const format = new Intl.DateTimeFormat("en-US", { timeZone: checked.timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
  const appointments = checked.value.appointments.map((appointment) => format.format(new Date(appointment.startsAt)));
  if (appointments.length === 0) return "I don't see an appointment scheduled for you.";
  if (appointments.length === 1) return `Your appointment is ${appointments[0]}.`;
  return `Your appointments are ${appointments.join("; ")}.`;
}

function authorityReference(authority: ProtectedReadSpeechAuthority) {
  return { directiveId: authority.directiveId, requestId: authority.requestId, requestRevision: authority.requestRevision,
    receiptId: authority.receiptId, receiptHash: authority.receiptHash, resultHash: authority.resultHash,
    sourceVersion: authority.sourceVersion, readKind: authority.readKind };
}

type ValueComparison = "matched" | "mismatch" | "unassessable";

function compareValues(authority: ProtectedReadSpeechAuthority, quote: string): ValueComparison {
  if (authority.readKind === "referral_status") return compareReferralStatus(authority.value.status, quote);
  // Negated source text needs semantic interpretation and cannot safely drive correction.
  if (hasNegation(quote)) return "unassessable";
  if (authority.readKind === "billing_balance") return compareBalance(authority.value.amount, authority.value.currency, quote);
  return compareAppointment(authority.value.appointments, authority.timeZone, quote);
}

function compareReferralStatus(status: string, quote: string): ValueComparison {
  const expected = normalizePhrase(status);
  const spoken = normalizePhrase(spokenReferralStatus(status));
  const actual = normalizePhrase(quote);
  const accepted = new Set([
    expected,
    `your referral is ${spoken}`,
    `your referral status is ${spoken}`,
    `your referral is ${expected}`,
    `your referral status is ${expected}`,
    `the referral is ${expected}`,
    `the referral status is ${expected}`,
  ]);
  return accepted.has(actual) ? "matched" : "unassessable";
}

function spokenReferralStatus(status: string): string {
  return sentenceFragment(status.replace(/^Synthetic referral record\s+/i, ""));
}

function compareBalance(amount: string, currency: "USD", quote: string): ValueComparison {
  const expected = cents(amount);
  const amountPattern = "(\\d{1,8}(?:,\\d{3})*(?:\\.\\d{1,2})?)";
  const matches = [
    ...quote.matchAll(new RegExp(`\\$\\s*${amountPattern}`, "gi")),
    ...quote.matchAll(new RegExp(`\\bUSD\\s*${amountPattern}`, "gi")),
    ...quote.matchAll(new RegExp(`\\b${amountPattern}\\s*(?:USD|dollars?)\\b`, "gi")),
  ];
  const amounts = new Set(matches.map((match) => cents(match[1]!.replaceAll(",", ""))).filter((value): value is number => value !== null));
  if (currency !== "USD" || expected === null || amounts.size !== 1) return "unassessable";
  return amounts.has(expected) ? "matched" : "mismatch";
}

function compareAppointment(appointments: readonly { startsAt: string }[], timeZone: string, quote: string): ValueComparison {
  // Multi-appointment speech needs an ordered binding; zero results have no date/time to compare.
  if (appointments.length !== 1) return "unassessable";
  const expected = dateTimeParts(appointments[0]!.startsAt, timeZone);
  const dates = parsedDates(quote);
  const times = parsedTimes(quote);
  if (dates.length !== 1 || times.length !== 1) return "unassessable";
  const date = dates[0]!, time = times[0]!;
  if (time.minute === null && expected.minute !== 0) return "unassessable";
  const dateMatches = date.month === expected.month && date.day === expected.day
    && (date.year === null || date.year === expected.year);
  const timeMatches = time.hour === expected.hour && (time.minute ?? 0) === expected.minute && time.meridiem === expected.meridiem;
  return dateMatches && timeMatches ? "matched" : "mismatch";
}

function dateTimeParts(startsAt: string, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(startsAt)).map((part) => [part.type, part.value]));
  return { month: Number(parts.month!), day: Number(parts.day!), year: Number(parts.year!), hour: Number(parts.hour!),
    minute: Number(parts.minute!), meridiem: parts.dayPeriod!.toLowerCase() };
}

function parsedDates(value: string): Array<{ month: number; day: number; year: number | null }> {
  const months: Record<string, number> = { january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
    june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
    november: 11, nov: 11, december: 12, dec: 12 };
  const found = new Map<string, { month: number; day: number; year: number | null }>();
  for (const match of value.matchAll(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi)) {
    const parsed = { month: months[match[1]!.toLowerCase()]!, day: Number(match[2]), year: match[3] === undefined ? null : Number(match[3]) };
    found.set(JSON.stringify(parsed), parsed);
  }
  for (const match of value.matchAll(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/g)) {
    const parsed = { month: Number(match[1]), day: Number(match[2]), year: match[3] === undefined ? null : normalizedYear(match[3]) };
    found.set(JSON.stringify(parsed), parsed);
  }
  return [...found.values()];
}

function parsedTimes(value: string): Array<{ hour: number; minute: number | null; meridiem: string }> {
  const found = new Map<string, { hour: number; minute: number | null; meridiem: string }>();
  for (const match of value.matchAll(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/gi)) {
    const parsed = { hour: Number(match[1]), minute: match[2] === undefined ? null : Number(match[2]),
      meridiem: match[3]!.replaceAll(".", "").toLowerCase() };
    found.set(JSON.stringify(parsed), parsed);
  }
  return [...found.values()];
}

function normalize(value: string): string {
  const numbers: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12" };
  return value.normalize("NFKD").toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (word) => numbers[word]!)
    .replace(/(\d)(?:st|nd|rd|th)\b/g, "$1").replace(/[^a-z0-9$:/.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function normalizePhrase(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function hasNegation(value: string): boolean {
  return /\b(?:not|no longer|incorrect|wrong|isn(?:'|\s)?t|wasn(?:'|\s)?t|doesn(?:'|\s)?t|didn(?:'|\s)?t)\b/i.test(value);
}

function normalizedYear(value: string): number { const year = Number(value); return value.length === 2 ? 2_000 + year : year; }
function cents(value: string): number | null { const parsed = Number(value); return Number.isFinite(parsed) ? Math.round(parsed * 100) : null; }
function money(value: string): string { return (cents(value)! / 100).toFixed(2); }
function sentenceFragment(value: string): string { return value.trim().replace(/[.!?]+$/, ""); }
