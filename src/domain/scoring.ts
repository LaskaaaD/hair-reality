import type { ServiceKind } from "./catalogue.js";
import { loadStyles, type StyleVariant } from "./knowledge-base.js";
import { curlCodes, faceShapeContested, faceShapeSingleSource, type Person, lowConfidence, unknownReading } from "./person.js";
import { addsCurlToSmoothHair, assessFeasibility, curlShrinkage, effectiveLength, FILTER_MIN_CONFIDENCE, GROWTH_CM_PER_MONTH, recessionOf, crownWhorlOf, type Feasibility, type GrowthGoal } from "./feasibility.js";
import { FIT_STEP, roundFit } from "../shared/fit.js";
import { CROWN_SHORT_MAX_CM, isTextureBuilt, neutralTraits } from "./style-traits.js";
import { assignDistinctReasons, faceReadsLong, isStatementStyle, personalizedRankingReason } from "./ranking-reason.js";

export type Answers = {
  stylingMinutes: "5" | "15" | "30";
  heatStyle: "none" | "sometimes" | "daily";
  keep: "length" | "fringe" | "nothing";
  colourHistory: "natural" | "box-dye" | "lightened" | "unknown";
  beardGrowth: "full" | "patchy" | "unknown";
  presentation: "masculine" | "feminine" | "either" | "auto";
  naturalState: "natural" | "styled" | "unknown";
  chemical: "none" | "lightened" | "permed" | "relaxed" | "unknown";
  strand: "fine" | "medium" | "coarse" | "unknown";
  blowdryer: "yes" | "no" | "unknown";
  products: "yes" | "no" | "unknown";
  canShorten: "yes" | "no" | "unknown";
  canGrow: "yes" | "a-little" | "no" | "unknown";
  forehead: "cover" | "show" | "either" | "unknown";
  glassesDaily: "yes" | "no" | "unknown";
  facialHair: "none" | "stubble" | "moustache" | "short" | "medium" | "long" | "unknown";
  cowlick: "none" | "front" | "crown" | "both" | "unknown";
  /** The client's own words about what they want (any language), at most 300 characters; empty when they wrote nothing. */
  wish: string;
};

export type ScoreLabel = "realistic" | "needs-treatment" | "not-on-your-hair";
export type CriterionStatus = "ok" | "watch" | "block";

export type Criterion = {
  id: string;
  status: CriterionStatus;
  text: string;
};

export { GROWTH_CM_PER_MONTH, addsCurlToSmoothHair };
export type { Feasibility, GrowthGoal };

/** The professional-consultation rubric, 100 points: hair behaviour first, then the face, hairline, head, upkeep, features and trend. */
export const CRITERIA_MAX = {
  hairBehavior: 30,
  face: 25,
  hairline: 15,
  head: 10,
  lifestyle: 10,
  features: 5,
  trend: 5,
} as const;
export type CriterionKey = keyof typeof CRITERIA_MAX;
export const CRITERION_KEYS = Object.keys(CRITERIA_MAX) as CriterionKey[];

export type ScoreComponents = Record<CriterionKey, number> & {
  /** Likes, length intent and grow-out wait: outside the 100, counted at half weight. */
  goals: number;
  /** Carried-over barber taste (see barberTaste): outside the 100, counted at half weight. */
  taste: number;
};

export type PreferenceHints = {
  likedFamilies: ReadonlySet<string>;
  likedTokens: ReadonlySet<string>;
};

export function preferenceHintsFromLikes(likes: readonly string[], styles: readonly StyleVariant[]): PreferenceHints {
  const likedFamilies = new Set<string>();
  const likedTokens = new Set<string>();
  const byKey = new Map(styles.map((variant) => [variant.key, variant]));
  for (const key of likes) {
    const variant = byKey.get(key);
    const raw = key.replace(/^haircut:/, "").toLowerCase();
    for (const part of raw.split(/[-_]/)) {
      if (part.length >= 3) likedTokens.add(part);
    }
    if (!variant) continue;
    likedFamilies.add(variant.familyId);
    const blob = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
    for (const token of ["bob", "lob", "bixie", "curl", "curly", "fringe", "mullet", "pixie", "shag", "fade", "buzz"]) {
      if (blob.includes(token)) likedTokens.add(token);
    }
  }
  return { likedFamilies, likedTokens };
}

export type Presentation = "masculine" | "feminine" | "either";

export type ScoredVariant = {
  variant: StyleVariant;
  score: number;
  label: ScoreLabel;
  reasons: string[];
  criteria: Criterion[];
  components: ScoreComponents;
  confidence: number;
  excluded: boolean;
  liked: boolean;
  growth: GrowthGoal | null;
  /** Step A verdict: pass, adapt, goal or fail, with a plain reason per check. */
  feasibility: Feasibility;
  /** One plain line the client can say at the chair (the stylist model writes it; absent on the rules-only path). */
  tellYourBarber?: string;
  stylistScript: string;
  stylingMinutes: number;
  maintenanceWeeks: number;
};

export const PALETTE_LIMIT = 50;
export const RENDER_LIMIT = 3;
export const SESSION_UNIT_CAP = 40;
export const DAILY_UNIT_CAP = 200;
export const CONFIDENCE_FLOOR = 0.7;

export const ACCOUNT_UNITS = {
  "hair-type": 2,
  "hair-length": 2,
  "hair-density": 1,
  "hair-frizziness": 2,
  "face-attributes": 10,
  "facial-color-tones": 20,
  hairstyle: 2,
  "hair-color": 1,
  beard: 2,
} as const;

export type AnalysisMode = "hackathon" | "salon";

export function analysisUnits(service: ServiceKind, mode: AnalysisMode, lean: boolean): number {
  if (mode === "salon") return 0;
  if (service === "haircut") {
    const full = lean ? 0 : ACCOUNT_UNITS["face-attributes"] + ACCOUNT_UNITS["hair-frizziness"];
    return full + ACCOUNT_UNITS["hair-type"] + ACCOUNT_UNITS["hair-density"];
  }
  if (service === "colour") return lean ? 0 : ACCOUNT_UNITS["facial-color-tones"];
  return lean ? 0 : ACCOUNT_UNITS["face-attributes"];
}

export function previewUnitCost(service: ServiceKind): number {
  if (service === "colour") return ACCOUNT_UNITS["hair-color"];
  if (service === "beard") return ACCOUNT_UNITS.beard;
  return ACCOUNT_UNITS.hairstyle;
}

export function estimatedUnits(service: ServiceKind, lean: boolean): number {
  return analysisUnits(service, "hackathon", lean) + RENDER_LIMIT * previewUnitCost(service);
}

export function emptyAnswers(): Answers {
  return {
    stylingMinutes: "15",
    heatStyle: "sometimes",
    keep: "nothing",
    colourHistory: "unknown",
    beardGrowth: "unknown",
    presentation: "auto",
    naturalState: "unknown",
    chemical: "unknown",
    strand: "unknown",
    blowdryer: "unknown",
    products: "unknown",
    canShorten: "unknown",
    canGrow: "unknown",
    forehead: "unknown",
    glassesDaily: "unknown",
    facialHair: "unknown",
    cowlick: "unknown",
    wish: "",
  };
}

