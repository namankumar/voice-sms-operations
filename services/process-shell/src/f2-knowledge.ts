import { z } from "zod";
import { createHash } from "node:crypto";

const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().trim().min(1).max(2_000);
const timestamp = z.string().datetime({ offset: true });

export const knowledgeClassificationSchema = z.enum(["public", "protected"]);
export type KnowledgeClassification = z.infer<typeof knowledgeClassificationSchema>;

export const knowledgeSourceSchema = z.object({
  sourceId: z.string().trim().min(1).max(500),
  sourceVersion: id,
  kind: z.enum(["approved_prd", "offline_fixture", "staff_artifact"]),
}).strict();
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const knowledgeReviewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("approved"), approver: id, approvedAt: timestamp, artifactVersion: id }).strict(),
  z.object({ status: z.literal("illustrative") }).strict(),
]);
export type KnowledgeReview = z.infer<typeof knowledgeReviewSchema>;

export const knowledgeConflictSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("clear") }).strict(),
  z.object({ status: z.literal("conflicted"), conflictingFactIds: z.array(id).min(1).max(16) }).strict(),
]);
export type KnowledgeConflict = z.infer<typeof knowledgeConflictSchema>;

/** A knowledge fact is always about the practice; patient facts never enter this pack. */
export const reviewedKnowledgeFactSchema = z.object({
  factId: id,
  subject: z.literal("practice"),
  topic: id,
  classification: knowledgeClassificationSchema,
  answer: text,
  source: knowledgeSourceSchema,
  version: id,
  review: knowledgeReviewSchema,
  expiresAt: timestamp.nullable(),
  conflict: knowledgeConflictSchema,
}).strict();
export type ReviewedKnowledgeFact = z.infer<typeof reviewedKnowledgeFactSchema>;

export const reviewedKnowledgePackSchema = z.object({
  schemaVersion: z.literal(1),
  packId: id,
  packVersion: id,
  practiceId: id,
  expiresAt: timestamp.nullable(),
  facts: z.array(reviewedKnowledgeFactSchema).min(1).max(32),
}).strict().superRefine((pack, ctx) => {
  const seen = new Set<string>();
  for (const [index, fact] of pack.facts.entries()) {
    if (seen.has(fact.factId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["facts", index, "factId"], message: "knowledge_fact_id_duplicate" });
    seen.add(fact.factId);
  }
});
export type ReviewedKnowledgePack = z.infer<typeof reviewedKnowledgePackSchema>;

export const knowledgeQuerySchema = z.object({
  practiceId: id,
  channel: z.enum(["voice", "sms"]),
  topic: id,
  access: z.enum(["public", "protected"]),
  asOf: timestamp,
}).strict();
export type KnowledgeQuery = z.infer<typeof knowledgeQuerySchema>;

const unknownReasonSchema = z.enum([
  "practice_mismatch", "pack_expired", "topic_unknown", "topic_conflicted", "fact_conflicted", "fact_expired", "protected_not_authorized", "illustrative_not_policy", "approval_not_effective", "approval_version_mismatch", "unapproved_content",
]);
export type KnowledgeUnknownReason = z.infer<typeof unknownReasonSchema>;

export const knowledgeQueryResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("found"),
    topic: id,
    answer: text,
    classification: knowledgeClassificationSchema,
    factId: id,
    factVersion: id,
    packVersion: id,
    source: knowledgeSourceSchema,
    review: z.object({ status: z.literal("approved"), approver: id, approvedAt: timestamp, artifactVersion: id }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("unknown"),
    topic: id,
    reason: unknownReasonSchema,
    packVersion: id,
    nextAction: z.literal("clarify_or_handoff"),
  }).strict(),
]);
export type KnowledgeQueryResult = z.infer<typeof knowledgeQueryResultSchema>;

