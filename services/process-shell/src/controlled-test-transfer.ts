import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { ConversationScope } from "./conversation-contract.js";
import { routeCategorySchema } from "./route-category.js";

const id = z.string().regex(/^[A-Za-z0-9_.-]{3,200}$/);
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);
const version = z.string().regex(/^[A-Za-z0-9_.-]{3,100}$/);
const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const routeCategories = routeCategorySchema.options;
const scopeSchema = z.object({ practiceId: id, instanceId: id, conversationId: id }).strict();

export const controlledRecipientConsentSchema = z.object({ id, version, acceptedAt: timestamp, evidenceHash: hash }).strict();
export const controlledRecipientSchema = z.object({ id, destination: e164, consentEvidence: controlledRecipientConsentSchema }).strict();
const recipientMapSchema = z.object(Object.fromEntries(routeCategories.map((category) => [category, controlledRecipientSchema])) as Record<z.infer<typeof routeCategorySchema>, typeof controlledRecipientSchema>).strict()
  .superRefine((recipients, context) => {
    const values = Object.values(recipients);
    if (new Set(values.map((recipient) => recipient.id)).size !== routeCategories.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "controlled_transfer_recipient_ids_must_be_distinct" });
    if (new Set(values.map((recipient) => recipient.destination)).size !== 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "controlled_transfer_destinations_must_match" });
  });
export const controlledTransferMapSchema = z.object({ version, sourceNumberE164: e164, enabled: z.boolean(), recipients: recipientMapSchema }).strict();
export type ControlledTransferMap = z.infer<typeof controlledTransferMapSchema>;

export const controlledTransferAttemptSchema = z.object({
  id, scope: scopeSchema, requestId: id, requestRevision: z.number().int().nonnegative(),
  ownerEpoch: z.number().int().nonnegative(), voiceEpoch: z.number().int().nonnegative(), category: routeCategorySchema, configVersion: version,
  recipientId: id, recipientConsent: controlledRecipientConsentSchema,
  sourceSnapshot: z.object({ configuredSourceE164: e164, callerE164: e164 }).strict(),
  destinationE164: e164, parentCallId: id, childCallId: id.nullable(), state: z.enum(["prepared", "ringing", "answered"]), issuedAt: timestamp,
  deadlineAt: timestamp, callbackToken: z.string().regex(/^[A-Za-z0-9_-]{16,}\.[0-9]{10,13}\.[A-Za-z0-9_-]{43}$/),
}).strict();
export type ControlledTransferAttempt = z.infer<typeof controlledTransferAttemptSchema>;

const callbackEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("call_status"), token: z.string().min(1).max(512), parentCallId: id, childCallId: id,
    status: z.enum(["initiated", "ringing", "answered", "busy", "no_answer", "failed", "canceled", "completed"]), receivedAt: timestamp }).strict(),
  // A terminal <Dial action> result is about the original parent call. Twilio can omit DialCallSid when no child leg exists.
  z.object({ kind: z.literal("parent_dial_result"), token: z.string().min(1).max(512), parentCallId: id,
    status: z.enum(["busy", "no_answer", "failed", "canceled"]), receivedAt: timestamp }).strict(),
  z.object({ kind: z.literal("screening_digits"), token: z.string().min(1).max(512), parentCallId: id, childCallId: id,
    digits: z.string().max(8), receivedAt: timestamp }).strict(),
]);
export type ControlledTransferCallback = z.infer<typeof callbackEventSchema>;

export type ControlledTransferAcceptanceEvidence = Readonly<{ recipientId: string; childCallId: string; acceptedAt: string }>;
export type ControlledTransferTerminalOutcome =
  | Readonly<{ kind: "recipient_accepted"; acceptance: ControlledTransferAcceptanceEvidence }>
  | Readonly<{ kind: "fallback"; reason: "busy" | "refused" | "no_answer" | "failed" | "canceled" | "late_accept" }>;
export type ControlledTransferResult =
  | Readonly<{ kind: "pending"; attempt: ControlledTransferAttempt }>
  | Readonly<{ kind: "recipient_accepted"; attempt: ControlledTransferAttempt; acceptance: ControlledTransferAcceptanceEvidence }>
  | Readonly<{ kind: "fallback"; attempt: ControlledTransferAttempt; reason: "busy" | "refused" | "no_answer" | "failed" | "canceled" | "late_accept" }>
  | Readonly<{ kind: "rejected"; reason: "callback_invalid" | "attempt_invalid" | "screening_not_answered" }>;

