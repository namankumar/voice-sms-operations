import { createHash } from "node:crypto";

import { z } from "zod";

import { scopeOf, type AiResolutionResult, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationJob, ConversationJobResult } from "./conversation-jobs.js";
import type { ConversationStore } from "./conversation-store.js";
import { compileF2Prompt, parseF2ControlToolCall, type CompiledF2Prompt, type F2ControlToolCall, type F2PromptContext } from "./f2-prompt.js";
import { F2RuntimeContext } from "./f2-runtime-context.js";
import { createGuardedF2ResponsesTransport } from "./f2-responses-transport.js";
import { fullRequestProposalSchema, type FullRequestProposal } from "./f2-request-policy.js";
import { syntheticSlotSchema, type SyntheticDatasetScope } from "./f2-synthetic-practice-contract.js";
import type { PostgresF2SyntheticPracticeStore } from "./f2-synthetic-practice-store.js";
import { type F2TurnCoordinator, type F2TurnResult } from "./f2-turn-coordinator.js";

const payloadSchema = z.object({ sourceId: z.string().min(1).max(200) }).strict();
const modelOutputSchema = z.object({
  status: z.literal("completed"),
  output: z.array(z.object({ type: z.string() }).passthrough()).max(16),
}).passthrough();
const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  name: z.string().min(1).max(120),
  arguments: z.string().max(16_384),
}).passthrough();
const outgoingTextSchema = z.string().trim().min(1).max(1_600);
const fixtureTextSchema = z.string().trim().min(1).max(500);
const appointmentReadSchema = z.object({ label: fixtureTextSchema }).strict();
const appointmentDetailsReadSchema = z.object({ appointments: z.array(z.object({
  appointmentId: z.string().trim().min(1).max(200), slotId: z.string().trim().min(1).max(200), startsAt: z.string().datetime(), endsAt: z.string().datetime(),
  appointmentType: fixtureTextSchema, location: fixtureTextSchema, version: z.number().int().nonnegative(), attendanceConfirmed: z.boolean(),
}).strict()).max(8) }).strict();
const referralReadSchema = z.object({ status: fixtureTextSchema }).strict();
const billingReadSchema = z.object({ amount: z.string().regex(/^\d{1,8}(?:\.\d{2})?$/), currency: z.literal("USD"), label: fixtureTextSchema }).strict();
const offeredSlotSchema = syntheticSlotSchema.transform((slot) => ({ id: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, location: slot.location }));
// F2 is restricted to the approved synthetic dataset; its persisted
// slots are UTC instants and deliberately do not repeat this clinic setting.
const SYNTHETIC_PRACTICE_TIME_ZONE = "UTC";

export type F2TextRequest = Readonly<{
  model: string;
  instructions: string;
  input: string;
  store: false;
  service_tier: "default";
  max_output_tokens: number;
  parallel_tool_calls: false;
  tools: { type: "function"; name: string; description: string; strict: true; parameters: Record<string, unknown> }[];
}>;
export type F2TextTransport = (request: F2TextRequest, signal: AbortSignal) => Promise<unknown>;

export type F2SmsToolCall = Readonly<{ id: string; name: string; arguments: unknown }>;
export type F2SmsFailure = { scope: ConversationScope; stage: "context" | "input_overflow" | "interpretation" | "dispatch" | "render" | "queue" };
export interface F2SmsTurnInterpreter {
  interpret(input: { model: string; prompt: CompiledF2Prompt; signal: AbortSignal }): Promise<F2SmsToolCall | null>;
}
/** Hubble owns durable gateway reads needed to assemble this projection. */
export interface F2SmsPromptContextPort {
  build(input: { conversation: Conversation; sourceId: string; requestId?: string }): Promise<F2PromptContext>;
  requestForSource?(input: { conversation: Conversation; sourceId: string; proposedCapability?: FullRequestProposal["capability"] }): string | null | Promise<string | null>;
}
/** Only this server port may turn typed coordinator results into customer-visible text. */
export interface F2SmsResponseRenderer {
  render(input: { conversation: Conversation; requestId: string; sourceId: string; result: F2TurnResult }): Promise<string | null>;
}

