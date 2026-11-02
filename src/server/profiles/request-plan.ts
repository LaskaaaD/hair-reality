import type { AnalysisPlan } from "../../shared/face-colour.js";
import { faceColourCapabilities } from "../../shared/face-colour.js";
import { hairProfileCapabilities } from "../../shared/hair-profile.js";
import { assembleFaceColour, type SuggestionChoices } from "./face-colour.js";
import { assembleHairProfile, type HairProfileInput } from "./hair-profile.js";

const SCALP = new Set<string>(hairProfileCapabilities);

export function buildRequestPlan(input: HairProfileInput, suggestions: SuggestionChoices): AnalysisPlan {
  const hair = assembleHairProfile(input);
  const face = assembleFaceColour(input, suggestions);
  return {
    presentation: input.presentation,
    suggestions,
    coverage: [...faceColourCapabilities],
    schedule: [...hair.schedule, ...face.schedule],
    slots: face.slots,
  };
}

export function includesScalpAnalysis(schedule: readonly string[]): boolean {
  return schedule.some((capability) => SCALP.has(capability));
}
