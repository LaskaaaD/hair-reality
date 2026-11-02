import type { StyleVariant } from "./knowledge-base.js";
import { curlCodes, recessionLevels, type CurlCode, type Person, type Reading, type RecessionLevel } from "./person.js";
import type { Answers, Presentation } from "./scoring.js";
import { CROWN_SHORT_MAX_CM, isFringeHeavy } from "./style-traits.js";
import { isSmoothCurl, isVeryCurly, needsStraightHair, needsTexturedHair } from "./texture-rules.js";

/** pass: the hair can do it today. adapt: it can, if the barber changes one thing. goal: only after growing out. fail: not on this hair. */
export type FeasibilityStatus = "pass" | "adapt" | "goal" | "fail";

export type FeasibilityCheck = {
  check: "gender" | "curl" | "density" | "strand" | "length" | "recession" | "cowlick" | "crown" | "beard";
  status: Exclude<FeasibilityStatus, "pass">;
  /** One plain-English line, no measurements beyond what the client needs to plan a grow-out. */
  note: string;
};

export type GrowthGoal = {
  missingCm: number;
  months: number;
  text: string;
};

export type Feasibility = {
  status: FeasibilityStatus;
  /** Only the checks that did not pass. */
  checks: FeasibilityCheck[];
  adaptNotes: string[];
  failReason: string | null;
  growth: GrowthGoal | null;
};

export const GROWTH_CM_PER_MONTH = 1.25;
/** Longer than this and a cut is no goal worth planning around: it fails instead of joining the grow-out group. */
export const MAX_GOAL_MONTHS = 12;
/** Product assumption (not measured): how much of its stretched length curly hair gives up when it dries into its curl. */
export const CURL_SHRINKAGE = { "3": 0.3, "4": 0.5 } as const;
/** Readings under this confidence are guesses: the hard filters ignore them. */
export const FILTER_MIN_CONFIDENCE = 0.5;
/** A mild recession is a faint call from photos (it is easy to see in a normal hairline), so it only counts from this confidence; moderate and advanced count from FILTER_MIN_CONFIDENCE. */
export const MILD_RECESSION_MIN_CONFIDENCE = 0.65;

export function curlShrinkage(curl: Person["hair"]["curl"]["value"]): number {
  if (curl === "unknown") return 0;
  if (curl.startsWith("3")) return CURL_SHRINKAGE["3"];
  if (curl.startsWith("4")) return CURL_SHRINKAGE["4"];
  return 0;
}

function sure<T>(reading: Reading<T> | undefined): T | null {
  return !reading || reading.value === "unknown" || reading.confidence < FILTER_MIN_CONFIDENCE ? null : reading.value;
}

/** How far the hairline has receded: the vision reading when there is one, else what a receded hairline or strong temple loss implies. */
export function recessionOf(person: Person): RecessionLevel | null {
  const direct = sure(person.hair.recession);
  if (direct && (direct !== "mild" || (person.hair.recession?.confidence ?? 0) >= MILD_RECESSION_MIN_CONFIDENCE)) return direct;
  const temples = sure(person.hairLoss.temples);
  if (temples === "strong") return "moderate";
  if (temples === "mild" && (person.hairLoss.temples.confidence >= MILD_RECESSION_MIN_CONFIDENCE)) return "mild";
  if (sure(person.hair.hairline) === "receded") return "moderate";
  return null;
}

export function crownWhorlOf(person: Person): boolean {
  return sure(person.hair.cowlickCrown) === true;
}

function frontCowlickOf(person: Person): boolean {
  return sure(person.hair.cowlickFront) === true;
}

/**
 * Hard texture rules. Straight or wavy hair (curl 1 or 2x) never ranks a perm, wave pattern, loc, twist, afro or
 * coil style, and very curly hair (4x) never ranks a style that needs straight hair, unless the client asked for it.
 */
export function addsCurlToSmoothHair(person: Person, answers: Answers, variant: StyleVariant, liked: boolean): boolean {
  const curl = person.hair.curl.value;
  if (curl === "unknown" || liked || answers.chemical === "permed") return false;
  if (isSmoothCurl(curl)) return needsTexturedHair(variant, curl);
  if (isVeryCurly(curl)) return needsStraightHair(variant);
  return false;
}

