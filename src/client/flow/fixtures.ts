export type ConfidenceReading<T extends string> = {
  value: T;
  confidence: number;
};

export type FlowProfile = {
  hairType: ConfidenceReading<string>;
  density: ConfidenceReading<string>;
  length: ConfidenceReading<string>;
  frizz: ConfidenceReading<string>;
  faceShape: ConfidenceReading<string>;
  beard: ConfidenceReading<string>;
};

export type YoucamMatchQuality = "exact" | "close";

export type YoucamStyleMatch = {
  templateId: string;
  matchQuality: YoucamMatchQuality;
};

/** Catalog variant id → YouCam hairstyle template (subset used by ranking fixtures). */
export const YOUCAM_MATCH_BY_VARIANT_ID: Record<string, YoucamStyleMatch> = {
  "crop--textured-crop": { templateId: "male_textured_crop", matchQuality: "exact" },
  "crop--french-crop": { templateId: "male_textured_crop", matchQuality: "close" },
  "side-part--classic-side-part": {
    templateId: "all_side_swept_undercut",
    matchQuality: "close",
  },
  "taper--low-taper-fade": { templateId: "male_gray_taper_fade", matchQuality: "close" },
  "buzz--buzz-with-skin-fade": { templateId: "all_buzz_cut", matchQuality: "close" },
  "crew--ivy-league": { templateId: "all_crewcut", matchQuality: "exact" },
  "flow--messy-medium": { templateId: "all_tousled_waves", matchQuality: "close" },
  "flow--bro-flow": { templateId: "all_tousled_waves", matchQuality: "close" },
  "quiff--textured-quiff": { templateId: "all_messy_tapered_fade", matchQuality: "close" },
  "curly--curly-top-skin-fade": { templateId: "male_short_curly", matchQuality: "close" },
};

export type RankedStyle = {
  id: string;
  name: string;
  group: "works-today" | "less-styling" | "grow-out" | "bolder";
  fit: number;
  preference: number;
  realismLabel: string;
  why: string;
  /** Demo try-on / style render under `public/demo-media/`. */
  imageFilename: string;
  /** Catalogue family reference under `public/demo-media/`. */
  familyCatalogFilename: string;
  /** Key into `YOUCAM_MATCH_BY_VARIANT_ID` when a YouCam template applies. */
  catalogVariantId?: string;
};

export type RejectedStyle = {
  id: string;
  name: string;
  reason: string;
};

export const FLOW_STEP_LABELS = ["Photos", "Your goal", "Ranking", "Try-on"] as const;

export const DEMO_PROFILE: FlowProfile = {
  hairType: { value: "Wavy", confidence: 0.82 },
  density: { value: "Medium", confidence: 0.76 },
  length: { value: "7 cm on top", confidence: 0.71 },
  frizz: { value: "Light", confidence: 0.68 },
  faceShape: { value: "Oval", confidence: 0.8 },
  beard: { value: "Stubble", confidence: 0.74 },
};

export function rankedStyleById(id: string): RankedStyle | undefined {
  return RANKED_STYLES.find((style) => style.id === id);
}

