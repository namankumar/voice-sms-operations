import { createHash } from "node:crypto";
import { z } from "zod";
import { scopeOf, type Conversation, type ConversationScope } from "./conversation-contract.js";
import type { ConversationJob, ConversationJobResult } from "./conversation-jobs.js";
import type { ConversationStore } from "./conversation-store.js";
import { compileReceptionistPrompt, persistedCallbackDirective, receptionistAppInstanceSchema, type CompiledReceptionistPrompt, type ReceptionistAppInstance, type ReceptionistEmergencyDirective } from "./receptionist-policy.js";
import { ReceptionistToolGateway } from "./receptionist-tool-gateway.js";

const payloadSchema = z.object({ sourceId: z.string().min(1).max(200) }).strict();
const toolSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), name: z.string().min(1).max(120), arguments: z.unknown() }).strict();
const outputSchema = z.object({ naturalText: z.string().trim().min(1).max(500), tools: z.array(toolSchema).max(1) }).strict();

/** Injected model boundary; implementations must not log the prompt's protected caller content. */
export interface SmsTurnInterpreter { interpret(input: { model: string; prompt: CompiledReceptionistPrompt; signal: AbortSignal; repair: boolean }): Promise<unknown>; }
/** Worker boundary: job payload is the protected `{ sourceId }` reference, never caller text. */
export interface ReceptionistSmsTurnHandler { handleSmsTurn(job: Pick<ConversationJob, "kind" | "scope" | "payload">, context: { signal?: AbortSignal }): Promise<ConversationJobResult>; }

