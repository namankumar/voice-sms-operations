import { z } from "zod";

import { normalizedDob, normalizedZip } from "./mock-practice-system.js";

const id = z.string().trim().min(3).max(200);
const revision = z.number().int().nonnegative();
const generation = z.number().int().positive();
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const syntheticDatasetScopeSchema = z.object({
  practiceId: id,
  datasetId: id,
  generation,
}).strict();
export type SyntheticDatasetScope = z.infer<typeof syntheticDatasetScopeSchema>;

/**
 * `observedConversationRevision` is causal provenance only. It changes for
 * heartbeats and unrelated agenda work, so it is never an authorization fence.
 */
export const f2RequestBindingSchema = z.object({
  scope: syntheticDatasetScopeSchema,
  instanceId: id,
  conversationId: z.string().uuid(),
  requestId: id,
  observedConversationRevision: revision,
  requestRevision: revision,
}).strict();
export type F2RequestBinding = z.infer<typeof f2RequestBindingSchema>;

export const syntheticDatasetSchema = z.object({
  scope: syntheticDatasetScopeSchema,
  seedVersion: id,
  seedHash: sha256,
  clinicTimeZone: z.string().trim().min(3).max(80),
  state: z.enum(["active", "resetting", "retired"]),
  version: revision,
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type SyntheticDataset = z.infer<typeof syntheticDatasetSchema>;

const identityFactorSchema = z.enum(["date_of_birth", "zip"]);
export type SyntheticIdentityFactor = z.infer<typeof identityFactorSchema>;
export const identityAttemptLimit = 4;

export const syntheticIdentityAttemptSchema = z.object({
  factor: identityFactorSchema,
  attempt: z.number().int().min(1).max(identityAttemptLimit),
  outcome: z.enum(["matched", "no_match", "ambiguous", "caregiver"]),
  evidenceId: id.nullable(),
  evidenceHash: sha256.nullable(),
}).strict();
export type SyntheticIdentityAttempt = z.infer<typeof syntheticIdentityAttemptSchema>;

export const syntheticIdentityResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("matched"), patientId: id }).strict(),
  z.object({ kind: z.literal("no_match") }).strict(),
  z.object({ kind: z.literal("ambiguous") }).strict(),
  z.object({ kind: z.literal("caregiver") }).strict(),
]);
export type SyntheticIdentityResolution = z.infer<typeof syntheticIdentityResolutionSchema>;

export const syntheticIdentityGrantSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  subjectHash: sha256,
  attempts: z.object({
    date_of_birth: z.number().int().min(1).max(identityAttemptLimit),
    zip: z.number().int().min(1).max(identityAttemptLimit),
  }).strict(),
  factorEvidenceIds: z.object({ date_of_birth: id, zip: id }).strict(),
  factorEvidenceHashes: z.object({ date_of_birth: sha256, zip: sha256 }).strict(),
  authority: z.literal("code"),
  issuedAt: timestamp,
  expiresAt: timestamp,
  version: revision,
}).strict();
export type SyntheticIdentityGrant = z.infer<typeof syntheticIdentityGrantSchema>;

export type SyntheticIdentityGrantDecision =
  | Readonly<{ kind: "granted"; grant: SyntheticIdentityGrant }>
  | Readonly<{ kind: "denied"; reason: "no_match" | "ambiguous" | "caregiver" | "factor_incomplete" | "factor_exhausted" }>;

/**
 * Code, not a model or caller number, decides whether a verification grant can exist.
 * Raw DOB/ZIP values are normalized at ingress and deliberately never enter this record.
 */
