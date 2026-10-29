const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Internal boundary check shared by the fixed SDK fetch adapter and its offline tests. */
export function assertGuardedF2ResponsesRequest(input: RequestInfo | URL, init: RequestInit | undefined): void {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.toString() !== OPENAI_RESPONSES_URL || url.username !== "" || url.password !== "" || init?.method !== "POST" ||
      (init.redirect !== undefined && init.redirect !== "error")) throw new Error("f2_responses_endpoint_rejected");
}
