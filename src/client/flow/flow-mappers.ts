import type { PaletteItem, RecommendationCard, SessionView } from "../api.js";
import { roundFit } from "../../shared/fit.js";
import { scoreToFeasibilityTier, type FeasibilityTier } from "../design/feasibility.js";
import { RANKING_GROUP_LABELS, RANKED_STYLES, rankedStyleById, type RankedStyle } from "./fixtures.js";
import {
  GENERIC_RANKING_REASON_PATTERNS,
  rankingReasonForKey,
} from "../../shared/ranking-style-data.js";
import { rankingCardDemoFilename } from "./ranking-card-media.js";
import { scoreToVerdict } from "../design/feasibility.js";

export type PreviewSource = "youcam" | "cached" | "fixture" | null;

export type ProfileField = {
  id: string;
  label: string;
  value: string;
  confidence: number;
  /** Who read it: "YouCam", "AI photo read" or "You"; absent when unknown. */
  source?: string;
};

function sourceLabel(source: unknown): string | undefined {
  if (source === "youcam") return "YouCam";
  if (source === "vision") return "AI photo read";
  if (source === "answer" || source === "override") return "You";
  return undefined;
}

const CURL_LABELS: Record<string, string> = {
  "1": "Straight",
  "2a": "Wavy",
  "2b": "Wavy",
  "2c": "Wavy",
  "3a": "Curly",
  "3b": "Curly",
  "3c": "Curly",
  "4a": "Coily",
  "4b": "Coily",
  "4c": "Coily",
};

const DENSITY_LABELS: Record<number, string> = {
  1: "Low",
  2: "Medium-light",
  3: "Medium",
  4: "High",
};

const FRIZZ_LABELS: Record<string, string> = {
  none: "None",
  slight: "Light",
  frizzy: "Moderate",
  extreme: "High",
};

const BEARD_LABELS: Record<string, string> = {
  none: "Clean shaven",
  stubble: "Stubble",
  moustache: "Moustache",
  short: "Short beard",
  medium: "Medium beard",
  long: "Long beard",
};

function readingValue(value: unknown): string {
  if (value === "unknown" || value === null || value === undefined) return "Not sure";
  if (typeof value === "number") return `${value} cm`;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "Not sure";
  }
  return "Not sure";
}

function readingConfidence(confidence: unknown): number {
  return typeof confidence === "number" && Number.isFinite(confidence) ? confidence : 0;
}

