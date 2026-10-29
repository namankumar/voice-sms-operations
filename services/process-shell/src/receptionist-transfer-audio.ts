import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ControlPlaneSpokenDirective, StreamingSpeechProvider } from "@salven/voice-runtime";
import type { Conversation, ConversationScope } from "./conversation-contract.js";
import type { ConversationStore } from "./conversation-store.js";
import { controlledTransferAnnouncement, type ControlledTransferAttempt } from "./controlled-test-transfer.js";

type Asset = { id: string; scope: ConversationScope; parentCallId: string; profile: string; transferId: string; sourceId: string;
  ownerEpoch: number; voiceEpoch: number; requestId: string; requestRevision: number; expires: number; bytes: Buffer };
/** Short neutral caller announcements only; transient synthesis buffers are not call recordings or playback receipts. */
export class ReceptionistTransferAudioAssets {
  private readonly assets = new Map<string, Asset>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly controllers = new Set<AbortController>();
  private readonly base: URL;
  constructor(private readonly options: { speech: StreamingSpeechProvider; publicOrigin: string; secret: string;
    store: Pick<ConversationStore, "get">; currentProfile(state: Conversation): string | null; now?: () => number }) {
    this.base = new URL(options.publicOrigin);
    if (this.base.protocol !== "https:" || this.base.pathname !== "/" || this.base.search || this.base.hash || this.base.username || this.base.password || options.secret.length < 32) throw new Error("transfer_audio_configuration_invalid");
  }
  async prepare(state: Conversation, attempt: ControlledTransferAttempt): Promise<string> {
    const profile = this.options.currentProfile(state);
    if (profile === null || state.owner !== "ai" || state.phase !== "active" || state.suppressed || attempt.ownerEpoch !== state.ownerEpoch || attempt.voiceEpoch !== state.voiceEpoch) throw new Error("transfer_audio_authority_lost");
    const key = `${profile}:${attempt.id}`;
    const existing = [...this.assets.values()].find(asset => asset.profile === profile && asset.transferId === attempt.id && asset.expires > this.now());
    if (existing && await this.current(existing)) return this.url(existing);
    const inFlight = this.pending.get(key); if (inFlight) return await inFlight;
    const work = this.generate(state, attempt, profile);
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  private async generate(state: Conversation, attempt: ControlledTransferAttempt, profile: string): Promise<string> {
    this.prune(); if (this.assets.size >= 64) throw new Error("transfer_audio_capacity");
    const sourceId = state.inputs.at(-1)?.id; if (!sourceId) throw new Error("transfer_audio_source_missing");
    const asset: Asset = { id: randomBytes(16).toString("hex"), scope: { practiceId: state.admission.practiceId, instanceId: state.admission.instanceId, conversationId: state.id },
      parentCallId: state.admission.externalId, profile, transferId: attempt.id, sourceId, ownerEpoch: state.ownerEpoch, voiceEpoch: state.voiceEpoch,
      requestId: attempt.requestId, requestRevision: attempt.requestRevision, expires: Math.min(this.now() + 30_000, Date.parse(attempt.deadlineAt)), bytes: Buffer.alloc(0) };
    if (!await this.current(asset)) throw new Error("transfer_audio_authority_lost");
    const text = controlledTransferAnnouncement(attempt.category);
    const directive: ControlPlaneSpokenDirective = { id: `announcement-${asset.id}`, kind: "speak", purpose: "response", callId: asset.parentCallId,
      callLifecycleId: asset.transferId, turnId: asset.id, callStateVersion: state.revision, goalId: asset.requestId, text,
      provenance: { authority: "control_plane", issuerId: "receptionist-transfer-audio", authorityReceiptId: asset.id, authorityNonce: asset.id,
        authorityExpiresAtMs: asset.expires, traceId: asset.id, issuedAtMs: this.now(), sourceEventIds: [sourceId] } };
    const abort = new AbortController(); this.controllers.add(abort);
    const timer = setTimeout(() => abort.abort(), 5_000); timer.unref();
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const frame of this.options.speech.streamAuthorizedSpeech("transfer-announcement", directive, abort.signal)) {
        if (abort.signal.aborted) throw new Error("transfer_audio_timeout");
        const pcmu = Buffer.from(frame.payloadBase64, "base64"); bytes += pcmu.length;
        if (frame.callId !== asset.parentCallId || frame.encoding !== "audio/pcmu" || frame.sampleRateHz !== 8000 || bytes > 80_000) throw new Error("transfer_audio_invalid");
        chunks.push(pcmu);
      }
      if (bytes === 0 || !await this.current(asset)) throw new Error("transfer_audio_authority_lost");
      asset.bytes = Buffer.concat(chunks); this.assets.set(asset.id, asset); return this.url(asset);
    } finally { clearTimeout(timer); this.controllers.delete(abort); }
  }
  async serve(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url ?? "/", this.base), match = /^\/voice\/audio\/transfer\/([a-f0-9]{32})$/.exec(url.pathname);
    const caps = url.searchParams.getAll("cap");
    if (request.method !== "GET" || !match || caps.length !== 1 || [...url.searchParams.keys()].some(key => key !== "cap")) return false;
    const asset = this.assets.get(match[1]!); if (!asset || asset.expires <= this.now() || !equal(caps[0]!, this.capability(asset)) || !await this.current(asset)) return false;
    response.writeHead(200, { "Content-Type": "audio/ulaw", "Content-Length": asset.bytes.length, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    response.end(asset.bytes); return true;
  }
  private async current(asset: Asset): Promise<boolean> {
    if (asset.expires <= this.now()) return false;
    const state = await this.options.store.get(asset.scope);
    const record = state?.controlledTransfers.find(item => item.attempt.id === asset.transferId), request = state?.requests.find(item => item.id === asset.requestId);
    return state !== null && state.owner === "ai" && state.phase === "active" && !state.suppressed && state.admission.externalId === asset.parentCallId
      && state.ownerEpoch === asset.ownerEpoch && state.voiceEpoch === asset.voiceEpoch && this.options.currentProfile(state) === asset.profile
      && state.inputs.at(-1)?.id === asset.sourceId && request?.revision === asset.requestRevision && record?.outcome === null;
  }
  private capability(asset: Asset): string { return `${asset.expires}.${createHmac("sha256", this.options.secret).update(JSON.stringify([asset.id, asset.scope, asset.parentCallId, asset.profile, asset.transferId, asset.sourceId, asset.ownerEpoch, asset.voiceEpoch, asset.expires])).digest("base64url")}`; }
  private url(asset: Asset): string { const url = new URL(`/voice/audio/transfer/${asset.id}`, this.base); url.searchParams.set("cap", this.capability(asset)); return url.toString(); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private prune(): void { for (const [id, value] of this.assets) if (value.expires <= this.now()) this.assets.delete(id); }
  close(): void { for (const controller of this.controllers) controller.abort(); this.assets.clear(); }
}
function equal(a: string, b: string): boolean { const first = Buffer.from(a), second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); }
