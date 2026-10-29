import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runLocalVoiceAppFixture, type LocalAppBridgeObservation } from "../../../scripts/verification-voice-app.js";
import type { Trial } from "./scorecard.js";

const frozen = new Set(["public-baseline-fixture-v1", "public-candidate-fixture-v1"]);
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export async function runLocalFixtureTrial(input: { sourceArtifact: string; scenarioId: string; trial: number; fixtureSource: { manifestPath: string; expectedManifestSha256: string; fixtureId: string }; evidencePath: string }): Promise<Trial> {
  if (!frozen.has(input.sourceArtifact)) throw new Error("benchmark_source_artifact_not_frozen_pair");
  const adapterSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  const observation: { value: LocalAppBridgeObservation | null } = { value: null };
  const evidence = await runLocalVoiceAppFixture({ fixtureSource: input.fixtureSource, expectedCategory: "scheduling", evidencePath: input.evidencePath, observe: item => { observation.value = item; } });
  const observed = observation.value;
  if (observed === null || observed.conversationId !== evidence.conversationId || observed.sipAttemptId !== evidence.sipAttemptId || observed.transcriptReceiptId !== evidence.transcriptReceiptId || observed.toolReceiptId !== evidence.toolReceiptId) throw new Error("benchmark_local_fixture_observation_mismatch");
  return Object.freeze({ scenarioId: input.scenarioId, trial: input.trial, binding: { sourceArtifact: input.sourceArtifact, productionFiles: ["services/process-shell/src/receptionist-callback-dialogue.ts", "services/process-shell/src/receptionist-voice-session.ts"], fixtureSha256: `sha256:${evidence.fixtureManifestSha256}`, adapterSha256, profile: "offline-signed-sip-pg", nodeVersion: process.version, runnerVersion: "vitest", prompt: null, model: null, tool: null }, validity: "unknown", outcome: "inconclusive", priorFailure: null, traces: [`public-artifact:${input.sourceArtifact}`, `adapter:${adapterSha256}`, `selected-source:${evidence.selectedSourceFingerprints.appSelectedFiles.sha256}`, `harness:${evidence.selectedSourceFingerprints.harnessFile.sha256}`, `response:${observed.responseToken}:${observed.responseCreateEventIndex}`, `sip:${observed.sipAttemptId}`, `conversation:${observed.conversationId}`, `transcript:${observed.transcriptReceiptId}`, `tool:${observed.toolReceiptId}`], actualSessionFrameBinding: true, persistedStateReadback: true, latencyMs: null, costUsd: null, goals: [], failure: "local_fixture_has_no_causal_caller_bridge_or_full_resolution" } satisfies Trial);
}
