import type { CurlCode, DensityLevel, FaceName, FieldSource, Person } from "./person.js";
import { fixturePerson, known, unknownPerson } from "./person.js";

export function fixtureAnalysis(): Person {
  return fixturePerson("fixture");
}

export function unknownAnalysis(source: Person["sex"]["source"]): Person {
  return unknownPerson(source);
}

export function applyEvidence(current: Person, capability: string, values: Record<string, unknown>): Person {
  const next = structuredClone(current);
  const source: FieldSource = "youcam";
  if (capability === "hair-length") {
    const cm = lengthCm(values.term);
    if (cm !== null) next.hair.lengthCm = known(cm, source, 0.45);
  }
  if (capability === "hair-type") {
    const curl = curlFrom(values.mapping);
    if (curl) next.hair.curl = known(curl, source, 0.85);
  }
  if (capability === "hair-density") {
    const density = densityFrom(values.term);
    if (density) next.hair.density = known(density, source, 0.85);
  }
  if (capability === "hair-frizziness") {
    const frizz = frizzFrom(values.term);
    if (frizz) next.hair.frizz = known(frizz, source, 0.8);
  }
  if (capability === "face-attributes") {
    const shape = faceFrom(values.faceshape);
    if (shape) next.face.shape = known(shape, source, 0.8);
    const youcamShape = text(values.faceshape);
    if (youcamShape) next.face.youcamShape = known(youcamShape, source, 0.8);
    const ratio = aspectRatio(values.faceAspectRatio);
    if (ratio !== null) next.face.aspectRatio = known(ratio, source, 0.75);
    const cheek = text(values.cheekbones);
    if (cheek === "low" || cheek === "average" || cheek === "high") next.face.cheekbones = known(cheek, source, 0.7);
    const jaw = text(values.noseToLipToChin);
    if (jaw === "narrow" || jaw === "average" || jaw === "wide") next.face.jaw = known(jaw, source, 0.65);
  }
  if (capability === "facial-color-tones") {
    const name = text(values.hair_color_name);
    if (name) {
      next.colour.name = known(name, source, 0.8);
      const level = colourLevel(name);
      if (level !== null) next.colour.level = known(level, source, 0.7);
    }
    const skin = text(values.skin_color);
    if (skin) next.colour.skinTone = known(skinTone(skin), source, 0.6);
  }
  return next;
}

function lengthCm(value: unknown): number | null {
  if (value === "above the ears") return 2;
  if (value === "ear length" || value === "ear length or longer") return 6;
  if (value === "short hair" || value === "short hair or longer") return 12;
  if (value === "above chest" || value === "above chest or longer") return 25;
  if (value === "long hair") return 40;
  return null;
}

function curlFrom(value: unknown): CurlCode | null {
  if (value === "1 to 2a") return "2a";
  if (value === "2a to 2b") return "2b";
  if (value === "2b to 2c") return "2c";
  if (value === "2c to 3a") return "3a";
  if (value === "3a to 3b") return "3b";
  if (value === "3b to 3c") return "3c";
  if (value === "3c to 4a") return "4a";
  if (value === "4a to 4b") return "4b";
  if (value === "4b to 4c") return "4c";
  return null;
}

function densityFrom(value: unknown): DensityLevel | null {
  if (value === "Extremely Low Density") return 1;
  if (value === "Low Density") return 2;
  if (value === "Medium Density") return 3;
  if (value === "High Density") return 4;
  return null;
}

function frizzFrom(value: unknown): Person["hair"]["frizz"]["value"] | null {
  if (value === "Not Frizzy") return "none";
  if (value === "Slightly Frizzy") return "slight";
  if (value === "Frizzy") return "frizzy";
  if (value === "Extreme Frizzy") return "extreme";
  return null;
}

function faceFrom(value: unknown): FaceName | null {
  if (typeof value !== "string") return null;
  const textValue = value.toLowerCase();
  if (textValue.includes("oval")) return "oval";
  if (textValue.includes("round")) return "round";
  if (textValue.includes("square")) return "square";
  if (textValue.includes("heart") || textValue.includes("invtriangle") || textValue.includes("inverted") || textValue.includes("diamond")) return "heart";
  if (textValue.includes("triangle")) return "square";
  if (textValue.includes("long") || textValue.includes("oblong") || textValue.includes("rectangle")) return "long";
  return null;
}

function colourLevel(name: string): number | null {
  const textValue = name.toLowerCase();
  if (textValue.includes("platinum")) return 10;
  if (textValue.includes("gray") || textValue.includes("grey") || textValue.includes("rose")) return 8;
  if (textValue.includes("blonde") || textValue.includes("blond")) return 7;
  if (textValue.includes("red") || textValue.includes("copper")) return 6;
  if (textValue.includes("brown")) return textValue.includes("dark") ? 3 : 4;
  if (textValue.includes("black")) return 1;
  return null;
}

function skinTone(hex: string): "light" | "medium" | "deep" {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return "medium";
  const value = Number.parseInt(match[1], 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const luma = (red + green + blue) / 3;
  if (luma > 180) return "light";
  if (luma < 90) return "deep";
  return "medium";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** YouCam gives face_aspect_ratio as [width, length], e.g. [1000, 1431]; the ratio is length over width. */
function aspectRatio(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number" && value[0] > 0) {
    const ratio = value[1] / value[0];
    return Number.isFinite(ratio) ? ratio : null;
  }
  return null;
}
