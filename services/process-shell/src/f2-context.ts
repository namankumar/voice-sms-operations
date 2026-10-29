import { createHash } from "node:crypto";

import { z } from "zod";

import { conversationSchema, type Conversation } from "./conversation-contract.js";
import { F2_FULL_MASTER_PROMPT_VERSION, F2_FULL_TOOL_SCHEMA_VERSION, f2PhaseSchema, f2PromptContextSchema, type F2Phase, type F2PromptContext } from "./f2-prompt.js";
import { decideFullRequest, fullExecutableCapabilitySchema, fullRequestProposalSchema } from "./f2-request-policy.js";
import { syntheticIdentityGrantSchema, type SyntheticIdentityGrant } from "./f2-synthetic-practice-contract.js";

const id = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().trim().min(1).max(8_000);
const timestamp = z.string().datetime({ offset: true });

const trustedProposalSchema = z.object({ requestId: id, requestRevision: z.number().int().nonnegative(), proposal: fullRequestProposalSchema }).strict();
const trustedFactSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), factId: id, statement: z.string().trim().min(1).max(2_000), receiptId: id, sourceVersion: id, sourceTimestamp: timestamp }).strict(),
  z.object({ status: z.literal("uncertain"), topic: z.string().trim().min(1).max(2_000), reason: z.string().trim().min(1).max(2_000) }).strict(),
]);
const identityStatusSchema = z.enum(["unverified", "unknown", "exhausted"]);
const capabilityAvailabilitySchema = z.object({ capability: fullExecutableCapabilitySchema, state: z.enum(["available", "unavailable"]), reason: z.string().trim().min(1).max(2_000) }).strict();
const smsMutationGateSchema = z.object({ state: z.enum(["exact_consent_required", "exact_consent_recorded"]), consentReceipt: z.object({ receiptId: id, sourceVersion: id, issuedAt: timestamp }).strict().nullable(), reason: z.string().trim().min(1).max(2_000) }).strict()
  .superRefine((value, ctx) => { if (value.state === "exact_consent_recorded" && value.consentReceipt === null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["consentReceipt"], message: "sms_consent_receipt_required" }); });

export type TrustedF2Proposal = z.infer<typeof trustedProposalSchema>;
export type TrustedF2PromptFact = z.infer<typeof trustedFactSchema>;
export type F2CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;
export type F2SmsMutationGate = z.infer<typeof smsMutationGateSchema>;

/** All non-conversation values enter through server-owned typed gateway results. */
export type F2PromptContextBuildInput = Readonly<{
  conversation: Conversation;
  versions: Readonly<{ model: string; knowledgeVersion: string; policyVersion: string }>;
  phase: F2Phase;
  currentGrant: SyntheticIdentityGrant | null;
  identityWithoutGrant: "unverified" | "unknown" | "exhausted";
  proposals: readonly TrustedF2Proposal[];
  facts: readonly TrustedF2PromptFact[];
  capabilities: readonly F2CapabilityAvailability[];
  smsMutationGate?: F2SmsMutationGate | undefined;
  voiceMutationEnabled?: boolean;
  /** Server clock for grant freshness; defaults to the current process clock. */
  asOf?: string;
}>;

/**
 * Creates the only F2 model context from durable conversation state and typed,
 * server-owned gateway results. It never queries a provider or retrieves values.
 */
