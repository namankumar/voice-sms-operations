import { createHash } from "node:crypto";
import { z } from "zod";

/** Public, non-secret resolved configuration. This schema is not evidence that audio was heard. */
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const explicit = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/)
  .refine(value => !/(^|[_.:-])(default|auto|inherit)([_.:-]|$)/i.test(value), "explicit_setting_required");
export const ordinaryCallerVoiceBranches = [
  "greeting", "acknowledgement", "clarification", "transfer_announcement", "transfer_failure",
  "after_hours", "message", "purpose", "contact", "repair", "recap", "saved",
  "final_invitation", "goodbye", "emergency", "no_message",
] as const;
export const ordinaryVoiceRenderers = ["primary_sip", "callback_media", "transfer_play"] as const;
const branchId = z.enum(ordinaryCallerVoiceBranches);
const rendererId = z.enum(ordinaryVoiceRenderers);
const vad = z.object({
  type: z.literal("server_vad"), threshold: z.number().min(0).max(1),
  prefixPaddingMs: z.number().int().min(0).max(2000), silenceDurationMs: z.number().int().min(100).max(5000),
  createResponse: z.boolean(), interruptResponse: z.boolean(),
}).strict();
export const receptionistVoiceReleaseProfileSchema = z.object({
  version: z.literal("receptionist-voice-release/v1"),
  sourceSha256: digest, promptVersion: explicit, promptSha256: digest, toolsSha256: digest, policySha256: digest,
  syntheticOnly: z.literal(true), recordCalls: z.literal(false),
  routeMapSha256: digest, hoursPolicySha256: digest,
  primary: z.object({
    renderer: z.literal("openai_realtime_sip"), model: explicit, voice: explicit,
    transcriptionModel: explicit, language: z.literal("en"), vad,
  }).strict(),
  callback: z.object({
    renderer: z.literal("openai_speech_media"), decisionModel: explicit, speechModel: explicit, voice: explicit,
    transcriptionModel: explicit, language: z.literal("en"), vad,
    inputClock: z.object({ kind: z.literal("ordered_pcm_samples_v1"), maxPresentationStepErrorMs: z.literal(20), maxPresentationCumulativeDriftMs: z.literal(300) }).strict(),
    codec: z.literal("pcmu_8000_mono"), playback: z.literal("twilio_authenticated_mark_v1"),
    interruption: z.literal("abort_clear_fence_v1"),
  }).strict(),
  transfer: z.object({
    renderer: z.literal("openai_speech_play"), speechModel: explicit, voice: explicit,
    codec: z.enum(["ulaw_8000_mono", "wav_pcm16_8000_mono"]),
    ringMs: z.number().int().positive().max(24000), screenMs: z.number().int().positive().max(8000),
    assetPolicy: z.literal("hmac_parent_profile_ttl_v1"),
  }).strict(),
  degraded: z.object({
    policy: z.enum(["preserve_and_end", "declared_audio"]),
    renderers: z.array(z.object({
      id: explicit, renderer: z.enum(["twilio_conversation_relay", "twilio_say"]),
      provider: explicit, model: explicit, voice: explicit, reason: explicit,
    }).strict()).max(8),
  }).strict(),
  branches: z.array(z.object({ id: branchId, renderers: z.array(rendererId).min(1).max(3) }).strict()).length(ordinaryCallerVoiceBranches.length),
}).strict().superRefine((p, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (p.callback.voice !== p.primary.voice || p.transfer.voice !== p.primary.voice)
    issue(["callback", "voice"], "ordinary_voice_identity_mismatch");
  if (p.callback.speechModel !== p.transfer.speechModel)
    issue(["transfer", "speechModel"], "ordinary_speech_model_mismatch");
  if (p.callback.vad.createResponse || p.callback.vad.interruptResponse)
    issue(["callback", "vad"], "callback_transcription_must_not_generate_audio");
  if (p.callback.vad.silenceDurationMs !== 1200)
    issue(["callback", "vad", "silenceDurationMs"], "callback_endpointing_contract_mismatch");
  if (new Set(p.branches.map(b => b.id)).size !== ordinaryCallerVoiceBranches.length)
    issue(["branches"], "ordinary_branch_missing_or_duplicate");
  for (const [index, branch] of p.branches.entries())
    if (new Set(branch.renderers).size !== branch.renderers.length) issue(["branches", index, "renderers"], "duplicate_branch_renderer");
  if (!ordinaryVoiceRenderers.every(renderer => p.branches.some(b => b.renderers.includes(renderer))))
    issue(["branches"], "ordinary_renderer_uncovered");
  if (JSON.stringify(p.branches.find(b => b.id === "transfer_announcement")?.renderers) !== JSON.stringify(["transfer_play"]))
    issue(["branches"], "transfer_announcement_renderer_mismatch");
  for (const id of ["recap", "saved"] as const)
    if (JSON.stringify(p.branches.find(b => b.id === id)?.renderers) !== JSON.stringify(["callback_media"]))
      issue(["branches"], "callback_terminal_renderer_mismatch");
  for (const id of ["final_invitation", "goodbye", "no_message"] as const) {
    const renderers = p.branches.find(b => b.id === id)?.renderers ?? [];
    if (!renderers.includes("callback_media") || renderers.some(r => r !== "callback_media" && r !== "primary_sip"))
      issue(["branches"], "ordinary_closing_renderer_mismatch");
  }
  if ((p.degraded.policy === "preserve_and_end") !== (p.degraded.renderers.length === 0))
    issue(["degraded"], "degraded_policy_renderer_mismatch");
  if (new Set(p.degraded.renderers.map(r => r.id)).size !== p.degraded.renderers.length)
    issue(["degraded", "renderers"], "duplicate_degraded_renderer");
});
export type ReceptionistVoiceReleaseProfile = z.infer<typeof receptionistVoiceReleaseProfileSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return "{" + Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
  return JSON.stringify(value);
}
export function parseReceptionistVoiceReleaseProfile(value: unknown): ReceptionistVoiceReleaseProfile {
  const profile = receptionistVoiceReleaseProfileSchema.parse(value);
  return { ...profile, branches: profile.branches.map(branch => ({ ...branch, renderers: [...branch.renderers].sort() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    degraded: { ...profile.degraded, renderers: [...profile.degraded.renderers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) } };
}
export function receptionistVoiceReleaseProfileHash(value: unknown): string {
  return "sha256:" + createHash("sha256").update(canonical(parseReceptionistVoiceReleaseProfile(value))).digest("hex");
}
export function assertReceptionistVoiceReleaseProfile(value: unknown, expectedHash: string): ReceptionistVoiceReleaseProfile {
  digest.parse(expectedHash);
  const profile = parseReceptionistVoiceReleaseProfile(value);
  if (receptionistVoiceReleaseProfileHash(profile) !== expectedHash) throw new Error("voice_release_profile_mismatch");
  return profile;
}

/** Candidate admission needs a valid current profile, not an already-qualified acoustic receipt. */
const qualificationSchema = z.object({
  version: z.literal("receptionist-voice-qualification/v1"),
  profileSha256: digest, runtimeCommit: z.string().regex(/^[a-f0-9]{40}$/),
  callerAudioSha256: digest, backendEvidenceSha256: digest,
  offlineBranchCoverage: z.array(branchId).length(ordinaryCallerVoiceBranches.length),
  audioRendererCoverage: z.array(rendererId).length(ordinaryVoiceRenderers.length),
  completeClosing: z.boolean(), terminalCleanup: z.boolean(), materialFailureCount: z.number().int().nonnegative(),
  voiceConsistency: z.enum(["consistent", "failed", "unassessed"]), reviewRef: z.string().trim().min(1).max(1000),
}).strict();
export type ReceptionistVoiceQualification = z.infer<typeof qualificationSchema>;
/** Structural policy only. The release launcher must separately open/hash the actual evidence and verify its provenance. */
export function assessReceptionistVoicePromotion(profile: unknown, evidence: unknown, expectedRuntimeCommit: string):
  { eligible: boolean; blockers: string[] } {
  const p = receptionistVoiceReleaseProfileSchema.safeParse(profile), e = qualificationSchema.safeParse(evidence);
  if (!p.success) return { eligible: false, blockers: ["voice_release_profile_invalid"] };
  if (!e.success) return { eligible: false, blockers: ["voice_release_qualification_missing_or_invalid"] };
  const q = e.data, blockers: string[] = [];
  if (q.profileSha256 !== receptionistVoiceReleaseProfileHash(p.data)) blockers.push("voice_release_qualification_stale");
  if (q.runtimeCommit !== expectedRuntimeCommit) blockers.push("voice_release_source_mismatch");
  if (new Set(q.offlineBranchCoverage).size !== ordinaryCallerVoiceBranches.length) blockers.push("voice_release_branch_coverage_missing");
  if (new Set(q.audioRendererCoverage).size !== ordinaryVoiceRenderers.length) blockers.push("voice_release_audio_coverage_missing");
  if (!q.completeClosing) blockers.push("voice_release_closing_unverified");
  if (!q.terminalCleanup) blockers.push("voice_release_cleanup_unverified");
  if (q.materialFailureCount !== 0) blockers.push("voice_release_material_failure");
  if (q.voiceConsistency !== "consistent") blockers.push("voice_release_voice_unqualified");
  return { eligible: blockers.length === 0, blockers };
}
