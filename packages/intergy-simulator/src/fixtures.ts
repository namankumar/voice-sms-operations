import {
  syntheticAppointmentSchema,
  syntheticAvailabilitySlotSchema,
  type SyntheticAppointment,
  type SyntheticAvailabilitySlot,
} from "./contracts.js";

export interface IntergySimulatorFixtures {
  appointments: readonly SyntheticAppointment[];
  slots: readonly SyntheticAvailabilitySlot[];
}

export const deterministicIntergyFixtures: IntergySimulatorFixtures = Object.freeze({
  appointments: Object.freeze([
    syntheticAppointmentSchema.parse({
      id: "appointment-alpha-100",
      practiceId: "practice-alpha",
      patientId: "subject-alpha-100",
      providerId: "provider-alpha-1",
      locationId: "location-alpha-main",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-10T16:00:00.000Z",
      endsAt: "2030-01-10T16:30:00.000Z",
      status: "scheduled",
      slotId: "slot-alpha-booked-100",
      version: 3,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
    syntheticAppointmentSchema.parse({
      id: "appointment-other-100",
      practiceId: "practice-other",
      patientId: "patient-other-100",
      providerId: "provider-other-1",
      locationId: "location-other-main",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-10T16:00:00.000Z",
      endsAt: "2030-01-10T16:30:00.000Z",
      status: "scheduled",
      slotId: "slot-other-booked-100",
      version: 1,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
  ]),
  slots: Object.freeze([
    syntheticAvailabilitySlotSchema.parse({
      id: "slot-alpha-booked-100",
      practiceId: "practice-alpha",
      providerId: "provider-alpha-1",
      locationId: "location-alpha-main",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-10T16:00:00.000Z",
      endsAt: "2030-01-10T16:30:00.000Z",
      status: "booked",
      bookedAppointmentId: "appointment-alpha-100",
      version: 2,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
    syntheticAvailabilitySlotSchema.parse({
      id: "slot-alpha-200",
      practiceId: "practice-alpha",
      providerId: "provider-alpha-1",
      locationId: "location-alpha-main",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-11T17:00:00.000Z",
      endsAt: "2030-01-11T17:30:00.000Z",
      status: "available",
      bookedAppointmentId: null,
      version: 1,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
    syntheticAvailabilitySlotSchema.parse({
      id: "slot-alpha-201",
      practiceId: "practice-alpha",
      providerId: "provider-alpha-2",
      locationId: "location-alpha-west",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-12T18:00:00.000Z",
      endsAt: "2030-01-12T18:30:00.000Z",
      status: "available",
      bookedAppointmentId: null,
      version: 1,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
    syntheticAvailabilitySlotSchema.parse({
      id: "slot-other-booked-100",
      practiceId: "practice-other",
      providerId: "provider-other-1",
      locationId: "location-other-main",
      appointmentType: "synthetic-follow-up",
      startsAt: "2030-01-10T16:00:00.000Z",
      endsAt: "2030-01-10T16:30:00.000Z",
      status: "booked",
      bookedAppointmentId: "appointment-other-100",
      version: 1,
      updatedAt: "2030-01-05T10:00:00.000Z",
    }),
  ]),
});

export function cloneDeterministicIntergyFixtures(): IntergySimulatorFixtures {
  return structuredClone(deterministicIntergyFixtures);
}
