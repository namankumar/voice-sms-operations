import { createHash } from "node:crypto";

import { capabilitySchema } from "@salven/contracts";
import { z } from "zod";

const idSchema = z.string().min(3).max(160);
const timestampSchema = z.string().datetime({ offset: true });
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const intergyOperationSchema = z.enum([
  "appointment.details.read",
  "appointment.availability.read",
  "appointment.schedule",
  "appointment.move",
]);
export type IntergyOperation = z.infer<typeof intergyOperationSchema>;

export const executionAuthorizationSchema = z
  .object({
    kind: z.literal("consumed_validated_execution_authorization"),
    authorizationId: idSchema,
    permitId: idSchema,
    actionRequestId: idSchema,
    caseId: idSchema,
    policyDecisionId: idSchema,
    practiceId: idSchema,
    capability: capabilitySchema,
    subjectId: idSchema.nullable(),
    parameterHash: hashSchema,
    stateVersion: z.number().int().nonnegative(),
    consumedAt: timestampSchema,
    validatedAt: timestampSchema,
    executionExpiresAt: timestampSchema,
    validationEvidenceId: idSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const consumedAt = new Date(value.consumedAt).getTime();
    const validatedAt = new Date(value.validatedAt).getTime();
    const expiresAt = new Date(value.executionExpiresAt).getTime();
    if (validatedAt < consumedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "authorization_validated_before_consumption" });
    }
    if (expiresAt <= validatedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "authorization_expired_before_validation" });
    }
  });
export type ExecutionAuthorization = z.infer<typeof executionAuthorizationSchema>;

export interface ExecutionAuthorizationAuthority {
  resolve(candidate: unknown): ExecutionAuthorization | null;
  currentStateVersion(practiceId: string, caseId: string): number | null;
}

