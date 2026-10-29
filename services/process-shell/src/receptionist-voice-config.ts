import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { newConversation } from "./conversation-contract.js";
import { compileReceptionistPrompt, receptionistAppInstanceSchema, type VoiceAppInstance } from "./receptionist-policy.js";
import { RECEPTIONIST_PRIMARY_VAD, RECEPTIONIST_REALTIME_MODEL, RECEPTIONIST_TRANSCRIPTION_MODEL } from "./receptionist-openai.js";
import { parseReceptionistVoiceReleaseProfile, receptionistVoiceReleaseProfileHash, type ReceptionistVoiceReleaseProfile } from "./receptionist-voice-release.js";
import type { ControlledTransferMap } from "./controlled-test-transfer.js";

export const CALLBACK_SPEECH_MODEL = "gpt-4o-mini-tts-2025-12-15";
export const CALLBACK_SPEECH_DELIVERY = "Speak warmly, clearly, and naturally at a calm conversational pace. Read the supplied text faithfully without adding words.";
export const CALLBACK_INPUT_CLOCK = Object.freeze({ kind: "ordered_pcm_samples_v1" as const, maxPresentationStepErrorMs: 20 as const, maxPresentationCumulativeDriftMs: 300 as const });
export const CALLBACK_VAD = Object.freeze({ type: "server_vad" as const, threshold: 0.7, prefixPaddingMs: 300,
  silenceDurationMs: 1200, createResponse: false, interruptResponse: false });
const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Reads deployed production source bytes. Generated output, tests, credentials and environment values are excluded. */
export function receptionistRuntimeSourceDigests(root = runtimeRoot): { sourceSha256: string; policySha256: string } {
  const files: Array<[string, string]> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ["node_modules", "dist", "tests", ".git"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && path.includes("/src/")) files.push([relative(root, path), sha(readFileSync(path))]);
    }
  };
  walk(join(root, "services")); walk(join(root, "packages")); files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (files.length < 20) throw new Error("voice_release_source_unavailable");
  const policy = files.filter(([path]) => /(?:conversation-contract|receptionist-policy|receptionist-tool-gateway|receptionist-callback-|receptionist-voice-session|receptionist-openai|receptionist-voice-release|receptionist-voice-config|controlled-test-transfer|voice-runtime\/src\/)/.test(path));
  return { sourceSha256: sha(canonical(files)), policySha256: sha(canonical(policy)) };
}
/** Constructs the profile from the same constants/options used by actual providers; caller JSON is never a source. */
export function resolveReceptionistVoiceReleaseProfile(options: { instance: VoiceAppInstance; realtimeVoice: string; textModel: string;
  controlledTransferMap?: ControlledTransferMap; recordCalls?: boolean; directDemoEnabled?: boolean; root?: string }): ReceptionistVoiceReleaseProfile {
  if (options.instance.mode !== "receptionist" || options.instance.dataMode !== "synthetic_only" || options.recordCalls === true) throw new Error("voice_candidate_receptionist_synthetic_only");
  const instance = receptionistAppInstanceSchema.parse(options.instance);
  const conversation = newConversation({ practiceId: instance.practiceId, instanceId: instance.instanceId, configVersion: instance.configVersion,
    mode: "receptionist", accountId: instance.accountId, provider: "twilio", channel: "voice", externalId: "profile-call", contact: "+12025550147",
    destination: instance.numberBinding.sourceNumberE164, hours: instance.hours.fixture }, "profile-context", "2000-01-01T00:00:00.000Z");
  const prompt = compileReceptionistPrompt(instance, conversation), digests = receptionistRuntimeSourceDigests(options.root);
  const both = ["primary_sip", "callback_media"];
  return parseReceptionistVoiceReleaseProfile({ version: "receptionist-voice-release/v1", ...digests,
    promptVersion: instance.promptVersion, promptSha256: sha(canonical({ system: prompt.system, delivery: CALLBACK_SPEECH_DELIVERY })),
    toolsSha256: sha(canonical(prompt.tools)), syntheticOnly: true, recordCalls: false,
    routeMapSha256: sha(canonical(options.controlledTransferMap ?? { enabled: false, routes: instance.routes })),
    hoursPolicySha256: sha(canonical(options.directDemoEnabled === true
      ? { hours: instance.hours, directDemo: "operator_demo_normal_entry_v1" }
      : { hours: instance.hours, candidate: "immutable_case_receipt_v1" })),
    primary: { renderer: "openai_realtime_sip", model: RECEPTIONIST_REALTIME_MODEL, voice: options.realtimeVoice,
      transcriptionModel: RECEPTIONIST_TRANSCRIPTION_MODEL, language: "en", vad: RECEPTIONIST_PRIMARY_VAD },
    callback: { renderer: "openai_speech_media", decisionModel: options.textModel, speechModel: CALLBACK_SPEECH_MODEL, voice: options.realtimeVoice,
      transcriptionModel: RECEPTIONIST_TRANSCRIPTION_MODEL, language: "en", vad: CALLBACK_VAD, inputClock: CALLBACK_INPUT_CLOCK, codec: "pcmu_8000_mono",
      playback: "twilio_authenticated_mark_v1", interruption: "abort_clear_fence_v1" },
    transfer: { renderer: "openai_speech_play", speechModel: CALLBACK_SPEECH_MODEL, voice: options.realtimeVoice,
      codec: "ulaw_8000_mono", ringMs: 24000, screenMs: 8000, assetPolicy: "hmac_parent_profile_ttl_v1" },
    degraded: { policy: "declared_audio", renderers: [
      { id: "provider_outage_relay", renderer: "twilio_conversation_relay", provider: "Amazon", model: "Twilio_managed_neural", voice: "Joanna-Neural", reason: "provider_failure" },
      { id: "provider_outage_scripted", renderer: "twilio_say", provider: "Amazon", model: "Twilio_managed_neural", voice: "Polly.Joanna-Neural", reason: "provider_failure" },
    ] },
    branches: [
      { id: "greeting", renderers: ["primary_sip"] }, { id: "acknowledgement", renderers: both }, { id: "clarification", renderers: both },
      { id: "transfer_announcement", renderers: ["transfer_play"] }, { id: "transfer_failure", renderers: ["callback_media"] },
      { id: "after_hours", renderers: ["callback_media"] }, { id: "message", renderers: ["callback_media"] }, { id: "purpose", renderers: both },
      { id: "contact", renderers: ["callback_media"] }, { id: "repair", renderers: both }, { id: "recap", renderers: ["callback_media"] },
      { id: "saved", renderers: ["callback_media"] }, { id: "final_invitation", renderers: both }, { id: "goodbye", renderers: both },
      { id: "emergency", renderers: both }, { id: "no_message", renderers: both },
    ] });
}
export function resolvedReceptionistVoiceProfileHash(options: Parameters<typeof resolveReceptionistVoiceReleaseProfile>[0]): string {
  return receptionistVoiceReleaseProfileHash(resolveReceptionistVoiceReleaseProfile(options));
}
