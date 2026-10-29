import { ConversationCipher, type PostgresConversationStore } from "./conversation-store.js";
import type { Conversation, ConversationScope } from "./conversation-contract.js";
import { F2ExecutionGateway } from "./f2-execution-gateway.js";
import { F2HandoffService } from "./f2-handoff.js";
import { vegasVascularKnowledgePack } from "./f2-knowledge.js";
import { F2RuntimeContext } from "./f2-runtime-context.js";
import { F2SmsAuthorityResolver, F2SmsConsentService } from "./f2-sms-consent.js";
import { createF2SmsTurn, OpenAIF2SmsTextInterpreter, type F2TextTransport, type F2SmsFailure } from "./f2-sms-turn.js";
import { syntheticDatasetScopeSchema, type SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import { PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";
import { F2TurnCoordinator } from "./f2-turn-coordinator.js";
import { F2VoiceDriver } from "./f2-voice-driver.js";
import { F2VoiceConsentService } from "./f2-voice-consent.js";
import { fullAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { bootstrapF2DemoFixtures, f2DemoFixtureIdentity } from "./f2-demo-fixtures.js";
import { F2ReadDeliveryService } from "./f2-read-delivery.js";
import type { ControlledTransferCoordinator } from "./controlled-transfer-coordinator.js";
import { PostgresControlledCallbackSaveFailures } from "./controlled-callback-save-failure.js";
import { PostgresControlledProtectedReadFailure } from "./controlled-protected-read-failure.js";
import { equivalentCanonicalOfferTranscript, PostgresControlledOfferExpiry } from "./controlled-offer-expiry.js";

/** Separate full-mode composition; no provider call, live patient lookup, or migration runs here. */
export function createF2Runtime(options: {
  instance: VoiceAppInstance; dataset: SyntheticDatasetScope; databaseUrl: string; cipher: ConversationCipher;
  conversations: PostgresConversationStore; textModel: string; openAIApiKey: string;
  textTransport?: F2TextTransport;
  onSmsFailure?: (failure: F2SmsFailure) => void;
  controlledTransfer?: Pick<ControlledTransferCoordinator, "start">;
  dialoguePolicy?: "legacy" | "adaptive";
  voiceMutationPolicy?: "disabled" | "synthetic_exact_readback";
  controlledCallbackSaveFailures?: boolean;
  controlledProtectedReadFailure?: boolean;
  controlledOfferExpiry?: boolean;
}) {
  const instance = fullAppInstanceSchema.parse(options.instance);
  if (options.controlledCallbackSaveFailures === true && instance.dataMode !== "synthetic_only") throw new Error("controlled_callback_failure_synthetic_full_only");
  if (options.controlledProtectedReadFailure === true && instance.dataMode !== "synthetic_only") throw new Error("controlled_protected_read_failure_synthetic_full_only");
  if (options.controlledOfferExpiry === true && instance.dataMode !== "synthetic_only") throw new Error("controlled_offer_expiry_synthetic_only");
  if (instance.instanceId !== f2DemoFixtureIdentity.instanceId) throw new Error("f2_demo_instance_not_configured");
  const dataset = syntheticDatasetScopeSchema.parse(options.dataset);
  if (dataset.practiceId !== instance.practiceId || dataset.practiceId !== f2DemoFixtureIdentity.datasetScope.practiceId
    || dataset.datasetId !== f2DemoFixtureIdentity.datasetScope.datasetId || dataset.generation !== f2DemoFixtureIdentity.datasetScope.generation) throw new Error("f2_demo_dataset_not_configured");
  let practice!: PostgresF2SyntheticPracticeStore;
  const controlledOfferExpiry = options.controlledOfferExpiry === true ? new PostgresControlledOfferExpiry(options.databaseUrl, {
    instance, dataset, conversations: options.conversations, enabled: true,
    pendingVerification: async (input) => await practice.pendingVerification(input),
    canonicalOffer: async (input) => await controlledOfferTranscriptMatches({ ...input, dataset, conversations: options.conversations,
      practice }),
  }) : undefined;
  const authority = new F2SmsAuthorityResolver({ conversations: options.conversations, practice: () => practice });
  practice = controlledOfferExpiry === undefined
    ? new PostgresF2SyntheticPracticeStore(options.databaseUrl, options.cipher, authority)
    : new PostgresF2SyntheticPracticeStore(options.databaseUrl, options.cipher, authority, undefined, undefined,
      { consume: controlledOfferExpiry.consume.bind(controlledOfferExpiry) });
  const consent = new F2SmsConsentService({ conversations: options.conversations, practice, dataset });
  const voiceConsent = options.voiceMutationPolicy === "synthetic_exact_readback"
    ? new F2VoiceConsentService({ conversations: options.conversations, practice, dataset }) : undefined;
  const protectedReadFailure = options.controlledProtectedReadFailure === true
    ? new PostgresControlledProtectedReadFailure(options.databaseUrl, { instance, conversations: options.conversations, enabled: true }) : undefined;
  const gateway = new F2ExecutionGateway({ conversationStore: options.conversations, store: practice, dataset,
    model: options.textModel, promptVersion: instance.promptVersion,
    ...(protectedReadFailure === undefined ? {} : { controlledProtectedReadFailure: protectedReadFailure }) });
  const callbackFailures = options.controlledCallbackSaveFailures === true
    ? new PostgresControlledCallbackSaveFailures(options.databaseUrl, { instance, conversations: options.conversations, enabled: true }) : undefined;
  const coordinator = new F2TurnCoordinator({ conversations: options.conversations, gateway, smsConsent: consent,
    ...(callbackFailures === undefined ? {} : { controlledCallbackSaveFailure: callbackFailures }),
    ...(voiceConsent === undefined ? {} : { voiceConsent }),
    handoffs: new F2HandoffService({ store: options.conversations, instance,
      ...(options.controlledTransfer === undefined ? {} : { controlledTransfer: options.controlledTransfer }) }) });
  const versions = { model: options.textModel, knowledgeVersion: vegasVascularKnowledgePack.packVersion, policyVersion: instance.configVersion };
  const context = new F2RuntimeContext({ conversations: options.conversations, practice, dataset, ...versions,
    voiceMutationEnabled: voiceConsent !== undefined });
  const delivery = new F2ReadDeliveryService({ conversations: options.conversations, practice, dataset });
  const voice = new F2VoiceDriver({ projection: context, coordinator, dialoguePolicy: options.dialoguePolicy ?? "legacy",
    readAuthority: ({ conversation, requestId, result }) => delivery.authorityForRead({ conversation, requestId, receiptId: result.receiptId }),
    presentation: (input) => delivery.voicePresented(input),
    ...(voiceConsent === undefined ? {} : {
      proposalAuthority: async ({ scope, requestId, result }: { scope: ConversationScope; requestId: string; result: import("./f2-turn-coordinator.js").F2TurnResult }) => {
        // A normal slot list is not yet a singular consent proposal. Attendance
        // has no slot-selection stage, so admit it only once its durable consent
        // question is current; the consent service revalidates every binding.
        if (result.kind === "appointment_offered" && !currentAttendanceConsent(await options.conversations.get(scope), requestId)) return null;
        return await voiceConsent.prepareExactProposal({ scope, requestId });
      },
      proposalPresentation: (input: { scope: import("./conversation-contract.js").ConversationScope; presentation: import("./f2-synthetic-practice-contract.js").VoiceProposalReadbackReceipt }) => voiceConsent.recordReadback({ scope: input.scope, receipt: input.presentation }),
    }) });
  const sms = createF2SmsTurn({ conversations: options.conversations, practice, dataset, coordinator, ...versions,
    ...(options.onSmsFailure === undefined ? {} : { onFailure: options.onSmsFailure }),
    textModelAdapter: new OpenAIF2SmsTextInterpreter({ apiKey: options.openAIApiKey, ...(options.textTransport === undefined ? {} : { transport: options.textTransport }) }) });
  return { practice, voice, sms, consent, voiceConsent, delivery, controlledOfferExpiry, protectedReadFailure,
    async start() { await controlledOfferExpiry?.ready(); await protectedReadFailure?.ready(); if (!await practice.ready()) throw new Error("f2_database_not_ready"); await bootstrapF2DemoFixtures(practice); },
    async stop() { try { await callbackFailures?.close(); } finally { try { await protectedReadFailure?.close(); } finally { try { await controlledOfferExpiry?.close(); } finally { await practice.close(); } } } },
  };
}

export function currentAttendanceConsent(conversation: Conversation | null, requestId: string): boolean {
  const question = conversation?.pendingQuestion;
  const request = conversation?.requests.find((candidate) => candidate.id === requestId);
  return conversation?.phase === "active" && conversation.owner === "ai" && !conversation.suppressed && conversation.emergency === null
    && question?.kind === "attendance_consent" && question.requestId === requestId && request !== undefined
    && question.requestRevision === request.revision && request.state === "draft"
    && request.fullProposal?.capability === "appointment_attendance_confirm";
}

async function controlledOfferTranscriptMatches(input: {
  scope: ConversationScope; requestId: string; requestRevision: number; ownerEpoch: number; voiceEpoch: number; proposalId: string; transcript: string;
  dataset: SyntheticDatasetScope; conversations: Pick<PostgresConversationStore, "get">;
  practice: Pick<PostgresF2SyntheticPracticeStore, "currentGrant" | "currentProposal" | "describeProposalSlots">;
}): Promise<boolean> {
  const before = await input.conversations.get(input.scope);
  if (!currentControlledSlotOffer(before, input)) return false;
  const binding = { scope: input.dataset, instanceId: input.scope.instanceId, conversationId: input.scope.conversationId,
    requestId: input.requestId, requestRevision: input.requestRevision, observedConversationRevision: before.revision };
  const trusted = { expectedOwnerEpoch: input.ownerEpoch };
  try {
    const grant = await input.practice.currentGrant({ trusted, binding });
    if (grant === null) return false;
    const proposal = await input.practice.currentProposal({ trusted, binding });
    if (proposal === null || proposal.id !== input.proposalId || !("slots" in proposal) || proposal.slots.length !== 2
      || proposal.patientId !== grant.patientId) return false;
    const slots = await input.practice.describeProposalSlots({ trusted, binding, patientId: grant.patientId, grantId: grant.id, proposalId: proposal.id });
    if (slots.length !== 2) return false;
    // Do not let an offer acquired under an earlier owner/question snapshot
    // authorize the later observation write.
    const after = await input.conversations.get(input.scope);
    if (!currentControlledSlotOffer(after, input)) return false;
    const expected = `I can offer ${slots[0]!.localTime}, or ${slots[1]!.localTime}. Which works better for you?`;
    return equivalentCanonicalOfferTranscript(input.transcript, expected);
  } catch { return false; }
}

function currentControlledSlotOffer(conversation: Conversation | null, input: {
  requestId: string; requestRevision: number; ownerEpoch: number; voiceEpoch: number;
}): conversation is Conversation {
  const question = conversation?.pendingQuestion;
  const request = conversation?.requests.find((candidate) => candidate.id === input.requestId);
  return conversation !== null && conversation.phase === "active" && conversation.owner === "ai" && !conversation.suppressed
    && conversation.emergency === null && conversation.ownerEpoch === input.ownerEpoch && conversation.voiceEpoch === input.voiceEpoch
    && request?.state === "draft" && request.revision === input.requestRevision && question?.kind === "slot_selection"
    && question.requestId === input.requestId && question.requestRevision === input.requestRevision;
}
