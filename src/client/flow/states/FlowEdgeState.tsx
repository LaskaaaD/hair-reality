import type { EdgeStateKind } from "./edge-state.js";
import { edgeStateCopy } from "./edge-state.js";

type FlowEdgeStateProps = {
  kind: EdgeStateKind;
  onPrimary: () => void;
  onSecondary?: () => void;
};

export function FlowEdgeState({ kind, onPrimary, onSecondary }: FlowEdgeStateProps) {
  const copy = edgeStateCopy(kind);
  return (
    <section className="e12-edge-state" data-testid={`edge-state-${kind}`} aria-live="polite">
      <div className="e12-edge-state-icon" aria-hidden="true">
        {kind === "api-unavailable" ? "☁" : kind === "failed-analysis" ? "⚠" : "!"}
      </div>
      <h2 className="e12-edge-state-title">{copy.title}</h2>
      <p className="e12-edge-state-body">{copy.body}</p>
      <div className="e12-edge-state-actions">
        <button type="button" className="button e12-btn-primary" onClick={onPrimary}>
          {copy.primaryLabel}
        </button>
        {copy.secondaryLabel && onSecondary ? (
          <button type="button" className="button secondary e12-btn-secondary" onClick={onSecondary}>
            {copy.secondaryLabel}
          </button>
        ) : null}
      </div>
    </section>
  );
}