export const RANKED_STYLES: RankedStyle[] = [
  {
    id: "textured-crop",
    name: "Textured crop",
    group: "works-today",
    fit: 91,
    preference: 84,
    realismLabel: "Works today",
    why: "Short sides keep your wave tidy without daily heat.",
    imageFilename: "style-textured-crop.jpg",
    familyCatalogFilename: "catalog/men/taper--taper-with-long-top.jpg",
    catalogVariantId: "crop--textured-crop",
  },
  {
    id: "side-part-classic",
    name: "Classic side part",
    group: "works-today",
    fit: 88,
    preference: 79,
    realismLabel: "Works today",
    why: "Your density supports a clean part with minimal length change.",
    imageFilename: "style-side-part.jpg",
    familyCatalogFilename: "catalog/men/side-part--1920s-peaky-side-part.jpg",
    catalogVariantId: "side-part--classic-side-part",
  },
  {
    id: "french-crop",
    name: "French crop",
    group: "works-today",
    fit: 86,
    preference: 81,
    realismLabel: "Works today",
    why: "Forward fringe softens your hairline without extra length.",
    imageFilename: "style-french-crop.jpg",
    familyCatalogFilename: "catalog/men/asian-fringe--korean-bowl-cut.jpg",
    catalogVariantId: "crop--french-crop",
  },
  {
    id: "low-taper",
    name: "Low taper natural",
    group: "works-today",
    fit: 85,
    preference: 77,
    realismLabel: "Works today",
    why: "Keeps weight on top while cleaning the neckline.",
    imageFilename: "style-low-taper.jpg",
    familyCatalogFilename: "catalog/men/fade--low-fade.jpg",
    catalogVariantId: "taper--low-taper-fade",
  },
  {
    id: "buzz-taper",
    name: "Buzz with taper",
    group: "less-styling",
    fit: 83,
    preference: 88,
    realismLabel: "Works today",
    why: "Under two minutes to dry; fits a low-maintenance morning.",
    imageFilename: "style-buzz-taper.jpg",
    familyCatalogFilename: "catalog/men/military--high-and-tight.jpg",
    catalogVariantId: "buzz--buzz-with-skin-fade",
  },
  {
    id: "ivy-league",
    name: "Ivy league",
    group: "less-styling",
    fit: 80,
    preference: 82,
    realismLabel: "Works today",
    why: "Short enough to air-dry; office-friendly silhouette.",
    imageFilename: "style-ivy-league.jpg",
    familyCatalogFilename: "catalog/men/comb-over--comb-over.jpg",
    catalogVariantId: "crew--ivy-league",
  },
  {
    id: "curtain-medium",
    name: "Curtain medium",
    group: "grow-out",
    fit: 78,
    preference: 75,
    realismLabel: "+3 cm · ~3 months",
    why: "Needs a little length through the fringe for the split.",
    imageFilename: "style-curtain-medium.jpg",
    familyCatalogFilename: "catalog/women/j-style--jellyfish-cut.jpg",
    catalogVariantId: "curtains--middle-part-short",
  },
  {
    id: "wavy-mid",
    name: "Wavy mid length",
    group: "grow-out",
    fit: 74,
    preference: 70,
    realismLabel: "+4 cm · ~4 months",
    why: "Your wave will carry volume once the sides grow in.",
    imageFilename: "style-wavy-mid.jpg",
    familyCatalogFilename: "catalog/men/korean-perm--down-perm.jpg",
    catalogVariantId: "flow--messy-medium",
  },
  {
    id: "flow-hair",
    name: "Bro flow",
    group: "grow-out",
    fit: 72,
    preference: 68,
    realismLabel: "+5 cm · ~5 months",
    why: "Works with your texture once the back catches up.",
    imageFilename: "style-bro-flow.jpg",
    familyCatalogFilename: "catalog/men/flow--skater-hair.jpg",
    catalogVariantId: "flow--bro-flow",
  },
  {
    id: "man-bun-grow",
    name: "Man bun",
    group: "grow-out",
    fit: 69,
    preference: 66,
    realismLabel: "+8 cm · ~8 months",
    why: "Works once the crown and back reach tie-back length.",
    imageFilename: "style-man-bun.jpg",
    familyCatalogFilename: "catalog/men/two-block--classic-two-block.jpg",
  },
  {
    id: "quiff-modern",
    name: "Modern quiff",
    group: "bolder",
    fit: 76,
    preference: 73,
    realismLabel: "Works today",
    why: "Height at the front suits your face proportions.",
    imageFilename: "style-modern-quiff.jpg",
    familyCatalogFilename: "catalog/men/quiff--classic-quiff.jpg",
    catalogVariantId: "quiff--textured-quiff",
  },
  {
    id: "pompadour",
    name: "Soft pompadour",
    group: "bolder",
    fit: 71,
    preference: 69,
    realismLabel: "+2 cm · ~2 months",
    why: "Needs slightly more top length for the sweep back.",
    imageFilename: "style-pompadour.jpg",
    familyCatalogFilename: "catalog/men/pompadour--classic-pompadour.jpg",
  },
  {
    id: "mullet-modern",
    name: "Modern mullet",
    group: "bolder",
    fit: 68,
    preference: 65,
    realismLabel: "+6 cm · ~6 months",
    why: "Bold shape; back length is the main grow-out need.",
    imageFilename: "style-modern-mullet.jpg",
    familyCatalogFilename: "catalog/men/mullet--classic-80s-mullet.jpg",
  },
  {
    id: "curly-top-fade",
    name: "Curly top fade",
    group: "less-styling",
    fit: 70,
    preference: 72,
    realismLabel: "Works today",
    why: "Emphasises natural curl with a sharp fade line.",
    imageFilename: "style-curly-top-fade.jpg",
    familyCatalogFilename: "catalog/men/twists--sponge-twists.jpg",
    catalogVariantId: "curly--curly-top-skin-fade",
  },
  {
    id: "caesar-short",
    name: "Caesar short",
    group: "less-styling",
    fit: 81,
    preference: 80,
    realismLabel: "Works today",
    why: "One length on top; a dab of paste and you are out the door.",
    imageFilename: "style-caesar-short.jpg",
    familyCatalogFilename: "catalog/men/bowl--classic-bowl-cut.jpg",
  },
  {
    id: "slick-back",
    name: "Slick back",
    group: "bolder",
    fit: 66,
    preference: 62,
    realismLabel: "+4 cm · ~4 months",
    why: "Needs more length and hold for a clean sweep.",
    imageFilename: "style-slick-back.jpg",
    familyCatalogFilename: "catalog/men/slick-back--classic-slick-back.jpg",
  },
];