export function issueSyntheticIdentityGrant(input: {
  id: string;
  binding: F2RequestBinding;
  resolution: SyntheticIdentityResolution;
  attempts: readonly SyntheticIdentityAttempt[];
  subjectHash: string;
  issuedAt: string;
  expiresAt: string;
  version: number;
}): SyntheticIdentityGrantDecision {
  const parsed = z.object({ id, binding: f2RequestBindingSchema, resolution: syntheticIdentityResolutionSchema,
    attempts: z.array(syntheticIdentityAttemptSchema).max(identityAttemptLimit * 2), subjectHash: sha256,
    issuedAt: timestamp, expiresAt: timestamp, version: revision }).strict().parse(input);
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.issuedAt)) throw new Error("identity_grant_expiry_invalid");
  if (parsed.resolution.kind !== "matched") return { kind: "denied", reason: parsed.resolution.kind };
  const latest = latestAttemptByFactor(parsed.attempts);
  if (latest.date_of_birth === null || latest.zip === null) return { kind: "denied", reason: "factor_incomplete" };
  if (latest.date_of_birth.attempt >= identityAttemptLimit && latest.date_of_birth.outcome !== "matched"
    || latest.zip.attempt >= identityAttemptLimit && latest.zip.outcome !== "matched") return { kind: "denied", reason: "factor_exhausted" };
  if (latest.date_of_birth.outcome !== "matched" || latest.zip.outcome !== "matched"
    || latest.date_of_birth.evidenceId === null || latest.zip.evidenceId === null
    || latest.date_of_birth.evidenceHash === null || latest.zip.evidenceHash === null) return { kind: "denied", reason: "factor_incomplete" };
  return { kind: "granted", grant: syntheticIdentityGrantSchema.parse({
    id: parsed.id, binding: parsed.binding, patientId: parsed.resolution.patientId, subjectHash: parsed.subjectHash,
    attempts: { date_of_birth: latest.date_of_birth.attempt, zip: latest.zip.attempt },
    factorEvidenceIds: { date_of_birth: latest.date_of_birth.evidenceId, zip: latest.zip.evidenceId },
    factorEvidenceHashes: { date_of_birth: latest.date_of_birth.evidenceHash, zip: latest.zip.evidenceHash },
    authority: "code", issuedAt: parsed.issuedAt, expiresAt: parsed.expiresAt, version: parsed.version,
  }) };
}

export const typedSyntheticReadKindSchema = z.enum(["appointment_details", "referral_status", "billing_balance"]);
export type TypedSyntheticReadKind = z.infer<typeof typedSyntheticReadKindSchema>;
export const typedSyntheticReadReceiptSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  grantId: id,
  kind: typedSyntheticReadKindSchema,
  sourceVersion: revision,
  sourceTimestamp: timestamp,
  resultHash: sha256,
  receiptHash: sha256,
  expiresAt: timestamp,
}).strict();
export type TypedSyntheticReadReceipt = z.infer<typeof typedSyntheticReadReceiptSchema>;

export const syntheticSlotSchema = z.object({
  id,
  startsAt: timestamp,
  endsAt: timestamp,
  appointmentType: id,
  location: id,
  capacity: z.number().int().positive(),
  version: revision,
}).strict().superRefine((slot, context) => {
  if (Date.parse(slot.endsAt) <= Date.parse(slot.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "slot_time_invalid" });
});
export type SyntheticSlot = z.infer<typeof syntheticSlotSchema>;

export const syntheticSlotProposalSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  appointmentId: id.nullable(),
  originalAppointmentVersion: revision.nullable(),
  operation: z.enum(["schedule", "reschedule"]),
  slots: z.array(syntheticSlotSchema).min(1).max(2),
  parameterHash: sha256,
  directiveId: id,
  proposalRevision: revision,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((proposal, context) => {
  if (Date.parse(proposal.expiresAt) <= Date.parse(proposal.issuedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "proposal_expiry_invalid" });
  if (new Set(proposal.slots.map((slot) => slot.id)).size !== proposal.slots.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "proposal_slot_duplicate" });
  if (proposal.operation === "reschedule" && (proposal.appointmentId === null || proposal.originalAppointmentVersion === null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "reschedule_original_appointment_required" });
  if (proposal.operation === "schedule" && (proposal.appointmentId !== null || proposal.originalAppointmentVersion !== null)) context.addIssue({ code: z.ZodIssueCode.custom, message: "schedule_original_appointment_forbidden" });
});
export type SyntheticSlotProposal = z.infer<typeof syntheticSlotProposalSchema>;

