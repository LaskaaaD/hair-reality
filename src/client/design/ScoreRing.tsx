import { scoreRingTone } from "./feasibility.js";

export type ScoreRingProps = {
  score: number;
  /** e.g. "Reality Score" */
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

export function ScoreRing({ score, label, size = "md", className }: ScoreRingProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const shown = String(clamped);
  const tone = scoreRingTone(clamped);
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div
      className={["hr-score-ring", `hr-score-ring--${size}`, `hr-score-ring--${tone}`, className]
        .filter(Boolean)
        .join(" ")}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG ring wrapper needs an accessible name
      role="img"
      aria-label={label ? `${shown} ${label}` : `Score ${shown}`}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="hr-score-ring__track" cx="50" cy="50" r={radius} />
        <circle
          className="hr-score-ring__fill"
          cx="50"
          cy="50"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="hr-score-ring__value">
        <strong>{shown}</strong>
        {label ? <span>{label}</span> : null}
      </div>
    </div>
  );
}
