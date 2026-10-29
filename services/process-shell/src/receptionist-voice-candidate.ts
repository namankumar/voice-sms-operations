import { randomBytes } from "node:crypto";

export const receptionistCandidatePurpose = "receptionist_voice_candidate" as const;
export const receptionistCandidateAttemptPrefix = "vvc1_receptionist_" as const;
export const receptionistManualCandidateAttemptPrefix = "vvc2_receptionist_manual_" as const;
export const receptionistCandidateCases = ["closed", "open_unavailable", "open_no_answer", "open_accepted"] as const;
export type ReceptionistCandidateCase = typeof receptionistCandidateCases[number];
export type ReceptionistCandidateBinding = { caseId: ReceptionistCandidateCase; hoursFixture: "demo_open" | "demo_closed"; version: "vvc1" | "vvc2"; purpose: typeof receptionistCandidatePurpose; profileSha256: string; nonce: string };
export type ReceptionistCandidateAttempt = { kind: "candidate"; binding: ReceptionistCandidateBinding } | { kind: "legacy" } | { kind: "invalid" };
/** The ID is immutable, public metadata. It grants no authority without the scoped durable DTMF receipt. */
export function parseReceptionistCandidateAttemptId(value: unknown): ReceptionistCandidateAttempt {
  if (typeof value !== "string" || value.length > 200) return { kind: "invalid" };
  if (!value.startsWith("vvc")) return { kind: "legacy" };
  const match = /^(vvc1_receptionist_|vvc2_receptionist_manual_)(closed|open_unavailable|open_no_answer|open_accepted)_([a-f0-9]{64})_([a-f0-9]{32})$/.exec(value);
  return match === null ? { kind: "invalid" } : { kind: "candidate", binding: { caseId: match[2] as ReceptionistCandidateCase, hoursFixture: match[2] === "closed" ? "demo_closed" : "demo_open", version: match[1] === receptionistCandidateAttemptPrefix ? "vvc1" : "vvc2", purpose: receptionistCandidatePurpose,
    profileSha256: `sha256:${match[3]!}`, nonce: match[4]! } };
}
export function makeReceptionistCandidateAttemptId(profileSha256: string, caseId: ReceptionistCandidateCase, nonce = randomBytes(16).toString("hex")): string {
  if (!receptionistCandidateCases.includes(caseId) || !/^sha256:[a-f0-9]{64}$/.test(profileSha256) || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("voice_candidate_binding_invalid");
  return `${receptionistCandidateAttemptPrefix}${caseId}_${profileSha256.slice(7)}_${nonce}`;
}
/** A separate namespace keeps the four-digit human test from weakening existing 24-digit automated admission. */
export function makeReceptionistManualCandidateAttemptId(profileSha256: string, caseId: ReceptionistCandidateCase, nonce = randomBytes(16).toString("hex")): string {
  if (!receptionistCandidateCases.includes(caseId) || !/^sha256:[a-f0-9]{64}$/.test(profileSha256) || !/^[a-f0-9]{32}$/.test(nonce)) throw new Error("voice_candidate_binding_invalid");
  return `${receptionistManualCandidateAttemptPrefix}${caseId}_${profileSha256.slice(7)}_${nonce}`;
}
export function parseReceptionistCandidateFixtureId(value: string): ReceptionistCandidateAttempt {
  return value.startsWith("fixture_") ? parseReceptionistCandidateAttemptId(value.slice(8)) : { kind: "legacy" };
}

/** Readback uses only the immutable encrypted admission, never a global/environment profile claim. */
export function receptionistConversationVoiceReleaseBinding(state: { admission: { controlledHours?: { fixtureId: string; candidate?: { profileSha256: string } | undefined } | null | undefined; voiceRelease?: { stage: "operator_demo"; profileSha256: string } | { stage: "rehearsal"; profileSha256: string; qualificationSha256: string } | undefined } }):
  { stage: "candidate"; profileSha256: string; candidateAttemptId: string } | { stage: "operator_demo"; profileSha256: string } | { stage: "rehearsal"; profileSha256: string; qualificationSha256: string } | null {
  const receipt = state.admission.controlledHours;
  if (receipt?.candidate !== undefined) {
    const parsed = parseReceptionistCandidateFixtureId(receipt.fixtureId);
    if (parsed.kind !== "candidate" || parsed.binding.profileSha256 !== receipt.candidate.profileSha256) throw new Error("voice_candidate_readback_binding_invalid");
    return { stage: "candidate", profileSha256: parsed.binding.profileSha256, candidateAttemptId: receipt.fixtureId.slice("fixture_".length) };
  }
  return state.admission.voiceRelease === undefined ? null : { ...state.admission.voiceRelease };
}