export type F2SmsTurnFactoryOptions = Readonly<{
  conversations: Pick<ConversationStore, "get" | "getEvent" | "execute" | "history" | "queueSmsReplyOnce">;
  practice: Pick<PostgresF2SyntheticPracticeStore, "currentGrant" | "currentProposal" | "currentReadFacts" | "describeProposalText">
    & Partial<Pick<PostgresF2SyntheticPracticeStore, "describeProposalSlots">>;
  dataset: SyntheticDatasetScope;
  coordinator: Pick<F2TurnCoordinator, "dispatch">;
  textModelAdapter: F2SmsTurnInterpreter;
  model: string;
  knowledgeVersion: string;
  policyVersion: string;
  renderer?: F2SmsResponseRenderer;
  deadlineMs?: number;
  onFailure?: (failure: F2SmsFailure) => void;
}>;

/** Composition entrypoint. It does not register queues, HTTP routes, or providers. */
export function createF2SmsTurn(options: F2SmsTurnFactoryOptions): F2SmsTurn {
  const runtime = new F2RuntimeContext({ conversations: options.conversations, practice: options.practice, dataset: options.dataset,
    model: options.model, knowledgeVersion: options.knowledgeVersion, policyVersion: options.policyVersion });
  const context: F2SmsPromptContextPort = {
    requestForSource: async (input) => await runtime.requestForSource(input),
    build: async ({ conversation, requestId }) => await runtime.build({ conversation, ...(requestId === undefined ? {} : { requestId }),
      smsMutationGate: { state: "exact_consent_required", consentReceipt: null, reason: "Exact SMS consent has not been recorded." } }),
  };
  return new F2SmsTurn({ store: options.conversations, coordinator: options.coordinator, context,
    renderer: options.renderer ?? defaultResponseRenderer, model: options.model, interpreter: options.textModelAdapter,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.onFailure === undefined ? {} : { onFailure: options.onFailure }) });
}

/**
 * One bounded Responses API invocation. It accepts only a single F2 control
 * proposal and deliberately discards model prose.
 */
export class OpenAIF2SmsTextInterpreter implements F2SmsTurnInterpreter {
  private readonly transport: F2TextTransport;

  constructor(options: { apiKey: string; transport?: F2TextTransport }) {
    if (!options.apiKey.trim()) throw new Error("openai_api_key_required");
    if (options.transport !== undefined) this.transport = options.transport;
    else this.transport = createGuardedF2ResponsesTransport({ apiKey: options.apiKey });
  }

  async interpret(input: { model: string; prompt: CompiledF2Prompt; signal: AbortSignal }): Promise<F2SmsToolCall | null> {
    if (input.signal.aborted || input.model !== input.prompt.model || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.model)) {
      throw new Error("f2_text_interpretation_configuration_invalid");
    }
    try {
      const raw = await this.transport({
        model: input.model,
        instructions: input.prompt.system,
        input: "Interpret the latest caller turn in the protected context and return at most one available control tool. Do not perform actions or make completion claims.",
        store: false,
        service_tier: "default",
        max_output_tokens: 800,
        parallel_tool_calls: false,
        tools: input.prompt.tools.map(({ function: tool }) => ({ type: "function" as const, name: tool.name, description: tool.description,
          strict: true as const, parameters: { ...tool.parameters, required: [...tool.parameters.required] } })),
      }, input.signal);
      if (input.signal.aborted) throw new Error("aborted");
      const response = modelOutputSchema.parse(raw);
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length > 1) throw new Error("f2_text_multiple_tools");
      if (calls.length === 0) return null;
      const call = functionCallSchema.parse(calls[0]);
      if (!input.prompt.tools.some((tool) => tool.function.name === call.name)) throw new Error("f2_text_tool_not_allowed");
      return { id: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) as unknown };
    } catch {
      throw new Error(input.signal.aborted ? "f2_text_interpretation_aborted" : "f2_text_interpretation_failed");
    }
  }
}

