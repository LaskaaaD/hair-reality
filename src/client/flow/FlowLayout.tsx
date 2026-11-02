import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { Button, ProgressNav } from "../design/index.js";
import { readSalon, salonStyleVars } from "../salon.js";

export type FlowStepIndex = 0 | 1 | 2 | 3;

const E12_STEP_LABELS = ["Photos", "Your goal", "Ranking", "Try-on"] as const;

type FlowLayoutProps = {
  step: FlowStepIndex;
  title: string;
  subtitle?: string;
  pageClass?: string;
  backTo?: string;
  backLabel?: string;
  nextLabel?: string;
  nextTo?: string;
  nextDisabled?: boolean;
  onNext?: () => void;
  selectionSummary?: string;
  footerStrip?: ReactNode;
  headActions?: ReactNode;
  nextBusy?: boolean;
  onStartOver?: () => void;
  hideFooter?: boolean;
  children: ReactNode;
};

export function FlowLayout({
  step,
  title,
  subtitle,
  pageClass,
  backTo,
  backLabel = "Back",
  nextLabel = "Next",
  nextTo,
  nextDisabled,
  onNext,
  selectionSummary,
  footerStrip,
  headActions,
  nextBusy,
  onStartOver,
  hideFooter,
  children,
}: FlowLayoutProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [salon] = useState(readSalon);

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [step, title]);

  return (
    <div
      className={[
        "flow-page",
        "flow-page-sticky-footer",
        "flow-page-e12",
        pageClass ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={salon ? (salonStyleVars(salon) as CSSProperties) : undefined}
    >
      <div className="flow-shell e12-shell">
        <header className="e12-topbar">
          <Link className="flow-wordmark" to="/" reloadDocument>
            {salon ? salon.name : "Hair Reality"}
            {salon ? <span className="flow-wordmark-by"> · with Hair Reality</span> : null}
          </Link>
          <p className="flow-stepper-compact" aria-live="polite">
            Step {step + 1} of 4 · {E12_STEP_LABELS[step]}
          </p>
          <ProgressNav current={step} className="e12-progress-nav" />
          {onStartOver ? (
            <button type="button" className="flow-fix-link" onClick={onStartOver}>
              Start over
            </button>
          ) : null}
        </header>
        <main id="main" className="flow-main">
          {headActions ? (
            <div className="flow-title-block flow-title-block--with-actions">
              <div className="flow-title-block__text">
                <h1 ref={titleRef} tabIndex={-1}>
                  {title}
                </h1>
                {subtitle ? <p className="flow-page-subtitle">{subtitle}</p> : null}
              </div>
              <div className="flow-title-block__actions">{headActions}</div>
            </div>
          ) : (
            <div className="flow-title-block">
              <h1 ref={titleRef} tabIndex={-1}>
                {title}
              </h1>
              {subtitle ? <p className="flow-page-subtitle">{subtitle}</p> : null}
            </div>
          )}
          {children}
        </main>
        {hideFooter ? null : (
          <footer
            className={[
              "flow-bottom-bar",
              selectionSummary ? "flow-bottom-bar-with-summary" : "",
              footerStrip ? "flow-bottom-bar-with-strip" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-testid={selectionSummary ? "ranking-footer-bar" : undefined}
          >
            {footerStrip ? <div className="flow-bottom-bar-strip">{footerStrip}</div> : null}
            <div className="flow-bottom-bar-row">
              {backTo ? (
                <Button as="link" to={backTo} reloadDocument={backTo === "/"} variant="secondary" className="button secondary">
                  {backLabel}
                </Button>
              ) : (
                <span />
              )}
              <div className="flow-bottom-bar-actions">
                {selectionSummary ? (
                  <span className="flow-selection-summary">{selectionSummary}</span>
                ) : null}
                {nextTo ? (
                  <Button
                    as="link"
                    to={nextTo}
                    reloadDocument={!nextTo.startsWith("/demo")}
                    variant="primary"
                    className={`button${nextDisabled ? " flow-button-link-disabled" : ""}`}
                    aria-disabled={nextDisabled}
                    onClick={(event) => {
                      if (nextDisabled) event.preventDefault();
                    }}
                  >
                    {nextLabel}
                  </Button>
                ) : onNext ? (
                  <Button
                    variant="primary"
                    className="button"
                    type="button"
                    disabled={nextDisabled}
                    aria-busy={nextBusy || undefined}
                    onClick={onNext}
                  >
                    {nextLabel}
                  </Button>
                ) : null}
              </div>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