export function mapAnalysisToProfileFields(analysis: SessionView["analysis"]): ProfileField[] {
  if (!analysis) {
    return [
      { id: "hairType", label: "Hair type", value: "Not sure", confidence: 0 },
      { id: "density", label: "Density", value: "Not sure", confidence: 0 },
      { id: "length", label: "Length", value: "Not sure", confidence: 0 },
      { id: "frizz", label: "Frizz", value: "Not sure", confidence: 0 },
      { id: "faceShape", label: "Face shape", value: "Not sure", confidence: 0 },
      { id: "beard", label: "Beard", value: "Not sure", confidence: 0 },
    ];
  }

  const hair = analysis.hair;
  const face = analysis.face;
  const facialHair = analysis.facialHair;

  const curlRaw = hair?.curl?.value;
  const hairType: string =
    typeof curlRaw === "string" && curlRaw in CURL_LABELS
      ? (CURL_LABELS[curlRaw as keyof typeof CURL_LABELS] ?? readingValue(curlRaw))
      : readingValue(curlRaw);

  const densityRaw = hair?.density?.value;
  const density: string =
    typeof densityRaw === "number" && densityRaw in DENSITY_LABELS
      ? (DENSITY_LABELS[densityRaw as keyof typeof DENSITY_LABELS] ?? readingValue(densityRaw))
      : readingValue(densityRaw);

  const topCm = hair?.topCm?.value;
  const lengthCm = hair?.lengthCm?.value;
  const length: string =
    typeof topCm === "number"
      ? `${topCm} cm on top`
      : typeof lengthCm === "number"
        ? `${lengthCm} cm`
        : readingValue(topCm ?? lengthCm);

  const frizzFromHair = hair?.frizz;
  const frizzRaw = frizzFromHair?.value;
  const frizz: string =
    typeof frizzRaw === "string" && frizzRaw in FRIZZ_LABELS
      ? (FRIZZ_LABELS[frizzRaw as keyof typeof FRIZZ_LABELS] ?? readingValue(frizzRaw))
      : readingValue(frizzRaw);

  // A shape YouCam named is shown as YouCam wrote it; only a corrected or non-YouCam shape uses our own label.
  const youcamShape = face?.shape?.source === "youcam" ? face.youcamShape?.value : undefined;
  const faceShape: string = youcamShape ?? readingValue(face?.shape?.value);
  const beardStyle = facialHair?.style?.value;
  const beard: string =
    typeof beardStyle === "string" && beardStyle in BEARD_LABELS
      ? (BEARD_LABELS[beardStyle as keyof typeof BEARD_LABELS] ?? readingValue(beardStyle))
      : readingValue(beardStyle);

  const entries: ProfileField[] = [
    { id: "hairType", label: "Hair type", value: hairType, confidence: readingConfidence(hair?.curl?.confidence), source: hair?.curl?.source },
    { id: "density", label: "Density", value: density, confidence: readingConfidence(hair?.density?.confidence), source: hair?.density?.source },
    { id: "length", label: "Length", value: length, confidence: readingConfidence(hair?.topCm?.confidence ?? hair?.lengthCm?.confidence), source: hair?.topCm?.source ?? hair?.lengthCm?.source },
    { id: "frizz", label: "Frizz", value: frizz, confidence: readingConfidence(frizzFromHair?.confidence ?? hair?.diameter?.confidence), source: frizzFromHair?.source ?? hair?.diameter?.source },
    { id: "faceShape", label: "Face shape", value: faceShape, confidence: readingConfidence(face?.shape?.confidence), source: face?.shape?.source },
    { id: "beard", label: "Beard", value: beard, confidence: readingConfidence(facialHair?.style?.confidence), source: facialHair?.style?.source },
  ].map((entry) => {
    const label = entry.value === "Not sure" ? undefined : sourceLabel(entry.source);
    const { source: _source, ...rest } = entry;
    return label ? { ...rest, source: label } : rest;
  });

  return entries;
}

export function previewSourceBadgeLabel(source: PreviewSource): string | null {
  if (source === "youcam") return "YouCam render";
  if (source === "cached") return "Cached demo render";
  if (source === "fixture") return "Test fixture";
  return null;
}

export type RankingGroup = RankedStyle["group"];

export function cardTargetTopCm(card: RecommendationCard | PaletteItem): number {
  if ("targetLengthCm" in card && typeof card.targetLengthCm === "number") {
    return card.targetLengthCm;
  }
  const match = card.stylistScript.match(/about\s+(\d+(?:\.\d+)?)\s*cm/i);
  if (match?.[1]) return Number(match[1]);
  if ("lengthBand" in card) {
    if (card.lengthBand === "short") return 3;
    if (card.lengthBand === "long") return 18;
  }
  return 7;
}

export function isShortClassicCrop(card: RecommendationCard | PaletteItem): boolean {
  if (isFeminineStyleCard(card)) return false;
  const blob = `${card.key} ${card.title} ${card.family ?? ""}`.toLowerCase();
  return /caesar|short-shag|short shag|french-crop|french crop|textured-crop|textured crop|ivy-league|ivy league|ivy-cut|ivy cut|short-two-block|short two block|crew-cut|crew cut/.test(
    blob,
  );
}