export type ControlledTransferPrepared =
  | Readonly<{ kind: "fallback"; reason: "disabled" | "not_full_mode" | "unconfigured" | "source_mismatch" | "configured_self_loop" | "caller_self_loop" }>
  | Readonly<{ kind: "dial"; attempt: ControlledTransferAttempt; twiml: string }>;
export type ControlledTransferPrepareInput = Readonly<{ mode: "receptionist" | "full"; scope: ConversationScope; requestId: string; requestRevision: number; ownerEpoch: number; voiceEpoch: number; category: z.infer<typeof routeCategorySchema>; parentCallId: string; sourceNumberE164: string; callerNumberE164: string; issuedAt: string }>;
export interface ControlledTestTransferPort {
  prepare(input: ControlledTransferPrepareInput): ControlledTransferPrepared;
  renderDial(attempt: ControlledTransferAttempt, announcementAudioUrl?: string): string;
  screeningTwiml(attempt: ControlledTransferAttempt): string;
  outcome(attempt: ControlledTransferAttempt, callback: ControlledTransferCallback): ControlledTransferResult;
}

const callbackOriginSchema = z.string().url().transform((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "controlled_transfer_callback_origin_invalid" });
    return z.NEVER;
  }
  return url.origin;
});

/** Fixed selected-role acknowledgement precedes Dial; it never claims a connection. */
export function controlledTransferAnnouncement(category: z.infer<typeof routeCategorySchema>): string {
  const role = { scheduling: "scheduling person", referrals: "referrals team", billing_or_insurance: "billing and insurance team",
    clinical: "clinical team", records_or_administrative: "records and administration team", general_or_uncertain: "front desk" }[category];
  return `I'll try the ${role} for you now.`;
}

/** F3 adapter: emits TwiML and verifies callback evidence, but never calls a provider or persists an attempt. */
export class ControlledTestTransfer implements ControlledTestTransferPort {
  private readonly map: ControlledTransferMap;
  private readonly callbackOrigin: string;
  private readonly hmacSecret: Buffer;
  private readonly ringTimeoutSeconds: number;
  private readonly screeningTimeoutSeconds: number;
  private readonly nonce: () => string;

  constructor(options: { recipientMap: ControlledTransferMap; callbackOrigin: string; hmacSecret: string | Buffer; ringTimeoutSeconds?: number; screeningTimeoutSeconds?: number; nonce?: () => string }) {
    this.map = deepFreeze(structuredClone(controlledTransferMapSchema.parse(options.recipientMap)));
    this.callbackOrigin = callbackOriginSchema.parse(options.callbackOrigin);
    this.hmacSecret = Buffer.isBuffer(options.hmacSecret) ? Buffer.from(options.hmacSecret) : Buffer.from(options.hmacSecret, "utf8");
    if (this.hmacSecret.length < 32) throw new Error("controlled_transfer_hmac_secret_too_short");
    this.ringTimeoutSeconds = boundedTimeout(options.ringTimeoutSeconds ?? 24, 5, 30, "controlled_transfer_ring_timeout_invalid");
    this.screeningTimeoutSeconds = boundedTimeout(options.screeningTimeoutSeconds ?? 8, 1, 15, "controlled_transfer_screening_timeout_invalid");
    this.nonce = options.nonce ?? (() => randomBytes(24).toString("base64url"));
  }