export function buildF2PromptContext(input: F2PromptContextBuildInput): F2PromptContext {
  const conversation = conversationSchema.parse(input.conversation);
  if (conversation.admission.mode !== "full") throw new Error("f2_context_requires_full_conversation");
  const phase = f2PhaseSchema.parse(input.phase);
  const latestCallerInput = latestInput(conversation);
  for (const item of conversation.callerContext) {
    const source = conversation.inputs.find((input) => input.id === item.sourceId);
    if (source === undefined || source.body.trim().slice(0, 160).trim() !== item.text
      || source.questionId && !["patient_status", "request_clarification", "slot_selection"].includes(source.questionKind ?? "")) {
      throw new Error("f2_context_caller_memory_source_invalid");
    }
  }
  const callerInputBundle = selectPendingCallerInputs(conversation, latestCallerInput);
  const asOf = timestamp.parse(input.asOf ?? new Date().toISOString());
  const proposals = proposalMap(input.proposals);
  const requestIds = new Set(conversation.requests.map((request) => request.id));
  if ([...proposals.keys()].some((requestId) => !requestIds.has(requestId))) throw new Error("f2_context_proposal_request_missing");
  const agenda = conversation.requests.map((request) => {
    const sourceHistory = requestSourceHistory(conversation, request.sourceIds);
    const supplied = proposals.get(request.id);
    if (supplied !== undefined && supplied.requestRevision !== request.revision) throw new Error("f2_context_proposal_revision_mismatch");
    const durable = request.fullProposal === undefined ? null : fullRequestProposalSchema.parse(request.fullProposal);
    if (durable !== null && supplied !== undefined && JSON.stringify(durable) !== JSON.stringify(supplied.proposal)) throw new Error("f2_context_proposal_conflict");
    const fullProposal = durable ?? supplied?.proposal ?? null;
    return {
      serverRequestId: request.id,
      requestRevision: request.revision,
      state: request.state,
      fullProposal,
      acceptedDecision: fullProposal === null ? null : decideFullRequest(fullProposal),
      aiResolution: request.aiResolution ?? null,
      callerSummary: request.originalRequest,
      ...sourceHistory,
    };
  });
  const identity = identityFor(conversation, input.currentGrant, input.identityWithoutGrant, agenda.map((item) => item.serverRequestId), asOf);
  const capabilities = frozenCapabilities(input.capabilities);
  const mutationGate = conversation.admission.channel === "voice"
    ? input.voiceMutationEnabled === true
      ? { channel: "voice" as const, state: "synthetic_exact_consent" as const, authorityReceipt: null,
        reason: "Synthetic-only voice mutation requires the server's exact proposal readback to finish, followed by a current explicit caller answer." }
      : { channel: "voice" as const, state: "closed" as const, authorityReceipt: null, reason: "Voice mutation authority is not available in F2." }
    : smsGate(input.smsMutationGate);
  return f2PromptContextSchema.parse({
    schemaVersion: 1,
    versions: { promptVersion: F2_FULL_MASTER_PROMPT_VERSION, toolSchemaVersion: F2_FULL_TOOL_SCHEMA_VERSION, ...input.versions },
    conversation: { conversationId: conversation.id, revision: conversation.revision, ownerEpoch: conversation.ownerEpoch, channel: conversation.admission.channel, mode: "full" },
    planningBinding: { serverSourceEventId: latestCallerInput?.id ?? null, expectedConversationRevision: conversation.revision, expectedOwnerEpoch: conversation.ownerEpoch },
    latestCallerInput: latestCallerInput === null ? null : { sourceId: latestCallerInput.id, text: latestCallerInput.body },
    callerInputBundle: callerInputBundle.map((source) => ({ sourceId: source.id, text: source.body })),
    callerContext: conversation.admission.channel === "voice"
      ? conversation.callerContext.filter((item) => item.sourceId !== latestCallerInput?.id) : [],
    phase,
    agenda,
    pendingQuestion: conversation.pendingQuestion,
    identity,
    facts: input.facts.map((fact) => fact.status === "accepted"
      ? { status: "accepted" as const, factId: fact.factId, statement: fact.statement, receipt: { receiptId: fact.receiptId, sourceVersion: fact.sourceVersion, issuedAt: fact.sourceTimestamp } }
      : fact),
    interrupt: conversation.emergency === null ? { kind: "none" as const } : { kind: "emergency" as const, sourceEventId: conversation.emergency.sourceEventId },
    mutationGate,
    capabilities,
  });
}

function requestSourceHistory(conversation: Conversation, sourceIds: readonly string[]) {
  const byId = new Map(conversation.inputs.map((input) => [input.id, input]));
  const reusable = sourceIds.map((sourceId) => byId.get(sourceId)).filter((source): source is Conversation["inputs"][number] => source !== undefined
    && (conversation.admission.channel === "sms" || source.questionId === undefined || source.questionId.endsWith("-patient_status") || source.questionId.endsWith("-request_clarification")))
    .sort((a, b) => a.sequence - b.sequence);
  const selected = reusable.length <= 8 ? reusable : [...reusable.slice(0, 4), ...reusable.slice(-4)];
  return { callerSourceDetails: selected.map((source) => ({ sourceId: source.id, text: source.body.slice(0, 1_000), truncated: source.body.length > 1_000, historical: true as const })),
    omittedSourceCount: reusable.length - selected.length };
}

