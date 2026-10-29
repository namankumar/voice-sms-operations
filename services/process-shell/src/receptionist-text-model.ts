import OpenAI from "openai";
import { z } from "zod";
import type { SmsTurnInterpreter } from "./receptionist-sms-turn.js";
import type { RelayTextInterpreter } from "./receptionist-relay.js";

const outputSchema = z.object({
  status: z.literal("completed"),
  output: z.array(z.object({ type: z.string() }).passthrough()).max(16),
}).passthrough();
const callSchema = z.object({ type: z.literal("function_call"), call_id: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  name: z.string().min(1).max(120), arguments: z.string().max(16_384) }).passthrough();

export type ReceptionistTextRequest = {
  model: string; instructions: string; input: string; store: false;
  max_output_tokens: number; parallel_tool_calls: false; tool_choice?: "required";
  tools: Array<{ type: "function"; name: string; description: string; strict: true;
    parameters: Record<string, unknown> }>;
};
export type ReceptionistTextTransport = (request: ReceptionistTextRequest, signal: AbortSignal) => Promise<unknown>;

/** One bounded, non-retried text request. A configured model must pass capability acceptance before release. */
export class OpenAIReceptionistTextInterpreter implements SmsTurnInterpreter {
  private readonly transport: ReceptionistTextTransport;
  constructor(options: { apiKey: string; transport?: ReceptionistTextTransport }) {
    if (!options.apiKey.trim()) throw new Error("openai_api_key_required");
    if (options.transport) this.transport = options.transport;
    else {
      const client = new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: 8_000 });
      this.transport = (request, signal) => client.responses.create(request, { signal });
    }
  }

  async interpret(input: Parameters<SmsTurnInterpreter["interpret"]>[0]): Promise<unknown> {
    if (input.signal.aborted) throw new Error("text_interpretation_aborted");
    if (input.prompt.channel !== "sms" || !/^[A-Za-z0-9_.-]{1,100}$/.test(input.model)) throw new Error("text_interpretation_configuration_invalid");
    try {
      const raw = await this.transport({
        model: input.model, instructions: input.prompt.system,
        input: "Interpret the latest caller turn in the protected context and propose at most one available tool. Do not perform actions or make completion claims."
          + (input.repair ? " Your previous output could not be used. Return a valid tool call using exactly its schema." : ""),
        store: false, max_output_tokens: 800, parallel_tool_calls: false,
        ...(input.prompt.toolChoice === "required" ? { tool_choice: "required" as const } : {}),
        tools: input.prompt.tools.map(({ function: tool }) => ({ type: "function", name: tool.name, description: tool.description,
          strict: true, parameters: { ...tool.parameters, required: [...tool.parameters.required] } })),
      }, input.signal);
      if (input.signal.aborted) throw new Error("aborted");
      const response = outputSchema.parse(raw);
      const calls = response.output.filter((item) => item.type === "function_call");
      if (calls.length > 1) throw new Error("multiple_tools");
      const tools = calls.map((item) => {
        const call = callSchema.parse(item);
        if (!input.prompt.tools.some((tool) => tool.function.name === call.name)) throw new Error("tool_not_allowed");
        return { id: call.call_id, name: call.name, arguments: JSON.parse(call.arguments) as unknown };
      });
      // Model prose is not forwarded: the turn handler renders server-authorized SMS claims.
      return { naturalText: "Server response required.", tools };
    } catch { throw new Error(input.signal.aborted ? "text_interpretation_aborted" : "text_interpretation_failed"); }
  }
}

/** Reuses the bounded Responses tool-call adapter for ConversationRelay text turns. */
export class OpenAIReceptionistRelayInterpreter implements RelayTextInterpreter {
  private readonly sms: OpenAIReceptionistTextInterpreter;
  private readonly model: string;
  constructor(options: { apiKey: string; model: string; transport?: ReceptionistTextTransport }) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(options.model)) throw new Error("text_model_invalid");
    this.model = options.model;
    this.sms = new OpenAIReceptionistTextInterpreter(options);
  }
  async interpret(input: Parameters<RelayTextInterpreter["interpret"]>[0]): Promise<{ tool?: { id: string; name: string; arguments: unknown } }> {
    const result = await this.sms.interpret({ ...input, prompt: { ...input.prompt, channel: "sms" }, model: this.model, repair: false }) as { tools?: Array<{ id: string; name: string; arguments: unknown }> };
    return result.tools?.[0] === undefined ? {} : { tool: result.tools[0] };
  }
}