export function isBoldStyleCard(card: RecommendationCard | PaletteItem): boolean {
  if (isShortClassicCrop(card)) return false;
  if (isFeminineStyleCard(card) && cardTargetTopCm(card) <= 6) return true;
  const blob = `${card.key} ${card.title} ${card.family ?? ""}`.toLowerCase();
  return /mullet|wolf|shag-wolf|long-shag|modern-shag|70s-shag|curly-shag|locs|dreadlocks|braids|cornrows|twists|afro|perm|down-perm|faux-hawk|mohawk|undercut|two-block|pompadour|slick-back|flat-top|high-and-tight|skin-fade|bald-fade|skinhead|chelsea|buzz|shaved|pixie|bixie|hime|bouffant|fashion-color|crimped|jellyfish|mash|spiky|bowl/.test(
    blob,
  );
}

export function isStructuredAdjustmentCard(card: RecommendationCard | PaletteItem): boolean {
  const titleBlob = `${card.title} ${card.key.replace(/asian-fringe--/g, "")}`.toLowerCase();
  return /side-part|fringe|bangs|comma|graduated|a-line|curtain|blunt|flipped|quiff|pompadour|slick|taper|mexican|contour|layered|butterfly|short-shag|short shag/.test(
    titleBlob,
  );
}

export function rankingGroupFor(card: RecommendationCard | PaletteItem): RankingGroup {
  if (card.missingCm != null && card.missingCm > 0) return "grow-out";
  if (card.label === "needs-treatment") return "bolder";
  const topCm = cardTargetTopCm(card);
  if (!isShortClassicCrop(card) && (isBoldStyleCard(card) || topCm <= 1.2)) return "bolder";
  if (card.key === "haircut:male_textured_crop") return "less-styling";
  if (
    card.stylingMinutes > 5 ||
    (card.maintenanceWeeks <= 4 && isStructuredAdjustmentCard(card)) ||
    isStructuredAdjustmentCard(card)
  ) {
    return "works-today";
  }
  if (card.stylingMinutes <= 5) return "less-styling";
  return "works-today";
}

export function rankingGroupLabel(group: RankingGroup): string {
  return RANKING_GROUP_LABELS[group];
}

export function realismLabelForCard(card: RecommendationCard | PaletteItem): string {
  if (card.missingCm != null && card.missingCm > 0 && card.months != null) {
    return `+${card.missingCm} cm · ~${card.months} months`;
  }
  if (card.label === "realistic") return "Works today";
  if (card.label === "needs-treatment") return "Needs treatment";
  if (card.label === "not-on-your-hair") return "Not on your hair";
  return card.label;
}

export function feasibilityTierForCard(card: RecommendationCard | PaletteItem): FeasibilityTier {
  const feasible = "feasible" in card ? card.feasible : null;
  if (feasible === false) return "not_recommended";
  if ((card.missingCm ?? 0) > 0) return "challenging";
  if (card.label === "needs-treatment") return "possible";
  if (card.label === "not-on-your-hair") return "not_recommended";
  return scoreToFeasibilityTier(fitScoreForCard(card));
}

/** The card's Fit as shown: the real score to one decimal (74.6), never a whole-number rounding. */
export function fitScoreForCard(card: RecommendationCard | PaletteItem): number {
  return Math.max(0, Math.min(100, roundFit(card.score)));
}

export function preferenceScoreForCard(
  card: RecommendationCard | PaletteItem,
  hasGoalAnswers: boolean,
): number | null {
  if (!hasGoalAnswers || !card.components) return null;
  const goals = card.components.goals ?? 0;
  const raw = card.components.trend + card.components.lifestyle + goals;
  return Math.max(0, Math.min(100, Math.round((raw / 30) * 100)));
}

export function effectivePreferenceScoreForCard(
  card: RecommendationCard | PaletteItem,
  hasGoalAnswers: boolean,
): number {
  const fromGoals = preferenceScoreForCard(card, hasGoalAnswers);
  if (fromGoals != null) return fromGoals;
  if (card.components) {
    const goals = card.components.goals ?? 0;
    const raw = card.components.trend + card.components.lifestyle + goals;
    return Math.max(0, Math.min(100, Math.round((raw / 30) * 100)));
  }
  return Math.max(0, Math.min(100, Math.round(card.score)));
}

