import { demoMediaPreferredSrc, demoMediaSrcSet } from "./design/demoMedia.js";

export const LANDING_HERO_LCP_SRC = "/demo-media/sample-front.jpg";
export const LANDING_HERO_BEFORE_SRC = LANDING_HERO_LCP_SRC;

export const DEMO_E1_EXAMPLE_SRC = "/demo-media/sample-front.jpg";
export const DEMO_E1_WIDTHS = [240, 480] as const;
export const DEMO_E1_SIZES = "93px";

function imagePreloadLink(
  src: string,
  widths: readonly number[],
  sizes: string,
): string {
  const href = demoMediaPreferredSrc(src, widths);
  const srcSet = demoMediaSrcSet(src, widths);
  const attrs = [
    'rel="preload"',
    'as="image"',
    `href="${href}"`,
    'fetchpriority="high"',
  ];
  if (srcSet) {
    attrs.push(`imagesrcset="${srcSet}"`);
    attrs.push(`imagesizes="${sizes}"`);
  }
  return `    <link ${attrs.join(" ")}>`;
}

export function landingHeroPreloadTags(): string {
  return `    <link rel="preload" as="image" href="${LANDING_HERO_LCP_SRC}" fetchpriority="high">`;
}

export function demoE1PreloadTags(): string {
  return imagePreloadLink(DEMO_E1_EXAMPLE_SRC, DEMO_E1_WIDTHS, DEMO_E1_SIZES);
}
