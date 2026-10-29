import { TELEPHONY_PCMU_BYTES_PER_20MS } from "./ports.js";

export interface ProcessingCueAsset {
  readonly id: "typing-soft-v1";
  readonly durationMs: number;
  readonly peakDbfs: number;
  readonly bytes: Uint8Array;
}

function linearToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32_635;
  let value = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (value & mask) === 0; exponent -= 1, mask >>= 1) { /* scan */ }
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function renderTypingCue(): Uint8Array {
  const samples = new Int16Array(2_560);
  for (const start of [160, 720, 1_360, 2_000]) {
    for (let index = 0; index < 72; index += 1) {
      const envelope = 1 - index / 72;
      const wave = Math.sin(index * 1.73) + Math.sin(index * 0.61) * 0.35;
      samples[start + index] = Math.round(2_000 * envelope * wave);
    }
  }
  return Uint8Array.from(samples, linearToMulaw);
}

const typingBytes = renderTypingCue();

export const TYPING_PROCESSING_CUE: ProcessingCueAsset = Object.freeze({
  id: "typing-soft-v1",
  durationMs: typingBytes.length / TELEPHONY_PCMU_BYTES_PER_20MS * 20,
  peakDbfs: -24,
  bytes: typingBytes,
});

export function processingCueAsset(id: string): ProcessingCueAsset {
  if (id !== TYPING_PROCESSING_CUE.id) throw new Error("voice_processing_cue_asset_rejected");
  if (TYPING_PROCESSING_CUE.durationMs > 700 || TYPING_PROCESSING_CUE.peakDbfs > -18
    || TYPING_PROCESSING_CUE.bytes.length % TELEPHONY_PCMU_BYTES_PER_20MS !== 0) {
    throw new Error("voice_processing_cue_asset_invalid");
  }
  return TYPING_PROCESSING_CUE;
}
