import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { receptionistVoiceReleaseProfileHash, type ReceptionistVoiceReleaseProfile } from "./receptionist-voice-release.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const claimsSchema = z.object({
  version: z.literal("receptionist-voice-promotion/v1"),
  profileSha256: digest, sourceSha256: digest, qualificationSha256: digest,
  runtimeCommit: z.string().regex(/^[a-f0-9]{40}$/), issuedAt: z.string().datetime(),
}).strict();
const tokenSchema = claimsSchema.extend({ signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ReceptionistVoicePromotionClaims = z.infer<typeof claimsSchema>;
declare const verifiedPromotion: unique symbol;
export type VerifiedReceptionistVoicePromotion = Readonly<ReceptionistVoicePromotionClaims> & { readonly [verifiedPromotion]: true };
function signature(claims: ReceptionistVoicePromotionClaims, secret: string): string {
  if (Buffer.byteLength(secret) < 32) throw Error("voice_promotion_secret_invalid");
  // Fixed ordered serialization and a distinct purpose prevent reuse as a recovery/audio capability.
  return createHmac("sha256", secret).update("receptionist.voice.promotion.v1\n").update(JSON.stringify([
    claims.version, claims.profileSha256, claims.sourceSha256, claims.qualificationSha256, claims.runtimeCommit, claims.issuedAt,
  ])).digest("hex");
}
/** Trusted release tooling calls this only after opening and validating the actual qualification artifacts. */
export function signReceptionistVoicePromotion(value: ReceptionistVoicePromotionClaims, secret: string): string {
  const claims = claimsSchema.parse(value);
  return JSON.stringify({ ...claims, signature: signature(claims, secret) });
}
/** Composition rechecks the actual resolved profile; an environment hash alone cannot promote a release. */
export function verifyReceptionistVoicePromotion(
  token: string, secret: string, profile: ReceptionistVoiceReleaseProfile,
): VerifiedReceptionistVoicePromotion {
  if (token.length > 4096) throw Error("voice_promotion_token_invalid");
  const parsed = tokenSchema.parse(JSON.parse(token));
  const { signature: supplied, ...claims } = parsed;
  const expected = signature(claims, secret);
  if (!timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex")))
    throw Error("voice_promotion_signature_invalid");
  if (claims.profileSha256 !== receptionistVoiceReleaseProfileHash(profile) || claims.sourceSha256 !== profile.sourceSha256)
    throw Error("voice_promotion_profile_mismatch");
  return Object.freeze(claims) as VerifiedReceptionistVoicePromotion;
}
