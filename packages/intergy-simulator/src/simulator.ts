import { z } from "zod";

import {
  appointmentAvailabilityParametersSchema,
  appointmentDetailsParametersSchema,
  appointmentMoveParametersSchema,
  appointmentReadbackSchema,
  appointmentScheduleParametersSchema,
  availabilityReadbackSchema,
  executionAuthorizationSchema,
  hashIntergyParameters,
  intergyFailureModeSchema,
  intergyReceiptSchema,
  IntergySimulatorError,
  mutationReadbackSchema,
  syntheticAppointmentSchema,
  syntheticAvailabilitySlotSchema,
  type AppointmentAvailabilityParameters,
  type AppointmentDetailsParameters,
  type AppointmentMoveParameters,
  type AppointmentReadback,
  type AppointmentScheduleParameters,
  type AuthorizedIntergyRequest,
  type AvailabilityReadback,
  type ExecutionAuthorization,
  type ExecutionAuthorizationAuthority,
  type IntergyFailureMode,
  type IntergyOperation,
  type IntergyReadback,
  type IntergyReceipt,
  type IntergySuccess,
  type MutationReadback,
  type SyntheticAppointment,
  type SyntheticAvailabilitySlot,
} from "./contracts.js";
import {
  cloneDeterministicIntergyFixtures,
  type IntergySimulatorFixtures,
} from "./fixtures.js";

const idempotencyKeySchema = z.string().min(8).max(200);
const mutationOperations = new Set<IntergyOperation>(["appointment.schedule", "appointment.move"]);

interface IdempotencyRecord<TReadback extends IntergyReadback = IntergyReadback> {
  requestHash: string;
  result?: IntergySuccess<TReadback>;
  error?: IntergySimulatorError;
}

interface AuthorizationUse {
  authorizationHash: string;
  operation: IntergyOperation;
  requestHash: string;
  idempotencyKey: string;
}

interface QueuedFailure {
  mode: IntergyFailureMode;
  remaining: number;
}

export interface IntergySimulatorOptions {
  fixtures?: IntergySimulatorFixtures;
  now?: () => Date;
  authorizationAuthority: ExecutionAuthorizationAuthority;
}

export interface IntergySimulatorSnapshot {
  appointments: readonly SyntheticAppointment[];
  slots: readonly SyntheticAvailabilitySlot[];
}

/** Synthetic-only adapter. It has no transport, credentials, or policy-issuance capability. */
export class StatefulIntergySimulator {
  private readonly appointments = new Map<string, SyntheticAppointment>();
  private readonly slots = new Map<string, SyntheticAvailabilitySlot>();
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private readonly authorizationUses = new Map<string, AuthorizationUse>();
  private readonly failures = new Map<IntergyOperation, QueuedFailure[]>();
  private readonly now: () => Date;
  private readonly authorizationAuthority: ExecutionAuthorizationAuthority;
  private sequence = 0;

  constructor(options: IntergySimulatorOptions) {
    if (options.authorizationAuthority === undefined) {
      throw new Error("execution_authorization_authority_required");
    }
    this.authorizationAuthority = options.authorizationAuthority;
    this.now = options.now ?? (() => new Date("2030-01-05T12:00:00.000Z"));
    const fixtures = options.fixtures ?? cloneDeterministicIntergyFixtures();
    for (const appointment of fixtures.appointments) {
      const parsed = syntheticAppointmentSchema.parse(appointment);
      this.appointments.set(this.key(parsed.practiceId, parsed.id), parsed);
    }
    for (const slot of fixtures.slots) {
      const parsed = syntheticAvailabilitySlotSchema.parse(slot);
      this.slots.set(this.key(parsed.practiceId, parsed.id), parsed);
    }
  }