export function scoreVariant(
  person: Person,
  answers: Answers,
  variant: StyleVariant,
  liked: boolean,
  hints: PreferenceHints = { likedFamilies: new Set(), likedTokens: new Set() },
  presentation: Presentation | null = null,
): ScoredVariant {
  const answered = applyAnswers(person, answers);
  const feasibility = assessFeasibility(answered, answers, variant, {
    liked,
    presentation,
    acceptsPresentation: presentation === null ? true : acceptsPresentation(variant, presentation),
  });
  const growth = feasibility.growth;
  const excluded = feasibility.status === "fail";
  const densityBlocked = feasibility.checks.some((check) => check.check === "density" && check.status === "fail");
  const beardBlocked = feasibility.checks.some((check) => check.check === "beard" && check.status === "fail");
  const colourLift = colourTooLight(answered, variant);
  const boxDyeLift = answers.colourHistory === "box-dye" && colourDirection(answered, variant) === "lighter";
  const needsTreatment = !excluded && (variant.requirements.needsExtension || colourLift || boxDyeLift);
  const criteria = criteriaFor(answered, answers, variant, { growth, feasibility, densityBlocked, beardBlocked, colourLift, boxDyeLift });
  const geometry = geometryFit(answered, variant);
  const hair = hairFit(answered, variant);
  const forehead = foreheadFit(answered, answers, variant);
  const profile = profileFit(answered, variant);
  const lifestyle = lifestylePoints(answered, answers, variant, growth);
  const goals = goalsFit(answered, answers, variant, liked, hints);
  const adaptCost = ADAPT_COST * feasibility.checks.filter((check) => check.status === "adapt").length;
  const components: ScoreComponents = {
    // The length match is taken off after the cap, so cuts that all reach the hair maximum still differ by how much cutting or growing they need.
    hairBehavior: Math.max(0, clamp(hair.points + lengthNowPoints(answered, variant) - adaptCost, 0, CRITERIA_MAX.hairBehavior) - Math.round((1 - lengthMatchPoints(answered, variant)) * 100) / 100),
    face: clamp(geometry.points, 0, CRITERIA_MAX.face),
    hairline: clamp(forehead.points + recessionPoints(answered, variant), 0, CRITERIA_MAX.hairline),
    head: clamp(profile.points + headExtras(answered, variant), 0, CRITERIA_MAX.head),
    lifestyle: clamp(lifestyle, 0, CRITERIA_MAX.lifestyle),
    features: clamp(featurePoints(answered, variant), 0, CRITERIA_MAX.features),
    trend: trendPoints(answered, answers, variant),
    goals: Math.max(-GOALS_FLOOR, goals.points - growthPenalty(growth)),
    taste: tasteHolds(feasibility) ? Math.max(-TASTE_FLOOR, Math.min(TASTE_CAP, barberTaste(answered, variant))) : 0,
  };
  const confidence = confidenceOf(answered, answers);
  const score = displayScore(fitFromComponents(components, excluded), excluded);
  const label: ScoreLabel = excluded ? "not-on-your-hair" : needsTreatment ? "needs-treatment" : "realistic";
  const framing = profile.points <= 4 ? profile.text : forehead.text;
  const reasons = [personalizedRankingReason(answered, answers, variant, liked), hair.text, framing];
  return {
    variant,
    score,
    label,
    reasons: reasons.slice(0, 3),
    criteria,
    components,
    confidence,
    excluded,
    liked,
    growth,
    feasibility,
    stylistScript: variant.stylistScript,
    stylingMinutes: variant.lifestyle.stylingMinutes,
    maintenanceWeeks: variant.lifestyle.maintenanceWeeks,
  };
}

/** A style that failed a hard filter is never rendered, whatever asks for it. */
export function canRender(look: Pick<ScoredVariant, "excluded" | "feasibility">): boolean {
  return !look.excluded && look.feasibility.status !== "fail";
}

/** Fixed cost of each change the barber has to make to the cut (spec: pass beats adapt). */
export const ADAPT_COST = 3;
const GOALS_FLOOR = 24;
const TASTE_FLOOR = 24;
const TASTE_CAP = 14;

/**
 * Honest Fit: the shown number is the real rubric total to one decimal, kept strictly falling down the list. Only a
 * score that equals the one above it (same total, order settled by hair, then face, then id) steps down by FIT_STEP.
 */
export function spreadTiedDisplayScores(show: readonly ScoredVariant[]): ScoredVariant[] {
  let previous = 101;
  return show.map((look) => {
    if (look.excluded) return look;
    const score = Math.max(0, roundFit(Math.min(previous - FIT_STEP, look.score)));
    previous = score;
    return score === look.score ? look : { ...look, score };
  });
}

const GOALS_LIMIT = 8;

export function selectLooks(input: {
  service: ServiceKind;
  person: Person;
  answers: Answers;
  likes: readonly string[];
  referenceIds?: readonly string[];
  limit?: number;
  styles?: readonly StyleVariant[];
}): { show: ScoredVariant[]; goals: ScoredVariant[]; explain: ScoredVariant[]; ranked: ScoredVariant[] } {
  const styles = input.styles ?? loadStyles();
  const liked = new Set(input.likes);
  const hints = preferenceHintsFromLikes(input.likes, styles);
  const presentation = resolvedPresentation(input.person, input.answers);
  const catalogue = styles
    .filter((variant) => variant.service === input.service && acceptsPresentation(variant, presentation))
    .map((variant) => scoreVariant(input.person, input.answers, variant, liked.has(variant.key), hints, presentation));
  const references = (input.referenceIds ?? []).map((id) => scoreVariant(
    input.person,
    input.answers,
    referenceVariant(input.service, id),
    true,
    hints,
  ));
  const baseRanked = [...catalogue, ...references].sort(byScore);
  const limit = input.limit ?? PALETTE_LIMIT;
  const ready = baseRanked.filter((look) => !look.excluded && look.growth === null);
  const diversified = diversify(ready, limit, hints.likedFamilies);
  const likedFirst = ready.filter((look) => look.liked && !diversified.some((item) => item.variant.key === look.variant.key));
  const sharedReasons = { usedStructures: new Set<string>(), usedFirstSixWords: new Set<string>() };
  const answeredPerson = applyAnswers(input.person, input.answers);
  const shown = assignDistinctReasons(
    // Diversity decides which styles are shown, not their order: the list is in score order, so the Fit on each card is its real score.
    [...likedFirst, ...diversified].slice(0, Math.max(limit, likedFirst.length)).sort(compareLooks),
    answeredPerson,
    input.answers,
    sharedReasons,
  );
  const show = spreadTiedDisplayScores(shown);
  const growthPool = baseRanked.filter((look) => look.growth !== null && !look.excluded);
  const diversifiedGoals = diversify(growthPool, GOALS_LIMIT, hints.likedFamilies);
  // A grow-out cut the client liked stays in the goals bucket even when the growth penalty ranks it below eight nearer ones.
  const likedGoals = growthPool.filter((look) => look.liked && !diversifiedGoals.some((item) => item.variant.key === look.variant.key));
  const goals = assignDistinctReasons(
    [...likedGoals, ...diversifiedGoals].slice(0, Math.max(GOALS_LIMIT, likedGoals.length)),
    answeredPerson,
    input.answers,
    sharedReasons,
  );
  const calibratedByKey = new Map<string, ScoredVariant>();
  for (const look of shown) calibratedByKey.set(look.variant.key, look);
  for (const look of goals) {
    if (!calibratedByKey.has(look.variant.key)) calibratedByKey.set(look.variant.key, look);
  }
  const extraPool = baseRanked
    .filter((look) => !look.excluded && !calibratedByKey.has(look.variant.key))
    .slice(0, 24);
  for (const extra of assignDistinctReasons(extraPool, answeredPerson, input.answers, sharedReasons)) {
    calibratedByKey.set(extra.variant.key, extra);
  }
  const ranked = baseRanked.map((look) => calibratedByKey.get(look.variant.key) ?? look);
  return {
    show,
    goals,
    explain: ranked.filter((look) => look.excluded && look.liked).slice(0, 4),
    ranked,
  };
}

