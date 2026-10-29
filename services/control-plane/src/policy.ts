import type { ActionRequest, Capability, VerificationSession } from "@salven/contracts";

export type RequiredVerification = "none" | "basic" | "strong" | "human";

export const requiredVerificationByCapability: Readonly<Record<Capability, RequiredVerification>> = {
  "knowledge.public.read": "none",
  "knowledge.patient.read": "strong",
  "appointment.details.read": "strong",
  "appointment.availability.read": "none",
  "appointment.schedule": "strong",
  "appointment.move": "strong",
  "referral.state.read": "strong",
  "referral.state.transition": "human",
};

export type PolicyDisposition = "permit" | "deny" | "human_review";

export interface CurrentStatePolicyInput {
  request: ActionRequest;
  currentStateVersion: number;
  verification: VerificationSession | null;
  now: Date;
}

export interface CurrentStatePolicyResult {
  disposition: PolicyDisposition;
  requiredVerification: RequiredVerification;
  reasonCodes: readonly string[];
  obligations: readonly string[];
}

const assuranceRank: Readonly<Record<RequiredVerification, number>> = {
  none: 0,
  basic: 1,
  strong: 2,
  human: 3,
};

/** Evaluates only the state supplied for this decision; it never caches identity or verification. */
export class CurrentStatePolicyEngine {
  evaluate(input: CurrentStatePolicyInput): CurrentStatePolicyResult {
    const requiredVerification = requiredVerificationByCapability[input.request.capability];

    if (input.request.requestedStateVersion !== input.currentStateVersion) {
      return this.result("deny", requiredVerification, ["state_version_stale"]);
    }
    if (requiredVerification === "human") {
      return this.result("human_review", requiredVerification, ["human_authorization_required"]);
    }
    if (requiredVerification === "none") {
      return this.result("permit", requiredVerification, ["verification_not_required"]);
    }

    const verification = input.verification;
    if (verification === null) {
      return this.result("human_review", requiredVerification, ["verification_missing"]);
    }
    if (
      verification.practiceId !== input.request.practiceId ||
      verification.callId !== input.request.callId ||
      verification.capability !== input.request.capability ||
      verification.patientId !== input.request.subjectId
    ) {
      return this.result("deny", requiredVerification, ["verification_scope_mismatch"]);
    }
    if (
      verification.state === "failed" ||
      verification.state === "locked" ||
      verification.state === "expired"
    ) {
      return this.result("deny", requiredVerification, ["verification_unusable"]);
    }
    if (verification.expiresAt !== null && new Date(verification.expiresAt) <= input.now) {
      return this.result("human_review", requiredVerification, ["verification_expired"]);
    }
    if (verification.state !== "verified") {
      return this.result("human_review", requiredVerification, ["verification_pending"]);
    }
    if (assuranceRank[verification.requiredAssurance] < assuranceRank[requiredVerification]) {
      return this.result("human_review", requiredVerification, ["verification_assurance_insufficient"]);
    }

    return this.result("permit", requiredVerification, ["verification_current"]);
  }

  private result(
    disposition: PolicyDisposition,
    requiredVerification: RequiredVerification,
    reasonCodes: readonly string[],
  ): CurrentStatePolicyResult {
    return {
      disposition,
      requiredVerification,
      reasonCodes,
      obligations:
        disposition === "permit"
          ? ["consume_single_use_permit", "enforce_bound_state_and_parameters"]
          : disposition === "human_review"
            ? ["human_review_required"]
            : [],
    };
  }
}
