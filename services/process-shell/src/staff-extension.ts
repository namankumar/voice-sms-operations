import type { IncomingMessage, ServerResponse } from "node:http";

/** Called only after the existing staff session and POST CSRF checks succeed. */
export interface AuthenticatedStaffExtension {
  matches(url: URL): boolean;
  handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    actor: string;
    sessionId: string;
    csrfToken: string;
    fields: Readonly<Record<string, string>>;
    sessionActive(): Promise<boolean>;
    renderDocument(title: string, body: string): string;
  }): Promise<void>;
}