export function diversify(
  ranked: readonly ScoredVariant[],
  limit: number,
  preferredFamilies: ReadonlySet<string> = new Set(),
): ScoredVariant[] {
  const picked: ScoredVariant[] = [];
  const counts = new Map<string, number>();
  const deferred: ScoredVariant[] = [];
  const groupOf = (item: ScoredVariant) => {
    const familyId = item.variant.familyId;
    if (familyId !== "crop") return familyId;
    const title = item.variant.title.toLowerCase();
    return title.includes("french") ? "crop:french" : title.includes("caesar") ? "crop:caesar" : "crop:textured";
  };
  const capFor = (familyId: string, item: ScoredVariant) =>
    preferredFamilies.has(familyId) ? 4 : item.variant.service === "haircut" && item.variant.affinity === "masculine" ? 3 : 1;
  for (const item of ranked) {
    if (item.excluded) continue;
    const familyId = item.variant.familyId;
    const group = groupOf(item);
    const count = counts.get(group) ?? 0;
    if (count >= capFor(familyId, item)) {
      deferred.push(item);
      continue;
    }
    picked.push(item);
    counts.set(group, count + 1);
    if (picked.length === limit) return picked;
  }
  for (const item of deferred) {
    if (picked.length === limit) break;
    picked.push(item);
  }
  return picked;
}

export function applyRanking(show: readonly ScoredVariant[], rankedIds: readonly string[]): ScoredVariant[] {
  const byId = new Map(show.map((item) => [item.variant.id, item]));
  const next: ScoredVariant[] = [];
  for (const id of rankedIds) {
    const item = byId.get(id);
    if (!item || next.includes(item)) continue;
    next.push(item);
  }
  for (const item of show) {
    if (!next.includes(item)) next.push(item);
  }
  return next.map((item) => ({ ...item, score: item.score, label: item.label }));
}

export function fallbackCapabilities(person: Person, service: ServiceKind): ("hair-type" | "hair-density" | "face-attributes" | "facial-color-tones")[] {
  const caps: ("hair-type" | "hair-density" | "face-attributes" | "facial-color-tones")[] = [];
  if (service === "haircut") {
    if (lowConfidence(person.hair.curl)) caps.push("hair-type");
    if (lowConfidence(person.hair.density)) caps.push("hair-density");
    if (lowConfidence(person.face.shape)) caps.push("face-attributes");
  } else if (service === "colour") {
    if (lowConfidence(person.colour.level) || lowConfidence(person.colour.undertone)) caps.push("facial-color-tones");
  } else if (lowConfidence(person.face.jaw)) {
    caps.push("face-attributes");
  }
  return caps;
}

export function referenceVariant(service: ServiceKind, id: string): StyleVariant {
  return {
    key: `reference:${id}`,
    id: `reference-${id.slice(0, 24)}`,
    familyId: "reference",
    service,
    title: "Your reference",
    affinity: "either",
    requirements: {
      curl: ["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"],
      densityMin: 1,
      frontCm: null,
      topCm: null,
      sidesCm: null,
      strand: ["fine", "medium", "coarse"],
      blunt: false,
      needsExtension: false,
    },
    geometry: { addsHeight: 0.2, addsWidth: 0.2, coversForehead: 0.3, softensJaw: 0.2 },
    compatibility: {},
    fit: { direction: "any", cowlick: "ok", hairline: "either", mass: "medium" },
    lifestyle: { stylingMinutes: 8, blowdryer: false, maintenanceWeeks: 6 },
    bodyHint: null,
    beardFullness: service === "beard" ? "medium" : null,
    colourLevel: null,
    swatch: null,
    preset: service === "colour" ? "Honey Blonde" : null,
    reference: { kind: "brief", brief: "Uploaded reference photo." },
    attrs: null,
    traits: neutralTraits(),
    stylistScript: "Match the shape in the reference, and keep the client's own hair colour.",
  };
}

export function applyAnswers(person: Person, answers: Answers): Person {
  const next = structuredClone(person);
  if (answers.strand !== "unknown") next.hair.diameter = { value: answers.strand, confidence: 1, source: "answer" };
  if (answers.cowlick === "front" || answers.cowlick === "both") next.hair.cowlickFront = { value: true, confidence: 1, source: "answer" };
  if (answers.cowlick === "crown" || answers.cowlick === "both") next.hair.cowlickCrown = { value: true, confidence: 1, source: "answer" };
  if (answers.cowlick === "none") {
    next.hair.cowlickFront = { value: false, confidence: 1, source: "answer" };
    next.hair.cowlickCrown = { value: false, confidence: 1, source: "answer" };
  }
  if (answers.facialHair !== "unknown") next.facialHair.style = { value: answers.facialHair, confidence: 1, source: "answer" };
  if (answers.beardGrowth === "full" || answers.beardGrowth === "patchy") {
    next.facialHair.growth = { value: answers.beardGrowth, confidence: 1, source: "answer" };
  }
  if (answers.glassesDaily === "yes") next.context.glasses = { value: true, confidence: 1, source: "answer" };
  if (answers.glassesDaily === "no") next.context.glasses = { value: false, confidence: 1, source: "answer" };
  // The photos are taken without glasses, so what the scan read from them says nothing about daily wear: only the client's answer counts.
  if (answers.glassesDaily === "unknown") next.context.glasses = unknownReading("answer");
  if (answers.chemical === "lightened" || answers.chemical === "relaxed") next.hair.damage = { value: "high", confidence: 0.8, source: "answer" };
  if (answers.chemical === "none") next.hair.damage = { value: "none", confidence: 0.8, source: "answer" };
  return next;
}

function effectiveComparableLengthCm(person: Person, variant: StyleVariant): number | "unknown" {
  const top = person.hair.topCm.value;
  const len = person.hair.lengthCm.value;
  if (variant.affinity === "feminine") {
    if (typeof len === "number" && typeof top === "number") return Math.max(len, top);
    if (typeof len === "number") return len;
    return top;
  }
  return top !== "unknown" ? top : len;
}

function colourTooLight(person: Person, variant: StyleVariant): boolean {
  if (variant.colourLevel === null || person.colour.level.value === "unknown") return false;
  return variant.colourLevel - person.colour.level.value > 3;
}

function colourDirection(person: Person, variant: StyleVariant): "lighter" | "darker" | "same" | "unknown" {
  if (variant.colourLevel === null || person.colour.level.value === "unknown") return "unknown";
  if (variant.colourLevel > person.colour.level.value) return "lighter";
  if (variant.colourLevel < person.colour.level.value) return "darker";
  return "same";
}