/** GPT can propose one current policy tool; server state alone renders outbound text and completion claims. */
export class ReceptionistSmsTurn implements ReceptionistSmsTurnHandler {
  private readonly instance: ReceptionistAppInstance;
  private readonly gateway: ReceptionistToolGateway;
  constructor(private readonly options: { store: Pick<ConversationStore, "get" | "execute" | "getEvent">; instance: ReceptionistAppInstance; model: string; interpreter: SmsTurnInterpreter }) {
    this.instance = receptionistAppInstanceSchema.parse(options.instance);
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.model)) throw new Error("receptionist_model_identity_invalid");
    this.gateway = new ReceptionistToolGateway({ store: options.store, instance: this.instance, model: options.model });
  }

  async handleSmsTurn(job: Pick<ConversationJob, "kind" | "scope" | "payload">, context: { signal?: AbortSignal }): Promise<ConversationJobResult> {
    if (job.kind !== "sms_turn" || context.signal?.aborted) return { code: "not_needed" };
    const payload = payloadSchema.safeParse(job.payload);
    if (!payload.success) return { code: "not_needed" };
    const sourceId = payload.data.sourceId;
    const prior = await this.options.store.getEvent(job.scope, `sms.reply:${sourceId}`);
    if (prior?.receipt.accepted && prior.input.command.type === "sms.queue") return { code: "completed" };
    const emergencyPrior = await this.options.store.getEvent(job.scope, `sms.emergency:${sourceId}`);
    if (emergencyPrior?.receipt.accepted && emergencyPrior.input.command.type === "emergency.sms_instruction") return { code: "completed" };
    const capturePrior = await this.options.store.getEvent(job.scope, `sms.capture:${sourceId}`);
    const captureCommand = capturePrior?.input.command;
    if (capturePrior?.receipt.accepted && captureCommand?.type === "request.capture") {
      const state = await this.options.store.get(job.scope);
      const capturedEpoch = capturePrior.receipt.state.ownerEpoch;
      if (!this.authorized(state, sourceId, capturedEpoch, context.signal) || state.ownerEpoch !== capturedEpoch) return { code: "not_needed" };
      const request = state.requests.find((item) => item.id === captureCommand.requestId);
      if (request?.state !== "needs_callback") return { code: "not_needed" };
      return this.queue(state, sourceId, capturedEpoch, persistedCallbackDirective(this.instance, capturePrior.receipt, request.id).text, context.signal);
    }
    const initial = await this.options.store.get(job.scope);
    if (!this.authorized(initial, sourceId, undefined, context.signal)) return { code: "not_needed" };
    const ownerEpoch = initial.ownerEpoch;
    const prompt = compileReceptionistPrompt(this.instance, initial);
    try {
      const output = await this.interpret(prompt, context.signal);
      if (!this.authorized(await this.options.store.get(job.scope), sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
      const tool = output.tools[0];
      if (tool !== undefined && prompt.tools.some((allowed) => allowed.function.name === tool.name)) {
        const state = await this.options.store.get(job.scope);
        if (!this.authorized(state, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
        const requestId = requestIdFor(state, sourceId);
        const result = await this.gateway.invoke({ scope: scopeOf(state), invocationId: invocationId(sourceId, tool.id), sourceId, requestId,
          expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch, name: tool.name, arguments: normalizeToolArguments(tool.name, tool.arguments, this.instance) });
        if (context.signal?.aborted) return { code: "not_needed" };
        if (result.kind === "accepted" && result.directive !== undefined) return this.queueEmergencyDirective(job.scope, sourceId, ownerEpoch, result.directive, context.signal);
        if (result.kind !== "accepted") return this.ensureAndRender(job.scope, sourceId, ownerEpoch, context.signal);
      }
    } catch (error) {
      if (error instanceof ParentAbort) return { code: "not_needed" };
      const current = await this.options.store.get(job.scope);
      if (!this.authorized(current, sourceId, ownerEpoch, context.signal)) return { code: "not_needed" };
      const consumed = await this.consumePending(current, sourceId, ownerEpoch, context.signal);
      if (consumed === null) return { code: "not_needed" };
      return this.ensureAndRender(job.scope, sourceId, ownerEpoch, context.signal);
    }
    return this.ensureAndRender(job.scope, sourceId, ownerEpoch, context.signal);
  }

  private authorized(state: Conversation | null, sourceId: string, ownerEpoch?: number, signal?: AbortSignal): state is Conversation {
    if (signal?.aborted || state === null || state.admission.channel !== "sms" || state.owner !== "ai" || state.suppressed || state.phase !== "active" || state.inputs.at(-1)?.id !== sourceId || (ownerEpoch !== undefined && state.ownerEpoch !== ownerEpoch)) return false;
    try { compileReceptionistPrompt(this.instance, state); return true; } catch { return false; }
  }

  private async consumePending(state: Conversation, sourceId: string, ownerEpoch: number, signal?: AbortSignal): Promise<Conversation | null> {
    const pending = state.pendingQuestion, source = state.inputs.at(-1)!;
    if (pending === null || pending.id !== source.questionId) return state;
    const requestId = pending.requestId ?? `request-${sourceId}`;
    let command: Parameters<ConversationStore["execute"]>[0]["command"] | null = null;
    if (pending.kind === "name" && looksLikeName(source.body)) command = { type: "request.draft", requestId, sourceEventId: sourceId, name: source.body.trim() };
    else if (pending.kind === "message") command = { type: "request.capture_callback_message", requestId, sourceEventId: sourceId };
    else if (pending.kind === "callback_number_entry") { const value = e164(source.body); if (value !== null) command = { type: "request.draft", requestId, sourceEventId: sourceId, callbackNumber: value }; }
    else if (pending.kind === "callback_number" && /^yes[.!]?$/i.test(source.body.trim()) && pending.callbackNumber !== null) command = { type: "request.confirm_callback", requestId, callbackNumber: pending.callbackNumber, sourceEventId: sourceId };
    if (command === null || !this.authorized(state, sourceId, ownerEpoch, signal)) return command === null ? state : null;
    const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: `sms.field:${sourceId}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
      actor: { kind: command.type === "request.confirm_callback" ? "system" : "ai", id: "receptionist-sms-turn" }, command });
    if (!receipt.accepted || signal?.aborted) return null;
    const current = await this.options.store.get(scopeOf(receipt.state));
    return this.authorized(current, sourceId, ownerEpoch, signal) ? current : null;
  }

  private async ensureAndRender(scope: ConversationScope, sourceId: string, ownerEpoch: number, signal?: AbortSignal): Promise<ConversationJobResult> {
    let state = await this.options.store.get(scope);
    if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    if (state.emergency?.sourceEventId === sourceId) return this.queueEmergencyInstruction(state, sourceId, ownerEpoch, signal);
    let request = [...state.requests].reverse().find((value) => value.state === "draft");
    if (request === undefined) {
      const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: `sms.request:${sourceId}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
        actor: { kind: "ai", id: "receptionist-sms-turn" }, command: { type: "request.draft", requestId: `request-${sourceId}`, sourceEventId: sourceId } });
      if (!receipt.accepted || signal?.aborted) return { code: "not_needed" };
      state = await this.options.store.get(scope);
      if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
      request = state.requests.find((value) => value.id === `request-${sourceId}`);
    }
    if (request === undefined) return { code: "not_needed" };
    if (request.name && request.callbackConfirmed && request.callbackNumber) {
      const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: `sms.capture:${sourceId}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
        actor: { kind: "ai", id: "receptionist-sms-turn" }, command: { type: "request.capture", requestId: request.id } });
      if (!receipt.accepted || signal?.aborted) return { code: "not_needed" };
      return this.queue(receipt.state, sourceId, ownerEpoch, persistedCallbackDirective(this.instance, receipt, request.id).text, signal);
    }
    return this.render(state, sourceId, ownerEpoch, signal);
  }

  private async render(state: Conversation, sourceId: string, ownerEpoch: number, signal?: AbortSignal): Promise<ConversationJobResult> {
    if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    const request = [...state.requests].reverse().find((value) => value.state === "draft");
    if (request === undefined) return { code: "not_needed" };
    const kind = request.name ? request.callbackNumber ? "callback_number" : "callback_number_entry" : "name";
    let current = state;
    if (current.pendingQuestion?.kind !== kind || current.pendingQuestion.requestId !== request.id) {
      const receipt = await this.options.store.execute({ scope: scopeOf(current), eventId: `sms.question:${sourceId}:${kind}`, expectedRevision: current.revision, expectedOwnerEpoch: current.ownerEpoch,
        actor: { kind: "system", id: "receptionist-sms-turn" }, command: { type: "question.activate", questionId: `question-${sourceId}-${kind}`, kind, requestId: request.id } });
      if (!receipt.accepted || signal?.aborted) return { code: "not_needed" };
      current = receipt.state;
    }
    return this.queue(current, sourceId, ownerEpoch, questionText(kind), signal);
  }

  private async queue(state: Conversation, sourceId: string, ownerEpoch: number, body: string, signal?: AbortSignal): Promise<ConversationJobResult> {
    if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: `sms.reply:${sourceId}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
      actor: { kind: "ai", id: "receptionist-sms-turn" }, command: { type: "sms.queue", messageId: `sms-reply-${sourceId}`, body } });
    return !signal?.aborted && receipt.accepted ? { code: "completed" } : { code: "not_needed" };
  }

  private async queueEmergencyDirective(scope: ConversationScope, sourceId: string, ownerEpoch: number, directive: ReceptionistEmergencyDirective, signal?: AbortSignal): Promise<ConversationJobResult> {
    const state = await this.options.store.get(scope);
    if (!this.authorized(state, sourceId, ownerEpoch, signal)) return { code: "not_needed" };
    return directive.kind === "emergency_911"
      ? this.queueEmergencyInstruction(state, sourceId, ownerEpoch, signal)
      : this.queue(state, sourceId, ownerEpoch, directive.text, signal);
  }

  private async queueEmergencyInstruction(state: Conversation, sourceId: string, ownerEpoch: number, signal?: AbortSignal): Promise<ConversationJobResult> {
    if (!this.authorized(state, sourceId, ownerEpoch, signal) || state.emergency?.sourceEventId !== sourceId) return { code: "not_needed" };
    const receipt = await this.options.store.execute({ scope: scopeOf(state), eventId: `sms.emergency:${sourceId}`, expectedRevision: state.revision, expectedOwnerEpoch: state.ownerEpoch,
      actor: { kind: "system", id: "receptionist-sms-turn" }, command: { type: "emergency.sms_instruction", messageId: `sms-emergency-${sourceId}`, sourceEventId: sourceId } });
    return !signal?.aborted && receipt.accepted ? { code: "completed" } : { code: "not_needed" };
  }

  private async interpret(prompt: CompiledReceptionistPrompt, parent?: AbortSignal): Promise<z.infer<typeof outputSchema>> {
    if (parent?.aborted) throw new ParentAbort();
    const controller = new AbortController(), signal = parent === undefined ? controller.signal : AbortSignal.any([parent, controller.signal]);
    for (const repair of [false, true] as const) {
      const raw = await race(this.options.interpreter.interpret({ model: this.options.model, prompt, signal, repair }), controller, parent, Math.min(8_000, this.instance.latency.textGenerationDeadlineMs));
      const parsed = outputSchema.safeParse(raw); if (parsed.success) return parsed.data;
    }
    throw new Error("sms_turn_interpreter_invalid");
  }
}

