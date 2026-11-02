import type { StyleVariant } from "./knowledge-base.js";

/** Hair this smooth never holds a perm, wave pattern, loc or twist: curl 1 (straight) and every 2x (wavy). */
export function isSmoothCurl(curl: string): boolean {
  return curl === "1" || curl.startsWith("2");
}

/** 4a to 4c: coily hair that cannot be worn pin-straight without a relaxer or a daily heat routine. */
export function isVeryCurly(curl: string): boolean {
  return curl.startsWith("4");
}

const SMOOTH_CODES = new Set(["1", "2a", "2b", "2c"]);

/** Chemical texture and barber-wave patterns: none of them exist on straight hair without a treatment. */
const NEEDS_TEXTURE = /\bperm\b|\bperms\b|\b(180|360|540|720) waves\b|\bwaves with fade\b|\bcaesar with waves\b|wolfing waves|wave-perm|\blocs?\b|sisterlocks|\btwists?\b|twist-out|twist out|afro|frohawk|coil|jheri|curly|spiral|ringlet|sponge|bantu|wash and go|wash-and-go|crochet|crimp|superman curl|braid-out|\bTWA\b|natural/i;

/** Cuts that only work when the hair is straight or pressed flat. */
const NEEDS_STRAIGHT = /\bstraight\b|sleek|silk[- ]press|pin[- ]straight|wig install|glass hair|poker/i;

/**
 * True when the style needs curly, coily or textured (or chemically textured) hair. With the client's own curl
 * code, a style whose listed curl range does not include it counts too (a curly crop that starts at 2a suits 2a hair).
 */
export function needsTexturedHair(variant: Pick<StyleVariant, "id" | "title" | "requirements">, curl?: string): boolean {
  const codes = variant.requirements.curl;
  if (curl ? !codes.includes(curl as never) : !codes.some((code) => SMOOTH_CODES.has(code))) return true;
  return NEEDS_TEXTURE.test(`${variant.title} ${variant.id}`);
}

/** True when the style needs straight or smooth hair, which very curly hair does not have. */
export function needsStraightHair(variant: Pick<StyleVariant, "id" | "title" | "requirements">): boolean {
  if (NEEDS_STRAIGHT.test(`${variant.title} ${variant.id}`)) return true;
  return !variant.requirements.curl.some((code) => !SMOOTH_CODES.has(code)) && (variant.requirements.topCm ?? 0) >= 20;
}