/** Attendance confirmation is a distinct proposal: it never carries a replacement slot. */
export const syntheticAttendanceProposalSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  appointmentId: id,
  appointmentVersion: revision,
  proposalRevision: revision,
  parameterHash: sha256,
  directiveId: id,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((proposal, context) => {
  if (Date.parse(proposal.expiresAt) <= Date.parse(proposal.issuedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "attendance_proposal_expiry_invalid" });
});
export type SyntheticAttendanceProposal = z.infer<typeof syntheticAttendanceProposalSchema>;

export const exactConsentSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  proposalId: id,
  proposalRevision: revision,
  parameterHash: sha256,
  questionId: id.optional(),
  channel: z.enum(["voice", "sms"]),
  explicit: z.literal(true),
  sourceEventId: id,
  receivedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((consent, context) => {
  if (Date.parse(consent.expiresAt) <= Date.parse(consent.receivedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "consent_expiry_invalid" });
  if (consent.channel === "voice" && consent.questionId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: "voice_consent_question_missing" });
});
export type ExactConsent = z.infer<typeof exactConsentSchema>;

export const authenticatedPlaybackReceiptSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  proposalId: id,
  proposalRevision: revision,
  directiveId: id,
  parameterHash: sha256,
  source: z.literal("telephony_mark"),
  authority: z.literal("telephony_adapter"),
  authenticated: z.literal(true),
  authorityReceiptId: id,
  markId: id,
  completedWithoutInterruption: z.literal(true),
  playedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.playedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "playback_receipt_expiry_invalid" });
});
export type AuthenticatedPlaybackReceipt = z.infer<typeof authenticatedPlaybackReceiptSchema>;

/** Server-side audio completion for one exact synthetic proposal. It never claims caller hearing. */
export const voiceProposalReadbackReceiptSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  proposalId: id,
  proposalRevision: revision,
  directiveId: id,
  parameterHash: sha256,
  exactTextHash: sha256,
  questionId: id,
  ownerEpoch: revision,
  voiceEpoch: revision,
  source: z.literal("openai_realtime_server_audio"),
  responseId: id,
  outputItemId: id,
  reviewId: id,
  transportEvidenceId: id,
  completedWithoutInterruption: z.literal(true),
  state: z.literal("server_drained"),
  hearing: z.literal("unknown"),
  completedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((receipt, context) => {
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.completedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "voice_readback_expiry_invalid" });
});
export type VoiceProposalReadbackReceipt = z.infer<typeof voiceProposalReadbackReceiptSchema>;

export const smsProposalAcceptanceSchema = z.object({
  id,
  binding: f2RequestBindingSchema,
  patientId: id,
  proposalId: id,
  proposalRevision: revision,
  parameterHash: sha256,
  source: z.literal("provider_accepted"),
  providerMessageId: id,
  acceptedAt: timestamp,
  expiresAt: timestamp,
}).strict().superRefine((acceptance, context) => {
  if (Date.parse(acceptance.expiresAt) <= Date.parse(acceptance.acceptedAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "sms_acceptance_expiry_invalid" });
});
export type SmsProposalAcceptance = z.infer<typeof smsProposalAcceptanceSchema>;

export const syntheticActionReceiptSchema = z.object({
  id,
  sourceEventId: id.optional(),
  binding: f2RequestBindingSchema,
  patientId: id,
  proposalId: id.nullable(),
  operation: z.enum(["schedule", "reschedule", "attendance_confirm"]),
  idempotencyKey: id,
  parameterHash: sha256,
  expectedAppointmentVersion: revision.nullable(),
  resultingAppointmentVersion: revision.nullable(),
  state: z.enum(["committed", "uncertain", "routed"]),
  authorizationReceiptId: id,
  authorizationExpiresAt: timestamp,
  resultHash: sha256.nullable(),
  readbackHash: sha256.nullable(),
  createdAt: timestamp,
}).strict().superRefine((receipt, context) => {
  if (receipt.state === "committed" && (receipt.resultHash === null || receipt.readbackHash === null || receipt.resultingAppointmentVersion === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "committed_action_requires_readback" });
  }
  if (receipt.operation === "attendance_confirm" && receipt.proposalId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "attendance_does_not_use_slot_proposal" });
  }
  if (Date.parse(receipt.authorizationExpiresAt) <= Date.parse(receipt.createdAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "action_authority_expired_before_commit" });
  }
});
export type SyntheticActionReceipt = z.infer<typeof syntheticActionReceiptSchema>;

