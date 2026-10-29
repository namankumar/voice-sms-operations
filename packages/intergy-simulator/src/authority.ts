import { createHash } from "node:crypto";

import {
  actionPermitSchema,
  actionRequestSchema,
  type ActionPermit,
  type ActionRequest,
} from "@salven/contracts";

import {
  executionAuthorizationSchema,
  type ExecutionAuthorization,
  type ExecutionAuthorizationAuthority,
} from "./contracts.js";

export interface ConsumedPermitAuthorizationInput {
  permit: ActionPermit;
  request: ActionRequest;
  caseId: string;
  validationEvidenceId: string;
  validatedAt: string;
  executionExpiresAt: string;
}

/** Synthetic control-plane registry. The adapter receives only its opaque token. */
export class SyntheticExecutionAuthorizationRegistry implements ExecutionAuthorizationAuthority {
  private readonly authorizations = new Map<string, ExecutionAuthorization>();
  private readonly stateVersions = new Map<string, number>();

  issueFromConsumedPermit(input: ConsumedPermitAuthorizationInput): string {
    const permit = actionPermitSchema.parse(input.permit);
    const request = actionRequestSchema.parse(input.request);
    if (permit.consumedAt === null) throw new Error("execution_authorization_requires_consumed_permit");
    if (
      permit.practiceId !== request.practiceId ||
      permit.actionRequestId !== request.id ||
      permit.capability !== request.capability ||
      permit.subjectId !== request.subjectId ||
      permit.parameterHash !== request.parameterHash ||
      permit.stateVersion !== request.requestedStateVersion ||
      input.caseId !== request.caseId
    ) {
      throw new Error("execution_authorization_scope_mismatch");
    }
    if (new Date(input.executionExpiresAt) > new Date(permit.expiresAt)) {
      throw new Error("execution_authorization_exceeds_permit_expiry");
    }
    const token = `execution-${createHash("sha256")
      .update(`${permit.nonceHash}:${input.validationEvidenceId}:${input.validatedAt}`)
      .digest("hex")}`;
    const authorization = executionAuthorizationSchema.parse({
      kind: "consumed_validated_execution_authorization",
      authorizationId: token,
      permitId: permit.id,
      actionRequestId: request.id,
      caseId: request.caseId,
      policyDecisionId: permit.policyDecisionId,
      practiceId: request.practiceId,
      capability: request.capability,
      subjectId: request.subjectId,
      parameterHash: request.parameterHash,
      stateVersion: request.requestedStateVersion,
      consumedAt: permit.consumedAt,
      validatedAt: input.validatedAt,
      executionExpiresAt: input.executionExpiresAt,
      validationEvidenceId: input.validationEvidenceId,
    });
    this.authorizations.set(token, authorization);
    this.stateVersions.set(this.stateKey(request.practiceId, request.caseId), request.requestedStateVersion);
    return token;
  }

  resolve(candidate: unknown): ExecutionAuthorization | null {
    if (typeof candidate !== "string") return null;
    const value = this.authorizations.get(candidate);
    return value === undefined ? null : structuredClone(value);
  }

  currentStateVersion(practiceId: string, caseId: string): number | null {
    return this.stateVersions.get(this.stateKey(practiceId, caseId)) ?? null;
  }

  setCurrentStateVersion(practiceId: string, caseId: string, version: number): void {
    this.stateVersions.set(this.stateKey(practiceId, caseId), version);
  }

  private stateKey(practiceId: string, caseId: string): string {
    return `${practiceId}:${caseId}`;
  }
}