  injectFailure(operation: IntergyOperation, mode: IntergyFailureMode, count = 1): void {
    intergyFailureModeSchema.parse(mode);
    if (!Number.isInteger(count) || count < 1) throw new Error("failure_count_invalid");
    if (mode === "timeout_before_response" && mutationOperations.has(operation)) {
      throw new Error(`failure_mode_not_supported:${operation}:${mode}`);
    }
    if ((mode === "timeout_before_write" || mode === "timeout_after_possible_write") && !mutationOperations.has(operation)) {
      throw new Error(`failure_mode_not_supported:${operation}:${mode}`);
    }
    const queue = this.failures.get(operation) ?? [];
    queue.push({ mode, remaining: count });
    this.failures.set(operation, queue);
  }

  readAppointment(
    request: AuthorizedIntergyRequest<AppointmentDetailsParameters>,
  ): IntergySuccess<AppointmentReadback> {
    const operation = "appointment.details.read" as const;
    const parameters = appointmentDetailsParametersSchema.parse(request.parameters);
    const authorization = this.authorize(request, operation, parameters);
    const appointment = this.findAppointment(authorization.practiceId, parameters.appointmentId, operation);
    this.assertSubject(authorization, appointment.patientId, operation);
    const providerRequestId = this.nextId("intergy-request");
    const failure = this.takeFailure(operation);

    if (failure === "timeout_before_response") {
      throw new IntergySimulatorError("timeout_read", operation, "read_failed", providerRequestId);
    }
    if (failure === "stale") {
      const stale = { ...appointment, version: Math.max(1, appointment.version - 1) };
      const readback = this.appointmentReadback(authorization.practiceId, stale);
      throw new IntergySimulatorError("stale_state", operation, "read_failed", providerRequestId, null, readback);
    }
    if (failure === "duplicate") {
      throw new IntergySimulatorError("duplicate_response", operation, "read_failed", providerRequestId);
    }
    if (failure === "partial_failure") {
      throw new IntergySimulatorError("partial_failure", operation, "read_failed", providerRequestId);
    }
    if (failure === "mismatch") {
      const mismatch = { ...appointment, id: "appointment-mismatch" };
      const readback = this.appointmentReadback(authorization.practiceId, mismatch);
      throw new IntergySimulatorError("readback_mismatch", operation, "read_failed", providerRequestId, null, readback);
    }

    const readback = this.appointmentReadback(authorization.practiceId, appointment);
    const receipt = this.receipt({
      authorization,
      operation,
      idempotencyKey: request.idempotencyKey,
      providerRequestId,
      parameters,
      outcome: "read",
      resources: [appointment],
    });
    return { kind: "success", operation, idempotencyStatus: "executed", receipt, readback };
  }

