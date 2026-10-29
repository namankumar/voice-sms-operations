import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECEPTIONIST_REALTIME_MODEL } from "../services/process-shell/src/receptionist-openai.js";
import { assertLocalFixtureReadback, awaitNewResponseToken, fingerprintSourceFiles, loadCallerFixture, runLocalVoiceAppFixture } from "./verification-voice-app.js";

const corpus = resolve(process.cwd(), "benchmarks/voice-receptionist/fixtures/synthetic/audio-manifest.json");
const corpusAvailable = existsSync(corpus);
if (!corpusAvailable) throw new Error("public_synthetic_voice_fixture_missing");
const manifestSha256 = "d217d926f6cc58357006d5910eb60c9f865b3eedd1ac91eada7cc7781b559274";
const fixtureSource = { manifestPath: corpus, expectedManifestSha256: manifestSha256, fixtureId: "synthetic/appointment-change" };

describe("local application voice bridge", () => {
  const nativeFetch = globalThis.fetch;
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("local_bridge_network_denied");
      return await nativeFetch(resource, init);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("rejects oversized corpus files and symlink escape before reading clip bytes", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vegas-voice-corpus-negative-"));
    try {
      const root = join(folder, "root");
      await mkdir(root);
      const outside = join(folder, "outside.wav");
      await writeFile(outside, "not a wave");
      await symlink(outside, join(root, "clip.wav"));
      const manifestPath = join(root, "audio-manifest.json");
      const manifest = (file: string) => JSON.stringify({ format: { container: "WAV", encoding: "PCM_S16LE", sample_rate: 16_000, channels: 1 },
        clips: [{ profile: "fixture", utterance: "one", transcript: "Please help me.", file,
          audio: { sha256: "0".repeat(64), duration_seconds: 1 } }] });
      const linked = manifest("clip.wav");
      await writeFile(manifestPath, linked);
      await expect(loadCallerFixture({ manifestPath, expectedManifestSha256: createHash("sha256").update(linked).digest("hex"), fixtureId: "fixture/one" }))
        .rejects.toThrow("voice_fixture_path_invalid");
      const hugeClip = Buffer.alloc(4_000_001);
      await writeFile(join(root, "big.wav"), hugeClip);
      const oversizedClip = manifest("big.wav");
      await writeFile(manifestPath, oversizedClip);
      await expect(loadCallerFixture({ manifestPath, expectedManifestSha256: createHash("sha256").update(oversizedClip).digest("hex"), fixtureId: "fixture/one" }))
        .rejects.toThrow("voice_fixture_file_size_or_type_invalid");
      const oversizedManifest = Buffer.alloc(2_000_001);
      await writeFile(manifestPath, oversizedManifest);
      await expect(loadCallerFixture({ manifestPath, expectedManifestSha256: createHash("sha256").update(oversizedManifest).digest("hex"), fixtureId: "fixture/one" }))
        .rejects.toThrow("voice_fixture_file_size_or_type_invalid");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it("changes source fingerprint on edited bytes and rejects a source symlink escape", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vegas-voice-source-negative-"));
    try {
      const root = join(folder, "root");
      await mkdir(root);
      await writeFile(join(root, "app.ts"), "export const version = 1;\n");
      const first = await fingerprintSourceFiles(root, ["app.ts"]);
      await writeFile(join(root, "app.ts"), "export const version = 2;\n");
      const second = await fingerprintSourceFiles(root, ["app.ts"]);
      expect(first.sha256).not.toBe(second.sha256);
      const outside = join(folder, "outside.ts");
      await writeFile(outside, "export const outside = true;\n");
      await symlink(outside, join(root, "link.ts"));
      await expect(fingerprintSourceFiles(root, ["link.ts"])).rejects.toThrow("local_app_source_path_invalid");
    } finally { await rm(folder, { recursive: true, force: true }); }
  });

  it("waits for a token change rather than assuming the opening token format", async () => {
    let token = "r1-2";
    const socket = { latestResponseToken: () => token };
    const next = awaitNewResponseToken(socket, "r1-2", 200);
    setTimeout(() => { token = "caller-turn-opaque"; }, 20);
    await expect(next).resolves.toBe("caller-turn-opaque");
    await expect(awaitNewResponseToken(socket, "caller-turn-opaque", 30)).rejects.toThrow("local_app_fixture_timeout");
  });

  it("rejects a caller-supplied composition or provider override before startup", async () => {
    let started = false;
    const injected = { fixtureSource, expectedCategory: "scheduling", evidencePath: join(tmpdir(), "must-not-write.json"),
      composition: { start: () => { started = true; throw new Error("ordinary_composition_started"); } } };
    await expect(runLocalVoiceAppFixture(injected as never)).rejects.toThrow("local_app_untrusted_injection");
    await expect(runLocalVoiceAppFixture({ fixtureSource, expectedCategory: "scheduling", evidencePath: join(tmpdir(), "must-not-write.json"),
      fetch: async () => { throw new Error("provider_override_started"); } } as never)).rejects.toThrow("local_app_untrusted_injection");
    expect(started).toBe(false);
  });

  it("binds transcript and tool receipts to the exact selected request, category, and fixture text", () => {
    const expected = { practiceId: "fixture-practice", instanceId: "fixture-instance", sourceId: "fixture-source",
      transcript: "I need to move my appointment.", category: "scheduling", promptVersion: "fixture-prompt-1",
      transcriptReceiptId: "transcript-receipt", toolReceiptId: "tool-receipt" };
    const scope = { practiceId: expected.practiceId, instanceId: expected.instanceId, conversationId: "conversation-1" };
    const durable = { id: scope.conversationId, inputs: [{ id: expected.sourceId, body: expected.transcript }],
      requests: [{ id: "request-1", sourceIds: [expected.sourceId], category: expected.category, originalRequest: expected.transcript }] };
    const transcriptReceipt = { receipt: { accepted: true, eventId: expected.transcriptReceiptId },
      input: { scope, command: { type: "input.record", sourceId: expected.sourceId, body: expected.transcript } } };
    const toolReceipt = { receipt: { accepted: true, eventId: expected.toolReceiptId },
      input: { scope, command: { type: "request.draft", requestId: "request-1", sourceEventId: expected.sourceId, category: expected.category },
        proposal: { sourceId: expected.sourceId, tool: "propose_receptionist_intent", promptVersion: expected.promptVersion,
          model: RECEPTIONIST_REALTIME_MODEL, provider: "openai", arguments: { category: expected.category } } } };
    const base = { durable, transcriptReceipt, toolReceipt, expected };
    expect(assertLocalFixtureReadback(base)).toBe("request-1");
    expect(() => assertLocalFixtureReadback({ ...base, toolReceipt: { ...toolReceipt,
      input: { ...toolReceipt.input, command: { ...toolReceipt.input.command, requestId: "request-other" } } } })).toThrow("local_app_durable_receipt_mismatch");
    expect(() => assertLocalFixtureReadback({ ...base, toolReceipt: { ...toolReceipt,
      input: { ...toolReceipt.input, command: { ...toolReceipt.input.command, category: "referrals" } } } })).toThrow("local_app_durable_receipt_mismatch");
    expect(() => assertLocalFixtureReadback({ ...base, toolReceipt: { ...toolReceipt,
      input: { ...toolReceipt.input, proposal: { ...toolReceipt.input.proposal, arguments: { category: "referrals" } } } } })).toThrow("local_app_durable_receipt_mismatch");
    expect(() => assertLocalFixtureReadback({ ...base, transcriptReceipt: { ...transcriptReceipt,
      input: { ...transcriptReceipt.input, command: { ...transcriptReceipt.input.command, body: "Different caller words." } } } })).toThrow("local_app_durable_receipt_mismatch");
  });

  it.skipIf(!corpusAvailable)("runs signed admission and webhook with selected-source-labeled durable readback (uses public synthetic fixture)", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vegas-local-voice-"));
    console.info(`local_voice_bridge_artifacts=${folder}`);
    const clip = await loadCallerFixture(fixtureSource);
    const evidencePath = join(folder, "local-evidence.json");
    const observed: unknown[] = [];
    const evidence = await runLocalVoiceAppFixture({ fixtureSource, expectedCategory: "scheduling", evidencePath, observe: item => { observed.push(item); } });
    expect(evidence).toMatchObject({ schemaVersion: "local-voice-app-fixture/v2",
      kind: "local_app_fixture_execution_not_carrier_or_model_evidence",
      sourceIdentityScope: "selected_source_files_only_not_exact_runtime_identity", fixtureId: clip.fixtureId,
      fixtureClipSha256: clip.clipSha256, fixtureManifestSha256: manifestSha256,
      configVersion: "fixture-config-1", promptVersion: "fixture-prompt-1", requestCategory: "scheduling", requestSourceIds: [evidence.sourceId] });
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files).toHaveLength(22);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files.some((file) => file.path.endsWith("/simulated-route-outcome.ts"))).toBe(true);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files.some((file) => file.path.endsWith("/receptionist-main.ts"))).toBe(true);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files.some((file) => file.path.endsWith("/conversation-console.ts"))).toBe(true);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files.some((file) => file.path.endsWith("/receptionist-public-faq.ts"))).toBe(true);
      expect(evidence.selectedSourceFingerprints.appSelectedFiles.files.some((file) => file.path.endsWith("/receptionist-response-owner.ts"))).toBe(false);
      expect(evidence.selectedSourceFingerprints.harnessFile.files).toEqual([{ path: "scripts/verification-voice-app.ts", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
      expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(evidence);
      expect(evidence.normalizedFixtureEvents.map((item) => item.type)).toContain("response.function_call_arguments.done");
      expect(evidence.offlineProviderRequests).toEqual([`https://api.openai.com/v1/realtime/calls/${evidence.providerCallId}/accept`]);
      expect(observed).toEqual([expect.objectContaining({ conversationId: evidence.conversationId, sipAttemptId: evidence.sipAttemptId, transcriptReceiptId: evidence.transcriptReceiptId, toolReceiptId: evidence.toolReceiptId, responseToken: expect.any(String), responseCreateEventIndex: expect.any(Number) })]);
  }, 40_000);

  it.skipIf(!corpusAvailable)("rejects a stale corpus pin before opening any app connection (uses public synthetic fixture)", async () => {
    await expect(loadCallerFixture({ manifestPath: corpus, expectedManifestSha256: "0".repeat(64), fixtureId: "samantha-normal/uncertain-time" }))
      .rejects.toThrow("voice_fixture_manifest_hash_mismatch");
    await expect(loadCallerFixture({ manifestPath: corpus, expectedManifestSha256: manifestSha256, fixtureId: "unknown/clip" }))
      .rejects.toThrow("voice_fixture_id_missing_or_duplicate");
  });

  it.skipIf(!corpusAvailable).each(["provider_rejected", "sideband_unavailable", "sideband_send_failed"] as const)("fails closed when %s and writes no success evidence (uses public synthetic fixture)", async (failureMode) => {
    const folder = await mkdtemp(join(tmpdir(), "vegas-local-voice-fail-"));
    console.info(`local_voice_bridge_artifacts=${folder}`);
    const evidencePath = join(folder, "should-not-exist.json");
    const observed: unknown[] = [];
    await expect(runLocalVoiceAppFixture({ fixtureSource, expectedCategory: "scheduling", evidencePath, failureMode, waitMs: 500, observe: item => { observed.push(item); } })).rejects.toThrow("local_app_fixture_timeout");
      await expect(readFile(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(`${evidencePath}.failure.json`, "utf8"))).toMatchObject({
        schemaVersion: "local-voice-app-fixture/v2", kind: "local_app_fixture_failure_not_carrier_or_model_evidence",
        sourceIdentityScope: "selected_source_files_only_not_exact_runtime_identity", fixtureId: fixtureSource.fixtureId,
        configVersion: "fixture-config-1", promptVersion: "fixture-prompt-1",
        selectedSourceFingerprints: { appSelectedFiles: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          harnessFile: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        reason: "local_app_fixture_timeout",
      });
      expect(observed).toEqual([]);
  }, 40_000);
});