class ParentAbort extends Error {}
async function race<T>(work: Promise<T>, controller: AbortController, parent: AbortSignal | undefined, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined, remove: (() => void) | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("sms_turn_deadline")); }, ms); if (parent) { const abort = () => { controller.abort(); reject(new ParentAbort()); }; parent.addEventListener("abort", abort, { once: true }); remove = () => parent.removeEventListener("abort", abort); } })]); }
  finally { if (timer) clearTimeout(timer); remove?.(); }
}
function requestIdFor(state: Conversation, sourceId: string): string { return state.pendingQuestion?.requestId ?? [...state.requests].reverse().find((request) => request.state === "draft")?.id ?? `request-${sourceId}`; }
function invocationId(sourceId: string, toolId: string): string { return `sms-${createHash("sha256").update(`${sourceId}:${toolId}`).digest("hex")}`; }
function e164(value: string): string | null { const result = value.trim(); return /^\+[1-9]\d{7,14}$/.test(result) ? result : null; }
function questionText(kind: "name" | "callback_number_entry" | "callback_number"): string { return kind === "name" ? "Please reply with your name." : kind === "callback_number_entry" ? "Please reply with a callback number including + and country code." : "Please reply YES to confirm the callback number you provided, or send the correct number."; }
function looksLikeName(value: string): boolean { return /^[A-Za-z][A-Za-z' -]{0,198}$/.test(value.trim()) && !/[?!.]/.test(value.trim()) && value.trim().split(/\s+/).length <= 4; }
function normalizeToolArguments(name: string, value: unknown, instance: ReceptionistAppInstance): unknown {
  if (name !== "propose_receptionist_capture" || value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>, callback = input.callbackNumber;
  if (typeof callback !== "string") return value;
  const compact = callback.replace(/[() .-]/g, "");
  const normalized = /^\d{10}$/.test(compact) && instance.numberBinding.sourceNumberE164.startsWith("+1") ? `+1${compact}` : e164(compact);
  return normalized === null ? value : { ...input, callbackNumber: normalized };
}
