import { FEASIBILITY_LABELS, scoreToFeasibilityTier, type FeasibilityTier } from "./feasibility.js";

export type FeasibilityBadgeProps = {
  /** Either explicit tier or derived from score. */
  tier?: FeasibilityTier;
  score?: number;
  className?: string;
};

export function FeasibilityBadge({ tier, score, className }: FeasibilityBadgeProps) {
  const resolved = tier ?? scoreToFeasibilityTier(score ?? 0);
  const label = FEASIBILITY_LABELS[resolved];
  return (
    <span className={["hr-feasibility-badge", `hr-feasibility-badge--${resolved}`, className].filter(Boolean).join(" ")}>
      <span className="hr-feasibility-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
