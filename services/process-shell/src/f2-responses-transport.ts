import OpenAI from "openai";

import type { F2TextRequest, F2TextTransport } from "./f2-sms-turn.js";
import { assertGuardedF2ResponsesRequest } from "./f2-responses-transport-internal.js";

export type F2ResponsesBeforeDispatchObserver = (request: F2TextRequest) => void;

/** The only production Responses transport: fixed endpoint, single attempt, and no redirect. */
export function createGuardedF2ResponsesTransport(options: { apiKey: string; beforeDispatch?: F2ResponsesBeforeDispatchObserver }): F2TextTransport {
  if (!options.apiKey.trim()) throw new Error("openai_api_key_required");
  const client = new OpenAI({ apiKey: options.apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 0, timeout: 8_000,
    fetchOptions: { redirect: "error" }, fetch: guardedFetch });
  return async (request, signal) => {
    if (signal.aborted) throw new Error("f2_responses_operation_aborted");
    options.beforeDispatch?.(request);
    return await client.responses.create(request, { signal });
  };
}

const guardedFetch: typeof fetch = async (input, init) => {
  assertGuardedF2ResponsesRequest(input, init);
  return await globalThis.fetch(input, { ...init, redirect: "error" });
};