/**
 * Resolves only an exact, current, approved fact. It intentionally accepts a
 * typed topic instead of free-form caller text, so no phrase or nearest-match
 * routing can turn missing knowledge into an invented answer.
 * The gateway supplies practice, access and asOf from trusted context, not model arguments.
 */
export function queryReviewedKnowledge(packInput: unknown, queryInput: unknown): KnowledgeQueryResult {
  const pack = reviewedKnowledgePackSchema.parse(packInput);
  const query = knowledgeQuerySchema.parse(queryInput);
  const unknown = (reason: KnowledgeUnknownReason): KnowledgeQueryResult => knowledgeQueryResultSchema.parse({
    kind: "unknown", topic: query.topic, reason, packVersion: pack.packVersion, nextAction: "clarify_or_handoff",
  });
  if (pack.practiceId !== query.practiceId) return unknown("practice_mismatch");
  const asOf = Date.parse(query.asOf);
  if (isExpired(pack.expiresAt, asOf)) return unknown("pack_expired");
  const candidates = pack.facts.filter((fact) => fact.topic === query.topic);
  if (candidates.length === 0) return unknown("topic_unknown");
  if (candidates.length !== 1) return unknown("topic_conflicted");
  const fact = candidates[0]!;
  if (fact.conflict.status === "conflicted") return unknown("fact_conflicted");
  if (isExpired(fact.expiresAt, asOf)) return unknown("fact_expired");
  if (fact.classification === "protected" && query.access !== "protected") return unknown("protected_not_authorized");
  if (fact.review.status !== "approved") return unknown("illustrative_not_policy");
  if (fact.review.artifactVersion !== pack.packVersion) return unknown("approval_version_mismatch");
  if (Date.parse(fact.review.approvedAt) > asOf) return unknown("approval_not_effective");
  return knowledgeQueryResultSchema.parse({
    kind: "found", topic: fact.topic, answer: fact.answer, classification: fact.classification, factId: fact.factId,
    factVersion: fact.version, packVersion: pack.packVersion, source: fact.source, review: fact.review,
  });
}

/** The expected digest comes from the deployed reviewed manifest, never the caller or model. */
export function queryPinnedKnowledge(packInput: unknown, expectedDigest: string, queryInput: unknown): KnowledgeQueryResult {
  const pack = reviewedKnowledgePackSchema.parse(packInput);
  const query = knowledgeQuerySchema.parse(queryInput);
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedDigest) || knowledgePackDigest(pack) !== expectedDigest) {
    return { kind: "unknown", topic: query.topic, reason: "unapproved_content", packVersion: pack.packVersion, nextAction: "clarify_or_handoff" };
  }
  return queryReviewedKnowledge(pack, query);
}

