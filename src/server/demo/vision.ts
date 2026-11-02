import { z } from "zod";
import { addCandidate, known, recessionLevels, unknownReading, type Person, type Reading } from "../../domain/person.js";

const curlCode = z.enum(["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c", "unknown"]);

export const visionReadingSchema = z.object({
  growthDirection: z.enum(["forward", "back", "left", "right", "unknown"]),
  cowlickFront: z.boolean().nullable(),
  cowlickCrown: z.boolean().nullable(),
  hairline: z.enum(["low", "average", "high", "receded", "unknown"]),
  glasses: z.boolean().nullable(),
  lengthCm: z.number().min(0).max(80).nullable(),
  frontCm: z.number().min(0).max(80).nullable(),
  topCm: z.number().min(0).max(80).nullable(),
  sideCm: z.number().min(0).max(80).nullable(),
  curl: curlCode,
  diameter: z.enum(["fine", "medium", "coarse", "unknown"]),
  density: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]),
  faceShape: z.enum(["oval", "round", "square", "heart", "long", "unknown"]),
  /** Face length divided by face width, about 1.0 to 1.7. */
  faceRatio: z.number().min(0.8).max(2.2).nullable().optional(),
  jaw: z.enum(["narrow", "average", "wide", "unknown"]),
  forehead: z.enum(["low", "average", "high", "unknown"]).optional(),
  foreheadWidth: z.enum(["narrow", "average", "wide", "unknown"]).optional(),
  ears: z.enum(["flat", "average", "prominent", "unknown"]).optional(),
  /** How far the hairline has receded (none, mild, moderate, advanced); unknown when it cannot be seen. */
  recession: z.enum([...recessionLevels, "unknown"]).optional(),
  /** A whorl (spiral growth) at the crown, from the crown or side photos. Feeds the crown cowlick. */
  crownWhorl: z.boolean().nullable().optional(),
  /** Back of the head: flat or round. */
  occipital: z.enum(["flat", "round", "unknown"]).optional(),
  /** Beard or stubble on the face; none when clean shaven. */
  facialHair: z.enum(["none", "stubble", "moustache", "short", "medium", "long", "unknown"]).optional(),
  confidence: z.number().min(0).max(1),
  /** Per-field confidence for the merged profile; a field without one falls back to `confidence`. */
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

export const FIELD_CONFIDENCE_KEYS = [
  "growthDirection", "cowlickFront", "cowlickCrown", "hairline", "glasses", "length", "curl", "diameter",
  "density", "faceShape", "faceRatio", "jaw", "forehead", "foreheadWidth", "ears", "recession", "crownWhorl", "occipital", "facialHair",
] as const;

/** Below this a vision value is treated as a guess and the YouCam value (or unknown) stays. */
export const VISION_MIN_CONFIDENCE = 0.5;

export type VisionReading = z.infer<typeof visionReadingSchema>;
export type VisionIssue = { field: string; reason: string };
export type VisionOutcome = {
  person: Person;
  filled: { field: string; value: unknown; confidence: number }[];
  skipped: VisionIssue[];
};

const shape = visionReadingSchema.shape;
const FIELD_SHAPES: Record<string, z.ZodType> = {
  growthDirection: shape.growthDirection,
  cowlickFront: shape.cowlickFront,
  cowlickCrown: shape.cowlickCrown,
  hairline: shape.hairline,
  glasses: shape.glasses,
  lengthCm: shape.lengthCm,
  frontCm: shape.frontCm,
  topCm: shape.topCm,
  sideCm: shape.sideCm,
  curl: shape.curl,
  diameter: shape.diameter,
  density: shape.density,
  faceShape: shape.faceShape,
  faceRatio: z.number().min(0.8).max(2.2).nullable(),
  jaw: shape.jaw,
  forehead: z.enum(["low", "average", "high", "unknown"]),
  foreheadWidth: z.enum(["narrow", "average", "wide", "unknown"]),
  ears: z.enum(["flat", "average", "prominent", "unknown"]),
  recession: shape.recession as z.ZodType,
  crownWhorl: shape.crownWhorl as z.ZodType,
  occipital: shape.occipital as z.ZodType,
  facialHair: shape.facialHair as z.ZodType,
};

