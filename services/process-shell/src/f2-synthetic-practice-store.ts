import { randomUUID } from "node:crypto";
import { isCallbackQuestion, resumesOfferedAppointment } from "./f2-dialogue-evidence.js";

import postgres from "postgres";
import { z } from "zod";

import { ConversationCipher } from "./conversation-store.js";
import { conversationSchema, type Conversation } from "./conversation-contract.js";
import { type FullRequestProposal } from "./f2-request-policy.js";
import { preferenceMatch, type SchedulingPreference } from "./f2-scheduling-preference.js";
import { authorizeF2Write, exactConsentSchema, smsProposalAcceptanceSchema, voiceProposalReadbackReceiptSchema, type ExactConsent, type F2RequestBinding,
  type SmsProposalAcceptance, sameRequestAuthority, syntheticActionReceiptSchema, type SyntheticActionReceipt,
  syntheticDatasetSchema, type SyntheticDataset, type SyntheticIdentityGrant, syntheticIdentityGrantSchema,
  syntheticAttendanceProposalSchema, type SyntheticAttendanceProposal, syntheticSlotProposalSchema, type SyntheticSlotProposal, typedSyntheticReadKindSchema, typedSyntheticReadReceiptSchema,
  type TypedSyntheticReadKind, type TypedSyntheticReadReceipt, type VoiceProposalReadbackReceipt, normalizeSyntheticDob, normalizeSyntheticZip, f2RequestBindingSchema } from "./f2-synthetic-practice-contract.js";
import type { PostgresControlledOfferExpiry } from "./controlled-offer-expiry.js";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;
const id = z.string().trim().min(3).max(200);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });

export const syntheticFixtureOrigin = "synthetic_fixture" as const;
const fixturePatientBodySchema = z.object({
  identity: z.object({ dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), zip: z.string().regex(/^\d{5}$/) }).strict(),
  eligibleAppointmentTypes: z.array(id).min(1).max(16),
  values: z.object({ appointment_details: z.unknown(), referral_status: z.unknown(), billing_balance: z.unknown() }).strict(),
}).strict();
const fixtureSlotBodySchema = z.object({ appointmentType: id, location: id }).strict();
const fixturePatientSchema = z.object({
  scope: z.object({ practiceId: id, datasetId: id, generation: z.number().int().positive() }).strict(),
  patientId: id,
  identityFingerprintHash: hash,
  origin: z.literal(syntheticFixtureOrigin),
  body: fixturePatientBodySchema,
  version: z.number().int().nonnegative(),
}).strict();
export type SyntheticFixturePatient = z.infer<typeof fixturePatientSchema>;

const fixtureSlotSchema = z.object({
  scope: z.object({ practiceId: id, datasetId: id, generation: z.number().int().positive() }).strict(),
  slotId: id,
  startsAt: timestamp,
  endsAt: timestamp,
  capacity: z.number().int().positive(),
  origin: z.literal(syntheticFixtureOrigin),
  body: fixtureSlotBodySchema,
  version: z.number().int().nonnegative(),
}).strict().superRefine((slot, context) => {
  if (Date.parse(slot.endsAt) <= Date.parse(slot.startsAt)) context.addIssue({ code: z.ZodIssueCode.custom, message: "fixture_slot_time_invalid" });
});
export type SyntheticFixtureSlot = z.infer<typeof fixtureSlotSchema>;
const fixtureAppointmentSchema = z.object({
  scope: z.object({ practiceId: id, datasetId: id, generation: z.number().int().positive() }).strict(), appointmentId: id, patientId: id, slotId: id,
  state: z.enum(["scheduled", "superseded", "canceled"]), attendanceVersion: z.number().int().nonnegative().nullable(), origin: z.literal(syntheticFixtureOrigin),
  body: z.unknown(), version: z.number().int().nonnegative(),
}).strict();
export type SyntheticFixtureAppointment = z.infer<typeof fixtureAppointmentSchema>;

export type StoredF2AuthorizationReceipt = VoiceProposalReadbackReceipt | SmsProposalAcceptance;
export interface F2AuthorityReceiptResolver {
  /** Resolves a server-authenticated adapter receipt by ID; model input never supplies receipt fields. */
  resolve(receiptId: string, binding: F2RequestBinding): Promise<StoredF2AuthorizationReceipt | null>;
}
export type F2Mutation = {
  actionId: string;
  trusted: F2TrustedConversationContext;
  binding: F2RequestBinding;
  patientId: string;
  grantId: string;
  proposalId: string;
  consentEvidenceId: string;
  authorizationReceiptId: string;
  operation: "schedule" | "reschedule" | "attendance_confirm";
  requestKind: "office_visit" | "not_applicable";
  selectedSlotId: string | null;
  idempotencyKey: string;
  parameterHash: string;
  expectedAppointmentVersion: number | null;
};

type DatasetRow = { state: "active" | "resetting" | "retired"; version: number; protected_payload: unknown };
type SessionRow = { patient_id: string; request_revision: number; expires_at: string | Date; revoked_at: string | Date | null; protected_payload: unknown };
type ActionRow = { id: string; operation: string; request_revision: number; patient_id: string; input_hash: string; state: string; authorization_receipt_id: string | null; expires_at: string | Date; protected_payload: unknown; version: number };
type ConversationRow = { instance_id: string; id: string; revision: number; contact_key: string; protected_state: unknown };
type VerificationRow = { state: "pending" | "verified" | "exhausted" | "revoked"; expires_at: string | Date; version: number; protected_payload: unknown };
type EvidenceRow = { kind: "proposal" | "read" | "voice_authority" | "sms_authority" | "consent"; protected_payload: unknown; expires_at: string | Date; consumed_by: string | null };
type SlotRow = { slot_id: string; capacity: number; booked_count: number; version: number; protected_payload: unknown };
type AppointmentRow = { appointment_id: string; patient_id: string; slot_id: string; state: "scheduled" | "superseded" | "canceled"; attendance_version: number | null; version: number; protected_payload: unknown };
export type F2TrustedConversationContext = { readonly expectedOwnerEpoch: number };
type CurrentF2Request = { readonly conversation: Conversation; readonly request: Conversation["requests"][number] };
export type TypedSyntheticReadResult = { readonly receipt: TypedSyntheticReadReceipt; readonly value: unknown };
export type CallerProvidedIdentity = Readonly<{ dateOfBirth: string; zip: string; status: "active" | "historical" }>;
export type F2MutationResultPublisher = (tx: Tx, input: { receipt: SyntheticActionReceipt; current: CurrentF2Request }) => Promise<void>;
export type F2ReadResultPublisher = (tx: Tx, input: { receipt: TypedSyntheticReadReceipt; current: CurrentF2Request }) => Promise<void>;
export type F2OfferPublisher = (tx: Tx, input: { current: CurrentF2Request; proposal: SyntheticSlotProposal | SyntheticAttendanceProposal }) => Promise<void>;
const MAX_AUTHORITY_TTL_MS = 15 * 60 * 1000;

/**
 * Postgres backing for F2 only. All displayable fixture values remain encrypted;
 * indexes contain synthetic IDs, opaque hashes, lifecycle state, and revisions only.
 */
export class PostgresF2SyntheticPracticeStore {
  private readonly sql: Sql;
  constructor(databaseUrl: string, private readonly cipher: ConversationCipher, private readonly authorityResolver: F2AuthorityReceiptResolver,
    private readonly now: () => Date = () => new Date(), private readonly maxAuthorityTtlMs = MAX_AUTHORITY_TTL_MS,
    private readonly controlledOfferExpiry?: Pick<PostgresControlledOfferExpiry, "consume">) {
    if (!Number.isInteger(maxAuthorityTtlMs) || maxAuthorityTtlMs <= 0 || maxAuthorityTtlMs > MAX_AUTHORITY_TTL_MS) throw new Error("synthetic_authority_ttl_invalid");
    this.sql = postgres(databaseUrl, { max: 5, connect_timeout: 5, idle_timeout: 20, onnotice: () => {}, connection: { application_name: "vegas-f2-synthetic-practice" } });
  }

  async ready(): Promise<boolean> {
    try {
      const rows = await this.sql<{ datasets: string | null; patients: string | null; slots: string | null; appointments: string | null; verifications: string | null; sessions: string | null; actions: string | null; evidence: string | null }[]>`
        SELECT to_regclass('public.synthetic_datasets')::text AS datasets,
          to_regclass('public.synthetic_patient_payloads')::text AS patients,
          to_regclass('public.synthetic_slots')::text AS slots,
          to_regclass('public.synthetic_appointments')::text AS appointments,
          to_regclass('public.synthetic_verifications')::text AS verifications,
          to_regclass('public.synthetic_sessions')::text AS sessions,
          to_regclass('public.synthetic_actions')::text AS actions,
          to_regclass('public.synthetic_evidence')::text AS evidence`;
      return Object.values(rows[0] ?? {}).length === 8 && Object.values(rows[0] ?? {}).every((value) => value !== null);
    } catch { return false; }
  }

  /** Server bootstrap only: one atomic, explicitly synthetic fixture set. No caller-phone or arbitrary patient endpoint exists. */
  async seedFixedFixtures(raw: { dataset: SyntheticDataset; patients: readonly SyntheticFixturePatient[]; slots: readonly SyntheticFixtureSlot[]; appointments?: readonly SyntheticFixtureAppointment[] }): Promise<void> {
    await this.seedFixtures(raw, false);
  }

  async seedFixedFixturesIfAbsent(raw: Parameters<PostgresF2SyntheticPracticeStore["seedFixedFixtures"]>[0]): Promise<"seeded" | "already_present"> {
    return await this.seedFixtures(raw, true);
  }