export type F2WriteAuthorization =
  | Readonly<{ kind: "authorized"; authorizationReceiptId: string }>
  | Readonly<{ kind: "denied"; reason: "proposal_expired" | "proposal_not_issued" | "binding_mismatch" | "consent_mismatch" | "consent_not_issued" | "consent_before_proposal" | "consent_not_subsequent" | "voice_readback_missing" | "voice_readback_mismatch" | "voice_readback_not_issued" | "voice_readback_before_proposal" | "sms_acceptance_missing" | "sms_acceptance_mismatch" | "sms_acceptance_not_issued" | "sms_acceptance_before_proposal" }>;

/**
 * Fail closed: a generated response completion is not a permitted receipt source.
 * This pure function validates binding and time ordering only. Its caller-provided
 * authority fields are untrusted; the Postgres store must resolve the returned ID
 * to a persisted adapter receipt and atomically consume it before committing.
 */
export function authorizeF2Write(input: {
  proposal: SyntheticSlotProposal | SyntheticAttendanceProposal;
  consent: ExactConsent;
  now: string;
  voiceReadback?: VoiceProposalReadbackReceipt;
  smsAcceptance?: SmsProposalAcceptance;
}): F2WriteAuthorization {
  const proposal = z.union([syntheticSlotProposalSchema, syntheticAttendanceProposalSchema]).parse(input.proposal);
  const consent = exactConsentSchema.parse(input.consent);
  const now = timestamp.parse(input.now);
  const nowMs = Date.parse(now);
  const proposalIssuedAt = Date.parse(proposal.issuedAt);
  if (proposalIssuedAt > nowMs) return { kind: "denied", reason: "proposal_not_issued" };
  if (Date.parse(proposal.expiresAt) <= nowMs) return { kind: "denied", reason: "proposal_expired" };
  if (!sameRequestAuthority(proposal.binding, consent.binding) || proposal.patientId !== consent.patientId
    || proposal.id !== consent.proposalId || proposal.proposalRevision !== consent.proposalRevision || proposal.parameterHash !== consent.parameterHash) {
    return { kind: "denied", reason: "consent_mismatch" };
  }
  const consentReceivedAt = Date.parse(consent.receivedAt);
  if (consentReceivedAt > nowMs) return { kind: "denied", reason: "consent_not_issued" };
  if (consentReceivedAt < proposalIssuedAt) return { kind: "denied", reason: "consent_before_proposal" };
  if (Date.parse(consent.expiresAt) <= nowMs) return { kind: "denied", reason: "consent_mismatch" };
  if (consent.channel === "voice") {
    if (input.voiceReadback === undefined) return { kind: "denied", reason: "voice_readback_missing" };
    const readback = voiceProposalReadbackReceiptSchema.parse(input.voiceReadback);
    if (!sameRequestAuthority(proposal.binding, readback.binding) || proposal.patientId !== readback.patientId
      || readback.proposalId !== proposal.id || readback.proposalRevision !== proposal.proposalRevision
      || readback.directiveId !== proposal.directiveId || readback.parameterHash !== proposal.parameterHash
      || consent.questionId === undefined || readback.questionId !== consent.questionId
      || readback.completedWithoutInterruption !== true || readback.state !== "server_drained" || readback.hearing !== "unknown"
      || Date.parse(readback.expiresAt) <= Date.parse(now)) return { kind: "denied", reason: "voice_readback_mismatch" };
    const completedAt = Date.parse(readback.completedAt);
    if (completedAt > nowMs) return { kind: "denied", reason: "voice_readback_not_issued" };
    if (completedAt < proposalIssuedAt) return { kind: "denied", reason: "voice_readback_before_proposal" };
    if (consentReceivedAt <= completedAt) return { kind: "denied", reason: "consent_not_subsequent" };
    return { kind: "authorized", authorizationReceiptId: readback.id };
  }
  if (input.smsAcceptance === undefined) return { kind: "denied", reason: "sms_acceptance_missing" };
  const acceptance = smsProposalAcceptanceSchema.parse(input.smsAcceptance);
  if (!sameRequestAuthority(proposal.binding, acceptance.binding) || proposal.patientId !== acceptance.patientId
    || acceptance.proposalId !== proposal.id || acceptance.proposalRevision !== proposal.proposalRevision
    || acceptance.parameterHash !== proposal.parameterHash || Date.parse(acceptance.expiresAt) <= Date.parse(now)) return { kind: "denied", reason: "sms_acceptance_mismatch" };
  const acceptanceAt = Date.parse(acceptance.acceptedAt);
  if (acceptanceAt > nowMs) return { kind: "denied", reason: "sms_acceptance_not_issued" };
  if (acceptanceAt < proposalIssuedAt) return { kind: "denied", reason: "sms_acceptance_before_proposal" };
  if (consentReceivedAt <= acceptanceAt) return { kind: "denied", reason: "consent_not_subsequent" };
  return { kind: "authorized", authorizationReceiptId: acceptance.id };
}