export function knowledgePackDigest(pack: ReviewedKnowledgePack): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(reviewedKnowledgePackSchema.parse(pack))).digest("hex")}`;
}

export const vegasVascularKnowledgePack = reviewedKnowledgePackSchema.parse({
  schemaVersion: 1,
  packId: "synthetic-practice-demo-knowledge",
  packVersion: "know-03-v2",
  practiceId: "synthetic-practice",
  expiresAt: null,
  facts: [{
    factId: "synthetic-practice-address",
    subject: "practice",
    topic: "practice_address",
    classification: "public",
    answer: "100 Demo Way, Suite 100, Example City, EX 00000",
    source: { sourceId: "sai-voice-sms-architecture-2026-09-23#KNOW-03", sourceVersion: "2026-09-23", kind: "approved_prd" },
    version: "address-v1",
    review: { status: "approved", approver: "naman", approvedAt: "2026-09-23T00:00:00.000Z", artifactVersion: "know-03-v2" },
    expiresAt: null,
    conflict: { status: "clear" },
  }, ...([
    ["synthetic-practice-demo_way-directions", "practice_directions_demo_way", "The Demo Way office is at 100 Demo Way, Suite 100, Example City, Example State 00000. It is across from a public landmark, near the local hospital. From the main highway, use the Demo Way exit exit."],
    ["synthetic-practice-sample_city-address", "practice_address_sample_city", "The Sample City office is at 200 Sample Avenue, Suite 200, Sample City, Example State 00001."],
    ["synthetic-practice-locations", "practice_locations", "There is a Demo Way office in Example City and a Sample Avenue office in Sample City. Which office are you headed to?"],
  ] as const).map(([factId, topic, answer]) => ({
    factId, subject: "practice" as const, topic, classification: "public" as const, answer,
    source: { sourceId: "sai-voice-sms-architecture-2026-09-23#KNOW-03", sourceVersion: "2026-09-29", kind: "approved_prd" as const },
    version: "directions-v1", review: { status: "approved" as const, approver: "naman", approvedAt: "2026-09-29T00:00:00.000Z", artifactVersion: "know-03-v2" },
    expiresAt: null, conflict: { status: "clear" as const },
  }))],
});

export const vegasVascularKnowledgeDigest = "sha256:33956703f5139cbcf5e6d931f758f0cf1ee6d0ff24154ca964212faef85dc05d";
export function querySyntheticPracticeKnowledge(query: KnowledgeQuery): KnowledgeQueryResult {
  return queryPinnedKnowledge(vegasVascularKnowledgePack, vegasVascularKnowledgeDigest, query);
}

/** Synthetic fixture alias only; production EMR locations require their own reviewed mapping. */
export function approvedAppointmentDirections(practiceId: string, locations: readonly string[], asOf: string): string | null {
  if (locations.length === 0 || locations.some((location) => location !== "synthetic-demo-location")) return null;
  const result = querySyntheticPracticeKnowledge({ practiceId, channel: "voice", topic: "practice_directions_demo_way", access: "public", asOf });
  return result.kind === "found" ? result.answer : null;
}

const illustrativeVariantSchema = z.object({
  configurationVersion: id,
  handling: z.enum(["unclassified_staff_review", "illustrative_type_labeled_staff_review"]),
  source: knowledgeSourceSchema,
  version: id,
  review: z.object({ status: z.literal("illustrative") }).strict(),
  expiresAt: timestamp.nullable(),
  conflict: z.object({ status: z.literal("clear") }).strict(),
}).strict();

/** Offline presenter evidence only. It is deliberately separate from queryReviewedKnowledge. */
export const offlineAppointmentHandlingExampleSchema = z.object({
  schemaVersion: z.literal(1),
  exampleId: z.literal("appointment-type-handling"),
  label: z.literal("illustrative_offline_example"),
  teamApproval: z.literal(null),
  baseline: illustrativeVariantSchema,
  revised: illustrativeVariantSchema,
}).strict();
export type OfflineAppointmentHandlingExample = z.infer<typeof offlineAppointmentHandlingExampleSchema>;

export const offlineAppointmentHandlingExample = offlineAppointmentHandlingExampleSchema.parse({
  schemaVersion: 1,
  exampleId: "appointment-type-handling",
  label: "illustrative_offline_example",
  teamApproval: null,
  baseline: {
    configurationVersion: "baseline-illustrative-v1",
    handling: "unclassified_staff_review",
    source: { sourceId: "know-03-offline-example", sourceVersion: "2026-09-23", kind: "offline_fixture" },
    version: "baseline-v1",
    review: { status: "illustrative" },
    expiresAt: null,
    conflict: { status: "clear" },
  },
  revised: {
    configurationVersion: "revised-illustrative-v1",
    handling: "illustrative_type_labeled_staff_review",
    source: { sourceId: "know-03-offline-example", sourceVersion: "2026-09-23", kind: "offline_fixture" },
    version: "revised-v1",
    review: { status: "illustrative" },
    expiresAt: null,
    conflict: { status: "clear" },
  },
});

function isExpired(expiresAt: string | null, asOf: number): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= asOf;
}
