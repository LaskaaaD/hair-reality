import type { ServiceKind } from "../../shared/consultations.js";
import {
  hairProfileCapabilities,
  type HairProfile,
  type HairProfileCapability,
  type HairProfileSlot,
} from "../../shared/hair-profile.js";
import {
  FRIZZ_TERMS,
  HAIR_DENSITY_TERMS,
  HAIR_LENGTH_TERMS,
  HAIR_TYPE_MAPPINGS,
  HAIR_TYPE_TERMS,
  storageRolesFor,
} from "../providers/youcam/contract.js";

const ACTIVE_JOBS = new Set(["QUEUED", "CLAIMED", "UPLOADING", "SUBMITTING", "RUNNING", "SUBMISSION_UNCERTAIN"]);
const RETAKE_CODES = new Set(["RETAKE_REQUIRED", "INVALID_PHOTO"]);

const LENGTH_SPANS: Record<(typeof HAIR_LENGTH_TERMS)[number], { from: string; to: string | null; openEnded: boolean }> = {
  "above the ears": { from: "above the ears", to: "above the ears", openEnded: false },
  "ear length": { from: "ear length", to: "ear length", openEnded: false },
  "ear length or longer": { from: "ear length", to: null, openEnded: true },
  "short hair": { from: "short hair", to: "short hair", openEnded: false },
  "short hair or longer": { from: "short hair", to: null, openEnded: true },
  "above chest": { from: "above chest", to: "above chest", openEnded: false },
  "above chest or longer": { from: "above chest", to: null, openEnded: true },
  "long hair": { from: "long hair", to: "long hair", openEnded: false },
};

export type ProfileAsset = {
  id: string;
  role: string;
  deleted: boolean;
  createdAt: string;
};

export type ProfileObservation = {
  capability: string;
  source: string;
  values: Record<string, unknown>;
  uncertainty: string | null;
  observedAt: string;
  inputAssetIds: string[];
};

export type ProfileJob = {
  capability: string;
  state: string;
  errorCode: string | null;
  mode: "fixture" | "recorded_demo" | "live";
  sourceAssetIds: string[];
  createdAt: string;
};

export type HairProfileInput = {
  presentation: HairProfile["presentation"];
  services: readonly ServiceKind[];
  assets: readonly ProfileAsset[];
  observations: readonly ProfileObservation[];
  jobs: readonly ProfileJob[];
};

type HairValue = NonNullable<HairProfileSlot["value"]> & { uncertainty: string | null };

export function assembleHairProfile(input: HairProfileInput): HairProfile {
  const required = new Set(requiredCapabilities(input.services));
  const current = currentAssets(input.assets);
  const slots = hairProfileCapabilities.map((capability) => slot(input, capability, required.has(capability), current));
  return {
    presentation: input.presentation,
    schedule: slots.flatMap((item) => item.schedule ? [item.capability] : []),
    slots: slots.map(({ schedule: _schedule, ...item }) => item),
  };
}

export function requiredCapabilities(services: readonly ServiceKind[]): HairProfileCapability[] {
  if (!services.includes("haircut")) return [];
  return [...hairProfileCapabilities];
}

