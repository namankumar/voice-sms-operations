import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { scopeOf } from "./conversation-contract.js";
import { IngressRejected, parseVoiceAdmission } from "./conversation-ingress.js";
import type { ConversationStore, PostgresConversationStore } from "./conversation-store.js";
import type { ConversationObservation } from "./conversation-observability.js";
import type { OpenAIWebhookVerifier } from "./receptionist-openai-transport.js";
import { voiceAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { sipDialTwiml, type PostgresSipBindings } from "./receptionist-sip-binding.js";
import type { ControlledSyntheticVoiceFixturePort } from "./controlled-synthetic-voice-fixture.js";

const incomingSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), type: z.literal("realtime.call.incoming"),
  data: z.object({ call_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
    sip_headers: z.array(z.object({ name: z.string().max(200), value: z.string().max(4_000) })).max(128),
    sip_media_security: z.string().optional() }) });

/** Signed ingress only. It persists an acceptance job; an HTTP acknowledgement never claims an answered call. */
export function createReceptionistSipIngress(options: {
  instance: VoiceAppInstance; projectId: string;
  recordCalls?: boolean;
  candidateProfileSha256?: string;
  requireCandidateRelease?: boolean;
  promotedVoiceRelease?: { stage: "rehearsal"; profileSha256: string; qualificationSha256: string };
  operatorDemoVoiceRelease?: { stage: "operator_demo"; profileSha256: string };
  store: Pick<ConversationStore, "admit"> & Partial<Pick<PostgresConversationStore, "findVoiceByParent">>;
  bindings: Pick<PostgresSipBindings, "create" | "bindIncoming">;
  verifier: Pick<OpenAIWebhookVerifier, "verify">;
  controlledFixtures?: Pick<ControlledSyntheticVoiceFixturePort, "claim" | "bind">;
  observeAdmission?: (correlation: string, observation: Pick<ConversationObservation, "stage" | "result" | "channel" | "admissionStep" | "durationMs">) => void;
  now?: () => number;
}) {
  const instance = voiceAppInstanceSchema.parse(options.instance);
  if (!/^proj_[A-Za-z0-9_-]{1,160}$/.test(options.projectId)) throw new Error("sip_project_invalid");
  const now = options.now ?? (() => performance.now());
  const observeAdmission = (correlation: string, admissionStep: "store_admit" | "sip_binding_create", result: "started" | "completed" | "failed", startedAt?: number): void => {
    const elapsedMs = startedAt === undefined ? undefined : now() - startedAt;
    const durationMs = elapsedMs === undefined ? undefined : Number.isFinite(elapsedMs) ? Math.min(86_400_000, Math.max(0, elapsedMs)) : 0;
    try { options.observeAdmission?.(correlation, { stage: "admission", result, channel: "voice", admissionStep,
      ...(durationMs === undefined ? {} : { durationMs }) }); } catch { /* Operational telemetry cannot alter signed ingress. */ }
  };
  return {
    async inbound(parameters: Readonly<Record<string, string>>): Promise<string> {
      const input = parseVoiceAdmission(parameters, instance.numberBinding.sourceNumberE164);
      if (input.AccountSid !== instance.accountId) throw new IngressRejected(403, "account_binding_mismatch");
      const correlation = `${input.AccountSid}:${input.CallSid}`;
      const controlledHours = await options.controlledFixtures?.claim({ practiceId: instance.practiceId, instanceId: instance.instanceId,
        accountId: instance.accountId, parentCallId: input.CallSid, caller: input.From, destination: input.To, now: new Date().toISOString() }) ?? null;
      if (controlledHours?.candidate !== undefined && (instance.mode !== "receptionist" || options.recordCalls === true
        || controlledHours.candidate.profileSha256 !== options.candidateProfileSha256)) throw new IngressRejected(403, "voice_candidate_profile_mismatch");
      const existing = await options.store.findVoiceByParent?.({ practiceId: instance.practiceId, instanceId: instance.instanceId, accountId: instance.accountId, parentCallId: input.CallSid });
      if (options.requireCandidateRelease === true && existing == null && controlledHours?.candidate === undefined && options.promotedVoiceRelease === undefined) throw new IngressRejected(403, "voice_candidate_admission_required");
      // A release change applies to fresh calls only; carrier retries preserve the original admission.
      const release = existing === undefined || existing === null ? options.operatorDemoVoiceRelease ?? options.promotedVoiceRelease : existing.admission.voiceRelease;
      const admittedAt = now(); observeAdmission(correlation, "store_admit", "started");
      let conversation;
      try {
        conversation = await options.store.admit({ practiceId: instance.practiceId, instanceId: instance.instanceId,
          configVersion: instance.configVersion, mode: instance.mode, provider: "twilio", accountId: instance.accountId,
          channel: "voice", externalId: input.CallSid, contact: input.From, destination: input.To,
          hours: controlledHours?.outcome ?? instance.hours.fixture, controlledHours, ...(controlledHours?.candidate !== undefined || release === undefined ? {} : { voiceRelease: release }) });
        observeAdmission(correlation, "store_admit", "completed", admittedAt);
      } catch (error) {
        observeAdmission(correlation, "store_admit", "failed", admittedAt); throw error;
      }
      if (controlledHours !== null) await options.controlledFixtures!.bind({ fixtureId: controlledHours.fixtureId, practiceId: instance.practiceId,
        instanceId: instance.instanceId, parentCallId: input.CallSid, conversationId: conversation.id });
      const bindingAt = now(); observeAdmission(correlation, "sip_binding_create", "started");
      try {
        const binding = await options.bindings.create({ scope: scopeOf(conversation), projectId: options.projectId });
        observeAdmission(correlation, "sip_binding_create", "completed", bindingAt);
        return sipDialTwiml(binding, { recordCalls: options.recordCalls === true });
      } catch (error) {
        observeAdmission(correlation, "sip_binding_create", "failed", bindingAt); throw error;
      }
    },
    async webhook(request: IncomingMessage): Promise<void> {
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new IngressRejected(415, "json_required");
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 65_536) throw new IngressRejected(413, "body_too_large");
        chunks.push(bytes);
      }
      let verified;
      try { verified = await options.verifier.verify({ rawBody: Buffer.concat(chunks).toString("utf8"), headers: request.headers }); }
      catch { throw new IngressRejected(403, "openai_signature_invalid"); }
      const parsed = incomingSchema.safeParse(verified.event);
      if (!parsed.success) throw new IngressRejected(400, "incoming_call_invalid");
      const event = parsed.data;
      // SDK metadata is optional. Missing metadata is not encryption proof; release still needs transport evidence.
      if (event.data.sip_media_security === "rtp") throw new IngressRejected(403, "sip_media_unencrypted");
      const correlations = event.data.sip_headers.filter((header) => header.name.toLowerCase() === "x-voice-operation-correlation");
      if (correlations.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(correlations[0]!.value)) throw new IngressRejected(403, "sip_correlation_invalid");
      await options.bindings.bindIncoming({ practiceId: instance.practiceId, instanceId: instance.instanceId,
        projectId: options.projectId, eventId: event.id, callId: event.data.call_id, token: correlations[0]!.value });
    },
  };
}