export type VerdictTone = "ok" | "warn" | "no";

export function verdictLabelForCard(card: RecommendationCard | PaletteItem): string {
  if ((card.missingCm ?? 0) > 0) return scoreToVerdict(Math.min(fitScoreForCard(card), 44));
  return scoreToVerdict(fitScoreForCard(card));
}

export function verdictToneForCard(card: RecommendationCard | PaletteItem): VerdictTone {
  const tier = feasibilityTierForCard(card);
  if (tier === "not_recommended") return "no";
  if (tier === "challenging" || tier === "possible") return "warn";
  return "ok";
}

function fixtureWhyForCardKey(key: string): string | undefined {
  const variantId = key.startsWith("haircut:") ? key.slice("haircut:".length) : key;
  const fixture =
    rankedStyleById(variantId) ??
    RANKED_STYLES.find((style) => variantId.includes(style.id) || key.includes(style.id));
  return fixture?.why;
}

export function whyTextForCard(card: RecommendationCard | PaletteItem): string {
  const dynamicReason = card.reasons[0]?.trim();
  if (
    dynamicReason &&
    dynamicReason.length >= 24 &&
    !GENERIC_RANKING_REASON_PATTERNS.some((pattern) => pattern.test(dynamicReason))
  ) {
    return dynamicReason;
  }
  const fromRanking = rankingReasonForKey(card.key);
  if (fromRanking) return fromRanking;
  const fromFixture = fixtureWhyForCardKey(card.key);
  if (fromFixture) return fromFixture;
  return dynamicReason || card.stylistScript;
}

export function rejectedFromPalette(cards: PaletteItem[]): { id: string; name: string; reason: string }[] {
  return cards
    .filter((card) => card.feasible === false)
    .slice(0, 8)
    .map((card) => ({
      id: card.key,
      name: card.title,
      reason: card.reasons[0] ?? card.criteria?.find((item) => item.status === "block")?.text ?? "This style does not fit your current profile.",
    }));
}

export const FEMININE_YOU_INSET_FILENAME =
  "catalog/women/thin-hair--blunt-collarbone-cut-for-fine-hair.jpg";

export type ResolvedRankingCardImage =
  | { kind: "demo"; filename: string }
  | { kind: "url"; url: string }
  | { kind: "placeholder"; title: string };

export function templateFilenameForStyleKey(key: string): string | null {
  return rankingCardDemoFilename(key);
}

const FEMININE_FAMILY_RE =
  /^(female_|bob|lob|pixie|shag-wolf|bangs|medium|updo|ponytail|braids|curly-wavy|afro-coily|asian-trends|retro-women|thin-hair|thick-hair|mature)/i;

const MASCULINE_FAMILY_RE =
  /^(male_|buzz|crew|military|crop|fringe|asian-fringe|side-part|comb-over|slick-back|pompadour|quiff|faux-hawk|undercut|two-block|taper|fade|flow|shag|mullet|bowl|curly|afro|braids-locs|long|bun-pony|receding|thinning|beard-combo|latin|retro)$/i;

export function isFeminineStyleCard(card: PaletteItem | RecommendationCard): boolean {
  const affinity = "affinity" in card ? card.affinity : undefined;
  if (affinity === "feminine") return true;
  if (affinity === "masculine") return false;
  const variantId = card.key.startsWith("haircut:") ? card.key.slice("haircut:".length) : card.key;
  if (variantId.startsWith("female_")) return true;
  if (variantId.startsWith("male_")) return false;
  if (card.family && FEMININE_FAMILY_RE.test(card.family)) return true;
  if (card.family && MASCULINE_FAMILY_RE.test(card.family)) return false;
  return FEMININE_FAMILY_RE.test(variantId);
}