export const appointmentStatusSchema = z.enum(["scheduled", "cancelled"]);
export const syntheticAppointmentSchema = z
  .object({
    id: idSchema,
    practiceId: idSchema,
    patientId: idSchema,
    providerId: idSchema,
    locationId: idSchema,
    appointmentType: z.string().min(1).max(120),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    status: appointmentStatusSchema,
    slotId: idSchema,
    version: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();
export type SyntheticAppointment = z.infer<typeof syntheticAppointmentSchema>;

export const slotStatusSchema = z.enum(["available", "booked"]);
export const syntheticAvailabilitySlotSchema = z
  .object({
    id: idSchema,
    practiceId: idSchema,
    providerId: idSchema,
    locationId: idSchema,
    appointmentType: z.string().min(1).max(120),
    startsAt: timestampSchema,
    endsAt: timestampSchema,
    status: slotStatusSchema,
    bookedAppointmentId: idSchema.nullable(),
    version: z.number().int().positive(),
    updatedAt: timestampSchema,
  })
  .strict();
export type SyntheticAvailabilitySlot = z.infer<typeof syntheticAvailabilitySlotSchema>;

export const appointmentDetailsParametersSchema = z
  .object({ appointmentId: idSchema })
  .strict();
export type AppointmentDetailsParameters = z.infer<typeof appointmentDetailsParametersSchema>;

export const appointmentAvailabilityParametersSchema = z
  .object({
    patientId: idSchema.nullable(),
    appointmentType: z.string().min(1).max(120),
    providerIds: z.array(idSchema).max(50),
    locationIds: z.array(idSchema).max(50),
    startsOnOrAfter: timestampSchema,
    startsBefore: timestampSchema,
  })
  .strict()
  .refine((value) => new Date(value.startsOnOrAfter) < new Date(value.startsBefore), {
    message: "availability_window_invalid",
  });
export type AppointmentAvailabilityParameters = z.infer<typeof appointmentAvailabilityParametersSchema>;

export const appointmentScheduleParametersSchema = z
  .object({
    patientId: idSchema,
    slotId: idSchema,
    expectedSlotVersion: z.number().int().positive(),
  })
  .strict();
export type AppointmentScheduleParameters = z.infer<typeof appointmentScheduleParametersSchema>;

export const appointmentMoveParametersSchema = z
  .object({
    appointmentId: idSchema,
    targetSlotId: idSchema,
    expectedAppointmentVersion: z.number().int().positive(),
    expectedTargetSlotVersion: z.number().int().positive(),
  })
  .strict();
export type AppointmentMoveParameters = z.infer<typeof appointmentMoveParametersSchema>;

export const intergyReceiptSchema = z
  .object({
    id: idSchema,
    providerRequestId: idSchema,
    practiceId: idSchema,
    operation: intergyOperationSchema,
    actionRequestId: idSchema,
    authorizationId: idSchema,
    idempotencyKey: z.string().min(8).max(200),
    requestHash: hashSchema,
    outcome: z.enum(["read", "applied"]),
    resourceIds: z.array(idSchema),
    resourceVersions: z.record(z.string(), z.number().int().positive()),
    receivedAt: timestampSchema,
    completedAt: timestampSchema,
  })
  .strict();
export type IntergyReceipt = z.infer<typeof intergyReceiptSchema>;

const readbackBaseSchema = z.object({
  providerReadId: idSchema,
  practiceId: idSchema,
  readAt: timestampSchema,
});

export const appointmentReadbackSchema = readbackBaseSchema
  .extend({
    kind: z.literal("appointment"),
    appointment: syntheticAppointmentSchema,
  })
  .strict();
export type AppointmentReadback = z.infer<typeof appointmentReadbackSchema>;

export const availabilityReadbackSchema = readbackBaseSchema
  .extend({
    kind: z.literal("availability"),
    slots: z.array(syntheticAvailabilitySlotSchema),
  })
  .strict();
export type AvailabilityReadback = z.infer<typeof availabilityReadbackSchema>;

export const mutationReadbackSchema = readbackBaseSchema
  .extend({
    kind: z.literal("appointment_mutation"),
    appointment: syntheticAppointmentSchema,
    affectedSlots: z.array(syntheticAvailabilitySlotSchema).min(1),
  })
  .strict();
export type MutationReadback = z.infer<typeof mutationReadbackSchema>;

export type IntergyReadback = AppointmentReadback | AvailabilityReadback | MutationReadback;

export interface IntergySuccess<TReadback extends IntergyReadback> {
  kind: "success";
  operation: IntergyOperation;
  idempotencyStatus: "executed" | "replayed";
  receipt: IntergyReceipt;
  readback: TReadback;
}

export interface AuthorizedIntergyRequest<TParameters> {
  authorization: unknown;
  idempotencyKey: string;
  parameters: TParameters;
}

export const intergyFailureModeSchema = z.enum([
  "stale",
  "timeout_before_response",
  "timeout_before_write",
  "timeout_after_possible_write",
  "duplicate",
  "mismatch",
  "partial_failure",
]);
export type IntergyFailureMode = z.infer<typeof intergyFailureModeSchema>;

export type IntergyErrorCode =
  | "authorization_required"
  | "authorization_invalid"
  | "authorization_expired"
  | "authorization_scope_mismatch"
  | "authorization_parameter_mismatch"
  | "authorization_reuse_mismatch"
  | "idempotency_key_mismatch"
  | "execution_in_progress"
  | "resource_not_found"
  | "stale_state"
  | "timeout_read"
  | "timeout_before_write"
  | "timeout_after_possible_write"
  | "duplicate_response"
  | "readback_mismatch"
  | "partial_failure";

export type IntergyOutcomeCertainty =
  | "not_written"
  | "read_failed"
  | "written_unverified"
  | "partially_written";

export class IntergySimulatorError extends Error {
  override readonly name = "IntergySimulatorError";

  constructor(
    readonly code: IntergyErrorCode,
    readonly operation: IntergyOperation,
    readonly certainty: IntergyOutcomeCertainty,
    readonly providerRequestId: string | null = null,
    readonly receipt: IntergyReceipt | null = null,
    readonly readback: IntergyReadback | null = null,
  ) {
    super(code);
  }
}

export function hashIntergyParameters(parameters: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(parameters)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_parameter");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported_parameter_value");
}