/** Validates the legacy parser's normalized value without changing its accepted language forms. */
export function normalizeSyntheticDob(value: string, now?: Date): string | null {
  const canonical = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(canonical)) return validSyntheticDob(canonical, now);
  if (!hasExplicitF2Year(value)) return null;
  const normalized = normalizedDob(value);
  return normalized === null ? null : validSyntheticDob(normalized, now);
}

/** Canonical tool values must retain the same calendar and future-date guards as caller wording. */
function validSyntheticDob(normalized: string, now?: Date): string | null {
  const [year, month, day] = normalized.split("-").map(Number);
  const actual = new Date(Date.UTC(year!, month! - 1, day!));
  if (actual.getUTCFullYear() !== year || actual.getUTCMonth() !== month! - 1 || actual.getUTCDate() !== day) return null;
  if (now !== undefined && normalized > now.toISOString().slice(0, 10)) return null;
  return normalized;
}
export function normalizeSyntheticZip(value: string): string | null { return normalizedZip(value); }

/**
 * Derives one factor only from caller speech. Explicit factor labels let a
 * combined answer retain the existing strict per-factor normalizers.
 */
export function normalizeSyntheticIdentityEvidence(value: string, factor: "date_of_birth" | "zip", now?: Date): string | null {
  const normalize = factor === "date_of_birth"
    ? (candidate: string) => normalizeSyntheticDob(candidate, now)
    : normalizeSyntheticZip;
  const labels = identityEvidenceLabels(value);
  const candidates = labels.map((label, index) => label.factor === factor
    ? normalizeUnambiguousIdentitySegment(identityEvidenceSegment(value, label.end, labels[index + 1]?.start), normalize,
      factor === "date_of_birth" ? (segment) => normalizeEmbeddedCanonicalDob(segment, value.slice(0, label.start), now) : undefined)
    : undefined);
  const values = candidates.filter((candidate): candidate is string | null => candidate !== undefined);
  if (values.length > 0) return values.every((candidate) => candidate !== null) && new Set(values).size === 1 ? values[0]! : null;
  // A different labeled factor fences unlabeled evidence to the preceding speech.
  const unlabeled = labels.length === 0 ? value : value.slice(0, labels[0]!.start);
  const primary = normalize(unlabeled);
  if (primary !== null || factor !== "date_of_birth") return primary;
  return normalizeUnlabeledCanonicalDob(unlabeled, now);
}

/** Detect a second complete factor without coupling the check to correction phrasing. */
function normalizeUnambiguousIdentitySegment(value: string, normalize: (candidate: string) => string | null,
  embeddedCanonical?: (value: string) => string | null | undefined): string | null {
  const primary = normalize(identityEvidencePrimaryClause(value));
  const candidates = new Set<string>();
  if (primary !== null) {
    candidates.add(primary);
    const tokens = value.match(/[a-z0-9]+/gi) ?? [];
    for (let start = 0; start < tokens.length; start += 1) {
      for (let end = start + 1; end <= Math.min(tokens.length, start + 8); end += 1) {
        // Do not turn a prefix of a spoken year into competing source evidence.
        if (end < tokens.length && continuesSpokenDate(tokens[end]!)) continue;
        const candidate = normalize(tokens.slice(start, end).join(" "));
        if (candidate !== null) candidates.add(candidate);
      }
    }
  }
  const canonical = embeddedCanonical?.(value);
  if (canonical === null) return null;
  if (canonical !== undefined) candidates.add(canonical);
  return candidates.size === 1 ? candidates.values().next().value! : null;
}

