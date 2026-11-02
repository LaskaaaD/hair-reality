import { useCallback, useId, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Button, PictureImg } from "../design/index.js";
import { FlowEmptyTile } from "./FlowEmptyTile.js";
import { PreviewImage } from "./StyleCardImage.js";
import type { Look } from "../api.js";

const SLIDER_MIN = 8;
const SLIDER_MAX = 92;
const SLIDER_STEP = 4;

type TryonLooksGridProps = {
  looks: Look[];
  activeIndex: number;
  onSelect: (index: number) => void;
};

export function TryonLooksGrid({ looks, activeIndex, onSelect }: TryonLooksGridProps) {
  return (
    <div className="flow-tryon-stage-wrap" data-testid="tryon-looks-wrap">
      <div className="flow-tryon-stage flow-card flow-tryon-looks-stage">
        <p className="flow-tryon-looks-lead">Your try-on renders — pick one to see it larger.</p>
        <div className="flow-tryon-render-row" role="tablist" aria-label="Picked styles">
          {looks.map((look, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={look.id}
                type="button"
                role="tab"
                aria-selected={selected}
                className="flow-tryon-render-card"
                data-selected={selected ? "true" : undefined}
                onClick={() => onSelect(index)}
              >
                <span className="flow-tryon-render-media">
                  {selected ? (
                    <span className="flow-tryon-render-selected-badge" aria-hidden="true">
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path
                          d="M11.5 4L5.75 9.75 2.5 6.5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  ) : null}
                  <PreviewImage
                    url={look.status === "ready" ? look.imageUrl : null}
                    alt={`${look.title} try-on render`}
                    className="flow-tryon-render-img"
                    emptyCaption={look.status === "pending" ? "Rendering…" : "Render pending"}
                  />
                </span>
                <span className="flow-tryon-render-name">{look.title}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

type TryonPreviewProps = {
  beforeSrc?: string;
  renderUrl: string | null;
  lookName: string;
  forceLoading: boolean;
  forceError?: boolean;
  /** The look has no render and none is coming (status "skipped"). */
  unavailable?: boolean;
  errorMessage?: string;
  onRetry?: () => void;
  retryBusy?: boolean;
  sourceLabel?: string | null;
  comparePosition?: number;
};

function clampSliderPosition(value: number): number {
  const numeric = Number.isFinite(value) ? value : 50;
  return Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(numeric)));
}

function TryonCompareSlider({
  beforeSrc,
  renderUrl,
  lookName,
  initial,
}: {
  beforeSrc: string;
  renderUrl: string;
  lookName: string;
  initial: number;
}) {
  const [position, setPosition] = useState(() => clampSliderPosition(initial));
  const inputId = useId();
  const positionStep = clampSliderPosition(position);
  const positionClass = `landing-compare-p${positionStep}`;

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPosition((current) => clampSliderPosition(current - SLIDER_STEP));
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setPosition((current) => clampSliderPosition(current + SLIDER_STEP));
    }
  }, []);

  return (
    <div
      className={[
        "hr-before-after",
        "marketing-slider",
        "landing-compare",
        positionClass,
        "flow-before-after",
      ].join(" ")}
      data-testid="tryon-compare-slider"
    >
      <PictureImg
        src={renderUrl}
        alt={`${lookName} try-on`}
        width={720}
        height={900}
        loading="eager"
        decoding="async"
      />
      <div className="marketing-before">
        <PictureImg src={beforeSrc} alt="Before — your current hair" width={720} height={900} loading="eager" decoding="async" />
      </div>
      <div className="landing-compare-divider marketing-divider" aria-hidden="true">
        <span className="landing-compare-handle" />
      </div>
      <label className="visually-hidden" htmlFor={inputId}>
        Compare before and after
      </label>
      <input
        id={inputId}
        aria-label="Compare before and after"
        type="range"
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        value={positionStep}
        onChange={(event) => setPosition(clampSliderPosition(Number(event.target.value)))}
        onKeyDown={onKeyDown}
      />
      <p className="marketing-photo-label before">
        <span className="marketing-photo-label-main">BEFORE</span>
      </p>
      <p className="marketing-photo-label after">
        <span className="marketing-photo-label-main">AFTER</span>
      </p>
    </div>
  );
}

function RenderingStage({ beforeSrc }: { beforeSrc?: string }) {
  return (
    <div className="flow-tryon-stage-wrap">
      <div
        className="e34-render-stage flow-tryon-stage-loading e34-tryon-media-frame"
        data-testid="tryon-loading"
        aria-busy="true"
        aria-live="polite"
      >
        {beforeSrc ? (
          <img src={beforeSrc} alt="" className="e34-render-portrait" width={900} height={600} decoding="async" />
        ) : (
          <div className="flow-skeleton e34-render-portrait" aria-hidden="true" />
        )}
        <div className="e34-render-overlay">
          <div>
            <h2>Creating your previews</h2>
            <p>YouCam is placing each cut on your own photo. Your face stays the same and only the hair changes. This can take up to a minute.</p>
          </div>
          <p className="e34-render-wait">
            <span className="hr-photos__upload-spinner" aria-hidden="true" /> Working on it…
          </p>
        </div>
      </div>
    </div>
  );
}

export function TryonPreview({
  beforeSrc,
  renderUrl,
  lookName,
  forceLoading,
  forceError = false,
  unavailable = false,
  errorMessage = "We could not finish this render.",
  onRetry,
  retryBusy = false,
  sourceLabel = null,
  comparePosition = 50,
}: TryonPreviewProps) {
  if (forceLoading) {
    return <RenderingStage {...(beforeSrc ? { beforeSrc } : {})} />;
  }

  if (forceError) {
    return (
      <div className="flow-tryon-stage-wrap">
        <div
          className="flow-tryon-stage flow-card flow-tryon-compare flow-tryon-stage-error e34-tryon-media-frame"
          data-testid="tryon-error"
          role="alert"
          aria-live="assertive"
        >
          <div className="flow-compare flow-tryon-error-stage">
            <div className="flow-tryon-error-panel">
              <p className="flow-tryon-error-title">We couldn&apos;t create this preview</p>
              <p className="flow-tryon-error-copy">{errorMessage}</p>
              <div className="flow-tryon-error-actions">
                <Button className="button secondary" variant="secondary" disabled={retryBusy} onClick={() => onRetry?.()}>
                  {retryBusy ? "Retrying…" : "Try again"}
                </Button>
                <Button as="link" to="/demo/results" className="button">
                  Choose a different style
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!beforeSrc) {
    return (
      <div className="flow-tryon-stage flow-tryon-stage-empty" data-testid="tryon-no-photo">
        <FlowEmptyTile caption="Add a front photo first" />
        <Link className="flow-fix-link" to="/demo">
          Back to photos
        </Link>
      </div>
    );
  }

  if (!renderUrl) {
    return (
      <div className="flow-tryon-stage-wrap" data-testid="tryon-compare-wrap">
        <div className="flow-tryon-stage flow-card flow-tryon-compare e34-tryon-media-frame">
          <div className="flow-tryon-empty-stage" data-testid="tryon-after-empty">
            <FlowEmptyTile
              caption={unavailable ? "No preview for this style. Pick another one." : "Render pending. YouCam render not generated yet"}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-tryon-stage-wrap" data-testid="tryon-compare-wrap">
      <div className="flow-tryon-stage flow-card flow-tryon-compare flow-tryon-before-after e34-tryon-media-frame">
        <TryonCompareSlider
          key={comparePosition}
          beforeSrc={beforeSrc}
          renderUrl={renderUrl}
          lookName={lookName}
          initial={comparePosition}
        />
        {sourceLabel ? (
          <p className="flow-tryon-fixture-caption flow-before-after-source" data-testid="preview-source">
            {sourceLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}
