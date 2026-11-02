import { CatalogueStylePlaceholder } from "./CatalogueStylePlaceholder.js";
import { DemoMedia } from "./DemoMedia.js";
import { FlowEmptyTile } from "./FlowEmptyTile.js";
import { rankingCardImage, type ResolvedRankingCardImage } from "./flow-mappers.js";
import type { PaletteItem, RecommendationCard } from "../api.js";

type StyleCardImageProps = {
  card: PaletteItem | RecommendationCard;
  alt: string;
  className?: string;
  resolvedImage?: ResolvedRankingCardImage;
};

export function StyleCardImage({ card, alt, className, resolvedImage }: StyleCardImageProps) {
  const image = resolvedImage ?? rankingCardImage(card);
  if (image.kind === "demo") {
    return <DemoMedia filename={image.filename} alt={alt} {...(className ? { className } : {})} />;
  }
  if (image.kind === "placeholder") {
    return <CatalogueStylePlaceholder title={image.title} {...(className ? { className } : {})} />;
  }
  return (
    <img
      className={className}
      src={image.url}
      alt={alt}
      onError={(event) => {
        event.currentTarget.replaceWith(
          Object.assign(document.createElement("div"), {
            className: className ?? "",
            innerHTML: "",
          }),
        );
      }}
    />
  );
}

export function StyleCardImageOrEmpty(props: StyleCardImageProps) {
  return (
    <StyleCardImage
      {...props}
      alt={props.alt}
    />
  );
}

export function CatalogueImage({ url, alt, className }: { url: string; alt: string; className?: string }) {
  return (
    <img
      className={className}
      src={url}
      alt={alt}
      onError={(event) => {
        const parent = event.currentTarget.parentElement;
        if (parent) {
          event.currentTarget.remove();
          parent.append(document.createElement("span"));
        }
      }}
    />
  );
}

export function PreviewImage({
  url,
  alt,
  className,
  emptyCaption = "Render pending",
}: {
  url: string | null;
  alt: string;
  className?: string;
  emptyCaption?: string;
}) {
  if (!url) {
    return <FlowEmptyTile caption={emptyCaption} {...(className ? { className } : {})} />;
  }
  return <img className={className} src={url} alt={alt} />;
}
