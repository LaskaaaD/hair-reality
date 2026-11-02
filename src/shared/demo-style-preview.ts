/** Maps catalogue candidate keys to bundled persona hairstyle photos (no generated overlays). */
export const DEMO_STYLE_PREVIEW_FILES: Record<string, string> = {
  "haircut:crop--caesar-cut": "style-caesar-short.jpg",
  "haircut:two-block--short-two-block": "style-wavy-mid.jpg",
  "haircut:crew--ivy-league": "style-ivy-league.jpg",
  "haircut:crew--crew-cut": "style-ivy-league.jpg",
  "haircut:male_short_curly": "style-curly-top-fade.jpg",
  "haircut:male_textured_crop": "style-textured-crop.jpg",
  "haircut:crop--french-crop": "style-french-crop.jpg",
  "haircut:crop--crop-with-long-fringe": "style-french-crop.jpg",
  "haircut:messy-taper": "style-low-taper.jpg",
  "haircut:taper--tapered-neckline": "style-low-taper.jpg",
  "haircut:side-part--classic-side-part": "style-side-part.jpg",
  "haircut:side-part--professional-short-cut": "style-side-part.jpg",
  "haircut:bro-flow": "style-bro-flow.jpg",
  "haircut:flow--bro-flow": "style-bro-flow.jpg",
  "haircut:male_tousled_cut": "style-wavy-mid.jpg",
  "haircut:shag--short-shag": "style-wavy-mid.jpg",
  "haircut:male_wavy_undercut": "style-slick-back.jpg",
  "haircut:male_textured_comma": "style-curtain-medium.jpg",
  "haircut:male_gray_taper_fade": "style-low-taper.jpg",
  "haircut:male_afro": "style-curly-top-fade.jpg",
  "haircut:side-swept-fringe": "style-side-part.jpg",
  "haircut:textured-fringe": "style-textured-crop.jpg",
  "haircut:comma-fringe": "style-curtain-medium.jpg",
};

export function demoStylePreviewFile(candidateKey: string): string | null {
  const direct = DEMO_STYLE_PREVIEW_FILES[candidateKey];
  if (direct) return direct;
  const k = candidateKey.toLowerCase();
  if (k.includes("caesar")) return "style-caesar-short.jpg";
  if (k.includes("ivy-league") || k.includes("crew")) return "style-ivy-league.jpg";
  if (k.includes("two-block") || k.includes("shag") || k.includes("tousled")) return "style-wavy-mid.jpg";
  if (k.includes("french-crop") || k.includes("choppy-fringe")) return "style-french-crop.jpg";
  if (k.includes("textured-crop") || k.includes("crop")) return "style-textured-crop.jpg";
  if (k.includes("side-part") || k.includes("contour") || k.includes("frat")) return "style-side-part.jpg";
  if (k.includes("curtain") || k.includes("middle-part") || k.includes("comma") || k.includes("gail")) {
    return "style-curtain-medium.jpg";
  }
  if (k.includes("flow") || k.includes("feathered") || k.includes("long--")) return "style-bro-flow.jpg";
  if (k.includes("curly") || k.includes("afro") || k.includes("perm") || k.includes("jheri")) {
    return "style-curly-top-fade.jpg";
  }
  if (k.includes("quiff") || k.includes("faux-hawk")) return "style-modern-quiff.jpg";
  if (k.includes("slick") || k.includes("undercut") || k.includes("peaky")) return "style-slick-back.jpg";
  if (k.includes("pompadour") || k.includes("flat-top")) return "style-pompadour.jpg";
  if (k.includes("mullet") || k.includes("wolf")) return "style-modern-mullet.jpg";
  if (k.includes("bun") || k.includes("knot") || k.includes("locs") || k.includes("braid") || k.includes("twist")) {
    return "style-man-bun.jpg";
  }
  if (k.includes("buzz") || k.includes("bald") || k.includes("shaved") || k.includes("skinhead")) {
    return "style-buzz-taper.jpg";
  }
  if (k.includes("taper") || k.includes("fade")) return "style-low-taper.jpg";
  return null;
}
