import type { ImgHTMLAttributes } from "react";
import { demoMediaPreferredSrc, demoMediaSrcSet, demoMediaWebpSrc } from "./demoMedia.js";

export type PictureImgProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Generate srcset from optimized `-{w}w.webp` variants (see optimize-images.mjs). */
  responsiveWidths?: readonly number[];
  sizes?: string;
};

export function PictureImg({
  src,
  alt,
  width,
  height,
  loading = "lazy",
  decoding = "async",
  fetchPriority,
  responsiveWidths,
  sizes,
  ...rest
}: PictureImgProps) {
  const webp = demoMediaWebpSrc(src);
  const srcSet = responsiveWidths?.length ? demoMediaSrcSet(src, responsiveWidths) : undefined;
  const preferredSrc = responsiveWidths?.length ? demoMediaPreferredSrc(src, responsiveWidths) : src;

  const img = (
    <img
      src={preferredSrc}
      alt={alt}
      width={width}
      height={height}
      loading={loading}
      decoding={decoding}
      fetchPriority={fetchPriority}
      {...(srcSet ? { srcSet, sizes: sizes ?? `${width}px` } : {})}
      {...rest}
    />
  );

  if (!webp && !srcSet) {
    return img;
  }

  return (
    <picture>
      {srcSet ? <source srcSet={srcSet} sizes={sizes ?? `${width}px`} type="image/webp" /> : null}
      {!srcSet && webp ? <source srcSet={webp} type="image/webp" /> : null}
      {img}
    </picture>
  );
}