  private async seedFixtures(raw: Parameters<PostgresF2SyntheticPracticeStore["seedFixedFixtures"]>[0], onlyIfAbsent: boolean): Promise<"seeded" | "already_present"> {
    const dataset = syntheticDatasetSchema.parse(raw.dataset);
    const patients = raw.patients.map((patient) => fixturePatientSchema.parse(patient));
    const slots = raw.slots.map((slot) => fixtureSlotSchema.parse(slot));
    const appointments = (raw.appointments ?? []).map((appointment) => fixtureAppointmentSchema.parse(appointment));
    if (dataset.state !== "active" || patients.length === 0 || slots.length === 0) throw new Error("synthetic_fixture_seed_invalid");
    if ([...patients, ...slots, ...appointments].some((item) => JSON.stringify(item.scope) !== JSON.stringify(dataset.scope))) throw new Error("synthetic_fixture_scope_mismatch");
    if (slots.some((slot) => !patients.some((patient) => patient.body.eligibleAppointmentTypes.includes(slot.body.appointmentType)))) throw new Error("synthetic_fixture_appointment_type_unregistered");
    const patientIds = new Set(patients.map((patient) => patient.patientId)), slotIds = new Set(slots.map((slot) => slot.slotId));
    if (appointments.some((appointment) => !patientIds.has(appointment.patientId) || !slotIds.has(appointment.slotId))) throw new Error("synthetic_fixture_appointment_orphan");
    const booked = new Map<string, number>();
    for (const appointment of appointments) if (appointment.state === "scheduled") booked.set(appointment.slotId, (booked.get(appointment.slotId) ?? 0) + 1);
    if (slots.some((slot) => (booked.get(slot.slotId) ?? 0) > slot.capacity)) throw new Error("synthetic_fixture_slot_overcapacity");
    return await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["f2-seed", dataset.scope])},0))`;
      if (onlyIfAbsent) {
        const existing = await tx<{ seed_version: string; seed_hash: string; state: string }[]>`SELECT seed_version,seed_hash,state FROM synthetic_datasets
          WHERE practice_id=${dataset.scope.practiceId} AND dataset_id=${dataset.scope.datasetId} AND generation=${dataset.scope.generation} FOR UPDATE`;
        if (existing[0]) {
          if (existing[0].seed_version !== dataset.seedVersion || existing[0].seed_hash !== dataset.seedHash || existing[0].state !== "active") throw new Error("synthetic_fixture_bootstrap_conflict");
          return "already_present" as const;
        }
      }
      const payload = this.protect(dataset, dataset.scope, "dataset", dataset.version);
      await tx`INSERT INTO synthetic_datasets(practice_id,dataset_id,generation,seed_version,seed_hash,clinic_timezone,state,version,protected_payload,created_at,updated_at)
        VALUES (${dataset.scope.practiceId},${dataset.scope.datasetId},${dataset.scope.generation},${dataset.seedVersion},${dataset.seedHash},${dataset.clinicTimeZone},${dataset.state},${dataset.version},${this.sql.json(payload as postgres.JSONValue)},${dataset.createdAt}::timestamptz,${dataset.updatedAt}::timestamptz)`;
      for (const patient of patients) {
        const patientPayload = this.protect(patient.body, patient.scope, `patient:${patient.patientId}`, patient.version);
        await tx`INSERT INTO synthetic_patient_payloads(practice_id,dataset_id,generation,patient_id,identity_fingerprint_hash,protected_payload,version)
          VALUES (${patient.scope.practiceId},${patient.scope.datasetId},${patient.scope.generation},${patient.patientId},${patient.identityFingerprintHash},${this.sql.json(patientPayload as postgres.JSONValue)},${patient.version})`;
      }
      for (const slot of slots) {
        const slotPayload = this.protect(slot.body, slot.scope, `slot:${slot.slotId}`, slot.version);
        await tx`INSERT INTO synthetic_slots(practice_id,dataset_id,generation,slot_id,starts_at,ends_at,capacity,booked_count,protected_payload,version)
          VALUES (${slot.scope.practiceId},${slot.scope.datasetId},${slot.scope.generation},${slot.slotId},${slot.startsAt}::timestamptz,${slot.endsAt}::timestamptz,${slot.capacity},${booked.get(slot.slotId) ?? 0},${this.sql.json(slotPayload as postgres.JSONValue)},${slot.version})`;
      }
      for (const appointment of appointments) {
        const appointmentPayload = this.protect(appointment.body, appointment.scope, `appointment:${appointment.appointmentId}`, appointment.version);
        await tx`INSERT INTO synthetic_appointments(practice_id,dataset_id,generation,appointment_id,patient_id,slot_id,state,attendance_version,protected_payload,version)
          VALUES (${appointment.scope.practiceId},${appointment.scope.datasetId},${appointment.scope.generation},${appointment.appointmentId},${appointment.patientId},${appointment.slotId},${appointment.state},${appointment.attendanceVersion},${this.sql.json(appointmentPayload as postgres.JSONValue)},${appointment.version})`;
      }
      return "seeded" as const;
    });
  }

  /** Use this immediately before matching a fixture patient; never persist the supplied raw factor. */
  normalizeDobForGrant(value: string): string | null { return normalizeSyntheticDob(value, this.now()); }

  /** Staff detail only: this reads verified caller-provided factors, never fixture identity or pending attempts. */
  async getCallerProvidedIdentity(input: { practiceId: string; instanceId: string; conversationId: string }): Promise<CallerProvidedIdentity | null> {
    const parsed = z.object({ practiceId: id, instanceId: id, conversationId: z.string().uuid() }).strict().parse(input);
    const rows = await this.sql<{ practice_id: string; dataset_id: string; generation: number; verification_id: string; version: number; expires_at: string | Date; protected_payload: unknown }[]>`
      SELECT practice_id,dataset_id,generation,verification_id,version,expires_at,protected_payload FROM synthetic_verifications
      WHERE practice_id=${parsed.practiceId} AND instance_id=${parsed.instanceId} AND conversation_id=${parsed.conversationId} AND state='verified'
      ORDER BY updated_at DESC LIMIT 1`;
    const row = rows[0]; if (row === undefined) return null;
    const body = verificationBodySchema.parse(this.cipher.unprotect(row.protected_payload, this.verificationBinding({ practiceId: row.practice_id, datasetId: row.dataset_id, generation: row.generation }, row.verification_id, row.version)));
    if (body.normalizedFactors.date_of_birth === undefined || body.normalizedFactors.zip === undefined) return null;
    return { dateOfBirth: body.normalizedFactors.date_of_birth, zip: body.normalizedFactors.zip,
      status: Date.parse(String(row.expires_at)) > this.now().getTime() ? "active" : "historical" };
  }

  async beginVerification(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; verificationId: string; expiresAt: string }): Promise<void> {
    const expiresAt = timestamp.parse(input.expiresAt);
    const now = this.now().toISOString();
    this.assertBoundedExpiry(expiresAt, now, "synthetic_verification_expiry_invalid");
    await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const body: VerificationBody = { attempts: { date_of_birth: 0, zip: 0 }, candidates: null, evidenceHashes: {}, normalizedFactors: {} };
      await tx`INSERT INTO synthetic_verifications(practice_id,dataset_id,generation,verification_id,instance_id,conversation_id,request_id,request_revision,owner_epoch,state,expires_at,protected_payload,version,created_at,updated_at)
        VALUES (${input.binding.scope.practiceId},${input.binding.scope.datasetId},${input.binding.scope.generation},${input.verificationId},${input.binding.instanceId},${input.binding.conversationId},${input.binding.requestId},${input.binding.requestRevision},${input.trusted.expectedOwnerEpoch},'pending',${expiresAt}::timestamptz,${this.sql.json(this.protect(body, input.binding.scope, `verification:${input.verificationId}`, 0) as postgres.JSONValue)},0,${now}::timestamptz,${now}::timestamptz)`;
    });
  }

  /** Server-only factor evaluation. The model receives the outcome, never a grant constructor. */
  async verifyFactor(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; verificationId: string; factor: "date_of_birth" | "zip"; value: string;
    answerSourceId?: string }): Promise<{ state: VerificationRow["state"]; grant: SyntheticIdentityGrant | null; nextFactor?: "date_of_birth" | "zip" }> {
    return this.verifyFactors({ trusted: input.trusted, binding: input.binding, verificationId: input.verificationId,
      ...(input.answerSourceId === undefined ? {} : { answerSourceId: input.answerSourceId }),
      factors: [{ factor: input.factor, value: input.value }] });
  }

  async verifyFactors(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; verificationId: string;
    factors: readonly { factor: "date_of_birth" | "zip"; value: string }[]; answerSourceId?: string
  }): Promise<{ state: VerificationRow["state"]; grant: SyntheticIdentityGrant | null; nextFactor?: "date_of_birth" | "zip" }> {
    const factors = identityFactorBatchSchema.parse(input.factors);
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      if (input.answerSourceId !== undefined) this.requireCurrentAnswer(current, input.answerSourceId, "identity");
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const rows = await tx<VerificationRow[]>`SELECT state,expires_at,version,protected_payload FROM synthetic_verifications WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND verification_id=${input.verificationId} AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND request_id=${input.binding.requestId} AND request_revision=${input.binding.requestRevision} AND owner_epoch=${input.trusted.expectedOwnerEpoch} FOR UPDATE`;
      const row = rows[0];
      if (row === undefined || row.state !== "pending") throw new Error("synthetic_verification_unavailable");
      const expiresAt = Date.parse(String(row.expires_at));
      const freshTime = (): string => {
        const fresh = this.now().toISOString();
        if (expiresAt <= Date.parse(fresh)) throw new Error("synthetic_verification_unavailable");
        return fresh;
      };
      const proposedAt = freshTime();
      const proposed = new Map(factors.map((item) => [item.factor,
        item.factor === "date_of_birth" ? normalizeSyntheticDob(item.value, new Date(proposedAt)) : normalizeSyntheticZip(item.value)]));
      const body = verificationBodySchema.parse(this.cipher.unprotect(row.protected_payload, this.verificationBinding(input.binding.scope, input.verificationId, row.version)));
      const order = ["date_of_birth", "zip"] as const;
      for (const factor of order) {
        if ((body.normalizedFactors[factor] === undefined) !== (body.evidenceHashes[factor] === undefined)) {
          throw new Error("synthetic_verification_evidence_missing");
        }
      }
      const priorMatches: Partial<Record<(typeof order)[number], string[]>> = {};
      for (const factor of order) {
        const value = body.normalizedFactors[factor];
        if (value !== undefined) priorMatches[factor] = await this.matchFixturePatients(tx, input.binding.scope, factor, value);
      }
      const attempts = { ...body.attempts };
      const evidenceHashes: Partial<Record<(typeof order)[number], string>> = {};
      const normalizedFactors: Partial<Record<(typeof order)[number], string>> = {};
      for (const factor of order) {
        if (body.evidenceHashes[factor] !== undefined) evidenceHashes[factor] = body.evidenceHashes[factor];
        if (body.normalizedFactors[factor] !== undefined) normalizedFactors[factor] = body.normalizedFactors[factor];
      }
      const retained = new Set<(typeof order)[number]>();
      for (const factor of order) {
        const normalized = proposed.get(factor);
        if (normalized === null || normalized === undefined) continue;
        const other = factor === "date_of_birth" ? "zip" : "date_of_birth";
        const unchanged = body.normalizedFactors[factor] === normalized;
        const matchedBefore = (priorMatches[factor]?.length ?? 0) > 0;
        const priorCompanionAbsentOrWrong = body.normalizedFactors[other] === undefined || priorMatches[other]?.length === 0;
        if (unchanged && matchedBefore && priorCompanionAbsentOrWrong) {
          retained.add(factor);
        } else if (attempts[factor] >= 4) {
          const updatedAt = freshTime();
          await tx`UPDATE synthetic_verifications SET state='exhausted',protected_payload=${this.sql.json(this.protect(body, input.binding.scope, `verification:${input.verificationId}`, row.version + 1) as postgres.JSONValue)},version=${row.version + 1},updated_at=${updatedAt}::timestamptz WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND verification_id=${input.verificationId} AND version=${row.version}`;
          return { state: "exhausted", grant: null };
        }
      }
      const invalid = new Set<(typeof order)[number]>();
      for (const factor of order) {
        if (!proposed.has(factor)) continue;
        const normalized = proposed.get(factor);
        if (normalized === null || normalized === undefined) {
          delete normalizedFactors[factor];
          delete evidenceHashes[factor];
          invalid.add(factor);
          continue;
        }
        if (retained.has(factor)) continue;
        attempts[factor] += 1;
        normalizedFactors[factor] = normalized;
        evidenceHashes[factor] = this.digest({ verificationId: input.verificationId, factor, normalized, attempt: attempts[factor] });
      }
      const matches: Partial<Record<(typeof order)[number], string[]>> = {};
      for (const factor of order) {
        const value = normalizedFactors[factor];
        if (value !== undefined) matches[factor] = value === body.normalizedFactors[factor] && priorMatches[factor] !== undefined
          ? priorMatches[factor] : await this.matchFixturePatients(tx, input.binding.scope, factor, value);
      }
      const candidates = matches.date_of_birth === undefined ? matches.zip ?? []
        : matches.zip === undefined ? matches.date_of_birth
          : matches.date_of_birth.filter((patientId) => matches.zip!.includes(patientId));
      const next: VerificationBody = { attempts, candidates, evidenceHashes, normalizedFactors };
      const bothProvided = normalizedFactors.date_of_birth !== undefined && normalizedFactors.zip !== undefined
        && evidenceHashes.date_of_birth !== undefined && evidenceHashes.zip !== undefined;
      let nextFactor: (typeof order)[number];
      if (invalid.has("date_of_birth") || matches.date_of_birth === undefined || matches.date_of_birth.length === 0) {
        nextFactor = "date_of_birth";
      } else if (invalid.has("zip") || matches.zip === undefined || matches.zip.length === 0) {
        nextFactor = "zip";
      } else if (factors.length === 1) {
        const submitted = factors[0]!.factor;
        const other = submitted === "date_of_birth" ? "zip" : "date_of_birth";
        nextFactor = candidates.length === 0 ? other : submitted;
      } else {
        nextFactor = attempts.date_of_birth < 4 ? "date_of_birth" : "zip";
      }
      const exhausted = attempts[nextFactor] >= 4;
      const state: VerificationRow["state"] = invalid.size === 0 && bothProvided && candidates.length === 1 ? "verified" : exhausted ? "exhausted" : "pending";
      const updatedAt = freshTime();
      await tx`UPDATE synthetic_verifications SET state=${state},protected_payload=${this.sql.json(this.protect(next, input.binding.scope, `verification:${input.verificationId}`, row.version + 1) as postgres.JSONValue)},version=${row.version + 1},updated_at=${updatedAt}::timestamptz WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND verification_id=${input.verificationId} AND version=${row.version}`;
      if (state !== "verified") return { state, grant: null, ...(state === "pending" ? { nextFactor } : {}) };
      const patientId = candidates[0]!;
      const grant = this.derivedGrant(input.binding, input.verificationId, patientId, next, freshTime(), new Date(row.expires_at).toISOString(), row.version + 1);
      await this.persistGrantTx(tx, grant, input.trusted.expectedOwnerEpoch);
      freshTime();
      return { state, grant };
    });
  }

  async recordProposal(input: { trusted: F2TrustedConversationContext; requestKind: "office_visit"; proposal: SyntheticSlotProposal }): Promise<void> {
    if (input.requestKind !== "office_visit") throw new Error("synthetic_booking_request_kind_denied");
    const proposal = syntheticSlotProposalSchema.parse(input.proposal);
    await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, proposal.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, proposal.binding.scope);
      this.assertSchedulingRequest(current.request, proposal.operation, input.requestKind);
      this.assertBoundedExpiry(proposal.expiresAt, proposal.issuedAt, "synthetic_proposal_expiry_invalid");
      if (Date.parse(proposal.issuedAt) > this.now().getTime()) throw new Error("synthetic_proposal_not_issued");
      await this.assertProposalEligibility(tx, proposal, input.requestKind);
      await this.recordEvidenceTx(tx, { id: proposal.id, kind: "proposal", binding: proposal.binding, expiresAt: proposal.expiresAt, payload: proposal });
    });
  }

  /** Server-only discovery: never accepts a model-supplied patient or grant. */
  async currentGrant(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding }): Promise<SyntheticIdentityGrant | null> {
    return await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const rows = await tx<{ grant_id: string; version: number; protected_payload: unknown }[]>`SELECT grant_id,version,protected_payload FROM synthetic_sessions
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND revoked_at IS NULL AND expires_at>${this.now().toISOString()}::timestamptz
        ORDER BY expires_at DESC FOR UPDATE`;
      const grants = rows.map((row) => syntheticIdentityGrantSchema.parse(this.cipher.unprotect(row.protected_payload,
        { domain: "f2-synthetic-practice/v1", scope: input.binding.scope, row: `session:${row.grant_id}`, version: row.version })));
      if (new Set(grants.map((grant) => grant.patientId)).size > 1) throw new Error("synthetic_patient_selection_ambiguous");
      return grants[0] ?? null;
    });
  }

  async pendingVerification(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding }): Promise<string | null> {
    return await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const rows = await tx<{ verification_id: string }[]>`SELECT verification_id FROM synthetic_verifications
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND request_id=${input.binding.requestId}
          AND request_revision=${input.binding.requestRevision} AND owner_epoch=${input.trusted.expectedOwnerEpoch} AND state='pending' AND expires_at>${this.now().toISOString()}::timestamptz
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
      return rows[0]?.verification_id ?? null;
    });
  }

  async currentProposal(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding }): Promise<SyntheticSlotProposal | SyntheticAttendanceProposal | null> {
    return await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const rows = await tx<{ evidence_id: string; protected_payload: unknown }[]>`SELECT evidence_id,protected_payload FROM synthetic_evidence
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND request_id=${input.binding.requestId}
          AND request_revision=${input.binding.requestRevision} AND kind='proposal' AND consumed_by IS NULL AND expires_at>${this.now().toISOString()}::timestamptz
        ORDER BY created_at DESC LIMIT 2 FOR UPDATE`;
      if (rows.length > 1) throw new Error("synthetic_proposal_ambiguous");
      const row = rows[0];
      return row ? z.union([syntheticSlotProposalSchema, syntheticAttendanceProposalSchema]).parse(this.cipher.unprotect(row.protected_payload,
        this.evidenceBinding(input.binding.scope, row.evidence_id, "proposal"))) : null;
    });
  }

  /** Callback metadata can change request revision without changing the patient's appointment. Revalidate before reissuing. */
  async resumeAppointmentOffer(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; answerSourceId: string }): Promise<SyntheticSlotProposal | null> {
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      if (current.conversation.admission.channel !== "voice" || !isCallbackQuestion(current.conversation.pendingQuestion?.kind)) return null;
      this.requireCurrentAnswer(current, input.answerSourceId, "slot_selection");
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, this.now().toISOString());
      const rows = await tx<{ evidence_id: string }[]>`SELECT evidence_id FROM synthetic_evidence
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND request_id=${input.binding.requestId}
          AND request_revision<${input.binding.requestRevision} AND kind='proposal' AND consumed_by IS NULL
          AND expires_at>${this.now().toISOString()}::timestamptz ORDER BY created_at DESC LIMIT 2 FOR UPDATE`;
      if (rows.length !== 1) return null;
      const previous = await this.loadEvidence(tx, input.binding.scope, rows[0]!.evidence_id, "proposal", syntheticSlotProposalSchema);
      if (previous.patientId !== input.patientId) return null;
      this.assertSchedulingRequest(current.request, previous.operation, "office_visit");
      const proposal = syntheticSlotProposalSchema.parse({ ...previous, binding: input.binding, id: `proposal-${randomUUID()}`,
        directiveId: `directive-${randomUUID()}`, proposalRevision: previous.proposalRevision + 1, issuedAt: this.now().toISOString() });
      await this.assertProposalEligibility(tx, proposal, "office_visit");
      await this.recordEvidenceTx(tx, { id: proposal.id, kind: "proposal", binding: input.binding, expiresAt: proposal.expiresAt, payload: proposal });
      return proposal;
    });
  }

  async describeProposalText(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; proposalId: string; channel?: "voice" | "sms" }): Promise<string> {
    return await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, this.now().toISOString());
      const proposal = await this.loadEvidence(tx, input.binding.scope, input.proposalId, "proposal", z.union([syntheticSlotProposalSchema, syntheticAttendanceProposalSchema]));
      if (!sameRequestAuthority(proposal.binding, input.binding) || proposal.patientId !== input.patientId) throw new Error("synthetic_proposal_stale");
      let slotId: string, verb: string;
      if ("slots" in proposal) {
        if (proposal.slots.length !== 1) throw new Error("synthetic_exact_slot_consent_required");
        slotId = proposal.slots[0]!.id;
        await this.assertSelectedSlotEligibility(tx, proposal, slotId, "office_visit");
        verb = proposal.operation === "schedule" ? "schedule your appointment" : "move your appointment";
      } else {
        const appointment = await this.currentAppointment(tx, input.binding.scope, proposal.appointmentId);
        if (appointment.patient_id !== input.patientId || appointment.version !== proposal.appointmentVersion || appointment.state !== "scheduled") throw new Error("synthetic_appointment_version_conflict");
        slotId = appointment.slot_id; verb = "confirm you will attend your appointment";
      }
      const rows = await tx<{ starts_at: string | Date; clinic_timezone: string }[]>`SELECT s.starts_at,d.clinic_timezone FROM synthetic_slots s JOIN synthetic_datasets d USING(practice_id,dataset_id,generation)
        WHERE s.practice_id=${input.binding.scope.practiceId} AND s.dataset_id=${input.binding.scope.datasetId} AND s.generation=${input.binding.scope.generation} AND s.slot_id=${slotId}`;
      if (!rows[0]) throw new Error("synthetic_slot_not_found");
      const label = new Intl.DateTimeFormat("en-US", { timeZone: rows[0].clinic_timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(rows[0].starts_at));
      if (input.channel === "voice") {
        const action = "slots" in proposal
          ? proposal.operation === "schedule" ? `schedule your appointment for ${label}` : `move your appointment to ${label}`
          : `confirm you'll attend your appointment on ${label}`;
        return `Should I ${action}?`;
      }
      return `Would you like me to ${verb} for ${label}? Reply YES to confirm, or NO to choose another option. This uses test appointment information only.`;
    });
  }

  async describeProposalSlots(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; proposalId: string }): Promise<readonly { id: string; localTime: string }[]> {
    return await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, this.now().toISOString());
      const proposal = await this.loadEvidence(tx, input.binding.scope, input.proposalId, "proposal", syntheticSlotProposalSchema);
      if (!sameRequestAuthority(proposal.binding, input.binding) || proposal.patientId !== input.patientId
        || Date.parse(proposal.expiresAt) <= this.now().getTime()) throw new Error("synthetic_proposal_stale");
      const ids = proposal.slots.map((slot) => slot.id);
      const rows = await tx<{ slot_id: string; starts_at: string | Date; clinic_timezone: string }[]>`SELECT s.slot_id,s.starts_at,d.clinic_timezone
        FROM synthetic_slots s JOIN synthetic_datasets d USING(practice_id,dataset_id,generation)
        WHERE s.practice_id=${input.binding.scope.practiceId} AND s.dataset_id=${input.binding.scope.datasetId} AND s.generation=${input.binding.scope.generation}
          AND s.slot_id = ANY(${ids})`;
      const byId = new Map(rows.map((row) => [row.slot_id, row]));
      if (byId.size !== proposal.slots.length) throw new Error("synthetic_slot_not_found");
      return proposal.slots.map((slot) => {
        const row = byId.get(slot.id);
        if (!row || new Date(row.starts_at).getTime() !== Date.parse(slot.startsAt)) throw new Error("synthetic_slot_stale");
        return { id: slot.id, localTime: new Intl.DateTimeFormat("en-US", { timeZone: row.clinic_timezone, weekday: "long", year: "numeric",
          month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(row.starts_at)) };
      });
    });
  }

  /** Builds and persists at most two actual eligible slots; no offered facts come from the model. */
  async planAppointment(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; operation: "schedule" | "reschedule" | "attendance_confirm"; preference?: SchedulingPreference | null; answerSourceId?: string }, onOffer?: F2OfferPublisher): Promise<SyntheticSlotProposal | SyntheticAttendanceProposal> {
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      if (input.answerSourceId !== undefined) this.requireCurrentAnswer(current, input.answerSourceId, "slot_selection");
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const now = this.now().toISOString();
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, now);
      if (input.operation === "attendance_confirm") this.assertAttendanceRequest(current.request, "not_applicable");
      else this.assertSchedulingRequest(current.request, input.operation, "office_visit");
      const patient = await this.fixturePatient(tx, input.binding.scope, input.patientId);
      const appointments = input.operation === "schedule" ? [] : await tx<AppointmentRow[]>`SELECT appointment_id,patient_id,slot_id,state,attendance_version,version,protected_payload FROM synthetic_appointments
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND patient_id=${input.patientId} AND state='scheduled' ORDER BY appointment_id FOR UPDATE`;
      if (input.operation !== "schedule" && appointments.length !== 1) throw new Error("synthetic_appointment_selection_required");
      const original = appointments[0];
      const originalSlot = original === undefined ? undefined : (await tx<SlotRow[]>`SELECT slot_id,capacity,booked_count,version,protected_payload FROM synthetic_slots
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND slot_id=${original.slot_id} FOR UPDATE`)[0];
      const originalType = originalSlot === undefined ? null : fixtureSlotBodySchema.parse(this.cipher.unprotect(originalSlot.protected_payload,
        { domain: "f2-synthetic-practice/v1", scope: input.binding.scope, row: `slot:${originalSlot.slot_id}`, version: originalSlot.version })).appointmentType;
      if (input.operation === "reschedule" && originalType !== "office-followup") {
        throw new Error("synthetic_appointment_type_requires_staff");
      }
      const proposalId = `proposal-${randomUUID()}`, directiveId = `directive-${randomUUID()}`;
      const controlledTtlMs = input.operation === "attendance_confirm" ? null : await this.controlledOfferExpiry?.consume(tx, {
        conversation: current.conversation, binding: input.binding, trusted: input.trusted, grantId: input.grantId, proposalId,
      });
      const base = { id: proposalId, binding: input.binding, patientId: input.patientId, proposalRevision: current.request.revision,
        directiveId, issuedAt: now, expiresAt: new Date(this.now().getTime() + (controlledTtlMs ?? this.maxAuthorityTtlMs)).toISOString() };
      let proposal: SyntheticSlotProposal | SyntheticAttendanceProposal;
      if (input.operation === "attendance_confirm") {
        proposal = syntheticAttendanceProposalSchema.parse({ ...base, appointmentId: original!.appointment_id, appointmentVersion: original!.version,
          parameterHash: this.digest({ operation: input.operation, appointmentId: original!.appointment_id, version: original!.version }) });
      } else {
        const rows = await tx<(SlotRow & { starts_at: string | Date; ends_at: string | Date; clinic_timezone: string })[]>`SELECT s.slot_id,s.starts_at,s.ends_at,s.capacity,s.booked_count,s.version,s.protected_payload,d.clinic_timezone
          FROM synthetic_slots s JOIN synthetic_datasets d USING(practice_id,dataset_id,generation)
          WHERE s.practice_id=${input.binding.scope.practiceId} AND s.dataset_id=${input.binding.scope.datasetId} AND s.generation=${input.binding.scope.generation}
            AND s.starts_at>${now}::timestamptz AND s.booked_count<s.capacity ORDER BY s.starts_at,s.slot_id FOR UPDATE OF s`;
        const slots = rows.flatMap((row) => {
          const body = fixtureSlotBodySchema.parse(this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope: input.binding.scope, row: `slot:${row.slot_id}`, version: row.version }));
          if (!patient.eligibleAppointmentTypes.includes(body.appointmentType) || row.slot_id === original?.slot_id
            || originalType !== null && body.appointmentType !== originalType) return [];
          return [{ id: row.slot_id, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(), capacity: row.capacity, version: row.version, ...body,
            clinicTimeZone: row.clinic_timezone }];
        }).sort((a, b) => {
          const preference = input.preference;
          if (preference === undefined || preference === null) return a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);
          return preferenceMatch(b.startsAt, b.clinicTimeZone, preference) - preferenceMatch(a.startsAt, a.clinicTimeZone, preference)
            || a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);
        }).slice(0, 2).map(({ clinicTimeZone: _clinicTimeZone, ...slot }) => slot);
        if (!slots.length) throw new Error("synthetic_no_eligible_slots");
        proposal = syntheticSlotProposalSchema.parse({ ...base, operation: input.operation, appointmentId: original?.appointment_id ?? null,
          originalAppointmentVersion: original?.version ?? null, slots, parameterHash: this.digest({ operation: input.operation, appointmentId: original?.appointment_id ?? null, version: original?.version ?? null, slots }) });
      }
      await this.recordEvidenceTx(tx, { id: proposal.id, kind: "proposal", binding: proposal.binding, expiresAt: proposal.expiresAt, payload: proposal });
      await onOffer?.(tx, { current, proposal });
      return proposal;
    });
  }

  async selectAppointmentSlot(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; proposalId: string; slotId: string;
    answerSourceId?: string }): Promise<SyntheticSlotProposal> {
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      if (input.answerSourceId !== undefined) this.requireCurrentAnswer(current, input.answerSourceId, "slot_selection");
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      const now = this.now().toISOString();
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, now);
      const offered = await this.loadEvidence(tx, input.binding.scope, input.proposalId, "proposal", syntheticSlotProposalSchema);
      if (!sameRequestAuthority(offered.binding, input.binding) || offered.patientId !== input.patientId || Date.parse(offered.expiresAt) <= Date.parse(now)) throw new Error("synthetic_proposal_stale");
      this.assertSchedulingRequest(current.request, offered.operation, "office_visit");
      const slot = offered.slots.find((candidate) => candidate.id === input.slotId);
      if (!slot) throw new Error("synthetic_booking_slot_not_offered");
      const selected = syntheticSlotProposalSchema.parse({ ...offered, id: `proposal-${randomUUID()}`, directiveId: `directive-${randomUUID()}`,
        proposalRevision: offered.proposalRevision + 1, issuedAt: now, slots: [slot], parameterHash: this.digest({ offered: offered.parameterHash, slotId: slot.id }) });
      await this.assertSelectedSlotEligibility(tx, selected, slot.id, "office_visit");
      await this.recordEvidenceTx(tx, { id: selected.id, kind: "proposal", binding: selected.binding, expiresAt: selected.expiresAt, payload: selected });
      return selected;
    });
  }

  async recordAttendanceProposal(input: { trusted: F2TrustedConversationContext; proposal: SyntheticAttendanceProposal }): Promise<void> {
    const proposal = syntheticAttendanceProposalSchema.parse(input.proposal);
    await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, proposal.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, proposal.binding.scope);
      this.assertAttendanceRequest(current.request, "not_applicable");
      this.assertBoundedExpiry(proposal.expiresAt, proposal.issuedAt, "synthetic_attendance_proposal_expiry_invalid");
      if (Date.parse(proposal.issuedAt) > this.now().getTime()) throw new Error("synthetic_attendance_proposal_not_issued");
      const appointment = await this.currentAppointment(tx, proposal.binding.scope, proposal.appointmentId);
      if (appointment.patient_id !== proposal.patientId || appointment.state !== "scheduled" || appointment.version !== proposal.appointmentVersion) throw new Error("synthetic_appointment_version_conflict");
      await this.recordEvidenceTx(tx, { id: proposal.id, kind: "proposal", binding: proposal.binding, expiresAt: proposal.expiresAt, payload: proposal });
    });
  }

  /** Adapter-only ingress. The resolver, not this method's caller, supplies the signed/provider-authenticated payload. */
  async persistAdapterAuthority(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; receiptId: string }): Promise<void> {
    const raw = await this.authorityResolver.resolve(input.receiptId, input.binding);
    if (raw === null) throw new Error("synthetic_authorization_receipt_missing");
    const receipt = "hearing" in raw ? voiceProposalReadbackReceiptSchema.parse(raw) : smsProposalAcceptanceSchema.parse(raw);
    if (!sameRequestAuthority(receipt.binding, input.binding) || receipt.id !== input.receiptId) throw new Error("synthetic_authorization_binding_mismatch");
    const createdAt = "completedAt" in receipt ? receipt.completedAt : receipt.acceptedAt;
    this.assertBoundedExpiry(receipt.expiresAt, createdAt, "synthetic_authorization_expiry_invalid");
    if (Date.parse(createdAt) > this.now().getTime()) throw new Error("synthetic_authorization_not_issued");
    await this.sql.begin(async (tx) => {
      await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.recordEvidenceTx(tx, { id: receipt.id, kind: "hearing" in receipt ? "voice_authority" : "sms_authority", binding: receipt.binding, expiresAt: receipt.expiresAt, payload: receipt });
    });
  }

  /** Trusted voice-session ingress for exact transcript plus server audio completion. */
  async persistVoiceReadbackAuthority(input: { trusted: F2TrustedConversationContext; receipt: VoiceProposalReadbackReceipt }): Promise<void> {
    const receipt = voiceProposalReadbackReceiptSchema.parse(input.receipt);
    this.assertBoundedExpiry(receipt.expiresAt, receipt.completedAt, "synthetic_authorization_expiry_invalid");
    if (Date.parse(receipt.completedAt) > this.now().getTime()) throw new Error("synthetic_authorization_not_issued");
    await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, receipt.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, receipt.binding.scope);
      const proposal = await this.loadEvidence(tx, receipt.binding.scope, receipt.proposalId, "proposal", z.union([syntheticSlotProposalSchema, syntheticAttendanceProposalSchema]));
      this.requirePendingConsentQuestion(current.conversation, receipt.questionId, receipt.binding, proposal);
      if (!sameRequestAuthority(proposal.binding, receipt.binding) || proposal.patientId !== receipt.patientId
        || proposal.proposalRevision !== receipt.proposalRevision || proposal.directiveId !== receipt.directiveId
        || proposal.parameterHash !== receipt.parameterHash) throw new Error("synthetic_authorization_binding_mismatch");
      await this.recordEvidenceTx(tx, { id: receipt.id, kind: "voice_authority", binding: receipt.binding, expiresAt: receipt.expiresAt, payload: receipt });
    });
  }

  /** Reducer/transport trusted ingress only. Commit accepts this evidence ID, never caller-supplied consent fields. */
  async persistExactConsent(input: { trusted: F2TrustedConversationContext; consent: ExactConsent }): Promise<void> {
    const consent = exactConsentSchema.parse(input.consent);
    this.assertBoundedExpiry(consent.expiresAt, consent.receivedAt, "synthetic_consent_expiry_invalid");
    if (Date.parse(consent.receivedAt) > this.now().getTime()) throw new Error("synthetic_consent_not_issued");
    await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, consent.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, consent.binding.scope);
      if (consent.questionId !== undefined) this.requirePendingConsentQuestion(current.conversation, consent.questionId, consent.binding);
      await this.recordEvidenceTx(tx, { id: consent.id, kind: "consent", binding: consent.binding, expiresAt: consent.expiresAt, payload: consent });
    });
  }

  async read(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string; kind: TypedSyntheticReadKind; id: string; expiresAt: string }, onResult?: F2ReadResultPublisher): Promise<TypedSyntheticReadResult> {
    const kind = typedSyntheticReadKindSchema.parse(input.kind);
    const expiresAt = timestamp.parse(input.expiresAt);
    const now = this.now().toISOString();
    this.assertBoundedExpiry(expiresAt, now, "synthetic_read_expired");
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      this.assertReadRequest(current.request, kind);
      const session = await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, now);
      const rows = await tx<{ version: number; protected_payload: unknown }[]>`SELECT version,protected_payload FROM synthetic_patient_payloads
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND patient_id=${input.patientId} FOR UPDATE`;
      const row = rows[0]; if (row === undefined) throw new Error("synthetic_patient_not_found");
      const patient = fixturePatientBodySchema.parse(this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope: input.binding.scope, row: `patient:${input.patientId}`, version: row.version }));
      const value = kind === "appointment_details" ? await this.readAppointments(tx, input.binding.scope, input.patientId) : patient.values[kind];
      const resultHash = this.digest({ kind, patientId: input.patientId, version: row.version, value });
      const receipt = typedSyntheticReadReceiptSchema.parse({ id: input.id, binding: input.binding, patientId: input.patientId, grantId: input.grantId, kind,
        sourceVersion: row.version, sourceTimestamp: now, resultHash, receiptHash: this.digest({ id: input.id, resultHash, session: session.patient_id }), expiresAt });
      await this.recordEvidenceTx(tx, { id: receipt.id, kind: "read", binding: receipt.binding, expiresAt: receipt.expiresAt, payload: receipt });
      if (onResult) await onResult(tx, { receipt, current });
      return { receipt, value };
    });
  }

  async commitMutation(raw: F2Mutation, onResult?: F2MutationResultPublisher): Promise<SyntheticActionReceipt> {
    return await this.sql.begin(async (tx) => this.commitMutationInTransaction(tx, raw, onResult));
  }

  /** Reconstruct only still-current receipt-backed read facts; stale values are not carried into another turn. */
  async currentReadFacts(input: { trusted: F2TrustedConversationContext; binding: F2RequestBinding; patientId: string; grantId: string }): Promise<readonly { statement: string; receipt: TypedSyntheticReadReceipt }[]> {
    return await this.sql.begin(async (tx) => {
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, this.now().toISOString());
      const rows = await tx<{ protected_payload: unknown; evidence_id: string }[]>`SELECT protected_payload,evidence_id FROM synthetic_evidence
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND conversation_id=${input.binding.conversationId} AND instance_id=${input.binding.instanceId} AND request_id=${input.binding.requestId}
          AND kind='read' AND expires_at > ${this.now().toISOString()}::timestamptz ORDER BY created_at DESC LIMIT 16`;
      const patientRows = await tx<{ version: number; protected_payload: unknown }[]>`SELECT version,protected_payload FROM synthetic_patient_payloads
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND patient_id=${input.patientId} FOR UPDATE`;
      const patientRow = patientRows[0];
      if (!patientRow) return [];
      const patient = fixturePatientBodySchema.parse(this.cipher.unprotect(patientRow.protected_payload, { domain: "f2-synthetic-practice/v1", scope: input.binding.scope, row: `patient:${input.patientId}`, version: patientRow.version }));
      const facts: { statement: string; receipt: TypedSyntheticReadReceipt }[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const receipt = typedSyntheticReadReceiptSchema.parse(this.cipher.unprotect(row.protected_payload, this.evidenceBinding(input.binding.scope, row.evidence_id, "read")));
        if (!sameRequestAuthority(receipt.binding, input.binding) || receipt.patientId !== input.patientId || receipt.grantId !== input.grantId
          || receipt.kind !== current.request.fullProposal?.capability || seen.has(receipt.kind)) continue;
        const value = receipt.kind === "appointment_details" ? await this.readAppointments(tx, input.binding.scope, input.patientId) : patient.values[receipt.kind];
        if (receipt.resultHash !== this.digest({ kind: receipt.kind, patientId: input.patientId, version: patientRow.version, value })) continue;
        const statement = JSON.stringify({ kind: receipt.kind, value });
        if (statement.length > 2_000) continue;
        seen.add(receipt.kind);
        facts.push({ statement, receipt });
      }
      return facts;
    });
  }

  /** Caller controls the outer transaction and can publish a parent-owned resolution only after durable readback. */
  async commitMutationInTransaction(tx: Tx, raw: F2Mutation, onResult?: F2MutationResultPublisher): Promise<SyntheticActionReceipt> {
      const input = mutationSchema.parse(raw);
      const now = this.now().toISOString();
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["f2-action", input.binding.scope, input.idempotencyKey])},0))`;
      const replay = await tx<ActionRow[]>`SELECT action_id AS id,operation,request_revision,patient_id,input_hash,state,authorization_receipt_id,expires_at,protected_payload,version FROM synthetic_actions
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND idempotency_key=${input.idempotencyKey} FOR UPDATE`;
      if (replay[0] !== undefined) {
        if (replay[0].input_hash !== input.parameterHash) throw new Error("synthetic_action_idempotency_conflict");
        const receipt = this.unprotectAction(replay[0], input.binding.scope);
        if (!sameRequestAuthority(receipt.binding, input.binding) || receipt.patientId !== input.patientId || receipt.operation !== input.operation || receipt.parameterHash !== input.parameterHash) throw new Error("synthetic_action_replay_binding_conflict");
        return receipt;
      }
      const current = await this.requireConversationAuthority(tx, input.binding, input.trusted);
      await this.requireActiveDatasetTx(tx, input.binding.scope);
      await this.requireActiveSession(tx, input.binding, input.patientId, input.grantId, now);
      const proposal = input.operation === "attendance_confirm"
        ? await this.loadEvidence(tx, input.binding.scope, input.proposalId, "proposal", syntheticAttendanceProposalSchema)
        : await this.loadEvidence(tx, input.binding.scope, input.proposalId, "proposal", syntheticSlotProposalSchema);
      if (!sameRequestAuthority(proposal.binding, input.binding) || proposal.patientId !== input.patientId || proposal.parameterHash !== input.parameterHash || Date.parse(proposal.expiresAt) <= Date.parse(now)) throw new Error("synthetic_proposal_stale");
      if (input.operation === "attendance_confirm") this.assertAttendanceRequest(current.request, input.requestKind);
      else {
        this.assertSchedulingRequest(current.request, input.operation, input.requestKind as "office_visit");
        if ((proposal as SyntheticSlotProposal).slots.length !== 1) throw new Error("synthetic_exact_slot_consent_required");
        await this.assertSelectedSlotEligibility(tx, proposal as SyntheticSlotProposal, input.selectedSlotId, input.requestKind as "office_visit");
      }
      const consent = await this.loadConsent(tx, input.binding.scope, input.consentEvidenceId, now);
      const authorization = await this.loadAuthorization(tx, input.binding.scope, input.authorizationReceiptId, now);
      if (consent.questionId !== undefined) this.requirePendingConsentQuestion(current.conversation, consent.questionId, input.binding, proposal);
      if (consent.channel === "voice" && !("hearing" in authorization) || consent.channel === "sms" && "hearing" in authorization) throw new Error("synthetic_authorization_channel_mismatch");
      const decision = consent.channel === "voice"
        ? authorizeF2Write({ proposal, consent, voiceReadback: authorization as VoiceProposalReadbackReceipt, now })
        : authorizeF2Write({ proposal, consent, smsAcceptance: authorization as SmsProposalAcceptance, now });
      if (decision.kind !== "authorized" || decision.authorizationReceiptId !== input.authorizationReceiptId) throw new Error(`synthetic_write_${decision.kind === "denied" ? decision.reason : "authorization_mismatch"}`);
      const consumed = await tx`UPDATE synthetic_evidence SET consumed_by=${input.actionId} WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND evidence_id IN (${input.authorizationReceiptId},${input.consentEvidenceId}) AND consumed_by IS NULL`;
      if (consumed.count !== 2) throw new Error("synthetic_authorization_or_consent_consumed");
      const applied = input.operation === "attendance_confirm" ? await this.applyAttendanceMutation(tx, input, proposal as SyntheticAttendanceProposal) : await this.applyAppointmentMutation(tx, input, proposal as SyntheticSlotProposal);
      const receipt = syntheticActionReceiptSchema.parse({ id: input.actionId, sourceEventId: consent.sourceEventId, binding: input.binding, patientId: input.patientId, proposalId: input.operation === "attendance_confirm" ? null : input.proposalId,
        operation: input.operation, idempotencyKey: input.idempotencyKey, parameterHash: input.parameterHash, expectedAppointmentVersion: input.expectedAppointmentVersion,
        resultingAppointmentVersion: applied.version, state: "committed", authorizationReceiptId: input.authorizationReceiptId,
        authorizationExpiresAt: authorization.expiresAt, resultHash: applied.resultHash, readbackHash: applied.readbackHash, createdAt: now });
      await this.recordActionTx(tx, receipt, input.trusted.expectedOwnerEpoch);
      if (onResult !== undefined) await onResult(tx, { receipt, current });
      return receipt;
  }

  async resetDataset(scope: SyntheticDataset["scope"]): Promise<void> {
    await this.sql.begin(async (tx) => {
      await this.requireActiveDatasetTx(tx, scope);
      const activeSessions = await tx<{ grant_id: string }[]>`SELECT grant_id FROM synthetic_sessions WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND revoked_at IS NULL AND expires_at > ${this.now().toISOString()}::timestamptz FOR UPDATE`;
      const pendingVerifications = await tx<{ verification_id: string }[]>`SELECT verification_id FROM synthetic_verifications WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND state='pending' AND expires_at > ${this.now().toISOString()}::timestamptz FOR UPDATE`;
      if (activeSessions.length > 0 || pendingVerifications.length > 0) throw new Error("synthetic_dataset_reset_active_authority");
      await tx`UPDATE synthetic_datasets SET state='retired',version=version+1,updated_at=now() WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation}`;
    });
  }

  /** Called by the server-side patient-selection reducer before changing the selected patient. */
  async revokeConversationGrants(input: { scope: SyntheticDataset["scope"]; instanceId: string; conversationId: string; patientId?: string }): Promise<void> {
    await this.sql`UPDATE synthetic_sessions SET revoked_at=${this.now().toISOString()}::timestamptz,version=version+1
      WHERE practice_id=${input.scope.practiceId} AND dataset_id=${input.scope.datasetId} AND generation=${input.scope.generation}
        AND instance_id=${input.instanceId} AND conversation_id=${input.conversationId} AND revoked_at IS NULL
        AND (${input.patientId ?? null}::text IS NULL OR patient_id <> ${input.patientId ?? null})`;
  }

  async close(): Promise<void> { await this.sql.end({ timeout: 1 }); }

  private async assertActiveDataset(scope: SyntheticDataset["scope"]): Promise<void> { await this.requireActiveDatasetTx(this.sql, scope); }
  private async requireActiveDatasetTx(tx: Sql | Tx, scope: SyntheticDataset["scope"]): Promise<DatasetRow> {
    const rows = await tx<DatasetRow[]>`SELECT state,version,protected_payload FROM synthetic_datasets WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} FOR UPDATE`;
    if (rows[0]?.state !== "active") throw new Error("synthetic_dataset_inactive");
    return rows[0];
  }
  private async requireActiveSession(tx: Tx, binding: F2RequestBinding, patientId: string, grantId: string, now: string): Promise<SessionRow> {
    const rows = await tx<SessionRow[]>`SELECT patient_id,request_revision,expires_at,revoked_at,protected_payload FROM synthetic_sessions WHERE practice_id=${binding.scope.practiceId} AND dataset_id=${binding.scope.datasetId} AND generation=${binding.scope.generation} AND grant_id=${grantId} AND instance_id=${binding.instanceId} AND conversation_id=${binding.conversationId} FOR UPDATE`;
    const session = rows[0];
    if (session === undefined || session.patient_id !== patientId || session.revoked_at !== null || Date.parse(String(session.expires_at)) <= Date.parse(now)) throw new Error("synthetic_grant_stale");
    return session;
  }
  private async persistGrantTx(tx: Tx, grant: SyntheticIdentityGrant, ownerEpoch: number): Promise<void> {
    const payload = this.protect(grant, grant.binding.scope, `session:${grant.id}`, grant.version);
    await tx`INSERT INTO synthetic_sessions(practice_id,dataset_id,generation,grant_id,instance_id,conversation_id,request_id,request_revision,owner_epoch,patient_id,factor_evidence_hashes,expires_at,revoked_at,protected_payload,version)
      VALUES (${grant.binding.scope.practiceId},${grant.binding.scope.datasetId},${grant.binding.scope.generation},${grant.id},${grant.binding.instanceId},${grant.binding.conversationId},${grant.binding.requestId},${grant.binding.requestRevision},${ownerEpoch},${grant.patientId},${this.sql.json(grant.factorEvidenceHashes as postgres.JSONValue)},${grant.expiresAt}::timestamptz,NULL,${this.sql.json(payload as postgres.JSONValue)},${grant.version})`;
  }
  private async matchFixturePatients(tx: Tx, scope: SyntheticDataset["scope"], factor: "date_of_birth" | "zip", value: string): Promise<string[]> {
    const rows = await tx<{ patient_id: string; version: number; protected_payload: unknown }[]>`SELECT patient_id,version,protected_payload FROM synthetic_patient_payloads WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} FOR UPDATE`;
    return rows.flatMap((row) => {
      const body = fixturePatientBodySchema.parse(this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope, row: `patient:${row.patient_id}`, version: row.version }));
      return body.identity[factor === "date_of_birth" ? "dateOfBirth" : "zip"] === value ? [row.patient_id] : [];
    });
  }
  private async assertProposalEligibility(tx: Tx, proposal: SyntheticSlotProposal, requestKind: "office_visit"): Promise<void> {
    const patient = await this.fixturePatient(tx, proposal.binding.scope, proposal.patientId);
    const slots = await this.fixtureSlots(tx, proposal.binding.scope, proposal.slots.map((slot) => slot.id));
    for (const proposed of proposal.slots) {
      const actual = slots.get(proposed.id);
      if (actual === undefined || actual.appointmentType !== proposed.appointmentType || !patient.eligibleAppointmentTypes.includes(actual.appointmentType)) {
        throw new Error("synthetic_booking_slot_not_eligible");
      }
      if (actual.version !== proposed.version || actual.startsAt !== proposed.startsAt || actual.endsAt !== proposed.endsAt || actual.location !== proposed.location) {
        throw new Error("synthetic_slot_proposal_stale");
      }
    }
    if (requestKind !== "office_visit") throw new Error("synthetic_booking_request_kind_denied");
  }
  private assertReadRequest(request: Conversation["requests"][number], kind: TypedSyntheticReadKind): void {
    const capability = request.fullProposal?.capability;
    if (request.fullProposal === undefined || request.fullProposal.patientStatus !== "established" || capability !== kind) throw new Error("synthetic_read_request_denied");
  }
  private assertSchedulingRequest(request: Conversation["requests"][number], operation: "schedule" | "reschedule", requestKind: "office_visit"): void {
    const proposal: FullRequestProposal | undefined = request.fullProposal;
    const required = operation === "schedule" ? "appointment_schedule" : "appointment_reschedule";
    if (requestKind !== "office_visit" || proposal === undefined || proposal.capability !== required
      || proposal.patientStatus !== "established" || (proposal.schedulingKind !== "office_visit"
        && !(operation === "reschedule" && proposal.schedulingKind === "uncertain"))) {
      throw new Error("synthetic_booking_request_kind_denied");
    }
  }
  private assertAttendanceRequest(request: Conversation["requests"][number], requestKind: "office_visit" | "not_applicable"): void {
    const proposal = request.fullProposal;
    if (requestKind !== "not_applicable" || proposal?.capability !== "appointment_attendance_confirm" || proposal.patientStatus !== "established" || proposal.schedulingKind !== "not_applicable") {
      throw new Error("synthetic_attendance_request_denied");
    }
  }
  private async assertSelectedSlotEligibility(tx: Tx, proposal: SyntheticSlotProposal, selectedSlotId: string | null, requestKind: "office_visit"): Promise<void> {
    if (selectedSlotId === null || !proposal.slots.some((slot) => slot.id === selectedSlotId)) throw new Error("synthetic_booking_slot_not_offered");
    const slot = await tx<{ starts_at: string | Date }[]>`SELECT starts_at FROM synthetic_slots WHERE practice_id=${proposal.binding.scope.practiceId} AND dataset_id=${proposal.binding.scope.datasetId}
      AND generation=${proposal.binding.scope.generation} AND slot_id=${selectedSlotId} FOR UPDATE`;
    if (!slot[0] || new Date(slot[0].starts_at).getTime() <= this.now().getTime()) throw new Error("synthetic_slot_in_past");
    await this.assertProposalEligibility(tx, { ...proposal, slots: proposal.slots.filter((slot) => slot.id === selectedSlotId) }, requestKind);
  }
  private async applyAppointmentMutation(tx: Tx, input: F2Mutation, proposal: SyntheticSlotProposal): Promise<{ version: number; resultHash: string; readbackHash: string }> {
    const selectedSlotId = input.selectedSlotId;
    if (selectedSlotId === null) throw new Error("synthetic_booking_slot_not_offered");
    if (input.operation === "schedule") {
      if (input.expectedAppointmentVersion !== null || proposal.appointmentId !== null) throw new Error("synthetic_schedule_version_invalid");
      const slot = await this.lockSlots(tx, input.binding.scope, [selectedSlotId]);
      const selected = slot.get(selectedSlotId)!;
      if (selected.booked_count >= selected.capacity) throw new Error("synthetic_slot_capacity_conflict");
      const appointmentId = `appointment-${input.actionId}`;
      await this.changeSlotOccupancy(tx, input.binding.scope, selected, 1);
      const payload = this.protect({ patientId: input.patientId, slotId: selectedSlotId, state: "scheduled" }, input.binding.scope, `appointment:${appointmentId}`, 0);
      await tx`INSERT INTO synthetic_appointments(practice_id,dataset_id,generation,appointment_id,patient_id,slot_id,state,attendance_version,protected_payload,version)
        VALUES (${input.binding.scope.practiceId},${input.binding.scope.datasetId},${input.binding.scope.generation},${appointmentId},${input.patientId},${selectedSlotId},'scheduled',NULL,${this.sql.json(payload as postgres.JSONValue)},0)`;
      return this.readbackAppointment(tx, input.binding.scope, appointmentId, input.operation, input.parameterHash);
    }
    if (proposal.appointmentId === null || proposal.originalAppointmentVersion === null || input.expectedAppointmentVersion !== proposal.originalAppointmentVersion) throw new Error("synthetic_reschedule_version_invalid");
    const appointmentRows = await tx<AppointmentRow[]>`SELECT appointment_id,patient_id,slot_id,state,attendance_version,version,protected_payload FROM synthetic_appointments
      WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND appointment_id=${proposal.appointmentId} FOR UPDATE`;
    const appointment = appointmentRows[0];
    if (appointment === undefined || appointment.patient_id !== input.patientId || appointment.state !== "scheduled" || appointment.version !== input.expectedAppointmentVersion) throw new Error("synthetic_appointment_version_conflict");
    const slots = await this.lockSlots(tx, input.binding.scope, [appointment.slot_id, selectedSlotId]);
    const oldSlot = slots.get(appointment.slot_id)!;
    const selected = slots.get(selectedSlotId)!;
    if (selectedSlotId !== appointment.slot_id && selected.booked_count >= selected.capacity) throw new Error("synthetic_slot_capacity_conflict");
    if (selectedSlotId !== appointment.slot_id) {
      await this.changeSlotOccupancy(tx, input.binding.scope, oldSlot, -1);
      await this.changeSlotOccupancy(tx, input.binding.scope, selected, 1);
    }
    const version = appointment.version + 1;
    const payload = this.protect({ patientId: input.patientId, slotId: selectedSlotId, state: "scheduled" }, input.binding.scope, `appointment:${appointment.appointment_id}`, version);
    await tx`UPDATE synthetic_appointments SET slot_id=${selectedSlotId},attendance_version=NULL,protected_payload=${this.sql.json(payload as postgres.JSONValue)},version=${version}
      WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND appointment_id=${appointment.appointment_id} AND version=${appointment.version}`;
    return this.readbackAppointment(tx, input.binding.scope, appointment.appointment_id, input.operation, input.parameterHash);
  }
  private async applyAttendanceMutation(tx: Tx, input: F2Mutation, proposal: SyntheticAttendanceProposal): Promise<{ version: number; resultHash: string; readbackHash: string }> {
    if (input.selectedSlotId !== null || input.expectedAppointmentVersion !== proposal.appointmentVersion) throw new Error("synthetic_attendance_version_invalid");
    const rows = await tx<AppointmentRow[]>`SELECT appointment_id,patient_id,slot_id,state,attendance_version,version,protected_payload FROM synthetic_appointments WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND appointment_id=${proposal.appointmentId} FOR UPDATE`;
    const appointment = rows[0];
    if (appointment === undefined || appointment.patient_id !== input.patientId || appointment.state !== "scheduled" || appointment.version !== proposal.appointmentVersion) throw new Error("synthetic_appointment_version_conflict");
    const version = appointment.version + 1, attendanceVersion = (appointment.attendance_version ?? 0) + 1;
    const payload = this.protect({ patientId: input.patientId, slotId: appointment.slot_id, state: "scheduled", attendanceVersion }, input.binding.scope, `appointment:${appointment.appointment_id}`, version);
    await tx`UPDATE synthetic_appointments SET attendance_version=${attendanceVersion},protected_payload=${this.sql.json(payload as postgres.JSONValue)},version=${version} WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation} AND appointment_id=${appointment.appointment_id} AND version=${appointment.version}`;
    return this.readbackAppointment(tx, input.binding.scope, appointment.appointment_id, "attendance_confirm", input.parameterHash);
  }
  private async currentAppointment(tx: Tx, scope: SyntheticDataset["scope"], appointmentId: string): Promise<AppointmentRow> {
    const rows = await tx<AppointmentRow[]>`SELECT appointment_id,patient_id,slot_id,state,attendance_version,version,protected_payload FROM synthetic_appointments WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND appointment_id=${appointmentId} FOR UPDATE`;
    const appointment = rows[0]; if (appointment === undefined) throw new Error("synthetic_appointment_not_found");
    return appointment;
  }
  private async lockSlots(tx: Tx, scope: SyntheticDataset["scope"], slotIds: readonly string[]): Promise<Map<string, SlotRow>> {
    const rows = await tx<SlotRow[]>`SELECT slot_id,capacity,booked_count,version,protected_payload FROM synthetic_slots WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND slot_id = ANY(${[...new Set(slotIds)].sort()}) ORDER BY slot_id FOR UPDATE`;
    if (rows.length !== new Set(slotIds).size) throw new Error("synthetic_slot_not_found");
    return new Map(rows.map((row) => [row.slot_id, row]));
  }
  private async changeSlotOccupancy(tx: Tx, scope: SyntheticDataset["scope"], slot: SlotRow, delta: 1 | -1): Promise<void> {
    const body = this.cipher.unprotect(slot.protected_payload, { domain: "f2-synthetic-practice/v1", scope, row: `slot:${slot.slot_id}`, version: slot.version });
    const payload = this.protect(body, scope, `slot:${slot.slot_id}`, slot.version + 1);
    const changed = await tx`UPDATE synthetic_slots SET booked_count=booked_count+${delta},version=version+1,protected_payload=${this.sql.json(payload as postgres.JSONValue)}
      WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND slot_id=${slot.slot_id} AND version=${slot.version}
      AND booked_count+${delta} BETWEEN 0 AND capacity`;
    if (changed.count !== 1) throw new Error("synthetic_slot_capacity_conflict");
  }
  private async readAppointments(tx: Tx, scope: SyntheticDataset["scope"], patientId: string): Promise<unknown> {
    const rows = await tx<(AppointmentRow & { starts_at: string | Date; ends_at: string | Date; slot_version: number; slot_payload: unknown })[]>`
      SELECT a.appointment_id,a.patient_id,a.slot_id,a.state,a.attendance_version,a.version,a.protected_payload,s.starts_at,s.ends_at,s.version AS slot_version,s.protected_payload AS slot_payload
      FROM synthetic_appointments a JOIN synthetic_slots s USING(practice_id,dataset_id,generation,slot_id)
      WHERE a.practice_id=${scope.practiceId} AND a.dataset_id=${scope.datasetId} AND a.generation=${scope.generation} AND a.patient_id=${patientId} AND a.state='scheduled'
      ORDER BY s.starts_at,a.appointment_id`;
    return { appointments: rows.map((row) => {
      this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope, row: `appointment:${row.appointment_id}`, version: row.version });
      const slot = fixtureSlotBodySchema.parse(this.cipher.unprotect(row.slot_payload, { domain: "f2-synthetic-practice/v1", scope, row: `slot:${row.slot_id}`, version: row.slot_version }));
      return { appointmentId: row.appointment_id, slotId: row.slot_id, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString(),
        appointmentType: slot.appointmentType, location: slot.location, version: row.version, attendanceConfirmed: row.attendance_version !== null };
    }) };
  }
  private async readbackAppointment(tx: Tx, scope: SyntheticDataset["scope"], appointmentId: string, operation: "schedule" | "reschedule" | "attendance_confirm", parameterHash: string): Promise<{ version: number; resultHash: string; readbackHash: string }> {
    const rows = await tx<AppointmentRow[]>`SELECT appointment_id,patient_id,slot_id,state,attendance_version,version,protected_payload FROM synthetic_appointments WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND appointment_id=${appointmentId} FOR UPDATE`;
    const appointment = rows[0]; if (appointment === undefined || appointment.state !== "scheduled") throw new Error("synthetic_appointment_readback_missing");
    const canonical = { appointmentId: appointment.appointment_id, patientId: appointment.patient_id, slotId: appointment.slot_id, state: appointment.state, attendanceVersion: appointment.attendance_version, version: appointment.version };
    return { version: appointment.version, resultHash: this.digest({ operation, parameterHash, ...canonical }), readbackHash: this.digest(canonical) };
  }
  private async fixturePatient(tx: Tx, scope: SyntheticDataset["scope"], patientId: string): Promise<z.infer<typeof fixturePatientBodySchema>> {
    const rows = await tx<{ version: number; protected_payload: unknown }[]>`SELECT version,protected_payload FROM synthetic_patient_payloads WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND patient_id=${patientId} FOR UPDATE`;
    const row = rows[0]; if (row === undefined) throw new Error("synthetic_patient_not_found");
    return fixturePatientBodySchema.parse(this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope, row: `patient:${patientId}`, version: row.version }));
  }
  private async fixtureSlots(tx: Tx, scope: SyntheticDataset["scope"], ids: readonly string[]): Promise<Map<string, z.infer<typeof fixtureSlotBodySchema> & { version: number; startsAt: string; endsAt: string }>> {
    const rows = await tx<{ slot_id: string; version: number; starts_at: string | Date; ends_at: string | Date; protected_payload: unknown }[]>`SELECT slot_id,version,starts_at,ends_at,protected_payload FROM synthetic_slots WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND slot_id = ANY(${ids}) FOR UPDATE`;
    return new Map(rows.map((row) => [row.slot_id, { ...fixtureSlotBodySchema.parse(this.cipher.unprotect(row.protected_payload, { domain: "f2-synthetic-practice/v1", scope, row: `slot:${row.slot_id}`, version: row.version })),
      version: row.version, startsAt: new Date(row.starts_at).toISOString(), endsAt: new Date(row.ends_at).toISOString() }]));
  }
  private derivedGrant(binding: F2RequestBinding, verificationId: string, patientId: string, body: VerificationBody, issuedAt: string, expiresAt: string, version: number): SyntheticIdentityGrant {
    const dobHash = body.evidenceHashes.date_of_birth; const zipHash = body.evidenceHashes.zip;
    if (dobHash === undefined || zipHash === undefined) throw new Error("synthetic_verification_evidence_missing");
    return syntheticIdentityGrantSchema.parse({ id: `grant-${verificationId}`, binding, patientId, subjectHash: this.digest({ scope: binding.scope, patientId }), attempts: body.attempts,
      factorEvidenceIds: { date_of_birth: `${verificationId}:date_of_birth`, zip: `${verificationId}:zip` }, factorEvidenceHashes: { date_of_birth: dobHash, zip: zipHash }, authority: "code", issuedAt, expiresAt, version });
  }
  /** Parent owns the reducer; this store only fences durable operations against the current request revision. */
  private async requireConversationAuthority(tx: Tx, binding: F2RequestBinding, trusted: F2TrustedConversationContext): Promise<CurrentF2Request> {
    const identity = (await tx<ConversationRow[]>`SELECT instance_id,id,revision,contact_key,protected_state FROM voice_sms_conversations
      WHERE practice_id=${binding.scope.practiceId} AND instance_id=${binding.instanceId} AND id=${binding.conversationId}`)[0];
    if (identity === undefined) throw new Error("f2_conversation_not_found");
    // Match ConversationStore.execute: contact policy first, then the conversation row.
    const policy = (await tx<{ revision: number; suppressed: boolean }[]>`SELECT revision,suppressed FROM voice_sms_contact_policy WHERE contact_key=${identity.contact_key} FOR UPDATE`)[0];
    const row = (await tx<ConversationRow[]>`SELECT instance_id,id,revision,contact_key,protected_state FROM voice_sms_conversations
      WHERE practice_id=${binding.scope.practiceId} AND instance_id=${binding.instanceId} AND id=${binding.conversationId} FOR UPDATE`)[0];
    if (row === undefined || policy === undefined) throw new Error("f2_conversation_not_found");
    const conversation = conversationSchema.parse(this.cipher.unprotect(row.protected_state, {
      practiceId: binding.scope.practiceId, instanceId: binding.instanceId, conversationId: binding.conversationId,
      revision: row.revision, eventId: "snapshot", schemaVersion: 1,
    }));
    const request = conversation.requests.find((candidate) => candidate.id === binding.requestId);
    if (conversation.admission.mode !== "full" || conversation.phase !== "active" || conversation.owner !== "ai" || policy.suppressed
      || conversation.ownerEpoch !== trusted.expectedOwnerEpoch || request?.revision !== binding.requestRevision) {
      throw new Error("f2_conversation_authority_stale");
    }
    return { conversation, request };
  }
  /** Recheck the gateway's answer under the same conversation-row lock as the write. */
  private requireCurrentAnswer(current: CurrentF2Request, sourceId: string, family: "identity" | "slot_selection"): void {
    const { conversation, request } = current;
    const source = conversation.inputs.at(-1);
    const question = conversation.pendingQuestion;
    const matchingKind = family === "identity" ? question?.kind === "identity_dob" || question?.kind === "identity_zip"
      : question?.kind === "slot_selection" || conversation.admission.channel === "voice" && conversation.providerTier === "realtime"
        && isCallbackQuestion(question?.kind) && resumesOfferedAppointment(source?.body ?? "");
    if (!matchingKind || question?.requestId !== request.id || question.requestRevision !== request.revision
      || source?.id !== sourceId || source.questionId !== question.id || source.sequence <= question.activatedRevision
      || !request.sourceIds.includes(sourceId)) throw new Error("f2_answer_source_stale");
  }
  private requirePendingConsentQuestion(conversation: Conversation, questionId: string, binding: F2RequestBinding,
    proposal?: SyntheticSlotProposal | SyntheticAttendanceProposal): void {
    const question = conversation.pendingQuestion;
    const expectedKind = proposal === undefined ? null : "slots" in proposal ? "appointment_consent" : "attendance_consent";
    if (question?.id !== questionId || question.requestId !== binding.requestId || question.requestRevision !== binding.requestRevision
      || expectedKind !== null && question.kind !== expectedKind) throw new Error("synthetic_consent_question_stale");
  }
  private async loadEvidence<T>(tx: Tx, scope: SyntheticDataset["scope"], idValue: string, kind: EvidenceRow["kind"], schema: z.ZodType<T>): Promise<T> {
    const rows = await tx<EvidenceRow[]>`SELECT kind,protected_payload,expires_at,consumed_by FROM synthetic_evidence WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND evidence_id=${idValue} AND kind=${kind} FOR UPDATE`;
    if (rows[0] === undefined || rows[0].consumed_by !== null || Date.parse(String(rows[0].expires_at)) <= this.now().getTime()) throw new Error("synthetic_evidence_missing");
    return schema.parse(this.cipher.unprotect(rows[0].protected_payload, this.evidenceBinding(scope, idValue, kind)));
  }
  private async loadAuthorization(tx: Tx, scope: SyntheticDataset["scope"], idValue: string, now: string): Promise<StoredF2AuthorizationReceipt> {
    const rows = await tx<EvidenceRow[]>`SELECT kind,protected_payload,expires_at,consumed_by FROM synthetic_evidence WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND evidence_id=${idValue} AND kind IN ('voice_authority','sms_authority') FOR UPDATE`;
    const row = rows[0]; if (row === undefined || row.consumed_by !== null || Date.parse(String(row.expires_at)) <= Date.parse(now)) throw new Error("synthetic_authorization_receipt_invalid");
    const payload = this.cipher.unprotect(row.protected_payload, this.evidenceBinding(scope, idValue, row.kind));
    return row.kind === "voice_authority" ? voiceProposalReadbackReceiptSchema.parse(payload) : smsProposalAcceptanceSchema.parse(payload);
  }
  private async loadConsent(tx: Tx, scope: SyntheticDataset["scope"], idValue: string, now: string): Promise<ExactConsent> {
    const rows = await tx<EvidenceRow[]>`SELECT kind,protected_payload,expires_at,consumed_by FROM synthetic_evidence WHERE practice_id=${scope.practiceId} AND dataset_id=${scope.datasetId} AND generation=${scope.generation} AND evidence_id=${idValue} AND kind='consent' FOR UPDATE`;
    const row = rows[0];
    if (row === undefined || row.consumed_by !== null || Date.parse(String(row.expires_at)) <= Date.parse(now)) throw new Error("synthetic_consent_invalid");
    return exactConsentSchema.parse(this.cipher.unprotect(row.protected_payload, this.evidenceBinding(scope, idValue, "consent")));
  }
  private async recordEvidence(input: Evidence): Promise<void> { await this.sql.begin((tx) => this.recordEvidenceTx(tx, input)); }
  private async recordEvidenceTx(tx: Tx, input: Evidence): Promise<void> {
    this.assertBoundedExpiry(input.expiresAt, this.now().toISOString(), "synthetic_evidence_expiry_invalid");
    if (input.kind === "proposal") {
      await tx`UPDATE synthetic_evidence SET consumed_by=${`superseded:${input.id}`}
        WHERE practice_id=${input.binding.scope.practiceId} AND dataset_id=${input.binding.scope.datasetId} AND generation=${input.binding.scope.generation}
          AND instance_id=${input.binding.instanceId} AND conversation_id=${input.binding.conversationId} AND request_id=${input.binding.requestId}
          AND kind='proposal' AND consumed_by IS NULL`;
    }
    const payload = this.protect(input.payload, input.binding.scope, `evidence:${input.id}:${input.kind}`, 0);
    await tx`INSERT INTO synthetic_evidence(practice_id,dataset_id,generation,evidence_id,kind,instance_id,conversation_id,request_id,request_revision,protected_payload,created_at,expires_at,consumed_by)
      VALUES (${input.binding.scope.practiceId},${input.binding.scope.datasetId},${input.binding.scope.generation},${input.id},${input.kind},${input.binding.instanceId},${input.binding.conversationId},${input.binding.requestId},${input.binding.requestRevision},${this.sql.json(payload as postgres.JSONValue)},${this.now().toISOString()}::timestamptz,${input.expiresAt}::timestamptz,NULL)`;
  }
  private async recordActionTx(tx: Tx, receipt: SyntheticActionReceipt, ownerEpoch: number): Promise<void> {
    const payload = this.protect(receipt, receipt.binding.scope, `action:${receipt.id}`, 0);
    await tx`INSERT INTO synthetic_actions(practice_id,dataset_id,generation,action_id,instance_id,conversation_id,request_id,request_revision,owner_epoch,patient_id,operation,idempotency_key,input_hash,state,authorization_receipt_id,protected_payload,result_hash,readback_hash,expires_at,version,created_at)
      VALUES (${receipt.binding.scope.practiceId},${receipt.binding.scope.datasetId},${receipt.binding.scope.generation},${receipt.id},${receipt.binding.instanceId},${receipt.binding.conversationId},${receipt.binding.requestId},${receipt.binding.requestRevision},${ownerEpoch},${receipt.patientId},${receipt.operation},${receipt.idempotencyKey},${receipt.parameterHash},'committed',${receipt.authorizationReceiptId},${this.sql.json(payload as postgres.JSONValue)},${receipt.resultHash},${receipt.readbackHash},${receipt.authorizationExpiresAt}::timestamptz,0,${receipt.createdAt}::timestamptz)`;
  }
  private protect(value: unknown, scope: SyntheticDataset["scope"], row: string, version: number): object { return this.cipher.protect(value, { domain: "f2-synthetic-practice/v1", scope, row, version }); }
  private digest(value: unknown): string { return `sha256:${this.cipher.digest(value)}`; }
  private verificationBinding(scope: SyntheticDataset["scope"], verificationId: string, version: number) { return { domain: "f2-synthetic-practice/v1", scope, row: `verification:${verificationId}`, version }; }
  private evidenceBinding(scope: SyntheticDataset["scope"], idValue: string, kind: EvidenceRow["kind"]) { return { domain: "f2-synthetic-practice/v1", scope, row: `evidence:${idValue}:${kind}`, version: 0 }; }
  private actionBinding(scope: SyntheticDataset["scope"], idValue: string, operation: string, version: number) { return { domain: "f2-synthetic-practice/v1", scope, row: `action:${idValue}`, version }; }
  private unprotectAction(row: ActionRow, scope: SyntheticDataset["scope"]): SyntheticActionReceipt { return syntheticActionReceiptSchema.parse(this.cipher.unprotect(row.protected_payload, this.actionBinding(scope, row.id, row.operation, 0))); }
  private assertBoundedExpiry(expiresAt: string, issuedAt: string, code: string): void {
    const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
    if (!Number.isFinite(duration) || duration <= 0 || duration > this.maxAuthorityTtlMs) throw new Error(code);
  }
}

type Evidence = { id: string; kind: EvidenceRow["kind"]; binding: F2RequestBinding; expiresAt: string; payload: unknown };
type VerificationBody = { attempts: { date_of_birth: number; zip: number }; candidates: string[] | null; evidenceHashes: Partial<Record<"date_of_birth" | "zip", string>>; normalizedFactors: Partial<Record<"date_of_birth" | "zip", string>> };
const identityFactorBatchSchema = z.array(z.object({ factor: z.enum(["date_of_birth", "zip"]), value: z.string().trim().min(1).max(2_000) }).strict()).min(1).max(2)
  .refine((factors) => new Set(factors.map((item) => item.factor)).size === factors.length, "identity_factor_duplicate");
const verificationBodySchema = z.object({ attempts: z.object({ date_of_birth: z.number().int().min(0).max(4), zip: z.number().int().min(0).max(4) }).strict(), candidates: z.array(id).nullable(), evidenceHashes: z.object({ date_of_birth: hash.optional(), zip: hash.optional() }).strict(), normalizedFactors: z.object({ date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), zip: z.string().regex(/^\d{5}$/).optional() }).strict() }).strict();
const mutationSchema = z.object({ actionId: id, trusted: z.object({ expectedOwnerEpoch: z.number().int().nonnegative() }).strict(), binding: f2RequestBindingSchema, patientId: id, grantId: id, proposalId: id, consentEvidenceId: id, authorizationReceiptId: id, operation: z.enum(["schedule", "reschedule", "attendance_confirm"]), requestKind: z.enum(["office_visit", "not_applicable"]), selectedSlotId: id.nullable(), idempotencyKey: id, parameterHash: hash, expectedAppointmentVersion: z.number().int().nonnegative().nullable() }).strict();
