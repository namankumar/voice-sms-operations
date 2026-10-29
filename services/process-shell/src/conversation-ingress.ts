import type { IncomingMessage } from "node:http";
import { TwilioHmacRequestValidator } from "@salven/voice-runtime";
import { z } from "zod";

const sid = (prefix: string) => z.string().regex(new RegExp(`^${prefix}[a-fA-F0-9]{32}$`));
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const common = { AccountSid: sid("AC"), From: phone, To: phone };
export const twilioVoiceAdmissionSchema = z.object({ ...common, CallSid: sid("CA"), Direction: z.literal("inbound") });
export const twilioSmsAdmissionSchema = z.object({ ...common, MessageSid: sid("SM"), Body: z.string().max(8_000), NumMedia: z.coerce.number().int().nonnegative().max(10), OptOutType: z.enum(["STOP", "START", "HELP"]).optional() });
const whatsappAddress = z.string().regex(/^whatsapp:\+[1-9]\d{7,14}$/);
export const twilioWhatsappAdmissionSchema = z.object({ AccountSid: sid("AC"), From: whatsappAddress, To: whatsappAddress,
  MessageSid: sid("SM"), Body: z.string().max(8_000), NumMedia: z.coerce.number().int().nonnegative().max(10) });
export class IngressRejected extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Verify the exact public URL and raw form before consuming any caller facts. */
export function createTwilioIngressVerifier(config: { publicOrigin: string; accountSid: string; authToken: string; destination: string }) {
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("public_origin_invalid");
  sid("AC").parse(config.accountSid); phone.parse(config.destination);
  const validator = new TwilioHmacRequestValidator(config.authToken);
  return async function verify(request: IncomingMessage, expectedPath: string): Promise<Readonly<Record<string, string>>> {
    if (request.method !== "POST") throw new IngressRejected(405, "post_required");
    if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new IngressRejected(415, "form_required");
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin.origin || url.pathname !== expectedPath || url.hash) throw new IngressRejected(404, "route_not_found");
    const signature = request.headers["x-twilio-signature"];
    if (typeof signature !== "string" || signature.length > 256) throw new IngressRejected(403, "signature_required");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 65_536) throw new IngressRejected(413, "body_too_large");
      chunks.push(bytes);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const parameters: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of form) {
      if (Object.hasOwn(parameters, key)) throw new IngressRejected(400, "duplicate_form_key");
      parameters[key] = value;
    }
    if (!validator.validate({ signature, url: url.toString(), parameters })) throw new IngressRejected(403, "signature_invalid");
    if (parameters.AccountSid !== config.accountSid) throw new IngressRejected(403, "account_binding_mismatch");
    return Object.freeze(parameters);
  };
}

export function parseVoiceAdmission(parameters: Readonly<Record<string, string>>, destination: string) {
  const input = twilioVoiceAdmissionSchema.parse(parameters);
  if (input.To !== destination) throw new IngressRejected(403, "destination_binding_mismatch");
  return input;
}
export function parseSmsAdmission(parameters: Readonly<Record<string, string>>, destination: string) {
  const input = twilioSmsAdmissionSchema.parse(parameters);
  if (input.To !== destination) throw new IngressRejected(403, "destination_binding_mismatch");
  return input;
}
export function parseWhatsappAdmission(parameters: Readonly<Record<string, string>>, destination: string) {
  const input = twilioWhatsappAdmissionSchema.parse(parameters);
  const from = input.From.slice("whatsapp:".length), to = input.To.slice("whatsapp:".length);
  if (to !== destination) throw new IngressRejected(403, "destination_binding_mismatch");
  return { ...input, From: from, To: to };
}
