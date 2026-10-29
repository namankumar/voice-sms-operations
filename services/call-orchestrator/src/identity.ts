import { createHash } from "node:crypto";

import type { Capability } from "@salven/contracts";
import { requiredVerificationByCapability, type IdSource, type RequiredVerification } from "@salven/control-plane";

import type { VerificationMemory } from "./repository.js";

export type IdentityFactor = "date_of_birth" | "phone_last_four";
export type IdentityMatch = "match" | "no_match" | "ambiguous" | "representative";

const factorsByAssurance: Readonly<Record<RequiredVerification, readonly IdentityFactor[]>> = {
  none: [], basic: ["phone_last_four"], strong: ["date_of_birth", "phone_last_four"], human: [],
};

export interface IdentityVerificationResult { factor: IdentityFactor; outcome: IdentityMatch; protectedEvidenceId: string | null; }
export interface IdentityVerifier {
  verify(input: { practiceId: string; callId: string; patientId: string; factor: IdentityFactor; value: string }):
    IdentityVerificationResult | Promise<IdentityVerificationResult>;
}
export type IdentityOutcome =
  | { kind: "verified"; session: VerificationMemory; results: readonly IdentityVerificationResult[] }
  | { kind: "failed"; session: VerificationMemory; results: readonly IdentityVerificationResult[] }
  | { kind: "human_review"; session: VerificationMemory; results: readonly IdentityVerificationResult[]; reason: "ambiguous_identity" | "representative_caller" };

export class DeterministicIdentityService {
  constructor(private readonly ids: IdSource) {}

  createPending(input: { practiceId: string; callId: string; capability: Capability; expiresAt: Date }): VerificationMemory {
    const requiredAssurance = requiredVerificationByCapability[input.capability];
    if (requiredAssurance === "none" || requiredAssurance === "human") throw new Error("identity_session_not_applicable");
    return {
      id: this.ids.next("verification"), practiceId: input.practiceId, callId: input.callId,
      capability: input.capability, requiredAssurance, state: "pending", attemptCount: 0,
      identityEvidenceIds: [], subjectHash: null, expiresAt: input.expiresAt.toISOString(), version: 0,
    };
  }

  requiredFactors(capability: Capability): readonly IdentityFactor[] {
    return factorsByAssurance[requiredVerificationByCapability[capability]];
  }

  async verify(input: {
    session: VerificationMemory;
    patientId: string;
    factors: Readonly<Record<IdentityFactor, string | undefined>>;
    verifier: IdentityVerifier;
    now: Date;
    verifiedUntil: Date;
  }): Promise<IdentityOutcome> {
    const required = this.requiredFactors(input.session.capability);
    if (input.session.state !== "pending") throw new Error("illegal_verification_transition");
    if (input.session.subjectHash !== null || input.session.attemptCount !== 0 || input.session.identityEvidenceIds.length !== 0) throw new Error("preverified_or_prepopulated_session_rejected");
    if (input.session.expiresAt === null || new Date(input.session.expiresAt) <= input.now) throw new Error("verification_session_expired");
    if (input.session.requiredAssurance !== requiredVerificationByCapability[input.session.capability]) throw new Error("verification_assurance_not_capability_derived");
    if (required.length === 0) throw new Error("verification_not_required");

    const results = await Promise.all(required.map(async (factor): Promise<IdentityVerificationResult> => {
      const value = input.factors[factor];
      if (value === undefined || value.length === 0) return { factor, outcome: "no_match", protectedEvidenceId: null };
      return input.verifier.verify({ practiceId: input.session.practiceId, callId: input.session.callId, patientId: input.patientId, factor, value });
    }));
    const evidenceIds = results.flatMap((result) => result.protectedEvidenceId === null ? [] : [result.protectedEvidenceId]);
    const nextBase: VerificationMemory = {
      ...input.session,
      subjectHash: hashValue(input.patientId),
      attemptCount: 1,
      identityEvidenceIds: evidenceIds,
      version: input.session.version + 1,
    };
    if (results.some((result) => result.outcome === "representative")) return { kind: "human_review", reason: "representative_caller", session: nextBase, results };
    if (results.some((result) => result.outcome === "ambiguous")) return { kind: "human_review", reason: "ambiguous_identity", session: nextBase, results };
    const verified = results.every((result) => result.outcome === "match" && result.protectedEvidenceId !== null);
    if (!verified) return { kind: "failed", session: { ...nextBase, state: "failed", expiresAt: null }, results };
    if (evidenceIds.length !== required.length) throw new Error("verified_identity_requires_factor_evidence");
    return { kind: "verified", session: { ...nextBase, state: "verified", expiresAt: input.verifiedUntil.toISOString() }, results };
  }
}

export function hashIdentitySubject(patientId: string): string { return hashValue(patientId); }
function hashValue(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