/** Steps between the person's curl and the style's range: 0 inside it. */
export function curlSteps(curl: CurlCode, range: { min: CurlCode; max: CurlCode }): number {
  const index = curlCodes.indexOf(curl);
  const low = curlCodes.indexOf(range.min);
  const high = curlCodes.indexOf(range.max);
  return index < low ? low - index : index > high ? index - high : 0;
}

export function effectiveLength(person: Person, variant: StyleVariant, zone: "front" | "top" | "sides"): Reading<number> | null {
  const { hair } = person;
  const pick = (reading: Reading<number>) => (reading.value === "unknown" ? null : reading);
  const long = pick(hair.lengthCm);
  if (zone === "sides") return variant.affinity === "feminine" ? null : pick(hair.sideCm);
  const own = zone === "front" ? pick(hair.frontCm) : pick(hair.topCm);
  if (variant.affinity === "feminine") {
    const top = pick(hair.topCm);
    return long && top ? (long.value >= top.value ? long : top) : long ?? top;
  }
  return own ?? long;
}

/**
 * How much shorter than the style the hair may read before the style counts as growth. Length read from photos is an
 * estimate (vision), so the gap allowed grows as the reading's confidence falls, up to 3.5 cm; a measured length keeps 0.5 cm.
 * Sides get 1.5 cm more: they are trimmed to the cut's own length anyway.
 */
function lengthTolerance(reading: Reading<number>, zone: "front" | "top" | "sides"): number {
  const base = reading.source !== "vision" ? 0.5 : Math.min(3.5, 0.5 + (1 - reading.confidence) * 12);
  return zone === "sides" ? base + 1.5 : base;
}

const ZONE_TEXT = { front: "at the front", top: "on top", sides: "at the sides" } as const;

function lengthCheck(person: Person, variant: StyleVariant): { growth: GrowthGoal | null; failNote: string | null } {
  const shrink = curlShrinkage(person.hair.curl.value);
  let worst = { missing: 0, zone: "top" as keyof typeof ZONE_TEXT };
  if (variant.requirements.needsExtension) return { growth: null, failNote: null };
  for (const zone of ["top", "front", "sides"] as const) {
    const needed = variant.traits.minLengthCm[zone];
    const reading = effectiveLength(person, variant, zone);
    if (needed === null || !reading || reading.value === "unknown") continue;
    const have = reading.value * (1 - shrink);
    const short = needed - have;
    if (short > lengthTolerance(reading, zone) && short > worst.missing) worst = { missing: short, zone };
  }
  if (worst.missing <= 0) return { growth: null, failNote: null };
  const missingCm = Math.round(worst.missing * 10) / 10;
  const months = Math.ceil(missingCm / GROWTH_CM_PER_MONTH);
  const shrinkText = shrink > 0 ? " once the curl has dried and sprung back" : "";
  const text = `This needs about ${missingCm} cm more ${ZONE_TEXT[worst.zone]}${shrinkText}, roughly ${months} months at ${GROWTH_CM_PER_MONTH} cm a month.`;
  return { growth: { missingCm, months, text }, failNote: months > MAX_GOAL_MONTHS ? `This cut is more than ${MAX_GOAL_MONTHS} months of growth away.` : null };
}

/**
 * Step A of the consultation: can this client's hair do the cut at all? Deterministic and run before any scoring.
 * Readings below FILTER_MIN_CONFIDENCE and unknown readings are never used here.
 */
