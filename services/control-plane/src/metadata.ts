import { capabilitySchema, caseStateSchema, type EventEnvelope } from "@salven/contracts";

type MetadataValue = EventEnvelope["metadata"][string];

const sensitiveKey = /(?:patient|name|dob|birth|phone|email|address|mrn|medical|diagnos|note|transcript|record)/i;
const decisions = new Set(["permit", "deny", "human_review"]);
const policyReasonCodes = new Set([
  "current_state_missing",
  "current_state_tenant_mismatch",
  "state_version_stale",
  "human_authorization_required",
  "verification_not_required",
  "verification_missing",
  "verification_scope_mismatch",
  "verification_unusable",
  "verification_expired",
  "verification_pending",
  "verification_assurance_insufficient",
  "verification_current",
  "policy_result_missing",
]);
const rulesetVersion = /^s[1-9]\d*-(?:[a-z][a-z0-9]*-)*(?:v[1-9]\d*|test)$/;
const sha256 = /^sha256:[a-f0-9]{64}$/;

/**
 * Event metadata is deliberately limited to operational tokens, not request
 * payloads. Unknown keys and values that could carry free-form PHI are removed.
 */
export function redactMetadata(
  metadata: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): Record<string, MetadataValue> {
  const allowed = new Set(allowedKeys);
  const result: Record<string, MetadataValue> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (!allowed.has(key)) {
      continue;
    }
    if (sensitiveKey.test(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    result[key] = isAllowedMetadataValue(key, value) ? value : "[REDACTED]";
  }

  return result;
}

function isAllowedMetadataValue(key: string, value: unknown): value is MetadataValue {
  switch (key) {
    case "capability":
      return capabilitySchema.safeParse(value).success;
    case "decision":
      return typeof value === "string" && decisions.has(value);
    case "reasonCode":
      return typeof value === "string" && policyReasonCodes.has(value);
    case "rulesetVersion":
      return typeof value === "string" && rulesetVersion.test(value);
    case "fromState":
    case "toState":
      return caseStateSchema.safeParse(value).success;
    case "stateVersion":
    case "expectedVersion":
    case "resolutionEvidenceCount":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "nextStateHash":
      return typeof value === "string" && sha256.test(value);
    default:
      return false;
  }
}
