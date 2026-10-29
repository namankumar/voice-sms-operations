import { createHash } from "node:crypto";

import type { PostgresF2SyntheticPracticeStore, SyntheticFixtureAppointment, SyntheticFixturePatient, SyntheticFixtureSlot } from "./f2-synthetic-practice-store.js";
import type { SyntheticDataset } from "./f2-synthetic-practice-contract.js";

const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** Separate, fictional F2 dataset identity. It is never an Intergy tenant or a receptionist dataset. */
export const f2DemoFixtureIdentity = {
  instanceId: "f2-full-demo",
  datasetScope: { practiceId: "synthetic-practice", datasetId: "f2-full-demo-fixture", generation: 1 },
} as const;

/** Stable fixture manifest; its future slots are anchored data, not recomputed from process startup time. */
export function f2DemoFixtureManifest(): {
  dataset: SyntheticDataset;
  patients: readonly SyntheticFixturePatient[];
  slots: readonly SyntheticFixtureSlot[];
  appointments: readonly SyntheticFixtureAppointment[];
} {
  const scope = f2DemoFixtureIdentity.datasetScope;
  const patientBody = { identity: { dateOfBirth: "1980-01-02", zip: "89109" }, eligibleAppointmentTypes: ["office-followup"],
    // Fixed fictitious values only; no clinic or patient system is queried.
    values: { appointment_details: { label: "Synthetic follow-up appointment" }, referral_status: { status: "Synthetic referral record pending review" }, billing_balance: { amount: "42.00", currency: "USD", label: "Synthetic test balance" } } };
  const slots: readonly SyntheticFixtureSlot[] = [
    { scope, slotId: "f2-demo-slot-2027-01-08-0900", startsAt: "2027-01-08T17:00:00.000Z", endsAt: "2027-01-08T17:30:00.000Z", capacity: 1,
      origin: "synthetic_fixture", body: { appointmentType: "office-followup", location: "synthetic-demo-location" }, version: 0 },
    { scope, slotId: "f2-demo-slot-2027-01-12-0900", startsAt: "2027-01-12T17:00:00.000Z", endsAt: "2027-01-12T17:30:00.000Z", capacity: 1,
      origin: "synthetic_fixture", body: { appointmentType: "office-followup", location: "synthetic-demo-location" }, version: 0 },
    { scope, slotId: "f2-demo-slot-2027-01-14-1100", startsAt: "2027-01-14T19:00:00.000Z", endsAt: "2027-01-14T19:30:00.000Z", capacity: 1,
      origin: "synthetic_fixture", body: { appointmentType: "office-followup", location: "synthetic-demo-location" }, version: 0 },
  ];
  const appointments: readonly SyntheticFixtureAppointment[] = [{ scope, appointmentId: "f2-demo-appointment-baseline", patientId: "f2-demo-patient-1", slotId: "f2-demo-slot-2027-01-08-0900",
    state: "scheduled", attendanceVersion: null, origin: "synthetic_fixture", body: { label: "Synthetic baseline follow-up" }, version: 0 }];
  return {
    dataset: { scope, seedVersion: "f2-full-demo-v1", seedHash: digest({ fixtureVersion: "f2-full-demo-v1", scope, patientBody, slots, appointments }), clinicTimeZone: "UTC", state: "active", version: 0,
      createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z" },
    patients: [{ scope, patientId: "f2-demo-patient-1", identityFingerprintHash: digest(patientBody.identity), origin: "synthetic_fixture", body: patientBody, version: 0 }],
    slots,
    appointments,
  };
}

/** The store owns one atomic insert-or-observe transaction; fixtures never reset or overwrite a dataset. */
export async function bootstrapF2DemoFixtures(store: Pick<PostgresF2SyntheticPracticeStore, "seedFixedFixturesIfAbsent">): Promise<"seeded" | "already_present"> {
  return await store.seedFixedFixturesIfAbsent(f2DemoFixtureManifest());
}