function criteriaFor(
  person: Person,
  answers: Answers,
  variant: StyleVariant,
  flags: { growth: GrowthGoal | null; feasibility: Feasibility; densityBlocked: boolean; beardBlocked: boolean; colourLift: boolean; boxDyeLift: boolean },
): Criterion[] {
  const lines: Criterion[] = [];
  if (flags.growth) lines.push({ id: "length", status: "watch", text: flags.growth.text });
  else if (person.hair.lengthCm.value !== "unknown") lines.push({ id: "length", status: "ok", text: "Length: enough for this shape." });
  const density = person.hair.density.value;
  if (flags.densityBlocked) lines.push({ id: "density", status: "block", text: "A heavy one-length cut needs more density than these photos show." });
  else if (density !== "unknown") lines.push({ id: "density", status: density < variant.requirements.densityMin ? "watch" : "ok", text: density < variant.requirements.densityMin ? "Density is lighter than this shape prefers." : "Density: enough." });
  const curl = person.hair.curl.value;
  if (curl !== "unknown") {
    lines.push({
      id: "texture",
      status: variant.requirements.curl.includes(curl) ? "ok" : "watch",
      text: variant.requirements.curl.includes(curl) ? "Texture: matches this construction." : "Texture: this shape fights the natural curl.",
    });
  }
  if (flags.beardBlocked) lines.push({ id: "beard", status: "block", text: "A full beard needs even growth. Patchy growth will not fill this shape." });
  if (flags.colourLift) lines.push({ id: "colour", status: "watch", text: "This shade is more than three levels lighter than the current colour, so it usually takes more than one visit." });
  if (flags.boxDyeLift) lines.push({ id: "history", status: "watch", text: "Box dye is still in the hair. Lifting it is a correction, not a single gloss." });
  if (variant.requirements.needsExtension) lines.push({ id: "extension", status: "watch", text: "Getting this length means extensions or growing it out. One visit will not create it." });
  for (const check of flags.feasibility.checks) {
    if (check.status === "adapt" && ["recession", "cowlick", "crown"].includes(check.check)) lines.push({ id: check.check, status: "watch", text: check.note });
  }
  return lines;
}

/**
 * Which catalogue the haircut pool is cut to. The explicit answer ("Men", "Women" or "Both") is the only thing that
 * sets it. A confident sex reading from the photos may stand in for an unanswered question, but a guess from hair
 * length, jaw or similar signals never does: a man with long hair would get a women's list. With neither, the
 * presentation is unknown (null) and `acceptsPresentation` lets through only genuinely unisex styles.
 */
export function resolvedPresentation(person: Person, answers: Answers): Presentation | null {
  if (answers.presentation !== "auto") return answers.presentation;
  if (person.sex.confidence < 0.5) return null;
  if (person.sex.value === "male") return "masculine";
  if (person.sex.value === "female") return "feminine";
  return null;
}

/** A haircut service cannot be ranked or rendered until the presentation is known: the catalogue has no unisex haircuts to fall back on. */
export function needsPresentationAnswer(service: ServiceKind, person: Person, answers: Answers): boolean {
  return service === "haircut" && resolvedPresentation(person, answers) === null;
}

export function acceptsPresentation(variant: StyleVariant, presentation: Presentation | null): boolean {
  if (variant.service !== "haircut" || variant.affinity === "either") return true;
  return presentation === "either" || variant.affinity === presentation;
}

function geometryFit(person: Person, variant: StyleVariant): { points: number; text: string } {
  // Two sources disagree on the shape: it favours no cut, the proportions (ratio, long face) still count.
  const shape = faceShapeContested(person) ? "unknown" : person.face.shape.value;
  const ratio = person.face.aspectRatio.value;
  const longFace = faceReadsLong(person);
  const roundFace =
    !longFace && (shape === "round" || (shape === "unknown" && typeof ratio === "number" && ratio > 0 && ratio < 1.2));
  const height = variant.geometry.addsHeight;
  const width = variant.geometry.addsWidth;
  const cover = variant.geometry.coversForehead;
  const fade = fadeKind(variant);
  let points = 20;
  const notes: string[] = [];
  if (shape !== "unknown") {
    const table = variant.compatibility[shape];
    // A shape only one source read is soft evidence: it counts half. Two agreeing sources, or the client's own correction, count in full.
    if (table !== undefined) points += Math.round((table - 0.75) * 14 * (faceShapeSingleSource(person) ? 0.5 : 1));
  }
  const title = variant.title;
  if (longFace) {
    if (height >= 0.65) {
      points -= 12;
      notes.push(`${title} stacks height over the forehead, and on a longer face that stretches the head.`);
    } else if (height >= 0.45) {
      points -= 6;
      notes.push(`${title} is a bit tall on top for a longer face. Less height would balance it better.`);
    } else if (width >= 0.25) {
      notes.push(`${title} keeps the top low and leaves some width at the sides, which is what a longer face needs.`);
    } else {
      notes.push(`${title} keeps the height modest, which helps a longer face.`);
    }
    if ((fade === "skin" || fade === "high") && height >= 0.4) points -= 15;
    if (fade === "skin" || fade === "high") {
      points -= 6;
      notes.push(`${title} clears the temples. On a longer face that removes the width you want to keep, so a low taper is the better side.`);
    } else if (fade === "low") {
      points += 3;
      notes.push(`${title} uses a low taper to clean the neck while keeping width above the ears.`);
    }
    if (width >= 0.25) points += 3;
    if (height <= 0.4) points += 3;
    if (cover >= 0.35 && cover <= 0.7) points += 3;
  } else if (roundFace) {
    if (height >= 0.4 && width <= 0.4) {
      points += 8;
      notes.push(`${title} adds a little height without widening the cheeks, which helps a rounder face.`);
    } else if (width >= 0.5 && height < 0.3) {
      points -= 8;
      notes.push(`${title} adds width without height, which makes a rounder face look wider.`);
    } else {
      notes.push(`${title} stays a workable outline for a rounder face.`);
    }
    if (fade === "high" || fade === "skin") points += 3;
  } else if (shape === "square") {
    if (variant.geometry.softensJaw >= 0.25 || cover >= 0.35) {
      points += 4;
      notes.push(`${title} softens a square jaw with texture instead of a hard corner.`);
    } else notes.push(`${title} can work on a square jaw if the edges stay soft.`);
  } else if (shape === "heart") {
    if (cover >= 0.3) {
      points += 4;
      notes.push(`${title} puts a little weight on the forehead, which balances a heart-shaped face.`);
    } else notes.push(`${title} opens the forehead, which emphasises the wider top of a heart-shaped face.`);
  } else if ((fade === "skin" || fade === "high") && height >= 0.4) {
    points -= 12;
    notes.push(`${title} puts a tall top over very short sides. On an oval face that stacks height on the head, so a low taper with a moderate top is the better side.`);
  } else if (height >= 0.75) {
    points -= 8;
    notes.push(`${title} is taller than an oval face needs. The extra height starts to stretch it.`);
  } else if (width >= 0.25 && height <= 0.4) {
    points += 6;
    notes.push(`${title} stays close to an oval face: some width, and no tall quiff on top.`);
  } else {
    notes.push(`${title} sits in a workable range for the face in the photos.`);
  }
  points += profileExtras(person, variant, longFace);
  const jaw = person.face.jaw.value;
  if (jaw === "wide" && variant.geometry.softensJaw >= 0.25) points += 2;
  if (jaw === "narrow" && width >= 0.3) points += 2;
  const text =
    notes.find((note) => !/^[^:]+:\s+keeps the height modest, which helps a longer face\./.test(note)) ??
    notes[0] ??
    "The outline sits in a workable range for the face in the photos.";
  if (faceReadsLong(person) && isStatementStyle(variant)) points -= 6;
  return { points: clamp(points * FACE_SCALE, 0, CRITERIA_MAX.face), text };
}