export function assessFeasibility(
  person: Person,
  answers: Answers,
  variant: StyleVariant,
  options: { liked: boolean; presentation: Presentation | null; acceptsPresentation: boolean },
): Feasibility {
  const checks: FeasibilityCheck[] = [];
  const add = (check: FeasibilityCheck["check"], status: FeasibilityCheck["status"], note: string) => checks.push({ check, status, note });
  let growth: GrowthGoal | null = null;

  if (!options.acceptsPresentation) add("gender", "fail", "This style is not in the list you chose (Men, Women or Both).");
  if (variant.beardFullness === "full" && answers.beardGrowth === "patchy") add("beard", "fail", "A full beard needs even growth. Patchy growth will not fill this shape.");

  if (variant.service === "haircut") {
    const { traits } = variant;
    const curl = person.hair.curl.value;
    if (curl !== "unknown" && person.hair.curl.confidence >= FILTER_MIN_CONFIDENCE) {
      // A cut built around a clean combed part holds on smooth to wavy hair only: past 2c it counts as outside its range however wide the catalogue lists it.
      const range = traits.combedPart && curlCodes.indexOf(traits.curlRange.max) > curlCodes.indexOf("2c") ? { ...traits.curlRange, max: "2c" as const } : traits.curlRange;
      const steps = curlSteps(curl, range);
      const permed = answers.chemical === "permed";
      if (addsCurlToSmoothHair(person, answers, variant, options.liked)) add("curl", "fail", isSmoothCurl(curl) ? "This shape needs curl or texture that straight to wavy hair does not have." : "This shape needs smooth, straight hair that this curl pattern does not have.");
      else if (steps >= 2 && !options.liked && !permed) add("curl", "fail", traits.combedPart ? "This cut depends on a clean combed part, and hair this curly will not lie flat to hold it." : "The curl pattern is too far from what this cut is built for.");
      else if (steps >= 1) add("curl", "adapt", "The curl is a step away from what this cut assumes, so it needs cutting and styling for your texture.");
    }

    const density = sure(person.hair.density);
    const strand = sure(person.hair.diameter);
    // A short cut (under the crown threshold) does not lean on density: thin hair shows little at that length.
    const shortCut = (traits.minLengthCm.top ?? 0) <= CROWN_SHORT_MAX_CM;
    if (density !== null && density < traits.minDensity && !(shortCut && variant.fit.mass !== "heavy" && !variant.requirements.blunt)) {
      if (variant.fit.mass === "heavy" || variant.requirements.blunt) add("density", "fail", "This cut needs more density than the photos show. It would look thin.");
      else add("density", "adapt", "Density is lighter than this shape prefers, so it needs to be cut to keep the top full.");
    } else if (density !== null && density > traits.maxDensity) add("density", "adapt", "Dense hair needs weight taken out of this shape.");
    if (density !== null && density >= 4 && strand === "coarse" && traits.bulkSensitive) add("density", "adapt", "Thick, dense strands will turn bulky here unless weight is taken out.");
    if (strand !== null && !variant.requirements.strand.includes(strand)) {
      add("strand", "adapt", strand === "fine" ? "Fine strands lose the shape of this cut, so it needs a blunter, simpler finish." : "Coarse strands push this cut out, so it needs weight removed.");
    }

    const length = lengthCheck(person, variant);
    if (length.failNote) add("length", "fail", length.failNote);
    else if (length.growth) { growth = length.growth; add("length", "goal", length.growth.text); }

    const level = recessionOf(person);
    if (level !== null) {
      const over = recessionLevels.indexOf(level) - recessionLevels.indexOf(traits.recessionMax);
      if (over >= 1 && recessionLevels.indexOf(level) >= recessionLevels.indexOf("moderate")) add("recession", "fail", "This cut needs the hairline in place, and yours has receded too far for it.");
      else if (over >= 1) add("recession", "adapt", "A hairline that is starting to recede needs this cut worn softer at the front.");
      else if (level !== "none" && isFringeHeavy(traits) && (sure(person.hair.density) ?? 4) <= 2) {
        // Over a thinning front on thin hair a heavy fringe does not cover, it shows the gaps; only a style the client asked for stays, adapted.
        if (recessionLevels.indexOf(level) >= recessionLevels.indexOf("moderate") && !options.liked) add("recession", "fail", "A heavy fringe will not cover a thinning front on fine, sparse hair; it shows the gaps instead.");
        else add("recession", "adapt", "Thinning at the front means a heavy fringe will not cover; it needs to be broken up and textured.");
      }
    }

    if (frontCowlickOf(person) && traits.fringeWeight > 0.6 && traits.fringeKind !== "split" && traits.fringeKind !== "side") {
      add("cowlick", "adapt", "A front cowlick fights a heavy, full fringe. A split or side fringe is the easier version.");
    }
    if (crownWhorlOf(person)) {
      if (traits.fadeHeight === "high" || traits.fadeHeight === "skin") add("crown", "adapt", "A crown whorl clashes with a high fade; the fade line needs to sit below the crown.");
      else if (traits.crownLength === "in-between") add("crown", "adapt", "A crown whorl stands up at this length, so the crown needs to stay longer than the rest.");
    }
  }

  const status: FeasibilityStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "goal") ? "goal" : checks.some((c) => c.status === "adapt") ? "adapt" : "pass";
  return {
    status,
    checks,
    adaptNotes: checks.filter((c) => c.status === "adapt").map((c) => c.note),
    failReason: checks.find((c) => c.status === "fail")?.note ?? null,
    growth: status === "fail" ? null : growth,
  };
}
