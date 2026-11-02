/** Maps a 0–100 reality score to the five feasibility tiers from the brand board. */
export type FeasibilityTier =
  | "highly_feasible"
  | "realistic"
  | "possible"
  | "challenging"
  | "not_recommended";

export const FEASIBILITY_LABELS: Record<FeasibilityTier, string> = {
  highly_feasible: "Highly feasible",
  realistic: "Realistic",
  possible: "Possible",
  challenging: "Challenging",
  not_recommended: "Not recommended",
};

export function scoreToFeasibilityTier(score: number): FeasibilityTier {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped >= 85) return "highly_feasible";
  if (clamped >= 70) return "realistic";
  if (clamped >= 55) return "possible";
  if (clamped >= 40) return "challenging";
  return "not_recommended";
}

export function feasibilityLabel(score: number): string {
  return FEASIBILITY_LABELS[scoreToFeasibilityTier(score)];
}

/** Short verdict line for style cards (demo marketing copy). */
export function scoreToVerdict(score: number): string {
  const tier = scoreToFeasibilityTier(score);
  switch (tier) {
    case "highly_feasible":
      return "Works today";
    case "realistic":
      return "Strong match";
    case "possible":
      return "Works with adjustment";
    case "challenging":
      return "Grow first";
    default:
      return "Not recommended";
  }
}

export function scoreRingTone(score: number): "high" | "mid" | "low" {
  if (score >= 70) return "high";
  if (score >= 50) return "mid";
  return "low";
}