export const REJECTED_STYLES: RejectedStyle[] = [
  {
    id: "heavy-pompadour",
    name: "Heavy pompadour",
    reason: "Needs high density and 12+ cm on top; your reading is medium at 7 cm.",
  },
  {
    id: "slick-straight",
    name: "Sleek slick side-part",
    reason: "Straight finish conflicts with wavy texture without chemical smoothing.",
  },
  {
    id: "skin-mohawk",
    name: "Skin fade mohawk",
    reason: "Office constraint and low fade maintenance do not match your goals.",
  },
];

export const RANKING_GROUP_LABELS: Record<RankedStyle["group"], string> = {
  "works-today": "With small adjustments",
  "less-styling": "Low maintenance",
  "grow-out": "Needs growth",
  bolder: "Bold change",
};

export const SAMPLE_PHOTO_FILES = {
  front: "sample-front.jpg",
  right: "sample-right.jpg",
  left: "sample-left.jpg",
  down: "sample-down.jpg",
} as const;

export const TRYON_RENDER_FILES = [
  "tryon-textured-crop.jpg",
  "tryon-side-part.jpg",
  "tryon-french-crop.jpg",
] as const;

export const TRYON_RENDER_BY_STYLE_ID: Record<string, (typeof TRYON_RENDER_FILES)[number]> = {
  "textured-crop": "tryon-textured-crop.jpg",
  "side-part-classic": "tryon-side-part.jpg",
  "french-crop": "tryon-french-crop.jpg",
};

export function tryonRenderFilename(styleId: string): string {
  return TRYON_RENDER_BY_STYLE_ID[styleId] ?? TRYON_RENDER_FILES[0];
}

export function demoMediaUrl(filename: string): string {
  return `/demo-media/${filename}`;
}

export function youcamTemplateFilename(templateId: string): string {
  return `youcam/${templateId}.jpg`;
}

export function youcamMatchForVariant(variantId: string | undefined): YoucamStyleMatch | undefined {
  if (!variantId) return undefined;
  return YOUCAM_MATCH_BY_VARIANT_ID[variantId];
}

/** Primary hero on ranking cards — sample-person style render when we have one. */
export function rankedStylePrimaryImage(style: RankedStyle): string {
  return style.imageFilename;
}

/** Primary image on the ranking card (YouCam template when matched, else style render). */
export function rankedStyleCardImage(style: RankedStyle): string {
  const match = youcamMatchForVariant(style.catalogVariantId);
  if (match) return youcamTemplateFilename(match.templateId);
  return style.imageFilename;
}

/** YouCam template filename for the reference thumb, if any. */
export function rankedStyleYouCamReference(style: RankedStyle): string | null {
  const match = youcamMatchForVariant(style.catalogVariantId);
  if (!match) return null;
  return youcamTemplateFilename(match.templateId);
}

/**
 * Small title-row thumb: our style render vs YouCam template — omitted when it would duplicate the card.
 */
export function rankedStyleTitleThumb(style: RankedStyle): string | null {
  const cardImage = rankedStyleCardImage(style);
  const match = youcamMatchForVariant(style.catalogVariantId);
  if (match) {
    const youcam = youcamTemplateFilename(match.templateId);
    if (cardImage === youcam && style.imageFilename !== youcam) {
      return style.imageFilename;
    }
    if (cardImage !== youcam) return youcam;
  }
  if (style.familyCatalogFilename !== cardImage) {
    return style.familyCatalogFilename;
  }
  return null;
}