  prepare(input: ControlledTransferPrepareInput): ControlledTransferPrepared {
    if (!this.map.enabled) return { kind: "fallback", reason: "disabled" };
    if (input.mode !== "receptionist") return { kind: "fallback", reason: "not_full_mode" };
    const scope = scopeSchema.parse(input.scope);
    const category = routeCategorySchema.parse(input.category);
    const requestId = id.parse(input.requestId);
    const requestRevision = z.number().int().nonnegative().parse(input.requestRevision);
    const ownerEpoch = z.number().int().nonnegative().parse(input.ownerEpoch);
    const voiceEpoch = z.number().int().nonnegative().parse(input.voiceEpoch);
    const parentCallId = id.parse(input.parentCallId);
    const sourceNumberE164 = e164.parse(input.sourceNumberE164);
    const callerNumberE164 = e164.parse(input.callerNumberE164);
    const issuedAt = timestamp.parse(input.issuedAt);
    if (sourceNumberE164 !== this.map.sourceNumberE164) return { kind: "fallback", reason: "source_mismatch" };
    const recipient = this.map.recipients[category];
    if (recipient === undefined) return { kind: "fallback", reason: "unconfigured" };
    if (recipient.destination === this.map.sourceNumberE164) return { kind: "fallback", reason: "configured_self_loop" };
    if (recipient.destination === callerNumberE164) return { kind: "fallback", reason: "caller_self_loop" };

    const deadlineAt = new Date(Date.parse(issuedAt) + (this.ringTimeoutSeconds + this.screeningTimeoutSeconds) * 1_000).toISOString();
    const attemptId = this.sign("attempt", [scope, requestId, requestRevision, ownerEpoch, voiceEpoch, category, parentCallId, this.map.version, recipient.id, recipient.consentEvidence.id, issuedAt]);
    const unsigned = { id: attemptId, scope, requestId, requestRevision, ownerEpoch, voiceEpoch, category, configVersion: this.map.version, recipientId: recipient.id, recipientConsent: recipient.consentEvidence,
      sourceSnapshot: { configuredSourceE164: sourceNumberE164, callerE164: callerNumberE164 }, destinationE164: recipient.destination,
      parentCallId, childCallId: null, state: "prepared" as const, issuedAt, deadlineAt };
    const attempt = controlledTransferAttemptSchema.parse({ ...unsigned, callbackToken: this.issueToken(unsigned) });
    return { kind: "dial", attempt, twiml: this.dialTwiml(attempt) };
  }

  /** Twilio requests this only after the child leg answers; it cannot confer acceptance. */
  screeningTwiml(rawAttempt: ControlledTransferAttempt): string {
    const attempt = this.requireAttempt(rawAttempt);
    if (attempt.state !== "answered" || attempt.childCallId === null) throw new Error("controlled_transfer_screening_not_answered");
    const action = this.callbackUrl("/f3/transfer/screen/decision", attempt.callbackToken);
    return `<Response><Gather input="dtmf" numDigits="1" timeout="${this.screeningTimeoutSeconds}" actionOnEmptyResult="true" action="${xml(action)}" method="POST"><Say>Controlled test transfer. Press 1 to accept responsibility for this caller.</Say></Gather><Hangup/></Response>`;
  }

  /** Parent code authenticates the provider and durably persists each returned pending attempt. */
  outcome(rawAttempt: ControlledTransferAttempt, rawEvent: ControlledTransferCallback): ControlledTransferResult {
    let attempt: ControlledTransferAttempt;
    let event: ControlledTransferCallback;
    try { attempt = this.requireAttempt(rawAttempt); event = callbackEventSchema.parse(rawEvent); }
    catch { return { kind: "rejected", reason: "attempt_invalid" }; }
    if (event.parentCallId !== attempt.parentCallId || !this.verifyToken(event.token, attempt)) return { kind: "rejected", reason: "callback_invalid" };
    if (event.kind === "parent_dial_result") {
      if (Date.parse(event.receivedAt) > Date.parse(attempt.deadlineAt)) return { kind: "fallback", attempt, reason: "no_answer" };
      // A parent Dial result has no child evidence, so the prepared attempt remains childless.
      return { kind: "fallback", attempt, reason: event.status };
    }
    if (event.childCallId === attempt.parentCallId || attempt.childCallId !== null && event.childCallId !== attempt.childCallId) return { kind: "rejected", reason: "callback_invalid" };
    const late = Date.parse(event.receivedAt) > Date.parse(attempt.deadlineAt);
    if (event.kind === "screening_digits") {
      if (attempt.state !== "answered" || attempt.childCallId !== event.childCallId) return { kind: "rejected", reason: "screening_not_answered" };
      if (event.digits === "1" && late) return { kind: "fallback", attempt, reason: "late_accept" };
      if (event.digits === "1") return { kind: "recipient_accepted", attempt, acceptance: { recipientId: attempt.recipientId, childCallId: event.childCallId, acceptedAt: event.receivedAt } };
      return { kind: "fallback", attempt, reason: "refused" };
    }
    if (late) return { kind: "fallback", attempt, reason: "no_answer" };
    if (event.status === "busy" || event.status === "no_answer" || event.status === "failed" || event.status === "canceled") return { kind: "fallback", attempt, reason: event.status };
    if (event.status === "completed") return { kind: "fallback", attempt, reason: "no_answer" };
    const next = controlledTransferAttemptSchema.parse({ ...attempt, childCallId: event.childCallId, state: event.status === "answered" ? "answered" : "ringing" });
    return { kind: "pending", attempt: next };
  }

  renderDial(attempt: ControlledTransferAttempt, announcementAudioUrl?: string): string { return this.dialTwiml(this.requireAttempt(attempt), announcementAudioUrl); }

