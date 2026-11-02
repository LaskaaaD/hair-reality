/** Four-step demo progress: Photos → Your goal → Ranking → Try-on. */
const STEPS = ["Photos", "Your goal", "Ranking", "Try-on"] as const;

export type ProgressNavProps = {
  /** 0-based index of the active step. */
  current: number;
  className?: string;
};

export function ProgressNav({ current, className }: ProgressNavProps) {
  return (
    <nav className={["hr-progress-nav", className].filter(Boolean).join(" ")} aria-label="Demo progress">
      <ol>
        {STEPS.map((label, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          return (
            <li key={label} className={`hr-progress-nav__item hr-progress-nav__item--${state}`}>
              <span className="hr-progress-nav__dot" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="hr-progress-nav__label">{label}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