const ALIASES: Record<string, Record<string, string>> = {
  growthDirection: { forwards: "forward", front: "forward", backward: "back", backwards: "back" },
  hairline: { medium: "average", normal: "average", receding: "receded" },
  forehead: { medium: "average", normal: "average", tall: "high", short: "low" },
  foreheadWidth: { medium: "average", normal: "average", broad: "wide", small: "narrow" },
  jaw: { medium: "average", normal: "average", broad: "wide", strong: "wide", small: "narrow" },
  ears: { medium: "average", normal: "average" },
  diameter: { thin: "fine", thick: "coarse", normal: "medium", average: "medium" },
  recession: { receding: "moderate", "very mild": "mild", slight: "mild", minimal: "mild", medium: "moderate", severe: "advanced", high: "advanced", bald: "advanced" },
  occipital: { rounded: "round", curved: "round", flatter: "flat" },
  faceShape: { oblong: "long", rectangle: "long", rectangular: "long" },
  facialHair: {
    "clean shaven": "none", "clean-shaven": "none", clean: "none", shaved: "none", beardless: "none",
    "stubble beard": "stubble", "light stubble": "stubble", "heavy stubble": "stubble", "5 o'clock shadow": "stubble", "five o'clock shadow": "stubble",
    mustache: "moustache", "short beard": "short", "medium beard": "medium", "long beard": "long", beard: "short",
  },
};

function normalizeField(field: string, value: unknown): unknown {
  if (field === "density") {
    if (typeof value === "string" && /^[1-4]$/.test(value.trim())) return Number(value.trim());
    if (typeof value === "number" && Number.isFinite(value)) return Math.min(4, Math.max(1, Math.round(value)));
    return value;
  }
  if ((field === "faceRatio" || field.endsWith("Cm")) && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (field === "curl" && typeof value === "string") {
    const code = value.trim().toLowerCase().replace(/^type\s*/, "").replace(/\s+/g, "");
    if (code === "straight" || code === "1a" || code === "1b" || code === "1c") return "1";
    if (code === "2") return "2b";
    if (code === "3") return "3b";
    if (code === "4") return "4b";
    return code;
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    return ALIASES[field]?.[text] ?? text;
  }
  return value;
}

function clampUnit(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  return Math.min(1, Math.max(0, number > 1 && number <= 100 ? number / 100 : number));
}

/**
 * Reads the model's JSON field by field so one bad value drops only that field. Enum case, curl codes such as
 * "Type 2A", numeric strings and confidences on a 0-100 scale are accepted; anything else is reported by field.
 */
export function readVision(raw: unknown): { reading: VisionReading; rejected: VisionIssue[] } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const rejected: VisionIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const [field, fieldShape] of Object.entries(FIELD_SHAPES)) {
    if (source[field] === undefined) continue;
    const parsed = fieldShape.safeParse(normalizeField(field, source[field]));
    if (parsed.success) out[field] = parsed.data;
    else rejected.push({ field, reason: `invalid value ${String(JSON.stringify(source[field])).slice(0, 40)}` });
  }
  const confidence = clampUnit(source.confidence);
  if (confidence === null) rejected.push({ field: "confidence", reason: "missing or not a number" });
  const fieldConfidence: Record<string, number> = {};
  const fc = source.fieldConfidence;
  if (typeof fc === "object" && fc !== null) {
    for (const [key, value] of Object.entries(fc)) {
      const unit = clampUnit(value);
      if (unit === null) rejected.push({ field: `fieldConfidence.${key}`, reason: "not a number" });
      else fieldConfidence[key] = unit;
    }
  }
  const reading = visionReadingSchema.safeParse({ ...fixtureVision(), ...out, confidence: confidence ?? 0, fieldConfidence });
  if (!reading.success) return null;
  return { reading: reading.data, rejected };
}

export function applyVision(person: Person, reading: VisionReading): Person {
  return applyVisionDetailed(person, reading).person;
}

