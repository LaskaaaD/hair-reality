export const OPENAI_MODEL_ID = "gpt-5.4-mini";
export const OPENAI_PRICING_VERSION = "openai-gpt-5.4-mini-2026-10-11";
export const OPENAI_PRICING_VERIFIED_AT = "2026-10-11";
export const MAX_OUTPUT_TOKENS = 2000;
/** Output ceiling of the demo stylist rank call only (28 candidates scored per criterion); every other call keeps MAX_OUTPUT_TOKENS. */
export const RANK_MAX_OUTPUT_TOKENS = 8000;
export const CONTEXT_WINDOW_TOKENS = 400_000;
export const TEXT_CHAR_LIMIT = 4000;
export const IMAGE_LIMIT = 2;
export const CANDIDATE_LIMIT = 12;
export const EVIDENCE_LIMIT = 8;
export const FINDING_LIMIT = 8;
export const IMAGE_DETAIL = "high" as const;
export const HIGH_DETAIL_MAX_SIDE = 2048;
export const HIGH_DETAIL_PATCH_BUDGET = 2500;
export const PATCH_PIXELS = 32;
export const MAX_PATCHES = 30_000;
export const IMAGE_TOKEN_NUMERATOR = 6;
export const IMAGE_TOKEN_DENOMINATOR = 5;
export const IMAGE_ROUNDING_ALLOWANCE = 1;
export const FRAMING_TOKEN_ALLOWANCE = 500;
export const INPUT_PRICE_NUMERATOR = 3;
export const INPUT_PRICE_DENOMINATOR = 4;
export const OUTPUT_PRICE_NUMERATOR = 9;
export const OUTPUT_PRICE_DENOMINATOR = 2;

export type ImageSize = { width: number; height: number };

export function ceilDiv(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0 || numerator < 0) {
    throw new Error("unsafe token arithmetic");
  }
  return Math.floor((numerator + denominator - 1) / denominator);
}

export function inputMicro(tokens: number): number {
  return ceilDiv(tokens * INPUT_PRICE_NUMERATOR, INPUT_PRICE_DENOMINATOR);
}

export function outputMicro(tokens: number): number {
  return ceilDiv(tokens * OUTPUT_PRICE_NUMERATOR, OUTPUT_PRICE_DENOMINATOR);
}

export function documentedImageTokens(width: number, height: number): number | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null;
  if (width < 1 || height < 1 || width > HIGH_DETAIL_MAX_SIDE || height > HIGH_DETAIL_MAX_SIDE) return null;
  let fittedWidth = width;
  let fittedHeight = height;
  let count = patchCount(fittedWidth, fittedHeight);
  if (count > HIGH_DETAIL_PATCH_BUDGET) {
    const shrink = Math.sqrt((PATCH_PIXELS * PATCH_PIXELS * HIGH_DETAIL_PATCH_BUDGET) / (fittedWidth * fittedHeight));
    fittedWidth = Math.floor(fittedWidth * shrink);
    fittedHeight = Math.floor(fittedHeight * shrink);
    if (fittedWidth < 1 || fittedHeight < 1) return null;
    count = patchCount(fittedWidth, fittedHeight);
    let guard = 0;
    while (count > HIGH_DETAIL_PATCH_BUDGET && guard < 64) {
      fittedWidth = Math.max(1, fittedWidth - 1);
      fittedHeight = Math.max(1, fittedHeight - 1);
      count = patchCount(fittedWidth, fittedHeight);
      guard += 1;
    }
  }
  if (count > HIGH_DETAIL_PATCH_BUDGET || count > MAX_PATCHES) return null;
  return ceilDiv(count * IMAGE_TOKEN_NUMERATOR, IMAGE_TOKEN_DENOMINATOR);
}

export function reservedImageTokens(width: number, height: number): number | null {
  const documented = documentedImageTokens(width, height);
  if (documented === null) return null;
  return documented + IMAGE_ROUNDING_ALLOWANCE;
}

export function textTokenCeiling(utf8Bytes: number): number | null {
  if (!Number.isSafeInteger(utf8Bytes) || utf8Bytes < 0) return null;
  const tokens = utf8Bytes + FRAMING_TOKEN_ALLOWANCE;
  if (!Number.isSafeInteger(tokens)) return null;
  return tokens;
}

export function reservationMicro(inputTokens: number): number | null {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) return null;
  const input = inputMicro(inputTokens);
  const output = outputMicro(MAX_OUTPUT_TOKENS);
  const total = input + output;
  if (!Number.isSafeInteger(total)) return null;
  return total;
}

export function usageMicro(inputTokens: number, outputTokens: number): number | null {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  if (inputTokens < 0 || outputTokens < 0) return null;
  const total = inputMicro(inputTokens) + outputMicro(outputTokens);
  if (!Number.isSafeInteger(total)) return null;
  return total;
}

function patchCount(width: number, height: number): number {
  return Math.ceil(width / PATCH_PIXELS) * Math.ceil(height / PATCH_PIXELS);
}
