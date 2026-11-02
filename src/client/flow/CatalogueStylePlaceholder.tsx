type CatalogueStylePlaceholderProps = {
  title: string;
  className?: string;
};

/** Deliberate editorial SVG style placeholder when no distinct catalogue photo exists (HSL tokens via CSS classes). */
export function CatalogueStylePlaceholder({ title, className }: CatalogueStylePlaceholderProps) {
  const classes = ["flow-catalogue-placeholder", className].filter(Boolean).join(" ");
  return (
    <div className={classes} data-testid="catalogue-style-placeholder">
      <span className="flow-catalogue-placeholder-eyebrow">Style silhouette</span>
      <svg className="flow-catalogue-placeholder-art" viewBox="0 0 160 156" aria-hidden="true">
        <rect className="flow-catalogue-placeholder-frame" x="18" y="8" width="124" height="140" rx="62" />
        <path
          className="flow-catalogue-placeholder-shoulders"
          d="M30 144 C36 122 54 114 80 114 C106 114 124 122 130 144"
        />
        <path className="flow-catalogue-placeholder-neck" d="M66 98 L66 116 C66 122 94 122 94 116 L94 98" />
        <ellipse className="flow-catalogue-placeholder-head" cx="80" cy="68" rx="30" ry="36" />
        <path
          className="flow-catalogue-placeholder-hair"
          d="M44 64 C42 32 58 20 80 20 C102 20 118 32 116 64 C116 78 110 88 102 92 C98 68 90 52 80 48 C70 52 62 68 58 92 C50 88 44 78 44 64 Z"
        />
        <path
          className="flow-catalogue-placeholder-detail"
          d="M54 42 C64 32 76 30 88 33 M60 50 C70 43 84 42 98 47"
        />
      </svg>
      <p className="flow-catalogue-placeholder-title">{title}</p>
    </div>
  );
}
