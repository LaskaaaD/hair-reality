/** Rankable haircut copy. Keys match catalogue `variant.key`. */

import generated from "./ranking-reasons.generated.json" with { type: "json" };

export type RankableStyleEntry = {
  reason: string;
};

/** Generic geometry templates scoring uses when no entry exists — tests reject these. */
export const GENERIC_RANKING_REASON_PATTERNS: readonly RegExp[] = [
  / keeps the top low and leaves some width at the sides/,
  / uses a low taper to clean the neck while keeping width above the ears\./,
  / stacks height over the forehead/,
  / stays a workable outline for a rounder face\./,
  / adds width without height, which makes a rounder face look wider\./,
];

export const RANKABLE_STYLE_BY_KEY: Record<string, RankableStyleEntry> = generated as Record<
  string,
  RankableStyleEntry
>;

export function rankableStyleEntryForKey(key: string): RankableStyleEntry | undefined {
  return RANKABLE_STYLE_BY_KEY[key];
}

export function rankingReasonForKey(key: string): string | undefined {
  return RANKABLE_STYLE_BY_KEY[key]?.reason;
}
