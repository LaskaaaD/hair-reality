import type { FaceColourCapability, FaceColourSlot } from "../../shared/face-colour.js";
import { faceColourCapabilities } from "../../shared/face-colour.js";
import type { HairProfileInput, ProfileAsset, ProfileJob, ProfileObservation } from "./hair-profile.js";

const ACTIVE_JOBS = new Set(["QUEUED", "CLAIMED", "UPLOADING", "SUBMITTING", "RUNNING", "SUBMISSION_UNCERTAIN"]);
const RETAKE_CODES = new Set(["RETAKE_REQUIRED", "INVALID_PHOTO"]);
export type SuggestionChoices = {
  silhouette: boolean;
  tones: boolean;
};

export function assembleFaceColour(input: HairProfileInput, suggestions: SuggestionChoices): {
  slots: FaceColourSlot[];
  schedule: FaceColourCapability[];
} {
  const current = currentFace(input.assets);
  const slots = faceColourCapabilities.map((capability) => {
    const enabled = capability === "face-attributes" ? suggestions.silhouette : suggestions.tones;
    return slot(input, capability, enabled, current);
  });
  return {
    slots: slots.map(({ schedule: _schedule, ...item }) => item),
    schedule: slots.flatMap((item) => item.schedule ? [item.capability] : []),
  };
}

function slot(
  input: HairProfileInput,
  capability: FaceColourCapability,
  enabled: boolean,
  faceId: string | null,
): FaceColourSlot & { schedule: boolean } {
  const assetIds = faceId ? [faceId] : null;
  const observation = latestObservation(input, capability, assetIds);
  const value = observation ? present(capability, observation.values) : null;
  if (observation && value) {
    return {
      capability,
      enabled,
      status: "current",
      freshness: "current",
      source: observation.source === "fixture" ? "fixture" : "youcam",
      uncertainty: joinUncertainty(value.kind === "colour" ? value.unknown : null, observation.uncertainty),
      observedAt: observation.observedAt,
      evidenceAssetIds: observation.inputAssetIds,
      nextAction: "none",
      value: value.kind === "face" ? value.face : value.colour,
      schedule: false,
    };
  }
  if (!enabled) return empty(capability, false, "none", null, false);
  const job = latestJob(input, capability, assetIds);
  if (job && ACTIVE_JOBS.has(job.state)) return empty(capability, true, "none", null, false);
  if (job && job.state === "FAILED" && job.errorCode !== null && RETAKE_CODES.has(job.errorCode)) {
    return {
      capability,
      enabled: true,
      status: "retake",
      freshness: "unknown",
      source: null,
      uncertainty: null,
      observedAt: null,
      evidenceAssetIds: assetIds ?? [],
      nextAction: "retake",
      value: null,
      schedule: false,
    };
  }
  if (job || observation) return empty(capability, true, "stylist_review", "incomplete", false);
  if (!faceId) return empty(capability, true, "stylist_review", null, false);
  return empty(capability, true, "stylist_review", null, true);
}

function empty(
  capability: FaceColourCapability,
  enabled: boolean,
  nextAction: FaceColourSlot["nextAction"],
  uncertainty: string | null,
  schedule: boolean,
): FaceColourSlot & { schedule: boolean } {
  return {
    capability,
    enabled,
    status: "unknown",
    freshness: "unknown",
    source: null,
    uncertainty,
    observedAt: null,
    evidenceAssetIds: [],
    nextAction,
    value: null,
    schedule,
  };
}

type Presented =
  | { kind: "face"; face: Extract<FaceColourSlot["value"], { faceShape: string }> }
  | { kind: "colour"; colour: Exclude<FaceColourSlot["value"], { faceShape: string } | null>; unknown: string | null };

function present(capability: FaceColourCapability, values: Record<string, unknown>): Presented | null {
  if (capability === "face-attributes") {
    const face = faceValue(values);
    return face ? { kind: "face", face } : null;
  }
  const colour = colourValue(values);
  return colour.known ? { kind: "colour", colour: colour.value, unknown: colour.unknown } : null;
}