export function applyVisionDetailed(person: Person, reading: VisionReading): VisionOutcome {
  const next = structuredClone(person);
  next.face.foreheadWidth ??= unknownReading<"narrow" | "average" | "wide">("vision");
  next.head.ears ??= unknownReading<"flat" | "average" | "prominent">("vision");
  const filled: VisionOutcome["filled"] = [];
  const skipped: VisionIssue[] = [];
  const at = (key: (typeof FIELD_CONFIDENCE_KEYS)[number]) => reading.fieldConfidence?.[key] ?? reading.confidence;
  const fill = <T,>(
    field: string,
    key: (typeof FIELD_CONFIDENCE_KEYS)[number],
    current: Reading<T>,
    value: T | null | undefined,
    write: (reading: Reading<T>) => void,
  ): void => {
    // Both readings stay on the profile whatever the merge decides: the resolved value is the higher-confidence one, the other is kept as a candidate.
    if (current.value !== "unknown" && current.source !== "vision" && (typeof current.value === "string" || typeof current.value === "number" || typeof current.value === "boolean")) {
      addCandidate(next, field, { source: current.source, value: current.value, confidence: current.confidence });
    }
    if (value === null || value === undefined) {
      skipped.push({ field, reason: "model gave unknown" });
      return;
    }
    const confidence = at(key);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") addCandidate(next, field, { source: "vision", value, confidence });
    if (confidence < VISION_MIN_CONFIDENCE) {
      skipped.push({ field, reason: `confidence ${confidence.toFixed(2)} below ${VISION_MIN_CONFIDENCE}` });
      return;
    }
    if (current.value !== "unknown" && current.confidence >= confidence) {
      skipped.push({ field, reason: `kept ${current.source} ${String(current.value)} (${current.confidence.toFixed(2)}) over vision ${String(value)} (${confidence.toFixed(2)})` });
      return;
    }
    write(known(value, "vision", confidence));
    filled.push({ field, value, confidence });
  };
  const text = <T extends string>(value: T | "unknown" | undefined): T | null => (value === undefined || value === "unknown" ? null : value);
  const direction = reading.growthDirection === "left" || reading.growthDirection === "right" ? "side" : text(reading.growthDirection);
  fill("growthDirection", "growthDirection", next.hair.growthDirection, direction, (r) => { next.hair.growthDirection = r; });
  fill("cowlickFront", "cowlickFront", next.hair.cowlickFront, reading.cowlickFront, (r) => { next.hair.cowlickFront = r; });
  fill("cowlickCrown", reading.cowlickCrown === null || reading.cowlickCrown === undefined ? "crownWhorl" : "cowlickCrown", next.hair.cowlickCrown, reading.cowlickCrown ?? reading.crownWhorl, (r) => { next.hair.cowlickCrown = r; });
  fill("recession", "recession", next.hair.recession ?? unknownReading<(typeof recessionLevels)[number]>("vision"), text(reading.recession), (r) => { next.hair.recession = r; });
  fill("occipital", "occipital", next.head.occipital, text(reading.occipital), (r) => { next.head.occipital = r; });
  fill("hairline", "hairline", next.hair.hairline, text(reading.hairline), (r) => { next.hair.hairline = r; });
  fill("lengthCm", "length", next.hair.lengthCm, reading.lengthCm, (r) => { next.hair.lengthCm = r; });
  fill("frontCm", "length", next.hair.frontCm, reading.frontCm, (r) => { next.hair.frontCm = r; });
  fill("topCm", "length", next.hair.topCm, reading.topCm, (r) => { next.hair.topCm = r; });
  fill("sideCm", "length", next.hair.sideCm, reading.sideCm, (r) => { next.hair.sideCm = r; });
  fill("curl", "curl", next.hair.curl, text(reading.curl), (r) => { next.hair.curl = r; });
  fill("diameter", "diameter", next.hair.diameter, text(reading.diameter), (r) => { next.hair.diameter = r; });
  fill("density", "density", next.hair.density, reading.density, (r) => { next.hair.density = r; });
  fill("faceShape", "faceShape", next.face.shape, text(reading.faceShape), (r) => { next.face.shape = r; });
  fill("faceRatio", "faceRatio", next.face.aspectRatio, reading.faceRatio, (r) => { next.face.aspectRatio = r; });
  fill("jaw", "jaw", next.face.jaw, text(reading.jaw), (r) => { next.face.jaw = r; });
  fill("forehead", "forehead", next.face.forehead, text(reading.forehead), (r) => { next.face.forehead = r; });
  fill("glasses", "glasses", next.context.glasses, reading.glasses, (r) => { next.context.glasses = r; });
  fill("foreheadWidth", "foreheadWidth", next.face.foreheadWidth ?? unknownReading<"narrow" | "average" | "wide">("vision"), text(reading.foreheadWidth), (r) => { next.face.foreheadWidth = r; });
  fill("ears", "ears", next.head.ears ?? unknownReading<"flat" | "average" | "prominent">("vision"), text(reading.ears), (r) => { next.head.ears = r; });
  fill("facialHair", "facialHair", next.facialHair.style, text(reading.facialHair), (r) => { next.facialHair.style = r; });
  return { person: next, filled, skipped };
}

export function fixtureVision(): VisionReading {
  return visionReadingSchema.parse({
    growthDirection: "unknown",
    cowlickFront: null,
    cowlickCrown: null,
    hairline: "unknown",
    glasses: null,
    lengthCm: null,
    frontCm: null,
    topCm: null,
    sideCm: null,
    curl: "unknown",
    diameter: "unknown",
    density: null,
    faceShape: "unknown",
    jaw: "unknown",
    recession: "unknown",
    crownWhorl: null,
    occipital: "unknown",
    facialHair: "unknown",
    confidence: 0,
  });
}
