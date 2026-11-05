import { createHash } from "node:crypto";
import { z } from "zod";

import { querySyntheticPracticeKnowledge, syntheticVascularKnowledgePack } from "./f2-knowledge.js";

/** The only public facts a receptionist-mode model may ask the server to read. */
export const receptionistPublicFaqTopicSchema = z.enum(["address", "demo_way_directions", "sample_city_address", "locations"]);
export type ReceptionistPublicFaqTopic = z.infer<typeof receptionistPublicFaqTopicSchema>;
export const receptionistPublicFaqProposalSchema = z.object({ topic: receptionistPublicFaqTopicSchema, unsupportedPart: z.boolean().optional() }).strict();
export type ReceptionistPublicFaqProposal = z.infer<typeof receptionistPublicFaqProposalSchema>;

/** A selected office authorizes only its own pinned family of public facts. */
export function sameSelectedOfficePublicFaqTopic(selected: Exclude<ReceptionistPublicFaqTopic, "locations"> | undefined,
  requested: ReceptionistPublicFaqTopic): boolean {
  if (selected === undefined || requested === "locations") return false;
  const sunset = (topic: ReceptionistPublicFaqTopic) => topic === "address" || topic === "demo_way_directions";
  return sunset(selected) ? sunset(requested) : selected === "sample_city_address" && requested === "sample_city_address";
}

/** Knowledge topic semantics, independent of the wording of its spoken answer. */
export const receptionistPublicFaqFlow: Readonly<Record<ReceptionistPublicFaqTopic,
  { requiresOfficeChoice: boolean; followUp: boolean }>> = {
  locations: { requiresOfficeChoice: true, followUp: false },
  address: { requiresOfficeChoice: false, followUp: true },
  demo_way_directions: { requiresOfficeChoice: false, followUp: true },
  sample_city_address: { requiresOfficeChoice: false, followUp: true },
};

const queryTopic: Readonly<Record<ReceptionistPublicFaqTopic, "practice_address" | "practice_directions_demo_way" | "practice_address_sample_city" | "practice_locations">> = {
  address: "practice_address",
  demo_way_directions: "practice_directions_demo_way",
  sample_city_address: "practice_address_sample_city",
  locations: "practice_locations",
};

export type ReceptionistPublicFaqAnswer = Readonly<{
  topic: ReceptionistPublicFaqTopic;
  text: string;
  packId: string;
  packVersion: string;
  factId: string;
  factVersion: string;
  sourceId: string;
  sourceVersion: string;
  contentHash: `sha256:${string}`;
}>;

/** Exact pack/source/fact pin check; topic is supplied by the caller of the check. */
export function receptionistPublicFaqReferenceMatches(reference: { packId: string; packVersion: string; factId: string; factVersion: string;
  knowledgeSourceId: string; knowledgeSourceVersion: string; contentHash: string }, answer: ReceptionistPublicFaqAnswer): boolean {
  return reference.packId === answer.packId && reference.packVersion === answer.packVersion && reference.factId === answer.factId
    && reference.factVersion === answer.factVersion && reference.knowledgeSourceId === answer.sourceId
    && reference.knowledgeSourceVersion === answer.sourceVersion && reference.contentHash === answer.contentHash;
}

/** Pinned public-only lookup. It never accepts caller text, freeform queries, or model-provided facts. */
export function resolveReceptionistPublicFaq(input: { practiceId: string; topic: ReceptionistPublicFaqTopic; asOf: string }): ReceptionistPublicFaqAnswer | null {
  const result = querySyntheticPracticeKnowledge({ practiceId: input.practiceId, channel: "voice", topic: queryTopic[input.topic], access: "public", asOf: input.asOf });
  if (result.kind !== "found") return null;
  const fact = syntheticVascularKnowledgePack.facts.find((item) => item.factId === result.factId);
  if (fact === undefined || fact.answer !== result.answer || fact.classification !== "public") return null;
  return { topic: input.topic, text: spokenText(input.topic, result.answer), packId: syntheticVascularKnowledgePack.packId,
    packVersion: syntheticVascularKnowledgePack.packVersion, factId: fact.factId, factVersion: fact.version,
    sourceId: `knowledge-source-${createHash("sha256").update(fact.source.sourceId).digest("hex").slice(0, 32)}`,
    sourceVersion: fact.source.sourceVersion, contentHash: `sha256:${createHash("sha256").update(fact.answer).digest("hex")}` };
}

export function receptionistPublicFaqAnswerMatches(answer: ReceptionistPublicFaqAnswer, input: { practiceId: string; topic: ReceptionistPublicFaqTopic; asOf: string }): boolean {
  const current = resolveReceptionistPublicFaq(input);
  return current !== null && JSON.stringify(current) === JSON.stringify(answer);
}

function spokenText(topic: ReceptionistPublicFaqTopic, answer: string): string {
  return topic === "address" ? `Our office is at ${answer.replace(/\bW\b/g, "West").replace(/\bRd\b/g, "Road")
    .replace(/,?\s*#(?=\d)/g, ", Suite ").replace(/\bNV\b/g, "Nevada")}.` : answer;
}