const MALE_ALL_YOUCAM_FILENAMES = new Set([
  "youcam/all_crewcut.jpg",
  "youcam/all_messy_tapered_fade.jpg",
  "youcam/all_tousled_waves.jpg",
  "youcam/all_pink_blue_fade.jpg",
  "youcam/all_highlight_pixie_cut.jpg",
  "youcam/all_dreadlocks.jpg",
  "youcam/all_side_swept_undercut.jpg",
  "youcam/all_hippie_wave.jpg",
  "youcam/all_buzz_cut.jpg",
]);

function isDemoFilenameCompatibleWithCard(
  filename: string,
  card: PaletteItem | RecommendationCard,
): boolean {
  const feminine = isFeminineStyleCard(card);
  if (feminine) {
    if (
      filename.startsWith("catalog/men/") ||
      filename.startsWith("youcam/male_") ||
      filename.startsWith("style-") ||
      MALE_ALL_YOUCAM_FILENAMES.has(filename)
    ) {
      return false;
    }
    return true;
  }
  if (filename.startsWith("catalog/women/") || filename.startsWith("youcam/female_")) {
    return false;
  }
  if (filename.startsWith("youcam/all_") && !MALE_ALL_YOUCAM_FILENAMES.has(filename)) {
    return false;
  }
  return true;
}

export function rankingCardImage(
  card: PaletteItem | RecommendationCard,
): ResolvedRankingCardImage {
  const filename = rankingCardDemoFilename(card.key);
  // Every catalogue style has its own generated photo (catalog/men or catalog/women): it always wins, never a shared or placeholder image.
  if (filename && filename.startsWith("catalog/")) return { kind: "demo", filename };
  if (filename && !filename.startsWith("style-") && isDemoFilenameCompatibleWithCard(filename, card)) {
    return { kind: "demo", filename };
  }
  if (card.imageUrl) return { kind: "url", url: card.imageUrl };
  return { kind: "placeholder", title: card.title };
}

/** One image per card. Catalogue photos are unique per style, so no card is blanked because another one looks alike. */
export function deduplicateRankingCardImages(
  cards: (PaletteItem | RecommendationCard)[],
): Map<string, ResolvedRankingCardImage> {
  const out = new Map<string, ResolvedRankingCardImage>();
  for (const card of cards) out.set(card.key, rankingCardImage(card));
  return out;
}

export type FlowRoute = "/demo" | "/demo/goal" | "/demo/results" | "/demo/tryon";

export function routeForSessionState(input: {
  hasFrontPhoto: boolean;
  analysisStatus: string;
  hasRecommendations: boolean;
  hasPreviews: boolean;
  target: FlowRoute;
}): FlowRoute | null {
  const { hasFrontPhoto, analysisStatus, hasRecommendations, hasPreviews, target } = input;
  if (target === "/demo/tryon" && !hasPreviews) return hasRecommendations ? "/demo/results" : "/demo/goal";
  if (target === "/demo/results" && !hasRecommendations && analysisStatus !== "ready") return "/demo/goal";
  if (target === "/demo/goal" && !hasFrontPhoto) return "/demo";
  if (target === "/demo/goal" && analysisStatus === "failed") return "/demo";
  if (target === "/demo/results" && analysisStatus !== "ready") return hasFrontPhoto ? "/demo/goal" : "/demo";
  if (target === "/demo/tryon" && analysisStatus !== "ready") return hasFrontPhoto ? "/demo/goal" : "/demo";
  return null;
}

export function photoRoleForSlot(slot: "front" | "right" | "left" | "down"): string {
  return slot === "down" ? "crown" : slot;
}

export function slotForPhotoRole(role: string): "front" | "right" | "left" | "down" | null {
  if (role === "front" || role === "right" || role === "left") return role;
  if (role === "crown" || role === "down") return "down";
  return null;
}
