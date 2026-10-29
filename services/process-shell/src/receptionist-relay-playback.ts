import { createHash } from "node:crypto";

export interface RelayPlaybackBinding {
  practiceId: string; instanceId: string; conversationId: string; parentCallId: string; recoveryId: string;
  sessionId: string | null; ownerEpoch: number; voiceEpoch: number; questionId: string; requestId: string; requestRevision: number;
}
type Pending = { binding: RelayPlaybackBinding; text: string; normalized: string; chunks: readonly string[]; nextChunk: number };

/**
 * Candidate adapter for the documented played-token event concept. Wire shapes below
 * require qualification against an authenticated real provider capture, not a fake test.
 * One instance belongs to one authenticated Relay connection; sent text is never proof.
 */
export class RelayPlayedTextGate {
  private pending: Pending | null = null;
  private readonly issued = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly retiredChunks = new Set<string>();

  issue(binding: RelayPlaybackBinding, text: string): boolean {
    this.pending = null;
    const chunks = rawSentenceChunks(text);
    if (!validBinding(binding) || text.length > 12_000 || normalize(text).length === 0 || this.issued.size >= 128
      || chunks === null || new Set(chunks).size !== chunks.length || chunks.some((chunk) => this.retiredChunks.has(chunk)) || this.retiredChunks.has(text)) return false;
    // Without a provider-issued talk-cycle identifier, identical retransmission is
    // ambiguous. Rephrase its preface instead of assigning an old receipt to it.
    const key = digest(JSON.stringify([binding.parentCallId, binding.recoveryId, binding.sessionId, binding.ownerEpoch, binding.voiceEpoch, normalize(text)]));
    if (this.issued.has(key)) return false;
    this.issued.add(key);
    for (const chunk of chunks) this.retiredChunks.add(chunk);
    this.retiredChunks.add(text);
    this.pending = { binding: structuredClone(binding), text, normalized: normalize(text), chunks, nextChunk: 0 };
    return true;
  }

  invalidate(): void { this.pending = null; }

  observe(raw: string): boolean {
    if (raw.length > 32_768 || this.pending === null) return false;
    let event: unknown;
    try { event = JSON.parse(raw); } catch { return false; }
    const parsed = candidatePlayedText(event);
    if (parsed === null || parsed.text.length > 12_000) return false;
    const wireHash = digest(raw);
    if (this.observed.has(wireHash) || this.observed.size >= 256) return false;
    this.observed.add(wireHash);
    const p = this.pending;
    if (parsed.sessionId !== null && parsed.sessionId !== p.binding.sessionId
      || parsed.parentCallId !== null && parsed.parentCallId !== p.binding.parentCallId) return false;
    if (p.nextChunk === 0 && parsed.text === p.text) { p.nextChunk = p.chunks.length; return true; }
    if (parsed.text !== p.chunks[p.nextChunk]) return false;
    p.nextChunk += 1;
    return true;
  }

  completed(binding: RelayPlaybackBinding, text: string): boolean {
    const p = this.pending;
    return p !== null && p.nextChunk === p.chunks.length && sameBinding(binding, p.binding) && normalize(text) === p.normalized;
  }
}

/** No elapsed-time, speaker-stopped, generic debug, or send-last message is a played-text receipt. */
function candidatePlayedText(value: unknown): { text: string; sessionId: string | null; parentCallId: string | null } | null {
  // This is deliberately limited to the observed authenticated Relay namespace.
  if (!record(value) || value.type !== "info" || value.name !== "tokensPlayed") return null;
  const candidates: string[] = [], sessions: string[] = [], parents: string[] = [];
  let fields = 0, invalid = false;
  const visit = (item: unknown, depth: number): void => {
    if (!record(item) || depth > 2 || invalid) return;
    for (const [key, entry] of Object.entries(item)) {
      if (++fields > 32) { invalid = true; return; }
      if (key === "sessionId") { if (typeof entry !== "string") invalid = true; else sessions.push(entry); continue; }
      if (key === "callSid") { if (typeof entry !== "string") invalid = true; else parents.push(entry); continue; }
      if ((key === "last" || key === "played") && entry === false) { invalid = true; continue; }
      if (typeof entry === "string" && !relayMetadataKey(key)) { if (entry.length > 0) candidates.push(entry); else invalid = true; continue; }
      if (Array.isArray(entry)) {
        if (relayMetadataKey(key) || entry.length === 0 || entry.length > 1_000 || !entry.every((part) => typeof part === "string")) { invalid = true; continue; }
        const joined = entry.join("");
        if (joined.length === 0 || joined.length > 12_000) { invalid = true; continue; }
        candidates.push(joined); continue;
      }
      if (record(entry)) {
        if (depth >= 2) invalid = true;
        else visit(entry, depth + 1);
      }
    }
  };
  visit(value, 0);
  if (invalid || candidates.length !== 1 || candidates[0]!.length === 0 || new Set(sessions).size > 1 || new Set(parents).size > 1) return null;
  return { text: candidates[0]!, sessionId: sessions[0] ?? null, parentCallId: parents[0] ?? null };
}
function relayMetadataKey(key: string): boolean { return ["type", "name", "event", "sessionId", "callSid", "last", "played", "timestamp", "sequence", "id"].includes(key); }
/** Preserve the provider's observed sentence spans, including whitespace before later sentences. */
function rawSentenceChunks(text: string): string[] | null {
  const chunks = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return chunks === null || chunks.length === 0 || chunks.join("") !== text || chunks.some((chunk) => chunk.length === 0) ? null : chunks;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function normalize(text: string): string { return text.normalize("NFKC").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim(); }
function digest(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function sameBinding(a: RelayPlaybackBinding, b: RelayPlaybackBinding): boolean {
  return Object.keys(b).every((key) => a[key as keyof RelayPlaybackBinding] === b[key as keyof RelayPlaybackBinding]);
}
function validBinding(b: RelayPlaybackBinding): boolean {
  return [b.practiceId, b.instanceId, b.conversationId, b.parentCallId, b.recoveryId, b.questionId, b.requestId].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200)
    && (b.sessionId === null || typeof b.sessionId === "string" && b.sessionId.length > 0 && b.sessionId.length <= 200)
    && [b.ownerEpoch, b.voiceEpoch, b.requestRevision].every((v) => Number.isSafeInteger(v) && v >= 0);
}
