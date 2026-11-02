type FlowEmptyTileProps = {
  caption: string;
  className?: string;
  /** In narrow compare panes, show icon + short label; full caption stays for screen readers. */
  compactInNarrowPane?: boolean;
  variant?: "default" | "photo-guide";
};

function AbstractImageIcon() {
  return (
    <svg className="flow-empty-icon" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4" y="6" width="24" height="20" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4 22 L12 14 L18 19 L22 15 L28 22"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PhotoFramingGuide() {
  return (
    <div className="flow-photo-guide-wrap">
      <svg className="flow-photo-guide" viewBox="0 0 120 150" aria-hidden="true">
        <ellipse
          cx="60"
          cy="52"
          rx="26"
          ry="32"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="4 3"
        />
        <path
          d="M 24 118 Q 60 88 96 118"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
        <line x1="60" y1="22" x2="60" y2="132" stroke="currentColor" strokeWidth="0.75" opacity="0.35" />
      </svg>
    </div>
  );
}

export function FlowEmptyTile({
  caption,
  className,
  compactInNarrowPane = false,
  variant = "default",
}: FlowEmptyTileProps) {
  const classes = [
    "flow-empty-tile",
    variant === "photo-guide" ? "flow-empty-tile--photo-guide" : "",
    compactInNarrowPane ? "flow-empty-tile--narrow-aware" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-testid="flow-empty-tile">
      {variant === "photo-guide" ? (
        <PhotoFramingGuide />
      ) : (
        <AbstractImageIcon />
      )}
      {caption ? (
        <>
          <p className="flow-empty-tile-caption">{caption}</p>
          {compactInNarrowPane ? (
            <p className="flow-empty-tile-compact" aria-hidden="true">Pending</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
