import type {
  CaseTransitionCommit,
  CaseTransitionCommitResult,
  PermitConsumeCommand,
  PermitConsumeResult,
} from "../repository.js";
import type { Case } from "@salven/contracts";

/**
 * Offline type boundary retained so the exported authority service remains
 * source-compatible. No database adapter or connection configuration is
 * included in this public slice.
 */
export interface AsyncControlPlaneRepository {
  commitPolicyDecision(input: unknown): Promise<void>;
  consumePermit(command: PermitConsumeCommand): Promise<PermitConsumeResult>;
  findCase(practiceId: string, caseId: string): Promise<Case | null>;
  transitionCase(command: CaseTransitionCommit): Promise<CaseTransitionCommitResult>;
  close(): Promise<void>;
}