/** The old geometry rubric ran to 40; the face now carries 25 of the 100. */
const FACE_SCALE = 25 / 40;

/** Extra face and hair rules, each weighted by how sure the reading is. */
function profileExtras(person: Person, variant: StyleVariant, longFace: boolean): number {
  let points = 0;
  const cover = variant.geometry.coversForehead;
  const partialFringe = variant.attrs
    ? variant.attrs.fringeType === "swept" || variant.attrs.fringeType === "curtain" || variant.attrs.fringeType === "textured"
    : cover >= 0.3 && cover <= 0.7;
  const wide = person.face.foreheadWidth;
  if (wide && wide.value === "wide") points += Math.round((partialFringe ? 4 : cover < 0.2 ? -4 : 0) * wide.confidence);
  const curl = person.hair.curl;
  if (longFace && curl.value !== "unknown" && curl.value.startsWith("2") && variant.geometry.addsHeight > 0.3) {
    points -= Math.round(5 * curl.confidence * variant.geometry.addsHeight);
  }
  return points;
}

/** Layered shapes that only hold with texture in the hair. */
const LAYERED_TEXTURE_FAMILIES = new Set(["wolf-shag", "mullet", "shag"]);

function hairFit(person: Person, variant: StyleVariant): { points: number; text: string } {
  let points = 9;
  const curl = person.hair.curl.value;
  const curlScore = curlDistance(curl, variant.requirements.curl);
  let text = "The hair in the photos can support this direction.";
  if (curlScore === "unknown") points += 4;
  else if (curlScore === "match") {
    points += 8;
    text = hairSentence(person, variant, false);
  } else if (curlScore === "near") {
    points += 5;
    text = hairSentence(person, variant, true);
  } else {
    points -= 6;
    text = "This shape fights the curl in the photos, so it will not sit the way the reference does.";
  }
  // Textured hair (3a and up) does best in a cut built for texture, not a generic cut that merely tolerates it.
  // A cut whose range reaches down to straight hair only tolerates texture; it is not built for it, so it gives up points to the ones that are.
  if (curl !== "unknown" && curlCodes.indexOf(curl) >= curlCodes.indexOf("3a")) {
    if (isTextureBuilt(variant.traits)) points += 3;
    else if (!LAYERED_TEXTURE_FAMILIES.has(variant.familyId)) points -= STRAIGHT_BUILT_ON_CURLS;
  }
  const strand = person.hair.diameter.value;
  if (strand !== "unknown") points += variant.requirements.strand.includes(strand) ? 2 : -3;
  const density = person.hair.density.value;
  if (density !== "unknown") {
    if (variant.fit.mass === "heavy" && density <= 2) {
      points -= 6;
      text = "This cut wants more density than the photos show. It will look thin through the top.";
    } else if (density >= variant.requirements.densityMin) points += 2;
    else if ((variant.requirements.topCm ?? 0) > CROWN_SHORT_MAX_CM) points -= 3;
  }
  const growth = person.hair.growthDirection.value;
  if (growth === "forward" || growth === "back" || growth === "side") {
    const fit = variant.fit.direction;
    points += growthPoints(growth, fit, person.hair.growthDirection.confidence);
    if ((growth === "forward" && fit === "back") || (growth === "back" && fit === "forward")) {
      text = growth === "forward"
        ? "Your hair wants to fall forward. Combing this back will fight that every day."
        : "Your hair grows back, so a heavy forward fringe will need constant product.";
    }
  }
  if (person.hair.cowlickFront.value === true && variant.fit.cowlick === "sensitive" && variant.geometry.coversForehead > 0.55) {
    text = "A front cowlick fights a heavy fringe. A softer, broken fringe is the easier version.";
  }
  if (LAYERED_TEXTURE_FAMILIES.has(variant.familyId) && (curl === "1" || curl === "2a")) {
    // Shag, wolf and mullet layers are cut to flick and separate; straight hair lies flat and the layers read as steps.
    points -= curl === "1" ? 5 : 4;
    text = "The layers in this cut are built to flick out with texture; straight hair lies flat, so they read as steps.";
    // A choppy front over a front cowlick splits where the cowlick wants, not where the cut puts it.
    if (person.hair.cowlickFront.value === true && variant.geometry.coversForehead >= 0.45) points -= 2;
  }
  points += hairExtras(person, variant);
  const frizz = person.hair.frizz.value;
  if ((frizz === "frizzy" || frizz === "extreme") && variant.requirements.curl.every((code) => code === "1" || code === "2a")) points -= 3;
  if (person.hair.damage.value === "high" && (variant.requirements.topCm ?? 0) >= 30) points -= 3;
  return { points: clamp(points, 0, HAIR_RAW_MAX), text };
}

/** A forward or side growth reading under this confidence is read as a blend of both: photos often cannot tell a forward fall from a side one. */
export const GROWTH_BLEND_CONFIDENCE = 0.75;

function directionPoints(growth: "forward" | "back" | "side", fit: StyleVariant["fit"]["direction"]): number {
  if (fit === "any" || fit === growth || (growth === "side" && fit !== "back")) return 3;
  return (growth === "forward" && fit === "back") || (growth === "back" && fit === "forward") ? -5 : 0;
}

/** Hair-behaviour points for how the cut falls against the way the hair grows; an unsure forward or side reading averages the points of both. */
export function growthPoints(growth: "forward" | "back" | "side", fit: StyleVariant["fit"]["direction"], confidence: number): number {
  if (growth === "back" || confidence >= GROWTH_BLEND_CONFIDENCE) return directionPoints(growth, fit);
  return (directionPoints("forward", fit) + directionPoints("side", fit)) / 2;
}

/** Hair-behaviour points a cut built for straight hair loses on curl 3a and above (a product weight, not research). */
const STRAIGHT_BUILT_ON_CURLS = 6;

/** Raw ceiling of the hair-behaviour rules before the length and adapt adjustments (the rubric gives it 30 with them). */
const HAIR_RAW_MAX = 27;


/** Strand, density and chemical-texture rules that decide whether the hair can carry the cut's weight. */
function hairExtras(person: Person, variant: StyleVariant): number {
  let points = 0;
  const strand = person.hair.diameter.value;
  const density = person.hair.density.value;
  // A short cut carries thin hair without showing it; the weight rules bite as the top gets longer.
  const shortCut = (variant.requirements.topCm ?? 0) <= CROWN_SHORT_MAX_CM;
  if (strand === "fine") {
    if (variant.requirements.blunt) points -= 6;
    if (variant.fit.mass === "heavy") points -= 10;
    if (density !== "unknown" && density < variant.requirements.densityMin) points -= shortCut ? 0 : 12;
  }
  if (density !== "unknown" && density <= 2 && variant.requirements.densityMin >= 3) points -= shortCut ? 0 : 8;
  if (variant.requirements.blunt) points -= 2;
  return Math.max(-14, points);
}