function faceValue(values: Record<string, unknown>): Extract<FaceColourSlot["value"], { faceShape: string }> | null {
  const shape = typeof values.faceshape === "string" && values.faceshape.trim() !== "" ? values.faceshape : null;
  const ratio = objectValue(values.facialratio);
  const horizontalThird = numberList(values.horizontalThird, 3) ?? (ratio ? numberList(ratio.horizontal_third ?? ratio.horizontalThird, 3) : null);
  const verticalFifth = numberList(values.verticalFifth, 5) ?? (ratio ? numberList(ratio.vertical_fifth ?? ratio.verticalFifth, 5) : null);
  const faceAspectRatio = numberList(values.faceAspectRatio, 2) ?? (ratio ? numberList(ratio.face_aspect_ratio ?? ratio.faceAspectRatio, 2) : null);
  if (!shape || !horizontalThird || !verticalFifth || !faceAspectRatio) return null;
  return { faceShape: shape, horizontalThird, verticalFifth, faceAspectRatio };
}

function colourValue(values: Record<string, unknown>): {
  known: boolean;
  unknown: string | null;
  value: Exclude<FaceColourSlot["value"], { faceShape: string } | null>;
} {
  const source = objectValue(values.color) ?? values;
  const unknown: string[] = [];
  const mapped = {
    skinColor: colourText(source.skin_color, unknown, "skinColor"),
    hairColor: colourText(source.hair_color, unknown, "hairColor"),
    hairColorName: colourText(source.hair_color_name, unknown, "hairColorName"),
    eyeColor: colourText(source.eye_color, unknown, "eyeColor"),
    eyeColorName: colourText(source.eye_color_name, unknown, "eyeColorName"),
    eyebrowColor: colourText(source.eyebrow_color, unknown, "eyebrowColor"),
    lipColor: colourText(source.lip_color, unknown, "lipColor"),
    unknown,
  };
  return { known: unknown.length === 0, unknown: unknown.length > 0 ? unknown.join(",") : null, value: mapped };
}

function colourText(value: unknown, unknown: string[], field: string): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  unknown.push(field);
  return null;
}

function numberList(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  if (!value.every((item) => typeof item === "number" && Number.isInteger(item))) return null;
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function currentFace(assets: readonly ProfileAsset[]): string | null {
  let newest: ProfileAsset | null = null;
  for (const asset of assets) {
    if (asset.deleted || asset.role !== "current_face") continue;
    if (!newest || Date.parse(asset.createdAt) >= Date.parse(newest.createdAt)) newest = asset;
  }
  return newest?.id ?? null;
}

function latestObservation(input: HairProfileInput, capability: string, assetIds: string[] | null): ProfileObservation | null {
  if (!assetIds) return null;
  const youcam = matching(input.observations, capability, assetIds, "youcam");
  if (youcam) return youcam;
  if (input.presentation !== "fixture") return null;
  return matching(input.observations, capability, assetIds, "fixture");
}

function matching(observations: readonly ProfileObservation[], capability: string, assetIds: readonly string[], source: string): ProfileObservation | null {
  return observations
    .filter((item) => item.capability === capability && item.source === source && sameIds(item.inputAssetIds, assetIds))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
}

function latestJob(input: HairProfileInput, capability: string, assetIds: string[] | null): ProfileJob | null {
  if (!assetIds) return null;
  return input.jobs
    .filter((job) => job.capability === capability && sameIds(job.sourceAssetIds, assetIds) && (input.presentation === "fixture" || job.mode !== "fixture"))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function joinUncertainty(normalized: string | null, stored: string | null): string | null {
  const parts = [normalized, stored].filter((item): item is string => item !== null && item.length > 0);
  return parts.length > 0 ? parts.join(",") : null;
}