/**
 * Full-mode SMS worker. The coordinator creates and binds a request atomically
 * with its accepted plan; this worker fences every async boundary and owns
 * only its queued reply.
 */
export class F2SmsTurn {
  private readonly interpreter: F2SmsTurnInterpreter;

  constructor(private readonly options: {
    store: Pick<ConversationStore, "get" | "getEvent" | "execute" | "history" | "queueSmsReplyOnce">;
    coordinator: Pick<F2TurnCoordinator, "dispatch">;
    context: F2SmsPromptContextPort;
    renderer: F2SmsResponseRenderer;
    model: string;
    interpreter?: F2SmsTurnInterpreter;
    openAIApiKey?: string;
    transport?: F2TextTransport;
    deadlineMs?: number;
    onFailure?: (failure: F2SmsFailure) => void;
  }) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.model)) throw new Error("f2_sms_model_identity_invalid");
    this.interpreter = options.interpreter ?? new OpenAIF2SmsTextInterpreter({ apiKey: options.openAIApiKey ?? "",
      ...(options.transport === undefined ? {} : { transport: options.transport }) });
  }

  async handleSmsTurn(job: Pick<ConversationJob, "kind" | "scope" | "payload">, context: { signal?: AbortSignal }): Promise<ConversationJobResult> {
    return this.handleSmsTurnAttempt(job, context, 0);
  }

  private async handleSmsTurnAttempt(job: Pick<ConversationJob, "kind" | "scope" | "payload">, context: { signal?: AbortSignal }, revisionRetries: number): Promise<ConversationJobResult> {
    if (job.kind !== "sms_turn" || context.signal?.aborted) return { code: "not_needed" };
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) return { code: "not_needed" };
    const sourceId = payload.data.sourceId;
    const replyEventId = eventId("reply", sourceId);
    const prior = (await this.options.store.history(job.scope)).some(({ input, receipt }) => receipt.accepted && input.command.type === "sms.queue"
      && (input.eventId === replyEventId || input.eventId.startsWith(`${replyEventId}-r`)));
    if (prior) return { code: "completed" };

    const initial = await this.options.store.get(job.scope);
    if (!this.authorized(initial, sourceId, undefined, context.signal)) return { code: "not_needed" };
    const ownerEpoch = initial.ownerEpoch;
    const resolvedRequest = initial.requests.find((request) => request.state === "ai_resolved" && request.sourceIds.includes(sourceId));
    if (resolvedRequest !== undefined) {
      try {
        const committed = await this.committedActionForSource(initial, sourceId, resolvedRequest.id);
        if (committed === null) return { code: "not_needed" };
        return await this.queue(initial, sourceId, ownerEpoch, actionConfirmation(committed), context.signal, `f2-action-${committed.receiptId}`);
      } catch {
        throw new Error("f2_sms_turn_failed");
      }
    }
    const patientFollowup = patientStatusFollowup(initial, sourceId);
    const boundRequest = initial.requests.find((request) => request.state === "draft" && request.sourceIds.includes(sourceId));
    const requestId = patientFollowup?.id ?? await this.options.context.requestForSource?.({ conversation: initial, sourceId }) ?? boundRequest?.id ?? `f2-request-${digest(`${initial.id}:${sourceId}`).slice(0, 32)}`;
    if (requestId === null) return { code: "not_needed" };

    let stage: F2SmsFailure["stage"] = "context";
    try {
      let tool: F2SmsToolCall | null;
      const prompt = compileF2Prompt(await this.options.context.build({ conversation: initial, sourceId,
        ...((patientFollowup ?? boundRequest) === undefined ? {} : { requestId: (patientFollowup ?? boundRequest)!.id }) }));
      const interpreterPrompt = promptWithCurrentQuestion(prompt);
      if (interpreterPrompt.model !== this.options.model || !this.authorized(await this.options.store.get(job.scope), sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
      stage = "interpretation";
      try { tool = await this.interpret(interpreterPrompt, context.signal); }
      catch {
        this.reportFailure(job.scope, stage);
        const current = await this.options.store.get(job.scope);
        if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        stage = "queue";
        return await this.queue(current, sourceId, ownerEpoch,
          "I'm having trouble processing your message. I haven't confirmed any action. Please try again, or call the office for help.", context.signal);
      }
      if (tool === null) {
        const current = await this.options.store.get(job.scope);
        if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        stage = "queue";
        return await this.queue(current, sourceId, ownerEpoch, patientFollowup === null ? "Please tell me a little more about what you need." : questionText("patient_status"), context.signal);
      }
      let parsedTool: F2ControlToolCall | null = null;
      try {
        parsedTool = parseF2ControlToolCall({ name: tool.name, arguments: tool.arguments });
        tool = { id: tool.id, ...parsedTool };
      } catch {
        tool = null;
      }
      if (tool === null) {
        this.reportFailure(job.scope, "interpretation");
        const current = await this.options.store.get(job.scope);
        if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        stage = "queue";
        return await this.queue(current, sourceId, ownerEpoch, patientFollowup === null ? "Please tell me a little more about what you need." : questionText("patient_status"), context.signal);
      }

      const beforeDispatch = await this.options.store.get(job.scope);
      if (!this.authorized(beforeDispatch, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
      if (beforeDispatch.revision !== interpreterPrompt.dynamicContext.conversation.revision) {
        if (revisionRetries < 2) return this.handleSmsTurnAttempt(job, context, revisionRetries + 1);
        stage = "queue";
        return await this.queue(beforeDispatch, sourceId, ownerEpoch,
          "I received an update while working on your request. Please send that last message again so I don't miss anything.", context.signal);
      }
      let dispatchRequestId = requestId;
      if (patientFollowup === null && parsedTool?.name === "propose_full_request") {
        dispatchRequestId = await this.options.context.requestForSource?.({ conversation: beforeDispatch, sourceId,
          proposedCapability: parsedTool.arguments.capability }) ?? dispatchRequestId;
      }
      if (patientFollowup !== null) {
        if (parsedTool?.name === "propose_full_request") {
          if (sameRequestIntent(parsedTool.arguments, patientFollowup.proposal)) {
            // Preserve the current request's durable intent; only its status answer advances.
            tool = { id: tool.id, name: parsedTool.name, arguments: { ...patientFollowup.proposal, patientStatus: parsedTool.arguments.patientStatus } };
          } else {
            // A model-interpreted change of topic starts a separate request from this source.
            dispatchRequestId = `f2-request-${digest(`${beforeDispatch?.id ?? initial.id}:${sourceId}`).slice(0, 32)}`;
          }
        } else if (tool.name !== "propose_full_interrupt") {
          stage = "queue";
          return await this.queue(beforeDispatch, sourceId, ownerEpoch, questionText("patient_status"), context.signal);
        }
      }
      // The coordinator also creates a staff-owned request for an explicit
      // human handoff. Every other follow-up control must already be bound.
      const bootstrap = tool.name === "propose_full_request" || tool.name === "propose_full_interrupt";
      if (!bootstrap && beforeDispatch.requests.find((request) => request.id === dispatchRequestId)?.sourceIds.includes(sourceId) !== true) return { code: "not_needed" };
      stage = "dispatch";
      const bundle = interpreterPrompt.dynamicContext.callerInputBundle;
      let sourceEventIds: string[] | undefined;
      if (tool.name === "propose_full_request" && patientFollowup === null && bundle.length > 1
        && !beforeDispatch.requests.some((request) => request.id === dispatchRequestId)) {
        const ids = bundle.map((item) => item.sourceId);
        if (bundle.some((item) => beforeDispatch.inputs.find((source) => source.id === item.sourceId)?.body !== item.text)
          || ids.at(-1) !== sourceId || ids.some((id) => beforeDispatch.requests.some((request) => request.sourceIds.includes(id)))) {
          return { code: "not_needed" };
        }
        sourceEventIds = ids;
      }
      const dispatchInput = { conversation: beforeDispatch, requestId: dispatchRequestId, sourceId,
        invocationId: invocationId(sourceId, tool.id), toolCall: { name: tool.name, arguments: tool.arguments },
        ...(sourceEventIds === undefined ? {} : { sourceEventIds }) };
      const result = await this.options.coordinator.dispatch(dispatchInput);
      if (context.signal?.aborted) return { code: "not_needed" };
      if (result.kind === "obsolete") return { code: "not_needed" };

      const current = await this.options.store.get(job.scope);
      if (result.kind === "rejected" && tool.name === "propose_full_request"
        && !beforeDispatch.requests.some((request) => request.sourceIds.includes(sourceId))) {
        // Our own accepted draft can precede a later execution failure; only another accepted plan wins this source.
        const ownPlanEventId = `full-plan-${dispatchInput.invocationId}`;
        const history = await this.options.store.history(job.scope);
        const ownPlanAccepted = history.some(({ input, receipt }) => input.eventId === ownPlanEventId && receipt.accepted);
        const competingPlanAccepted = history.some(({ input, receipt }) => input.eventId !== ownPlanEventId && receipt.accepted
          && input.command.type === "request.draft" && input.proposal?.sourceId === sourceId);
        if (!ownPlanAccepted && competingPlanAccepted) return { code: "not_needed" };
      }
      if (result.kind === "rejected" && result.reason === "context_stale" && this.authorized(current, sourceId, ownerEpoch, context.signal)) {
        if (revisionRetries < 2) return this.handleSmsTurnAttempt(job, context, revisionRetries + 1);
        stage = "queue";
        return await this.queue(current, sourceId, ownerEpoch,
          "I received an update while working on your request. Please send that last message again so I don't miss anything.", context.signal);
      }
      if (result.kind === "interrupt" && result.type === "emergency") {
        return current === null ? { code: "not_needed" } : await this.queueEmergencyInstruction(current, sourceId, ownerEpoch, context.signal);
      }
      if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
      if (result.kind === "sms_consent_delegated") {
        if (!result.committed) {
          const body = exactConsentNotConfirmedText(current, result.requestId);
          if (body === null) return { code: "not_needed" };
          stage = "queue";
          return await this.queue(current, sourceId, ownerEpoch, body, context.signal);
        }
        const committed = await this.committedActionForSource(current, sourceId, result.requestId);
        if (committed === null) return { code: "not_needed" };
        stage = "queue";
        return await this.queue(current, sourceId, ownerEpoch, actionConfirmation(committed), context.signal, `f2-action-${committed.receiptId}`);
      }
      // Exact-proposal consent has already queued the sole customer-visible SMS.
      // Rendering an attendance proposal has no slots and would otherwise retry.
      if ((result.kind === "appointment_offered" || result.kind === "appointment_selected") && result.queuedMessage) return { code: "completed" };
      stage = "render";
      const body = await this.options.renderer.render({ conversation: current, requestId: dispatchRequestId, sourceId, result });
      if (body === null || context.signal?.aborted) return { code: "completed" };
      stage = "queue";
      return await this.queue(current, sourceId, ownerEpoch, outgoingTextSchema.parse(body), context.signal,
        result.kind === "read" ? `f2-read-${result.receiptId}` : undefined);
    } catch (error) {
      if (stage === "context" && error instanceof Error && error.message === "f2_runtime_context_stale") {
        let current: Conversation | null;
        try { current = await this.options.store.get(job.scope); }
        catch {
          this.reportFailure(job.scope, stage);
          throw new Error("f2_sms_turn_failed");
        }
        if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        if (revisionRetries < 2) return this.handleSmsTurnAttempt(job, context, revisionRetries + 1);
      }
      if (stage === "context" && error instanceof Error && error.message === "f2_context_pending_input_bundle_overflow") {
        this.reportFailure(job.scope, "input_overflow");
        const current = await this.options.store.get(job.scope);
        if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        try {
          return await this.queue(current, sourceId, ownerEpoch,
            "I received several messages together and don't want to miss anything. Please restate your request in one message.", context.signal);
        } catch {
          this.reportFailure(job.scope, "queue");
          throw new Error("f2_sms_turn_failed");
        }
      }
      this.reportFailure(job.scope, stage);
      // The worker retry boundary receives no provider, caller, or store detail.
      throw new Error("f2_sms_turn_failed");
    }
  }

  private reportFailure(scope: ConversationScope, stage: F2SmsFailure["stage"]): void {
    try { this.options.onFailure?.({ scope, stage }); } catch { /* Telemetry cannot change turn authority. */ }
  }

  private authorized(state: Conversation | null, sourceId: string, ownerEpoch?: number, signal?: AbortSignal): state is Conversation {
    return !signal?.aborted && state !== null && state.admission.mode === "full" && state.admission.channel === "sms" && state.phase === "active"
      && state.owner === "ai" && !state.suppressed && state.emergency === null && state.inputs.at(-1)?.id === sourceId
      && (ownerEpoch === undefined || state.ownerEpoch === ownerEpoch);
  }

  private async interpret(prompt: CompiledF2Prompt, parent?: AbortSignal): Promise<F2SmsToolCall | null> {
    if (parent?.aborted) throw new Error("f2_sms_parent_aborted");
    const controller = new AbortController();
    const signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.interpreter.interpret({ model: this.options.model, prompt, signal }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("f2_sms_deadline")); }, this.options.deadlineMs ?? 8_000); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async queue(state: Conversation, sourceId: string, ownerEpoch: number, body: string, signal?: AbortSignal, messageId?: string): Promise<ConversationJobResult> {
    if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    const latest = await this.options.store.get(scopeOf(state));
    if (!this.authorized(latest, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    if (latest.revision !== state.revision) throw new Error("f2_sms_reply_state_changed");
    const checkedMessageId = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(200).parse(messageId ?? `f2-sms-reply-${digest(sourceId)}`);
    // Rejected stale writes must not reserve the reply event ID for a later valid revision.
    const reply = { scope: scopeOf(state), eventId: `${eventId("reply", sourceId)}-r${state.revision}`, expectedRevision: state.revision,
      expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "ai", id: "f2-sms-turn" },
      command: { type: "sms.queue", messageId: checkedMessageId, body } } as const;
    const receipt = this.options.store.queueSmsReplyOnce === undefined
      ? await this.options.store.execute(reply) : await this.options.store.queueSmsReplyOnce(reply, sourceId);
    if (receipt.accepted && !signal?.aborted) return { code: "completed" };
    if (signal?.aborted) return { code: "not_needed" };
    const current = await this.options.store.get(scopeOf(state));
    if (!this.authorized(current, sourceId, ownerEpoch)) return { code: "not_needed" };
    throw new Error("f2_sms_reply_queue_failed");
  }

  private async queueEmergencyInstruction(state: Conversation, sourceId: string, ownerEpoch: number, signal?: AbortSignal): Promise<ConversationJobResult> {
    if (!this.emergencyInstructionAuthorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: eventId("emergency", sourceId), expectedRevision: state.revision,
      expectedOwnerEpoch: state.ownerEpoch, actor: { kind: "system", id: "f2-sms-turn" },
      command: { type: "emergency.sms_instruction", messageId: `f2-sms-emergency-${digest(sourceId)}`, sourceEventId: sourceId } });
    if (receipt.accepted && !signal?.aborted) return { code: "completed" };
    if (signal?.aborted) return { code: "not_needed" };
    const current = await this.options.store.get(scopeOf(state));
    if (!current || !this.emergencyInstructionAuthorized(current, sourceId, ownerEpoch)) return { code: "not_needed" };
    throw new Error("f2_sms_emergency_queue_failed");
  }

  /** The post-assessment state permits exactly the fixed emergency instruction. */
  private emergencyInstructionAuthorized(state: Conversation, sourceId: string, ownerEpoch: number, signal?: AbortSignal): boolean {
    return !signal?.aborted && state.admission.mode === "full" && state.admission.channel === "sms" && state.phase === "active"
      && state.owner === "ai" && !state.suppressed && state.ownerEpoch === ownerEpoch
      && state.inputs.at(-1)?.id === sourceId && state.emergency?.sourceEventId === sourceId;
  }

  /** A committed action can be replayed only when its durable publication names this exact latest source. */
  private async committedActionForSource(state: Conversation, sourceId: string, requestId: string): Promise<Extract<AiResolutionResult, { kind: "action" }> | null> {
    const request = state.requests.find((candidate) => candidate.id === requestId);
    if (request?.state !== "ai_resolved" || !request.sourceIds.includes(sourceId) || request.aiResolution?.kind !== "action") return null;
    const result = request.aiResolution;
    const published = (await this.options.store.history(scopeOf(state))).find((event) => event.receipt.accepted
      && event.input.command.type === "request.resolve_ai" && event.input.command.requestId === request.id
      && event.input.command.sourceEventId === sourceId && event.input.command.result.kind === "action"
      && JSON.stringify(event.input.command.result) === JSON.stringify(result));
    return published === undefined ? null : result;
  }
}

/** Patient status may alter only the request named by the current durable question. */
function patientStatusFollowup(conversation: Conversation, sourceId: string): { id: string; proposal: z.infer<typeof fullRequestProposalSchema> } | null {
  const source = conversation.inputs.at(-1), question = conversation.pendingQuestion;
  if (question === null || source?.id !== sourceId || source.questionId !== question.id || question.kind !== "patient_status" || question.requestId === null || question.requestRevision === null) return null;
  const request = conversation.requests.find((candidate) => candidate.id === question.requestId);
  if (request?.state !== "draft" || request.revision !== question.requestRevision || !request.sourceIds.includes(sourceId)) return null;
  const proposal = fullRequestProposalSchema.safeParse(request.fullProposal);
  return proposal.success ? { id: request.id, proposal: proposal.data } : null;
}
function sameRequestIntent(a: z.infer<typeof fullRequestProposalSchema>, b: z.infer<typeof fullRequestProposalSchema>): boolean {
  return a.capability === b.capability && a.schedulingKind === b.schedulingKind && a.knowledgeTopic === b.knowledgeTopic;
}
function promptWithCurrentQuestion(prompt: CompiledF2Prompt): CompiledF2Prompt {
  const question = prompt.dynamicContext.pendingQuestion;
  if (question?.kind !== "patient_status") return prompt;
  return { ...prompt, system: `${prompt.system}\n\nCURRENT_SERVER_QUESTION: Are you a current patient of Synthetic Practice? First honor an explicit emergency, request for a person, or clear new unrelated request; those take precedence over this question. Otherwise interpret the latest caller input as the answer to this exact question. An affirmative means established, a negative means new, and genuine uncertainty means unknown. This is not identity verification.` };
}

const defaultResponseRenderer: F2SmsResponseRenderer = {
  async render({ result, conversation, requestId }) {
    switch (result.kind) {
      case "no_action": return null;
      case "side_question": return null;
      case "question": return questionText(result.question);
      case "knowledge": return result.answer;
      case "knowledge_unknown": return "I do not have approved information about that. A team member can help.";
      case "identity": return result.state === "exhausted" ? "I could not verify that information. A team member can help." : null;
      case "read": return renderF2ReadResult(result.value);
      case "appointment_offered": return renderAppointmentOffer(result.slots);
      case "appointment_selected": return null;
      case "appointment_withdrawn": return null;
      case "handoff": {
        const question = conversation.pendingQuestion;
        const acknowledgement = result.reason === "appointment_availability_unavailable"
          ? "I don't have an available appointment to offer. A team member can help."
          : result.reason === "appointment_selection_required"
            ? "I couldn't identify one appointment for that request. A team member can help."
            : "A team member can help with that request.";
        return question?.requestId === requestId && ["name", "message", "callback_number_entry", "callback_number"].includes(question.kind)
          ? `${acknowledgement} ${questionText(question.kind as "name" | "message" | "callback_number_entry" | "callback_number")}`
          : acknowledgement;
      }
      case "interrupt": return result.type === "urgent_unclear"
        ? "If this is an emergency, call 911. Are you reporting an emergency, or do you need a callback from the office?" : null;
      case "sms_consent_delegated": return null;
      case "voice_consent_delegated": return null;
      case "callback_captured": return "I've saved your message. The team will return your call.";
      case "callback_paused": return null;
      // This control is never available to SMS; retain exhaustiveness if a malformed result reaches the renderer.
      case "callback_dialogue": return null;
      case "obsolete": return null;
      case "rejected": return "I could not complete that request. A team member can help.";
    }
  },
};

function questionText(kind: Extract<F2TurnResult, { kind: "question" }>["question"]): string {
  switch (kind) {
    case "patient_status": return "Are you a current patient of Synthetic Practice?";
    case "identity_dob": return "Please reply with your date of birth.";
    case "identity_zip": return "Please reply with your ZIP code.";
    case "slot_selection": return "Please reply with the appointment option you prefer.";
    case "appointment_consent": return "Please reply YES only if you want to confirm the appointment option.";
    case "attendance_consent": return "Please reply YES only if you want to confirm attendance.";
    case "request_clarification": return "Please tell me a little more about what you need.";
    case "name": return "Please reply with your name.";
    case "message": return "Please tell me how our team can help.";
    case "callback_number_entry": return "Please reply with your callback number, including the country code.";
    case "callback_number": return "Please reply YES to confirm your callback number, or send the correct number.";
  }
}

/** Canonical renderer for a receipt-verified, typed synthetic read value. */
export function renderF2ReadResult(value: unknown): string {
  const billing = billingReadSchema.safeParse(value);
  if (billing.success) return `${billing.data.label}: $${billing.data.amount} ${billing.data.currency}. This uses test information only.`;
  const appointments = appointmentDetailsReadSchema.safeParse(value);
  if (appointments.success) {
    const times = appointments.data.appointments.map((appointment) => formatAppointmentTime(appointment.startsAt));
    if (times.length === 0) return "You do not have any scheduled test appointments. This uses test information only.";
    return `${times.length === 1 ? `Your test appointment is ${times[0]}.` : `Your test appointments are ${times.join("; ")}.`} This uses test information only.`;
  }
  const appointment = appointmentReadSchema.safeParse(value);
  if (appointment.success) return `${sentence(appointment.data.label)} This uses test information only.`;
  const referral = referralReadSchema.safeParse(value);
  if (referral.success) return `${sentence(referral.data.status)} This uses test information only.`;
  throw new Error("f2_sms_read_value_unrenderable");
}

function sentence(value: string): string { return /[.!?]$/.test(value) ? value : `${value}.`; }
function actionConfirmation(result: Extract<AiResolutionResult, { kind: "action" }>): string {
  const action = result.operation === "schedule" ? "scheduled" : result.operation === "reschedule" ? "rescheduled" : "confirmed";
  return `Your test appointment has been ${action}. This uses test information only.`;
}
function exactConsentNotConfirmedText(conversation: Conversation, requestId: string): string | null {
  const question = conversation.pendingQuestion;
  if (question?.requestId !== requestId) return null;
  if (question.kind === "appointment_consent") return "Your appointment has not been changed. Please reply YES only if you want to confirm the appointment option.";
  if (question.kind === "attendance_consent") return "Your attendance has not been confirmed. Please reply YES only if you want to confirm attendance.";
  return null;
}

function renderAppointmentOffer(rawSlots: readonly unknown[]): string {
  const slots = z.array(offeredSlotSchema).min(1).max(2).parse(rawSlots);
  return `${slots.map((slot, index) => `Option ${index + 1}: ${formatSlot(slot)} at ${slot.location}.`).join(" ")} Reply with the option you prefer.`;
}

function formatSlot(slot: z.infer<typeof offeredSlotSchema>): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: SYNTHETIC_PRACTICE_TIME_ZONE, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(slot.startsAt));
}

function formatAppointmentTime(startsAt: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: SYNTHETIC_PRACTICE_TIME_ZONE, weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" }).format(new Date(startsAt));
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function eventId(kind: "request" | "reply" | "emergency", sourceId: string): string { return `f2-sms-${kind}-${digest(sourceId)}`; }
function invocationId(sourceId: string, toolId: string): string { return `f2-sms-${digest(`${sourceId}:${toolId}`)}`; }