function latestInput(conversation: Conversation): Conversation["inputs"][number] | null {
  return conversation.inputs.reduce<Conversation["inputs"][number] | null>((current, item) => current === null || item.sequence > current.sequence ? item : current, null);
}

/** The server's bounded, same-conversation text source selection for planning. */
export function selectPendingCallerInputs(conversation: Conversation, latest: Conversation["inputs"][number] | null): readonly Conversation["inputs"][number][] {
  if (latest === null) return [];
  if (conversation.admission.channel !== "sms") return [latest];
  const claimed = new Set(conversation.requests.flatMap((request) => request.sourceIds));
  const question = conversation.pendingQuestion;
  const answeringCurrentQuestion = question !== null && latest.questionId === question.id && latest.sequence > question.activatedRevision;
  const ordered = [...conversation.inputs].sort((a, b) => a.sequence - b.sequence);
  const bundle: Conversation["inputs"][number][] = [];
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index]!;
    if (item.sequence > latest.sequence) continue;
    if (item !== latest && (claimed.has(item.id) && !answeringCurrentQuestion
      || conversation.messages.some((message) => message.id === `f2-sms-reply-${createHash("sha256").update(item.id).digest("hex")}`))) break;
    if (answeringCurrentQuestion ? item.questionId !== question!.id || item.sequence <= question!.activatedRevision
      : item.questionId !== latest.questionId) break;
    bundle.unshift(item);
    if (bundle.length > 8) throw new Error("f2_context_pending_input_bundle_overflow");
  }
  return bundle;
}

function proposalMap(raw: readonly TrustedF2Proposal[]): Map<string, TrustedF2Proposal> {
  const proposals = new Map<string, TrustedF2Proposal>();
  for (const candidate of raw) {
    const proposal = trustedProposalSchema.parse(candidate);
    if (proposals.has(proposal.requestId)) throw new Error("f2_context_proposal_duplicate");
    proposals.set(proposal.requestId, proposal);
  }
  return proposals;
}

function identityFor(conversation: Conversation, rawGrant: SyntheticIdentityGrant | null, withoutGrant: "unverified" | "unknown" | "exhausted", requestIds: readonly string[], asOf: string) {
  if (rawGrant === null) return { status: identityStatusSchema.parse(withoutGrant), grantReceipt: null };
  const grant = syntheticIdentityGrantSchema.parse(rawGrant);
  if (grant.binding.scope.practiceId !== conversation.admission.practiceId || grant.binding.instanceId !== conversation.admission.instanceId
    || grant.binding.conversationId !== conversation.id || !requestIds.includes(grant.binding.requestId)) throw new Error("f2_context_grant_binding_mismatch");
  if (Date.parse(grant.expiresAt) <= Date.parse(asOf)) throw new Error("f2_context_grant_expired");
  return { status: "verified" as const, grantReceipt: { receiptId: grant.id, sourceVersion: String(grant.version), issuedAt: grant.issuedAt } };
}

function frozenCapabilities(raw: readonly F2CapabilityAvailability[]) {
  const byCapability = new Map<string, F2CapabilityAvailability>();
  for (const candidate of raw) {
    const availability = capabilityAvailabilitySchema.parse(candidate);
    if (byCapability.has(availability.capability)) throw new Error("f2_context_capability_duplicate");
    byCapability.set(availability.capability, availability);
  }
  if (byCapability.size !== fullExecutableCapabilitySchema.options.length || fullExecutableCapabilitySchema.options.some((capability) => !byCapability.has(capability))) throw new Error("f2_context_capability_inventory_mismatch");
  return fullExecutableCapabilitySchema.options.map((capability) => byCapability.get(capability)!);
}

function smsGate(raw: F2SmsMutationGate | undefined) {
  if (raw === undefined) throw new Error("f2_context_sms_mutation_gate_missing");
  const gate = smsMutationGateSchema.parse(raw);
  return { channel: "sms" as const, ...gate };
}