/** Up to 3 points when the length the client has today is close to what the cut asks for: nothing to wait for or to cut away. */
function lengthNowPoints(person: Person, variant: StyleVariant): number {
  const rawHave = effectiveComparableLengthCm(person, variant);
  const top = variant.requirements.topCm;
  if (rawHave === "unknown" || top === null) return 2;
  const delta = Math.abs(rawHave * (1 - curlShrinkage(person.hair.curl.value)) - top);
  return delta <= 4 ? 3 : delta <= 10 ? 2 : delta <= 18 ? 1 : 0;
}

/**
 * 0 to 1 (1 = nothing to cut or grow, taken off hair behaviour as 1 minus this): how little cutting or growing the cut needs, zone by zone (top, front, sides), against the style's minimum length for the zone.
 * Growing counts 1.5x cutting. A cut that needs nothing changed scores 1; a zone gap of 12 cm or more scores 0; unknown lengths are neutral (0.5).
 * Small on purpose: it separates cuts the banded length points tie on.
 */
export function lengthMatchPoints(person: Person, variant: StyleVariant): number {
  const shrink = curlShrinkage(person.hair.curl.value);
  let sum = 0;
  let zones = 0;
  for (const zone of ["top", "front", "sides"] as const) {
    const needed = variant.traits.minLengthCm[zone];
    const reading = effectiveLength(person, variant, zone);
    if (needed === null || !reading || reading.value === "unknown") continue;
    const gap = reading.value * (1 - shrink) - needed;
    sum += Math.min(1, (gap < 0 ? -gap * 1.5 : gap) / 12);
    zones += 1;
  }
  return zones === 0 ? 0.5 : Math.round((1 - sum / zones) * 100) / 100;
}

function foreheadFit(person: Person, answers: Answers, variant: StyleVariant): { points: number; text: string } {
  const cover = variant.geometry.coversForehead;
  let points = cover >= 0.35 && cover <= 0.7 ? 11 : 8;
  let text = cover >= 0.35 && cover <= 0.72
    ? "The front frames the forehead without a heavy, straight line across it."
    : cover > 0.72
      ? "The fringe is heavy. It shortens the face, but a blunt line can feel like a helmet."
      : "The forehead stays mostly open, so the face reads a little longer.";
  const hairline = person.hair.hairline.value;
  // A known recession reading is scored by recessionPoints (low contrast, not hiding); the older high-hairline rule is for when it is unknown.
  if ((hairline === "high" || hairline === "receded") && (recessionOf(person) ?? "none") === "none") {
    if (variant.fit.hairline === "cover" || cover >= 0.45) {
      points += 5;
      text = "The hairline sits high, and this front covers enough of it to keep the forehead in proportion.";
    } else if (variant.fit.hairline === "show" || cover < 0.15) {
      points -= 6;
      text = "This leaves a high hairline fully exposed. A bit of fringe would frame it.";
    }
  }
  if (hairline === "low" && cover > 0.72) points -= 2;
  if (answers.forehead === "cover" && cover > 0.4) {
    points += 3;
    text = "You asked to keep the forehead covered, and this front does that.";
  }
  if (answers.forehead === "show" && cover > 0.55) {
    points -= 5;
    text = "You asked to show the forehead. This fringe covers more of it than you wanted.";
  } else if (answers.forehead === "show" && cover <= 0.4) {
    points += 2;
  }
  return { points: clamp(points, 0, CRITERIA_MAX.hairline), text };
}

/** A receding hairline wants low contrast at the front: a cut that tolerates recession frames it, one that needs the full hairline exposes it. */
function recessionPoints(person: Person, variant: StyleVariant): number {
  const level = recessionOf(person);
  if (level === null || level === "none") return 0;
  const tolerance = variant.traits.recessionMax;
  // A forward-falling textured fringe breaks up the front line, so it favours a receding hairline whatever its recession tolerance: it is never marked down for it.
  const texturedForward = variant.fit.direction === "forward" && variant.traits.fringeKind === "textured" && variant.traits.fringeWeight >= 0.3;
  const forwardCrop = (tolerance === "advanced" || texturedForward) && variant.fit.direction === "forward" ? 2 : 0;
  // Long forward pieces over a thinning hairline on low-density hair show the gaps: the longer the top, the sparser the front.
  const thinFront = level !== "mild" && (person.hair.density.value === 1 || person.hair.density.value === 2) && (variant.requirements.topCm ?? 0) > CROWN_SHORT_MAX_CM ? -3 : 0;
  const base = tolerance === "advanced" ? 3 : tolerance === "moderate" ? 1 : -3;
  return (texturedForward ? Math.max(base, 0) : base) + forwardCrop + thinFront;
}

/** Skull shape and the crown: a flat back of the head shows under very short sides, and a crown whorl under a fade. */
function headExtras(person: Person, variant: StyleVariant): number {
  let points = 0;
  const fade = variant.traits.fadeHeight;
  if (person.head.occipital.value === "flat" && (fade === "skin" || fade === "high")) points -= 2;
  if (crownWhorlOf(person) && (fade === "skin" || fade === "high")) points -= 1;
  return points;
}

/** Glasses, ears and beard pairing: small, and only where the cut changes what they look like. */
function featurePoints(person: Person, variant: StyleVariant): number {
  let points = 5;
  const fade = variant.traits.fadeHeight;
  const ears = person.head.ears;
  if (ears && ears.value === "prominent" && (fade === "high" || fade === "skin")) points -= Math.round(4 * ears.confidence);
  const glasses = person.context.glasses;
  if (glasses.value === true) {
    if (fade === "high" || fade === "skin") points -= Math.round(3 * glasses.confidence);
    if (variant.geometry.coversForehead > 0.72) points -= Math.round(2 * glasses.confidence);
    // A straight, low fringe meets the top of the frame as a second line; swept and textured fronts sit above it.
    else if (variant.attrs?.fringeType === "blunt" && variant.geometry.coversForehead > 0.45) points -= Math.round(glasses.confidence);
  }
  return points;
}

function profileFit(person: Person, variant: StyleVariant): { points: number; text: string } {
  const longFace = faceReadsLong(person);
  const fade = fadeKind(variant);
  const width = variant.geometry.addsWidth;
  let points = 6;
  let text = "The sides stay in proportion with the top, so the profile does not turn into a tall column.";
  if (longFace && (fade === "skin" || fade === "high")) {
    points -= 4;
    text = "From the side, short sides plus height on top make the head look narrower. Fuller sides fix that.";
  } else if (longFace && width >= 0.28 && fade !== "skin") {
    points += 3;
    text = "Leaving weight above the ears keeps the side profile from looking narrow.";
  } else if (person.face.shape.value === "round" && (fade === "high" || fade === "skin")) {
    points += 2;
    text = "Shorter sides keep a rounder face from looking wider in profile.";
  }
  if (person.head.occipital.value === "flat" && variant.geometry.addsHeight > 0.7) points -= 2;
  if (person.body.neck.value === "long" && variant.geometry.addsHeight > 0.65) points -= 1;
  return { points: clamp(points, 0, CRITERIA_MAX.head), text };
}

