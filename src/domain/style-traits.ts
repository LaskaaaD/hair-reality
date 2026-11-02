import { curlCodes, type CurlCode, type RecessionLevel } from "./person.js";

export type FadeHeight = "none" | "low" | "mid" | "high" | "skin";
export type CrownLength = "short" | "in-between" | "long";
export type FringeKind = "none" | "split" | "side" | "textured" | "blunt";

/**
 * What the hard feasibility filters read per style. Derived once from the catalogue's own geometry, requirements and
 * attrs (see `deriveTraits`), so every style has every field and no style is tagged by name.
 */
export type StyleTraits = {
  fadeHeight: FadeHeight;
  /** Length of the crown: a whorl stands up at the in-between length, so that is where it clashes. */
  crownLength: CrownLength;
  /** The most recession the cut still works with. */
  recessionMax: RecessionLevel;
  /** How much of the forehead the front covers, 0 to 1. */
  fringeWeight: number;
  fringeKind: FringeKind;
  minDensity: number;
  maxDensity: number;
  /** Blunt or very flat shapes that turn bulky on dense, coarse hair unless weight is taken out. */
  bulkSensitive: boolean;
  /** Shortest length per zone the cut needs today; null when the cut has no such requirement. */
  minLengthCm: { front: number | null; top: number | null; sides: number | null };
  curlRange: { min: CurlCode; max: CurlCode };
  /** A clean combed side part is the whole cut and the catalogue stops short of coily hair: it needs hair that lies flat to hold the line. */
  combedPart: boolean;
};

export type TraitSource = {
  requirements: {
    curl: readonly string[];
    densityMin: number;
    frontCm: number | null;
    topCm: number | null;
    sidesCm: number | null;
    blunt: boolean;
  };
  geometry: { addsHeight: number; addsWidth: number; coversForehead: number };
  fit: { direction: "forward" | "side" | "back" | "any"; hairline: "cover" | "either" | "show"; mass: "light" | "medium" | "heavy" };
  attrs: { sides: "scissor" | "low-taper" | "mid" | "high" | "skin"; fringeType: "none" | "curtain" | "blunt" | "textured" | "swept"; width: number } | null;
};

/** Crown lengths in cm of the top: under 4.5 reads short, over 9 reads long, between is where a whorl stands up. */
export const CROWN_SHORT_MAX_CM = 4.5;
export const CROWN_LONG_MIN_CM = 9;

/** A fringe at or above this weight, long enough to fall over the forehead, reads as a fringe-heavy cut. */
export const FRINGE_HEAVY_MIN = 0.5;

/**
 * Fringe-heavy: the front covers at least half the forehead (`fringeWeight` >= 0.5) and either the top is longer than
 * a crop (above CROWN_SHORT_MAX_CM) or the fringe is a blunt line straight across. A textured crop carries the same cover
 * on a short, broken front, so weight alone would put every crop in the same bucket as a long fringe. A product
 * threshold, not a measurement.
 */
export function isFringeHeavy(traits: Pick<StyleTraits, "fringeWeight" | "fringeKind" | "minLengthCm">): boolean {
  return traits.fringeWeight >= FRINGE_HEAVY_MIN && ((traits.minLengthCm.top ?? 0) > CROWN_SHORT_MAX_CM || traits.fringeKind === "blunt");
}

/** Built for texture: the curl range starts at wavy (2a) or above, so the cut assumes hair that is not straight. */
export function isTextureBuilt(traits: Pick<StyleTraits, "curlRange">): boolean {
  return curlCodes.indexOf(traits.curlRange.min) >= curlCodes.indexOf("2a");
}

const FADE: Record<NonNullable<TraitSource["attrs"]>["sides"], FadeHeight> = {
  skin: "skin", high: "high", mid: "mid", "low-taper": "low", scissor: "none",
};

const FRINGE: Record<NonNullable<TraitSource["attrs"]>["fringeType"], FringeKind> = {
  none: "none", curtain: "split", swept: "side", textured: "textured", blunt: "blunt",
};

export function deriveTraits(source: TraitSource): StyleTraits {
  const { requirements, geometry, fit, attrs } = source;
  const top = requirements.topCm;
  const indexes = requirements.curl.map((code) => curlCodes.indexOf(code as CurlCode)).filter((index) => index >= 0);
  const lowest = Math.min(...(indexes.length ? indexes : [0]));
  const highest = Math.max(...(indexes.length ? indexes : [curlCodes.length - 1]));
  const cover = geometry.coversForehead;
  const fringeKind: FringeKind = attrs ? FRINGE[attrs.fringeType] : cover >= 0.6 ? "blunt" : cover >= 0.3 ? "textured" : "none";
  const swept = fit.direction === "back" || (geometry.addsHeight >= 0.55 && cover < 0.3);
  const fadeHeight: FadeHeight = attrs ? FADE[attrs.sides] : "none";
  // A front that is swept aside or left bare over faded sides is high contrast at the temples: it shows a receding line.
  const exposed = fit.hairline === "show" || (cover < 0.2 && (top ?? 0) >= 5) || (fit.direction === "side" && cover < 0.4 && fadeHeight !== "none");
  // Cuts that need the whole hairline (swept back or tall) tolerate none; ones that leave it bare tolerate a little;
  // a short crop tolerates a lot; everything else sits in between.
  const recessionMax: RecessionLevel = swept ? "mild" : exposed ? "mild" : top !== null && top <= CROWN_SHORT_MAX_CM ? "advanced" : "moderate";
  const combedPart = attrs !== null && attrs.fringeType === "swept" && fit.direction === "side" && lowest === 0 && highest < curlCodes.indexOf("4a");
  return {
    fadeHeight,
    crownLength: top === null || top < CROWN_SHORT_MAX_CM ? "short" : top > CROWN_LONG_MIN_CM ? "long" : "in-between",
    recessionMax,
    fringeWeight: cover,
    fringeKind,
    minDensity: requirements.densityMin,
    maxDensity: fit.mass === "light" ? 3 : 4,
    bulkSensitive: requirements.blunt || fringeKind === "blunt" || (attrs !== null && attrs.width <= 0.15),
    minLengthCm: { front: requirements.frontCm, top, sides: requirements.sidesCm },
    curlRange: { min: curlCodes[lowest] ?? "1", max: curlCodes[highest] ?? "4c" },
    combedPart,
  };
}

export function neutralTraits(): StyleTraits {
  return {
    fadeHeight: "none",
    crownLength: "short",
    recessionMax: "advanced",
    fringeWeight: 0.3,
    fringeKind: "textured",
    minDensity: 1,
    maxDensity: 4,
    bulkSensitive: false,
    minLengthCm: { front: null, top: null, sides: null },
    curlRange: { min: "1", max: "4c" },
    combedPart: false,
  };
}
