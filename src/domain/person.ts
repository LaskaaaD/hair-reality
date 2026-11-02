import { z } from "zod";

export const fieldSources = ["youcam", "vision", "answer", "persona", "fixture"] as const;
export type FieldSource = (typeof fieldSources)[number];

export type Reading<T> = {
  value: T | "unknown";
  confidence: number;
  source: FieldSource;
};

export const curlCodes = ["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"] as const;
export type CurlCode = (typeof curlCodes)[number];
export const recessionLevels = ["none", "mild", "moderate", "advanced"] as const;
export type RecessionLevel = (typeof recessionLevels)[number];
export const faceNames = ["oval", "round", "square", "heart", "long"] as const;
export type FaceName = (typeof faceNames)[number];
export const densityLevels = [1, 2, 3, 4] as const;
export type DensityLevel = (typeof densityLevels)[number];

const sourceSchema = z.enum(fieldSources);

function readingSchema<T extends z.ZodType>(inner: T) {
  return z.object({
    value: z.union([inner, z.literal("unknown")]),
    confidence: z.number().min(0).max(1),
    source: sourceSchema,
  });
}

/** One source's reading of a field, kept next to the resolved value so nothing is overwritten. */
export const candidateSchema = z.object({
  source: sourceSchema,
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const personSchema = z.object({
  sex: readingSchema(z.enum(["male", "female", "unspecified"])),
  face: z.object({
    shape: readingSchema(z.enum(faceNames)),
    /** The face shape exactly as YouCam named it (e.g. "Diamond"); `shape` is only the scoring category. */
    youcamShape: readingSchema(z.string()).optional(),
    aspectRatio: readingSchema(z.number()),
    cheekbones: readingSchema(z.enum(["low", "average", "high"])),
    jaw: readingSchema(z.enum(["narrow", "average", "wide"])),
    forehead: readingSchema(z.enum(["low", "average", "high"])),
    asymmetry: readingSchema(z.enum(["mild", "notable"])),
    foreheadWidth: readingSchema(z.enum(["narrow", "average", "wide"])).optional(),
  }),
  head: z.object({
    occipital: readingSchema(z.enum(["flat", "round"])),
    ears: readingSchema(z.enum(["flat", "average", "prominent"])).optional(),
  }),
  hair: z.object({
    curl: readingSchema(z.enum(curlCodes)),
    density: readingSchema(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])),
    diameter: readingSchema(z.enum(["fine", "medium", "coarse"])),
    growthDirection: readingSchema(z.enum(["forward", "side", "up", "back"])),
    cowlickFront: readingSchema(z.boolean()),
    cowlickCrown: readingSchema(z.boolean()),
    hairline: readingSchema(z.enum(["low", "average", "high", "receded"])),
    damage: readingSchema(z.enum(["none", "mild", "high"])),
    lengthCm: readingSchema(z.number()),
    frontCm: readingSchema(z.number()),
    topCm: readingSchema(z.number()),
    sideCm: readingSchema(z.number()),
    frizz: readingSchema(z.enum(["none", "slight", "frizzy", "extreme"])),
    /** How far the hairline has receded; vision supplies it. Unknown is never used by the hard filters. */
    recession: readingSchema(z.enum(recessionLevels)).optional(),
  }),
  hairLoss: z.object({
    temples: readingSchema(z.enum(["none", "mild", "strong"])),
    crown: readingSchema(z.enum(["none", "mild", "strong"])),
    diffuse: readingSchema(z.enum(["none", "mild", "strong"])),
  }),
  facialHair: z.object({
    style: readingSchema(z.enum(["none", "stubble", "moustache", "short", "medium", "long"])),
    growth: readingSchema(z.enum(["full", "patchy"])),
  }),
  body: z.object({
    neck: readingSchema(z.enum(["short", "average", "long"])),
    shoulders: readingSchema(z.enum(["narrow", "average", "broad"])),
  }),
  context: z.object({
    glasses: readingSchema(z.boolean()),
  }),
  colour: z.object({
    level: readingSchema(z.number().int().min(1).max(10)),
    name: readingSchema(z.string().min(1).max(40)),
    skinTone: readingSchema(z.enum(["light", "medium", "deep"])),
    undertone: readingSchema(z.enum(["cool", "neutral", "warm"])),
  }),
  /** Every source's reading per field, keyed by the vision field name; the resolved value stays on the field itself. */
  candidates: z.record(z.string(), z.array(candidateSchema)).optional(),
});

export type Person = z.infer<typeof personSchema>;

export function candidatesOf(person: Person, field: string): Candidate[] {
  return person.candidates?.[field] ?? [];
}

/** Adds or replaces the reading one source gave for a field. */
export function addCandidate(person: Person, field: string, candidate: Candidate): void {
  person.candidates ??= {};
  person.candidates[field] = [...candidatesOf(person, field).filter((item) => item.source !== candidate.source), candidate];
}

/** Two sources read different shapes and neither is clearly surer: the face shape then favours no cut. */
export const FACE_SHAPE_CONTEST_GAP = 0.25;
const FACE_SHAPE_CONTEST_MIN = 0.5;

/**
 * True when YouCam and vision both gave a face shape of at least FACE_SHAPE_CONTEST_MIN confidence, the two differ, and their
 * confidences are within FACE_SHAPE_CONTEST_GAP. A shape the client corrected themselves is never contested.
 */
export function faceShapeContested(person: Person): boolean {
  const resolved = person.face.shape;
  if (resolved.value === "unknown" || (resolved.source !== "youcam" && resolved.source !== "vision")) return false;
  const readings = candidatesOf(person, "faceShape").filter((item) => item.confidence >= FACE_SHAPE_CONTEST_MIN && typeof item.value === "string" && item.value !== "unknown");
  const youcam = readings.find((item) => item.source === "youcam");
  const vision = readings.find((item) => item.source === "vision");
  if (!youcam || !vision || youcam.value === vision.value) return false;
  return Math.abs(youcam.confidence - vision.confidence) < FACE_SHAPE_CONTEST_GAP;
}