function slot(
  input: HairProfileInput,
  capability: HairProfileCapability,
  required: boolean,
  current: Map<string, string>,
): HairProfileSlot & { schedule: boolean } {
  const assetIds = assetIdsFor(capability, current);
  const observation = latestObservation(input, capability, assetIds);
  const normalized = observation ? normalize(capability, observation.values) : null;
  if (observation && normalized?.ok) {
    return {
      capability,
      required,
      status: "current",
      freshness: "current",
      source: observation.source === "fixture" ? "fixture" : "youcam",
      uncertainty: joinUncertainty(normalized.value.uncertainty, observation.uncertainty),
      observedAt: observation.observedAt,
      evidenceAssetIds: observation.inputAssetIds,
      nextAction: "none",
      value: stripUncertainty(normalized.value),
      schedule: false,
    };
  }
  if (observation) {
    return unknown(
      capability,
      required,
      "stylist_review",
      normalized && !normalized.ok && normalized.conflict ? "conflicting provider labels" : null,
      false,
    );
  }
  const job = latestJob(input, capability, assetIds);
  if (job && ACTIVE_JOBS.has(job.state)) return unknown(capability, required, "none", null, false);
  if (job && job.state === "FAILED" && job.errorCode !== null && RETAKE_CODES.has(job.errorCode)) {
    return {
      capability,
      required,
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
  if (job) return unknown(capability, required, "stylist_review", null, false);
  if (!required) return unknown(capability, required, "none", null, false);
  if (!assetIds) return unknown(capability, required, "stylist_review", null, false);
  return unknown(capability, required, "stylist_review", null, true);
}

function unknown(
  capability: HairProfileCapability,
  required: boolean,
  nextAction: HairProfileSlot["nextAction"],
  uncertainty: string | null,
  schedule: boolean,
): HairProfileSlot & { schedule: boolean } {
  return {
    capability,
    required,
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

function latestObservation(
  input: HairProfileInput,
  capability: HairProfileCapability,
  assetIds: string[] | null,
): ProfileObservation | null {
  if (!assetIds) return null;
  const youcam = matchingObservations(input.observations, capability, assetIds, "youcam");
  if (youcam) return youcam;
  if (input.presentation !== "fixture") return null;
  return matchingObservations(input.observations, capability, assetIds, "fixture");
}

function matchingObservations(
  observations: readonly ProfileObservation[],
  capability: string,
  assetIds: readonly string[],
  source: string,
): ProfileObservation | null {
  return observations
    .filter((item) => item.capability === capability && item.source === source && sameIds(item.inputAssetIds, assetIds))
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0] ?? null;
}

function latestJob(input: HairProfileInput, capability: string, assetIds: string[] | null): ProfileJob | null {
  if (!assetIds) return null;
  return input.jobs
    .filter((job) => job.capability === capability && sameIds(job.sourceAssetIds, assetIds) && jobVisible(input.presentation, job.mode))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

function jobVisible(presentation: HairProfile["presentation"], mode: ProfileJob["mode"]): boolean {
  return presentation === "fixture" || mode !== "fixture";
}

function currentAssets(assets: readonly ProfileAsset[]): Map<string, string> {
  const newest = new Map<string, ProfileAsset>();
  for (const asset of assets) {
    if (asset.deleted) continue;
    const prior = newest.get(asset.role);
    if (!prior || Date.parse(asset.createdAt) >= Date.parse(prior.createdAt)) newest.set(asset.role, asset);
  }
  return new Map([...newest].map(([role, asset]) => [role, asset.id]));
}

function assetIdsFor(capability: HairProfileCapability, current: Map<string, string>): string[] | null {
  const ids: string[] = [];
  for (const role of storageRolesFor(capability)) {
    const id = current.get(role);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalize(capability: HairProfileCapability, values: Record<string, unknown>): { ok: true; value: HairValue } | { ok: false; conflict: boolean } {
  if (capability === "hair-type") return normalizeType(values);
  if (capability === "hair-length") return normalizeLength(values);
  if (capability === "hair-density") return normalizeDensity(values);
  return normalizeFrizz(values);
}

function normalizeType(values: Record<string, unknown>): { ok: true; value: HairValue } | { ok: false; conflict: boolean } {
  const term = allowed(values.term, HAIR_TYPE_TERMS);
  const mapping = allowed(values.mapping, HAIR_TYPE_MAPPINGS);
  if (!term && !mapping) return { ok: false, conflict: false };
  const parts = mapping?.split(" to ") ?? [];
  const from = parts[0];
  const to = parts[1];
  const unknown = [term ? null : "term", mapping ? null : "mapping"].filter((item): item is string => item !== null);
  return {
    ok: true,
    value: {
      label: term ?? mapping ?? "",
      rawTerm: term,
      providerMapping: mapping,
      range: mapping && from && to ? { kind: "categories", from, to, openEnded: false } : null,
      uncertainty: unknown.length > 0 ? unknown.join(",") : null,
    },
  };
}

function normalizeLength(values: Record<string, unknown>): { ok: true; value: HairValue } | { ok: false; conflict: boolean } {
  const term = allowed(values.term, HAIR_LENGTH_TERMS);
  if (!term) return { ok: false, conflict: false };
  return {
    ok: true,
    value: {
      label: term,
      rawTerm: term,
      providerMapping: null,
      range: { kind: "categories", ...LENGTH_SPANS[term] },
      uncertainty: null,
    },
  };
}

function normalizeDensity(values: Record<string, unknown>): { ok: true; value: HairValue } | { ok: false; conflict: boolean } {
  const term = allowed(values.term, HAIR_DENSITY_TERMS);
  if (!term) return { ok: false, conflict: false };
  const mapping = typeof values.mapping === "string" && /^-?\d+(\.\d+)?$/.test(values.mapping) ? values.mapping : null;
  return {
    ok: true,
    value: {
      label: term,
      rawTerm: term,
      providerMapping: mapping,
      range: null,
      uncertainty: mapping || values.mapping === undefined ? null : "mapping",
    },
  };
}

function normalizeFrizz(values: Record<string, unknown>): { ok: true; value: HairValue } | { ok: false; conflict: boolean } {
  const term = allowed(values.term, FRIZZ_TERMS);
  const index = values.mapping === 0 || values.mapping === 1 || values.mapping === 2 || values.mapping === 3 ? values.mapping : null;
  const mapped = index === null ? null : FRIZZ_TERMS[index];
  if (term && mapped && term !== mapped) return { ok: false, conflict: true };
  const label = term ?? mapped;
  if (!label) return { ok: false, conflict: false };
  return {
    ok: true,
    value: {
      label,
      rawTerm: term,
      providerMapping: index === null ? null : String(index),
      range: null,
      uncertainty: term ? null : "term",
    },
  };
}

function allowed<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === "string" && choices.includes(value as T) ? value as T : null;
}

function joinUncertainty(normalized: string | null, stored: string | null): string | null {
  const parts = [normalized, stored].filter((item): item is string => item !== null && item.length > 0);
  return parts.length > 0 ? parts.join(",") : null;
}

function stripUncertainty(value: HairValue): NonNullable<HairProfileSlot["value"]> {
  return {
    label: value.label,
    rawTerm: value.rawTerm,
    providerMapping: value.providerMapping,
    range: value.range,
  };
}