/** 2026 trend, 0-5: low tapers, textured tops, curtains, mod, two-block and soft mullets score 5; tall hard-edged shapes score 1. */
function trendPoints(person: Person, answers: Answers, variant: StyleVariant): number {
  const text = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
  const attrs = variant.attrs;
  let points = 3;
  if (/pompadour|high and tight|high-and-tight|disconnected|faux.hawk|flat.top/.test(text)) points = 1;
  else if (attrs && (attrs.sides === "skin" || attrs.sides === "high") && attrs.height >= 0.4) points = 1;
  else if (/soft mullet|modern mullet|micro mullet|taper mullet/.test(text)) points = 5;
  else if (attrs?.sides === "low-taper" || attrs?.fringeType === "curtain" || attrs?.fringeType === "textured") points = 5;
  else if (/curtain|mod-cut|mod cut|two.block|textured|french crop|soft french|soft side part|caesar|comma|shag|wolf|bro-flow/.test(text)) points = 5;
  else if (attrs?.sides === "skin" || attrs?.sides === "high") points = 2;
  else if (/bowl|mohawk|broccoli|mullet/.test(text)) points = 2;
  if (isStatementStyle(variant)) points -= 2;
  if (faceReadsLong(person) && /mullet|bowl/.test(text)) points -= 1;
  return clamp(points, 0, 5);
}

function goalsFit(
  person: Person,
  answers: Answers,
  variant: StyleVariant,
  liked: boolean,
  hints: PreferenceHints,
): { points: number; text: string } {
  let points = 0;
  const blob = `${variant.familyId} ${variant.id} ${variant.title}`.toLowerCase();
  if (liked) points += 22;
  if (hints.likedFamilies.has(variant.familyId)) points += 16;
  if (hints.likedTokens.has("bob") && (variant.familyId === "bob" || /\bbob\b|\blob\b|bixie/.test(blob))) {
    points += 12;
  }
  for (const token of hints.likedTokens) {
    if (token === "bob") continue;
    if (blob.includes(token)) {
      points += 8;
      break;
    }
  }
  const have = person.hair.lengthCm.value !== "unknown" ? person.hair.lengthCm.value : person.hair.topCm.value;
  const needTop = variant.requirements.topCm;
  if (answers.keep === "length" && typeof have === "number" && needTop !== null) {
    if (needTop >= have - 4) points += 5;
    else if (needTop < have - 12) points -= 10;
  }
  if (answers.keep === "fringe" && variant.geometry.coversForehead >= 0.35) points += 4;
  if (isStatementStyle(variant)) points -= 16;
  const text =
    points >= 18
      ? "Matches what you picked in goals and upkeep answers."
      : points <= -4
        ? "Fights your stated length or maintenance preferences."
        : "Neutral against your goal answers.";
  return { points: clamp(points, -16, 15), text };
}

/** Styling time, upkeep interval and the client's length limits against the cut's own (0 to 10). */
function lifestylePoints(person: Person, answers: Answers, variant: StyleVariant, growth: GrowthGoal | null): number {
  const minutes = answers.stylingMinutes === "5" ? 5 : answers.stylingMinutes === "30" ? 30 : 15;
  let upkeep = 3;
  if (variant.lifestyle.stylingMinutes > minutes + 6) upkeep -= 4;
  else if (variant.lifestyle.stylingMinutes <= minutes) upkeep += 2;
  if (minutes <= 5 && variant.lifestyle.maintenanceWeeks <= 3) upkeep -= 2;
  upkeep -= shorteningPenalty(person, answers, variant);
  if (answers.canGrow === "no" && growthWouldNeed(variant, person)) upkeep -= 3;
  return practicalPoints(answers, variant, growth) + upkeep;
}

/** A trim up to this long (cm, about a finger's width) is an ordinary haircut, not a shortening the client ruled out. */
export const FREE_TRIM_CM = 4;

/**
 * 0 to 5 points off lifestyle for a client who will not cut their hair shorter ("canShorten: no"), by how much shorter the cut's top is than the top they have.
 * requirements.topCm is the length the cut needs (a minimum), so a cut at or above the hair costs nothing; below it, only the part beyond FREE_TRIM_CM counts, 1 point per cm.
 * An unknown current length costs nothing: nothing says the cut shortens it.
 */
export function shorteningPenalty(person: Person, answers: Answers, variant: StyleVariant): number {
  if (answers.canShorten !== "no") return 0;
  const needed = variant.requirements.topCm;
  const have = effectiveComparableLengthCm(person, variant);
  if (needed === null || have === "unknown") return 0;
  return Math.max(0, Math.min(5, Math.ceil(have - needed - FREE_TRIM_CM)));
}

function growthWouldNeed(variant: StyleVariant, person: Person): boolean {
  const needed = variant.requirements.topCm;
  const have = effectiveComparableLengthCm(person, variant);
  if (needed === null || have === "unknown") return false;
  return needed > have + 2;
}

function practicalPoints(answers: Answers, variant: StyleVariant, growth: GrowthGoal | null): number {
  const minutes = answers.stylingMinutes === "5" ? 5 : answers.stylingMinutes === "30" ? 30 : 15;
  let points = minutes + 3 >= variant.lifestyle.stylingMinutes ? 5 : minutes + 8 >= variant.lifestyle.stylingMinutes ? 3 : 1;
  if (answers.blowdryer === "no" && variant.lifestyle.blowdryer) points -= 2;
  if (answers.products === "no" && variant.lifestyle.stylingMinutes >= 10) points -= 1;
  if (answers.stylingMinutes === "5" && variant.lifestyle.stylingMinutes <= 5) points = 5;
  if (growth) points -= 2;
  return clamp(points, 0, 5);
}

export type SidesKind = "skin" | "high" | "mid" | "low" | "neutral";

/** Side construction read from the cut's own attributes; cuts without attributes stay neutral. */
function fadeKind(variant: StyleVariant): SidesKind {
  switch (variant.attrs?.sides) {
    case "skin": return "skin";
    case "high": return "high";
    case "mid": return "mid";
    case "low-taper":
    case "scissor": return "low";
    default: return "neutral";
  }
}

function curlDistance(curl: Person["hair"]["curl"]["value"], allowed: readonly string[]): "match" | "near" | "fight" | "unknown" {
  if (curl === "unknown") return "unknown";
  if (allowed.includes(curl)) return "match";
  const index = curlCodes.indexOf(curl);
  const near = allowed.some((code) => {
    const other = curlCodes.indexOf(code as (typeof curlCodes)[number]);
    return other >= 0 && Math.abs(other - index) <= 1;
  });
  return near ? "near" : "fight";
}

function hairSentence(person: Person, variant: StyleVariant, near: boolean): string {
  const curl = person.hair.curl.value;
  const straightish = curl === "1" || curl === "2a" || curl === "2b";
  const family = variant.familyId;
  const textured = family === "crop" || family.includes("fringe") || family === "curtains" || family === "two-block" || family === "mod" || family === "caesar";
  if (straightish && textured && variant.fit.direction !== "back") {
    return `${variant.title} works with straight-to-soft hair that wants to fall forward, instead of forcing a tall slick shape.`;
  }
  if (person.hair.growthDirection.value === "forward" && variant.fit.direction !== "back") {
    return "Your hair wants to come forward, and this cut works with that instead of forcing it up.";
  }
  if (near) return "The texture is close enough to what this cut is built for.";
  return "The texture in the photos matches how this cut is built.";
}