  readAvailability(
    request: AuthorizedIntergyRequest<AppointmentAvailabilityParameters>,
  ): IntergySuccess<AvailabilityReadback> {
    const operation = "appointment.availability.read" as const;
    const parameters = appointmentAvailabilityParametersSchema.parse(request.parameters);
    const authorization = this.authorize(request, operation, parameters);
    this.assertSubject(authorization, parameters.patientId, operation);
    const providerRequestId = this.nextId("intergy-request");
    const slots = [...this.slots.values()]
      .filter((slot) => slot.practiceId === authorization.practiceId)
      .filter((slot) => slot.status === "available")
      .filter((slot) => slot.appointmentType === parameters.appointmentType)
      .filter((slot) => parameters.providerIds.length === 0 || parameters.providerIds.includes(slot.providerId))
      .filter((slot) => parameters.locationIds.length === 0 || parameters.locationIds.includes(slot.locationId))
      .filter((slot) => slot.startsAt >= parameters.startsOnOrAfter && slot.startsAt < parameters.startsBefore)
      .sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id));
    const failure = this.takeFailure(operation);

    if (failure === "timeout_before_response") {
      throw new IntergySimulatorError("timeout_read", operation, "read_failed", providerRequestId);
    }
    if (failure === "stale") {
      const staleSlots = slots.map((slot) => ({ ...slot, version: Math.max(1, slot.version - 1) }));
      const readback = this.availabilityReadback(authorization.practiceId, staleSlots);
      throw new IntergySimulatorError("stale_state", operation, "read_failed", providerRequestId, null, readback);
    }
    if (failure === "duplicate") {
      const first = slots[0];
      const duplicated = first === undefined ? slots : [first, first, ...slots.slice(1)];
      const readback = this.availabilityReadback(authorization.practiceId, duplicated);
      throw new IntergySimulatorError("duplicate_response", operation, "read_failed", providerRequestId, null, readback);
    }
    if (failure === "partial_failure") {
      const readback = this.availabilityReadback(authorization.practiceId, slots.slice(0, 1));
      throw new IntergySimulatorError("partial_failure", operation, "read_failed", providerRequestId, null, readback);
    }
    if (failure === "mismatch") {
      const sameTenantSlot = slots[0];
      const readback = this.availabilityReadback(
        authorization.practiceId,
        sameTenantSlot === undefined ? [] : [{ ...sameTenantSlot, id: "slot-mismatch" }],
      );
      throw new IntergySimulatorError("readback_mismatch", operation, "read_failed", providerRequestId, null, readback);
    }

    const readback = this.availabilityReadback(authorization.practiceId, slots);
    const receipt = this.receipt({
      authorization,
      operation,
      idempotencyKey: request.idempotencyKey,
      providerRequestId,
      parameters,
      outcome: "read",
      resources: slots,
    });
    return { kind: "success", operation, idempotencyStatus: "executed", receipt, readback };
  }

  scheduleAppointment(
    request: AuthorizedIntergyRequest<AppointmentScheduleParameters>,
  ): IntergySuccess<MutationReadback> {
    const operation = "appointment.schedule" as const;
    const parameters = appointmentScheduleParametersSchema.parse(request.parameters);
    const authorization = this.authorize(request, operation, parameters);
    this.assertSubject(authorization, parameters.patientId, operation);
    return this.mutate(request.idempotencyKey, authorization, operation, parameters, () => {
      const slot = this.findSlot(authorization.practiceId, parameters.slotId, operation);
      if (slot.status !== "available" || slot.version !== parameters.expectedSlotVersion) {
        throw new IntergySimulatorError("stale_state", operation, "not_written");
      }
      const failure = this.takeFailure(operation);
      const providerRequestId = this.nextId("intergy-request");
      this.throwPreWriteFailure(failure, operation, providerRequestId);

      const appointment = syntheticAppointmentSchema.parse({
        id: this.nextId("appointment-sim"),
        practiceId: authorization.practiceId,
        patientId: parameters.patientId,
        providerId: slot.providerId,
        locationId: slot.locationId,
        appointmentType: slot.appointmentType,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        status: "scheduled",
        slotId: slot.id,
        version: 1,
        updatedAt: this.timestamp(),
      });
      const bookedSlot = syntheticAvailabilitySlotSchema.parse({
        ...slot,
        status: "booked",
        bookedAppointmentId: appointment.id,
        version: slot.version + 1,
        updatedAt: this.timestamp(),
      });

      if (failure === "duplicate") {
        throw new IntergySimulatorError("duplicate_response", operation, "not_written", providerRequestId);
      }
      this.appointments.set(this.key(appointment.practiceId, appointment.id), appointment);
      if (failure !== "partial_failure") {
        this.slots.set(this.key(bookedSlot.practiceId, bookedSlot.id), bookedSlot);
      }
      const actualSlot = failure === "partial_failure" ? slot : bookedSlot;
      const receipt = this.receipt({
        authorization,
        operation,
        idempotencyKey: request.idempotencyKey,
        providerRequestId,
        parameters,
        outcome: "applied",
        resources: [appointment, actualSlot],
      });
      const readback = this.mutationReadback(
        authorization.practiceId,
        failure === "mismatch" ? { ...appointment, slotId: "slot-mismatch" } : appointment,
        [actualSlot],
      );
      this.throwPostWriteFailure(failure, operation, providerRequestId, receipt, readback);
      return { kind: "success", operation, idempotencyStatus: "executed", receipt, readback };
    });
  }

  moveAppointment(
    request: AuthorizedIntergyRequest<AppointmentMoveParameters>,
  ): IntergySuccess<MutationReadback> {
    const operation = "appointment.move" as const;
    const parameters = appointmentMoveParametersSchema.parse(request.parameters);
    const authorization = this.authorize(request, operation, parameters);
    const appointment = this.findAppointment(authorization.practiceId, parameters.appointmentId, operation);
    this.assertSubject(authorization, appointment.patientId, operation);
    return this.mutate(request.idempotencyKey, authorization, operation, parameters, () => {
      const current = this.findAppointment(authorization.practiceId, parameters.appointmentId, operation);
      const oldSlot = this.findSlot(authorization.practiceId, current.slotId, operation);
      const targetSlot = this.findSlot(authorization.practiceId, parameters.targetSlotId, operation);
      if (
        current.version !== parameters.expectedAppointmentVersion ||
        targetSlot.version !== parameters.expectedTargetSlotVersion ||
        targetSlot.status !== "available"
      ) {
        throw new IntergySimulatorError("stale_state", operation, "not_written");
      }
      const failure = this.takeFailure(operation);
      const providerRequestId = this.nextId("intergy-request");
      this.throwPreWriteFailure(failure, operation, providerRequestId);
      if (failure === "duplicate") {
        throw new IntergySimulatorError("duplicate_response", operation, "not_written", providerRequestId);
      }

      const moved = syntheticAppointmentSchema.parse({
        ...current,
        providerId: targetSlot.providerId,
        locationId: targetSlot.locationId,
        appointmentType: targetSlot.appointmentType,
        startsAt: targetSlot.startsAt,
        endsAt: targetSlot.endsAt,
        slotId: targetSlot.id,
        version: current.version + 1,
        updatedAt: this.timestamp(),
      });
      const releasedOldSlot = syntheticAvailabilitySlotSchema.parse({
        ...oldSlot,
        status: "available",
        bookedAppointmentId: null,
        version: oldSlot.version + 1,
        updatedAt: this.timestamp(),
      });
      const bookedTargetSlot = syntheticAvailabilitySlotSchema.parse({
        ...targetSlot,
        status: "booked",
        bookedAppointmentId: moved.id,
        version: targetSlot.version + 1,
        updatedAt: this.timestamp(),
      });
      this.appointments.set(this.key(moved.practiceId, moved.id), moved);
      this.slots.set(this.key(bookedTargetSlot.practiceId, bookedTargetSlot.id), bookedTargetSlot);
      if (failure !== "partial_failure") {
        this.slots.set(this.key(releasedOldSlot.practiceId, releasedOldSlot.id), releasedOldSlot);
      }
      const actualOldSlot = failure === "partial_failure" ? oldSlot : releasedOldSlot;
      const receipt = this.receipt({
        authorization,
        operation,
        idempotencyKey: request.idempotencyKey,
        providerRequestId,
        parameters,
        outcome: "applied",
        resources: [moved, actualOldSlot, bookedTargetSlot],
      });
      const readback = this.mutationReadback(
        authorization.practiceId,
        failure === "mismatch" ? { ...moved, slotId: oldSlot.id } : moved,
        [actualOldSlot, bookedTargetSlot],
      );
      this.throwPostWriteFailure(failure, operation, providerRequestId, receipt, readback);
      return { kind: "success", operation, idempotencyStatus: "executed", receipt, readback };
    });
  }

  snapshot(): IntergySimulatorSnapshot {
    return {
      appointments: structuredClone([...this.appointments.values()]),
      slots: structuredClone([...this.slots.values()]),
    };
  }

  private authorize<TParameters>(
    request: AuthorizedIntergyRequest<TParameters>,
    operation: IntergyOperation,
    parameters: TParameters,
  ): ExecutionAuthorization {
    if (request.authorization === null || request.authorization === undefined) {
      throw new IntergySimulatorError("authorization_required", operation, "not_written");
    }
    const resolved = this.authorizationAuthority.resolve(request.authorization);
    const parsed = executionAuthorizationSchema.safeParse(resolved);
    if (!parsed.success || resolved === null) {
      throw new IntergySimulatorError("authorization_invalid", operation, "not_written");
    }
    const authorization = parsed.data;
    if (new Date(authorization.executionExpiresAt) <= this.now()) {
      throw new IntergySimulatorError("authorization_expired", operation, "not_written");
    }
    if (authorization.capability !== operation) {
      throw new IntergySimulatorError("authorization_scope_mismatch", operation, "not_written");
    }
    if (
      this.authorizationAuthority.currentStateVersion(authorization.practiceId, authorization.caseId) !==
      authorization.stateVersion
    ) {
      throw new IntergySimulatorError("stale_state", operation, "not_written");
    }
    const parameterHash = hashIntergyParameters(parameters);
    if (authorization.parameterHash !== parameterHash) {
      throw new IntergySimulatorError("authorization_parameter_mismatch", operation, "not_written");
    }
    idempotencyKeySchema.parse(request.idempotencyKey);
    const requestHash = hashIntergyParameters({ operation, parameters });
    const authorizationHash = hashIntergyParameters(authorization);
    const priorUse = this.authorizationUses.get(authorization.authorizationId);
    if (
      priorUse !== undefined &&
      (priorUse.authorizationHash !== authorizationHash ||
        priorUse.operation !== operation ||
        priorUse.requestHash !== requestHash ||
        priorUse.idempotencyKey !== request.idempotencyKey)
    ) {
      throw new IntergySimulatorError("authorization_reuse_mismatch", operation, "not_written");
    }
    if (priorUse !== undefined && !mutationOperations.has(operation)) {
      throw new IntergySimulatorError("authorization_reuse_mismatch", operation, "not_written");
    }
    this.authorizationUses.set(authorization.authorizationId, {
      authorizationHash,
      operation,
      requestHash,
      idempotencyKey: request.idempotencyKey,
    });
    return authorization;
  }

  private assertSubject(
    authorization: ExecutionAuthorization,
    expectedSubjectId: string | null,
    operation: IntergyOperation,
  ): void {
    if (authorization.subjectId !== expectedSubjectId) {
      throw new IntergySimulatorError("authorization_scope_mismatch", operation, "not_written");
    }
  }

  private mutate<TParameters>(
    idempotencyKey: string,
    authorization: ExecutionAuthorization,
    operation: IntergyOperation,
    parameters: TParameters,
    execute: () => IntergySuccess<MutationReadback>,
  ): IntergySuccess<MutationReadback> {
    const key = `${authorization.practiceId}:${operation}:${idempotencyKey}`;
    const requestHash = hashIntergyParameters(parameters);
    const existing = this.idempotencyRecords.get(key);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new IntergySimulatorError("idempotency_key_mismatch", operation, "not_written");
      }
      if (existing.error !== undefined) throw cloneSimulatorError(existing.error);
      if (existing.result === undefined) throw new Error("idempotency_record_invalid");
      const result = existing.result as IntergySuccess<MutationReadback>;
      return { ...structuredClone(result), idempotencyStatus: "replayed" };
    }
    try {
      const result = execute();
      this.idempotencyRecords.set(key, { requestHash, result: structuredClone(result) });
      return result;
    } catch (error) {
      if (
        error instanceof IntergySimulatorError &&
        (error.certainty === "written_unverified" || error.certainty === "partially_written")
      ) {
        this.idempotencyRecords.set(key, { requestHash, error: cloneSimulatorError(error) });
      }
      throw error;
    }
  }

  private throwPreWriteFailure(
    failure: IntergyFailureMode | null,
    operation: IntergyOperation,
    providerRequestId: string,
  ): void {
    if (failure === "stale") {
      throw new IntergySimulatorError("stale_state", operation, "not_written", providerRequestId);
    }
    if (failure === "timeout_before_write") {
      throw new IntergySimulatorError("timeout_before_write", operation, "not_written", providerRequestId);
    }
  }

  private throwPostWriteFailure(
    failure: IntergyFailureMode | null,
    operation: IntergyOperation,
    providerRequestId: string,
    receipt: IntergyReceipt,
    readback: MutationReadback,
  ): void {
    if (failure === "timeout_after_possible_write") {
      throw new IntergySimulatorError(
        "timeout_after_possible_write",
        operation,
        "written_unverified",
        providerRequestId,
        null,
        null,
      );
    }
    if (failure === "mismatch") {
      throw new IntergySimulatorError(
        "readback_mismatch",
        operation,
        "written_unverified",
        providerRequestId,
        receipt,
        readback,
      );
    }
    if (failure === "partial_failure") {
      throw new IntergySimulatorError(
        "partial_failure",
        operation,
        "partially_written",
        providerRequestId,
        receipt,
        readback,
      );
    }
  }

  private receipt(input: {
    authorization: ExecutionAuthorization;
    operation: IntergyOperation;
    idempotencyKey: string;
    providerRequestId: string;
    parameters: unknown;
    outcome: "read" | "applied";
    resources: readonly { id: string; version: number }[];
  }): IntergyReceipt {
    return intergyReceiptSchema.parse({
      id: this.nextId("intergy-receipt"),
      providerRequestId: input.providerRequestId,
      practiceId: input.authorization.practiceId,
      operation: input.operation,
      actionRequestId: input.authorization.actionRequestId,
      authorizationId: input.authorization.authorizationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: hashIntergyParameters(input.parameters),
      outcome: input.outcome,
      resourceIds: input.resources.map((resource) => resource.id),
      resourceVersions: Object.fromEntries(input.resources.map((resource) => [resource.id, resource.version])),
      receivedAt: this.timestamp(),
      completedAt: this.timestamp(),
    });
  }

  private appointmentReadback(practiceId: string, appointment: SyntheticAppointment): AppointmentReadback {
    return appointmentReadbackSchema.parse({
      kind: "appointment",
      providerReadId: this.nextId("intergy-read"),
      practiceId,
      readAt: this.timestamp(),
      appointment,
    });
  }

  private availabilityReadback(
    practiceId: string,
    slots: readonly SyntheticAvailabilitySlot[],
  ): AvailabilityReadback {
    return availabilityReadbackSchema.parse({
      kind: "availability",
      providerReadId: this.nextId("intergy-read"),
      practiceId,
      readAt: this.timestamp(),
      slots,
    });
  }

  private mutationReadback(
    practiceId: string,
    appointment: SyntheticAppointment,
    affectedSlots: readonly SyntheticAvailabilitySlot[],
  ): MutationReadback {
    return mutationReadbackSchema.parse({
      kind: "appointment_mutation",
      providerReadId: this.nextId("intergy-read"),
      practiceId,
      readAt: this.timestamp(),
      appointment,
      affectedSlots,
    });
  }

  private findAppointment(practiceId: string, appointmentId: string, operation: IntergyOperation): SyntheticAppointment {
    const appointment = this.appointments.get(this.key(practiceId, appointmentId));
    if (appointment === undefined) {
      throw new IntergySimulatorError("resource_not_found", operation, "not_written");
    }
    return structuredClone(appointment);
  }

  private findSlot(practiceId: string, slotId: string, operation: IntergyOperation): SyntheticAvailabilitySlot {
    const slot = this.slots.get(this.key(practiceId, slotId));
    if (slot === undefined) {
      throw new IntergySimulatorError("resource_not_found", operation, "not_written");
    }
    return structuredClone(slot);
  }

  private takeFailure(operation: IntergyOperation): IntergyFailureMode | null {
    const queue = this.failures.get(operation);
    const next = queue?.[0];
    if (next === undefined) return null;
    next.remaining -= 1;
    if (next.remaining === 0) queue?.shift();
    return next.mode;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence.toString().padStart(4, "0")}`;
  }

  private key(practiceId: string, resourceId: string): string {
    return `${practiceId}:${resourceId}`;
  }
}

function cloneSimulatorError(error: IntergySimulatorError): IntergySimulatorError {
  return new IntergySimulatorError(
    error.code,
    error.operation,
    error.certainty,
    error.providerRequestId,
    error.receipt === null ? null : structuredClone(error.receipt),
    error.readback === null ? null : structuredClone(error.readback),
  );
}
