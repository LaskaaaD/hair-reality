import { PictureImg } from "./PictureImg.js";

export type GrowthStage = {
  label: string;
  imageSrc: string;
  imageAlt: string;
};

export type GrowthTimelineProps = {
  stages: GrowthStage[];
  className?: string;
  showIndex?: boolean;
};

export function GrowthTimeline({ stages, className, showIndex = true }: GrowthTimelineProps) {
  return (
    <div className={["hr-growth-timeline", className].filter(Boolean).join(" ")}>
      <ol>
        {stages.map((stage, index) => (
          <li key={stage.label}>
            <figure>
              <PictureImg
                src={stage.imageSrc}
                alt={stage.imageAlt}
                width={280}
                height={360}
                loading="lazy"
                decoding="async"
              />
              <figcaption>
                {showIndex ? (
                  <span className="hr-growth-timeline__index">{String(index + 1).padStart(2, "0")}</span>
                ) : null}
                {stage.label}
              </figcaption>
            </figure>
            {index < stages.length - 1 ? <span className="hr-growth-timeline__connector" aria-hidden="true" /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