/**
 * True when the resolved face shape comes from a single source (YouCam or vision) and the other source did not read the same shape.
 * A shape both sources agree on, one the client corrected, and the persona and fixture profiles are not single-source.
 */
export function faceShapeSingleSource(person: Person): boolean {
  const resolved = person.face.shape;
  if (resolved.value === "unknown" || (resolved.source !== "youcam" && resolved.source !== "vision")) return false;
  const other = resolved.source === "youcam" ? "vision" : "youcam";
  return !candidatesOf(person, "faceShape").some((item) => item.source === other && item.value === resolved.value);
}

/** One shared definition of a long face: the shape reads "long", or the face is at least this much taller than wide. */
export const LONG_FACE_RATIO = 1.42;

export function known<T>(value: T, source: FieldSource, confidence = 0.9): Reading<T> {
  return { value, confidence, source };
}

export function unknownReading<T>(source: FieldSource): Reading<T> {
  return { value: "unknown", confidence: 0, source };
}

export function lowConfidence<T>(reading: Reading<T>): boolean {
  return reading.value === "unknown" || reading.confidence < 0.7;
}

export function parsePerson(value: unknown): Person | null {
  const parsed = personSchema.safeParse(withLengthDefaults(value));
  return parsed.success ? parsed.data : null;
}

function withLengthDefaults(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const person = value as { hair?: Record<string, unknown> };
  if (!person.hair) return value;
  const blank = () => ({ value: "unknown", confidence: 0, source: "youcam" });
  return { ...person, hair: { frontCm: blank(), topCm: blank(), sideCm: blank(), ...person.hair } };
}

export function unknownPerson(source: FieldSource): Person {
  return {
    sex: unknownReading(source),
    face: {
      shape: unknownReading(source),
      aspectRatio: unknownReading(source),
      cheekbones: unknownReading(source),
      jaw: unknownReading(source),
      forehead: unknownReading(source),
      asymmetry: unknownReading(source),
    },
    head: { occipital: unknownReading(source) },
    hair: {
      curl: unknownReading(source),
      density: unknownReading(source),
      diameter: unknownReading(source),
      growthDirection: unknownReading(source),
      cowlickFront: unknownReading(source),
      cowlickCrown: unknownReading(source),
      hairline: unknownReading(source),
      damage: unknownReading(source),
      lengthCm: unknownReading(source),
      frontCm: unknownReading(source),
      topCm: unknownReading(source),
      sideCm: unknownReading(source),
      frizz: unknownReading(source),
    },
    hairLoss: {
      temples: unknownReading(source),
      crown: unknownReading(source),
      diffuse: unknownReading(source),
    },
    facialHair: { style: unknownReading(source), growth: unknownReading(source) },
    body: { neck: unknownReading(source), shoulders: unknownReading(source) },
    context: { glasses: unknownReading(source) },
    colour: {
      level: unknownReading(source),
      name: unknownReading(source),
      skinTone: unknownReading(source),
      undertone: unknownReading(source),
    },
  };
}

/** What a live lean YouCam analysis returned for the reference client (live runs v3 to v7): hair density only, every other field unknown until vision fills it. */
export function recordedYouCamPerson(): Person {
  const person = unknownPerson("youcam");
  person.hair.density = known(3, "youcam", 0.85);
  return person;
}

export function fixturePerson(source: FieldSource = "fixture"): Person {
  return {
    sex: known("unspecified", source, 0.2),
    face: {
      shape: known("oval", source),
      aspectRatio: known(1.45, source),
      cheekbones: known("average", source),
      jaw: known("average", source),
      forehead: known("average", source),
      asymmetry: known("mild", source),
    },
    head: { occipital: known("round", source) },
    hair: {
      curl: known("2b", source),
      density: known(3, source),
      diameter: known("medium", source),
      growthDirection: known("side", source),
      cowlickFront: known(false, source),
      cowlickCrown: known(false, source),
      hairline: known("average", source),
      damage: known("none", source),
      lengthCm: known(28, source),
      frontCm: unknownReading(source),
      topCm: unknownReading(source),
      sideCm: unknownReading(source),
      frizz: known("slight", source),
    },
    hairLoss: {
      temples: known("none", source),
      crown: known("none", source),
      diffuse: known("none", source),
    },
    facialHair: { style: known("none", source), growth: known("full", source) },
    body: { neck: known("average", source), shoulders: known("average", source) },
    context: { glasses: known(false, source) },
    colour: {
      level: known(4, source),
      name: known("brown", source),
      skinTone: known("medium", source),
      undertone: known("neutral", source),
    },
  };
}

export function jordanPerson(): Person {
  const person = fixturePerson("persona");
  person.hair.curl = known("3b", "persona");
  person.hair.lengthCm = known(8, "persona");
  person.hair.density = known(3, "persona");
  return person;
}

export function ninaPerson(): Person {
  const person = fixturePerson("persona");
  person.hair.curl = known("2b", "persona");
  person.hair.lengthCm = known(32, "persona");
  person.face.shape = known("oval", "persona");
  return person;
}

export function mayaPerson(): Person {
  const person = fixturePerson("persona");
  person.hair.curl = known("2b", "persona");
  person.hair.lengthCm = known(42, "persona");
  person.colour.level = known(4, "persona");
  person.colour.name = known("brown", "persona");
  return person;
}

export function adrianPerson(): Person {
  return fixturePerson("persona");
}
