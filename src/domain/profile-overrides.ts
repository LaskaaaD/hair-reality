import type { CurlCode, DensityLevel, FaceName, Person } from "./person.js";
import { fixturePerson, known } from "./person.js";

export type ProfileOverrideMap = Record<string, string>;

const SKIP = new Set(["Not sure", ""]);

const HAIR_TYPE: Record<string, CurlCode> = {
  Straight: "1",
  Wavy: "2b",
  Curly: "3b",
  Coily: "4a",
};

const DENSITY: Record<string, DensityLevel> = {
  Low: 1,
  "Medium-light": 2,
  Medium: 3,
  High: 4,
};

const FRIZZ: Record<string, Person["hair"]["frizz"]["value"]> = {
  None: "none",
  Light: "slight",
  Moderate: "frizzy",
  High: "extreme",
};

const FACE: Record<string, FaceName> = {
  Oval: "oval",
  Round: "round",
  Square: "square",
  Heart: "heart",
};

const BEARD: Record<string, Person["facialHair"]["style"]["value"]> = {
  "Clean shaven": "none",
  Stubble: "stubble",
  "Short beard": "short",
  "Medium beard": "medium",
  "Long beard": "long",
};

const LENGTH_CM: Record<string, { topCm: number; lengthCm: number }> = {
  Short: { topCm: 4, lengthCm: 8 },
  Medium: { topCm: 8, lengthCm: 16 },
  Long: { topCm: 16, lengthCm: 32 },
};

/** Apply goal-step "Fix" overrides onto analysis for ranking (source: answer). */
export function applyProfileOverrides(person: Person, overrides: ProfileOverrideMap): Person {
  if (Object.keys(overrides).length === 0) return person;
  const next = structuredClone(person);
  const source = "answer" as const;

  for (const [fieldId, raw] of Object.entries(overrides)) {
    const label = raw.trim();
    if (SKIP.has(label)) continue;

    if (fieldId === "hairType") {
      const curl = HAIR_TYPE[label];
      if (curl) next.hair.curl = known(curl, source, 0.95);
      continue;
    }
    if (fieldId === "density") {
      const density = DENSITY[label];
      if (density) next.hair.density = known(density, source, 0.95);
      continue;
    }
    if (fieldId === "length") {
      const band = LENGTH_CM[label];
      if (band) {
        next.hair.topCm = known(band.topCm, source, 0.9);
        next.hair.lengthCm = known(band.lengthCm, source, 0.9);
      }
      continue;
    }
    if (fieldId === "frizz") {
      const frizz = FRIZZ[label];
      if (frizz) next.hair.frizz = known(frizz, source, 0.9);
      continue;
    }
    if (fieldId === "faceShape") {
      const shape = FACE[label];
      if (shape) next.face.shape = known(shape, source, 0.9);
      continue;
    }
    if (fieldId === "beard") {
      const style = BEARD[label];
      if (style) next.facialHair.style = known(style, source, 0.9);
    }
  }

  return next;
}

export function personForRanking(analysis: Person | null, overrides: ProfileOverrideMap): Person {
  const base = analysis ?? fixturePerson();
  return applyProfileOverrides(base, overrides);
}