function confidenceOf(person: Person, answers: Answers): number {
  const known = [
    person.hair.curl.value !== "unknown",
    person.hair.density.value !== "unknown",
    person.hair.diameter.value !== "unknown",
    person.face.shape.value !== "unknown",
    person.hair.growthDirection.value !== "unknown",
    person.hair.lengthCm.value !== "unknown" || person.hair.topCm.value !== "unknown",
    answers.blowdryer !== "unknown",
  ].filter(Boolean).length;
  return Math.round((known / 7) * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

/** The seven rubric parts (100), plus half of the goals and taste adjustments. */
export function componentsTotal(c: ScoreComponents): number {
  return CRITERION_KEYS.reduce((sum, key) => sum + c[key], 0) + 0.5 * (c.goals + c.taste);
}

/** Most a cut can reach: the seven parts (100) plus half of the capped goals (15) and taste (14). */
const FIT_MAX = 114.5;

/** The Fit of a set of components: the rubric total on a 0-100 scale, capped for a style that fails the hard filters. */
export function fitFromComponents(c: ScoreComponents, excluded: boolean): number {
  const raw = componentsTotal(c);
  return excluded ? Math.min(raw, 20) : (raw * 100) / FIT_MAX;
}

export function rankRawTotal(look: ScoredVariant): number {
  return componentsTotal(look.components);
}

/** A style that needs growth is not available today, so it ranks under the ones that are, by more the longer the wait. */
function growthPenalty(growth: GrowthGoal | null): number {
  return growth ? Math.min(14, 4 + growth.missingCm) : 0;
}

/**
 * The barber's taste carried over from the earlier rubric (the 2026 shortlist, texture fall, tall shapes on a narrow face).
 * It sits outside the 100 like goals and counts at half weight; the hard filters and the seven criteria do not depend on it.
 */
const BARBER_FAVOURED =
  /french crop|textured crop|textured fringe|messy fringe|mid-length curtains|e-boy curtains|mod cut|caesar cut|center part korean|two block (taper|middle part|side part|long fringe)|short two block|messy two block|ivy league|classic side part|side part fade|layered men|tapered neckline|low taper fade|ear tuck|korean two-block|short curtains|soft side part/;
const BARBER_TOP_TIER =
  /textured french crop|soft french crop|short curtains|mod cut|textured caesar|korean two-block|messy fringe|side-swept textured crop|soft side part|ivy league/;
/** The middle-part curtain cuts are the same cut as Short curtains with a different name; they rank under it. */
const NEAR_DUPLICATE_OF_CURTAINS = /middle part (short|with taper)/;
/** Tall front volume: it stacks height on an oval or long face and fights hair that falls forward or to the side. */
const TALL_VOLUME = /quiff|pompadour|faux hawk/;
const BARBER_SOFT_FAMILIES = new Set(["crop", "curtains", "two-block", "fringe", "side-part", "asian-fringe", "comma"]);
const BARBER_ARCHETYPES_TO_AVOID = /pompadour|quiff|faux hawk|high and tight|flat top|disconnected|skin|high fade|mid fade|high taper|burst|drop fade|temple fade|crew cut|brush cut|slick|wet look|hard part|peaky|greaser|undercut fade|shaved sides/;

/**
 * The taste block was written for one client: a man (the catalogue gate keeps women's styles out; a woman's reading
 * switches it off too) with straight to slightly wavy hair (curl 1 or 2a) and a hairline that has not receded past mild. For any other profile (curly, receding, a woman) it is switched off, not turned down.
 */
export function tasteApplies(person: Person): boolean {
  const curl = person.hair.curl;
  if (person.sex.value === "female" && person.sex.confidence >= FILTER_MIN_CONFIDENCE) return false;
  if (curl.value === "unknown" || curl.confidence < FILTER_MIN_CONFIDENCE) return false;
  if (curl.value !== "1" && curl.value !== "2a") return false;
  const level = recessionOf(person);
  return level === null || level === "none" || level === "mild";
}

/** Taste never lifts a cut the hard filters changed because of the hair itself: a curl, density, strand or recession adapt. */
function tasteHolds(feasibility: Feasibility): boolean {
  return !feasibility.checks.some((check) => ["curl", "density", "strand", "recession"].includes(check.check));
}

/** A barber's taste for a masculine cut that the geometry rules do not see: the 2026 shortlist and texture fall. */
export function barberTaste(person: Person, variant: StyleVariant): number {
  if (variant.service !== "haircut" || variant.affinity !== "masculine" || !tasteApplies(person)) return 0;
  // A newline between title and id: a pattern like "short curtains" must not match across the two ("Middle part short" + "curtains--...").
  const text = `${variant.title}
${variant.id}`.toLowerCase();
  let points = 0;
  if (BARBER_TOP_TIER.test(text)) points += 10;
  else if (BARBER_FAVOURED.test(text)) points += 4;
  else if (BARBER_SOFT_FAMILIES.has(variant.familyId)) points += 1;
  const narrowish = faceReadsLong(person) || person.face.shape.value === "oval";
  if (narrowish && BARBER_ARCHETYPES_TO_AVOID.test(text)) points -= 10;
  // The FIT rubric's key rule: skin or high sides strip the width an oval or long face needs, whatever the top does.
  if (narrowish && (variant.attrs?.sides === "skin" || variant.attrs?.sides === "high")) points -= 16;
  if (NEAR_DUPLICATE_OF_CURTAINS.test(text)) points -= 3;
  const growth = person.hair.growthDirection.value;
  const fallsDown = growth === "forward" || growth === "side";
  const tallVolume = TALL_VOLUME.test(text) && (variant.requirements.topCm ?? 0) >= 8;
  if (tallVolume && fallsDown && narrowish) points -= 12;
  if ((variant.requirements.topCm ?? 0) >= 18 && person.hair.lengthCm.value === "unknown" && person.hair.topCm.value === "unknown") points -= 6;
  const curl = person.hair.curl.value;
  const smoothHair = curl === "1" || curl === "2a" || curl === "2b";
  if (smoothHair && /shag|wolf|perm|curly|afro|twist|locs?|coil|sponge|hippie|fluffy/.test(text)) points -= 6;
  if (/see-through|mash|bowl|gail|dandy|leaf|hush|hipster|frat|bieber/.test(text)) points -= 3;
  return points;
}


/** The Fit as shown: the real score to one decimal. */
export function displayScore(raw: number, excluded: boolean): number {
  if (excluded) return Math.max(0, Math.min(20, roundFit(raw)));
  return Math.max(0, Math.min(100, roundFit(raw)));
}

/** The one deterministic order: raw total, then the hair criterion, then the face criterion, then the id, so catalogue order never decides a rank. */
export function compareLooks(left: ScoredVariant, right: ScoredVariant): number {
  return rankRawTotal(right) - rankRawTotal(left)
    || right.components.hairBehavior - left.components.hairBehavior
    || right.components.face - left.components.face
    || (left.variant.id < right.variant.id ? -1 : left.variant.id > right.variant.id ? 1 : 0);
}

const byScore = compareLooks;

export function labelText(label: ScoreLabel): string {
  if (label === "realistic") return "Realistic";
  if (label === "needs-treatment") return "Needs a treatment";
  return "Not on this hair";
}