  private dialTwiml(attempt: ControlledTransferAttempt, announcementAudioUrl?: string): string {
    const action = this.callbackUrl("/f3/transfer/dial", attempt.callbackToken);
    const status = this.callbackUrl("/f3/transfer/status", attempt.callbackToken);
    const screen = this.callbackUrl("/f3/transfer/screen", attempt.callbackToken);
    if (announcementAudioUrl !== undefined) {
      const audio = new URL(announcementAudioUrl);
      if (audio.protocol !== "https:" || audio.origin !== new URL(this.callbackOrigin).origin || audio.username || audio.password || audio.hash
        || !/^\/voice\/audio\/transfer\/[a-f0-9]{32}$/.test(audio.pathname)) throw new Error("controlled_transfer_audio_url_invalid");
    }
    const announcement = announcementAudioUrl === undefined ? `<Say>${xml(controlledTransferAnnouncement(attempt.category))}</Say>` : `<Play>${xml(announcementAudioUrl)}</Play>`;
    return `<Response>${announcement}<Dial timeout="${this.ringTimeoutSeconds}" answerOnBridge="true" action="${xml(action)}" method="POST"><Number url="${xml(screen)}" method="POST" statusCallback="${xml(status)}" statusCallbackMethod="POST" statusCallbackEvent="answered completed">${xml(attempt.destinationE164)}</Number></Dial></Response>`;
  }

  private callbackUrl(path: string, token: string): string { const url = new URL(path, this.callbackOrigin); url.searchParams.set("token", token); return url.toString(); }
  private requireAttempt(raw: ControlledTransferAttempt): ControlledTransferAttempt {
    const attempt = controlledTransferAttemptSchema.parse(raw);
    const recipient = this.map.recipients[attempt.category];
    if (attempt.configVersion !== this.map.version || recipient === undefined || attempt.recipientId !== recipient.id
      || attempt.destinationE164 !== recipient.destination || attempt.sourceSnapshot.configuredSourceE164 !== this.map.sourceNumberE164
      || JSON.stringify(attempt.recipientConsent) !== JSON.stringify(recipient.consentEvidence)
      || attempt.destinationE164 === this.map.sourceNumberE164 || attempt.destinationE164 === attempt.sourceSnapshot.callerE164
      || Date.parse(attempt.deadlineAt) <= Date.parse(attempt.issuedAt) || !this.verifyToken(attempt.callbackToken, attempt)) throw new Error("controlled_transfer_attempt_invalid");
    return attempt;
  }
  private issueToken(attempt: Omit<ControlledTransferAttempt, "callbackToken">): string {
    const nonce = this.nonce();
    if (!/^[A-Za-z0-9_-]{16,}$/.test(nonce)) throw new Error("controlled_transfer_nonce_invalid");
    const expiresAt = String(Math.floor(Date.parse(attempt.deadlineAt) / 1_000));
    return `${nonce}.${expiresAt}.${this.sign("callback", [nonce, expiresAt, attemptBinding(attempt)])}`;
  }
  private verifyToken(token: string, attempt: Omit<ControlledTransferAttempt, "callbackToken"> | ControlledTransferAttempt): boolean {
    const parsed = /^([A-Za-z0-9_-]{16,})\.([0-9]{10,13})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (parsed === null || Number(parsed[2]!) !== Math.floor(Date.parse(attempt.deadlineAt) / 1_000)) return false;
    const expected = this.sign("callback", [parsed[1]!, parsed[2]!, attemptBinding(attempt)]);
    return timingSafeEqual(Buffer.from(parsed[3]!), Buffer.from(expected));
  }
  private sign(purpose: string, value: unknown): string { return createHmac("sha256", this.hmacSecret).update(`${purpose}:${JSON.stringify(value)}`).digest("base64url"); }
}

function attemptBinding(attempt: Omit<ControlledTransferAttempt, "callbackToken"> | ControlledTransferAttempt): readonly unknown[] {
  return [attempt.id, attempt.scope, attempt.requestId, attempt.requestRevision, attempt.ownerEpoch, attempt.voiceEpoch, attempt.category, attempt.configVersion, attempt.recipientId, attempt.recipientConsent, attempt.issuedAt,
    attempt.sourceSnapshot, attempt.destinationE164, attempt.parentCallId, attempt.deadlineAt];
}
function boundedTimeout(value: number, min: number, max: number, code: string): number { if (!Number.isInteger(value) || value < min || value > max) throw new Error(code); return value; }
function xml(value: string): string { return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", "\"": "&quot;" })[character]!); }
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