/** A labeled ISO DOB needs an assertion, not merely a date-shaped instruction. */
function normalizeEmbeddedCanonicalDob(value: string, beforeLabel: string, now?: Date): string | null | undefined {
  const matches = [...value.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)];
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  if (!/^\s*(?:my\s+)?$/i.test(beforeLabel)
    || !/^\s*(?:(?:is|was)\b\s*|[:=]\s*)?$/i.test(value.slice(0, match.index))
    || !/^\s*(?:,?\s*(?:and|but)?\s*(?:my)?\s*)?[.!?]?\s*$/i.test(value.slice(match.index! + match[0].length))) return null;
  return normalizeSyntheticDob(match[1]!, now);
}

/** A bare DOB answer may use only a short declarative wrapper around canonical ISO. */
function normalizeUnlabeledCanonicalDob(value: string, now?: Date): string | null {
  const match = /^\s*(?:it'?s|it\s+is)\s+(\d{4}-\d{2}-\d{2})\s*[.!?]?\s*$/i.exec(value);
  return match === null ? null : normalizeSyntheticDob(match[1]!, now);
}

function continuesSpokenDate(token: string): boolean {
  return /^(?:\d+|and|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)$/.test(token.toLowerCase());
}

function identityEvidenceLabels(value: string): { factor: "date_of_birth" | "zip"; start: number; end: number }[] {
  const labels: { factor: "date_of_birth" | "zip"; start: number; end: number }[] = [];
  const pattern = /\b(?<dob>date\s+of\s+birth|birth\s*date|dob)\b|\b(?<zip>zip(?:\s+code)?|postal\s+code)\b/gi;
  for (const match of value.matchAll(pattern)) {
    const factor = match.groups?.dob === undefined ? "zip" : "date_of_birth";
    labels.push({ factor, start: match.index!, end: match.index! + match[0].length });
  }
  return labels;
}

function identityEvidenceSegment(value: string, start: number, nextLabelStart?: number): string {
  return value.slice(start, nextLabelStart);
}

function identityEvidencePrimaryClause(value: string): string {
  const sentenceEnd = value.search(/[.!?;](?:\s|$)/);
  return sentenceEnd === -1 ? value : value.slice(0, sentenceEnd);
}

/** Legacy normalization guesses a century for two-digit input; F2 never turns that ambiguity into identity evidence. */
function hasExplicitF2Year(value: string): boolean {
  const compact = value.trim();
  if (/^\d{8}$/.test(compact)) return true;
  if (/\d/.test(compact)) return /(^|\D)\d{4}(\D|$)/.test(compact);
  return /\b(?:nineteen|two thousand)\s+[a-z-]+\b/i.test(compact);
}

function latestAttemptByFactor(attempts: readonly SyntheticIdentityAttempt[]): Record<SyntheticIdentityFactor, SyntheticIdentityAttempt | null> {
  const latest: Record<SyntheticIdentityFactor, SyntheticIdentityAttempt | null> = { date_of_birth: null, zip: null };
  for (const attempt of attempts) {
    const current = latest[attempt.factor];
    if (current !== null && attempt.attempt <= current.attempt) throw new Error("identity_attempt_not_monotonic");
    latest[attempt.factor] = attempt;
  }
  return latest;
}

/**
 * Request revision is the authorization fence. The store must additionally lock
 * and compare the live request's patient and revision before it consumes a receipt.
 */
export function sameRequestAuthority(left: F2RequestBinding, right: F2RequestBinding): boolean {
  return left.scope.practiceId === right.scope.practiceId && left.scope.datasetId === right.scope.datasetId
    && left.scope.generation === right.scope.generation && left.conversationId === right.conversationId
    && left.instanceId === right.instanceId && left.requestId === right.requestId && left.requestRevision === right.requestRevision;
}
