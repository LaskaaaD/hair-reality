import type { CatalogueEntry, StoredTarget } from "../../shared/catalogue.js";
import type { ColourHistory, ConfirmedPriority, PreferencesInput } from "../../shared/client-brief.js";
import type { ServiceKind } from "../../shared/consultations.js";
import type { AnalysisPlan } from "../../shared/face-colour.js";
import type { HairProfile, HairProfileCapability, HairProfileSlot } from "../../shared/hair-profile.js";
import {
  coarseLengthInterval,
  densityGrades,
  frizzGrades,
  lengthIntervalFromTerm,
  textureFamiliesFromMapping,
  type DensityGrade,
  type FrizzGrade,
  type HairEvidence,
  type RealityCandidate,
  type RealityInput,
  type RealityTarget,
  type TextureFamily,
} from "../../shared/reality-engine.js";

const HAIR_DIMENSIONS = {
  "hair-length": "length",
  "hair-type": "texture",
  "hair-density": "density",
  "hair-frizziness": "frizz",
} as const;

export type RealityParts = {
  services: readonly ServiceKind[];
  profile: HairProfile | null;
  plan: AnalysisPlan | null;
  history: ColourHistory | null;
  preferences: PreferencesInput | null;
  targets: readonly StoredTarget[];
  catalogue: readonly CatalogueEntry[];
};

export function assembleRealityInput(parts: RealityParts): RealityInput {
  const goals = parts.preferences?.goals ?? [];
  const haircut = parts.services.includes("haircut");
  return {
    services: [...parts.services],
    hair: haircut ? hairEvidence(parts.profile) : null,
    beard: parts.services.includes("beard") ? beardEvidence(parts.targets) : null,
    face: faceEvidence(parts.plan),
    tones: toneEvidence(parts.plan),
    history: parts.services.includes("colour") ? parts.history : null,
    maintenance: parts.preferences?.maintenance ?? null,
    priorities: parts.preferences?.priorities ?? [],
    targets: parts.targets
      .filter((target) => parts.services.includes(target.serviceKind))
      .map((target) => toTarget(target, goals, faceEvidence(parts.plan) !== null, parts.catalogue, parts.preferences?.priorities ?? [])),
    candidates: parts.catalogue
      .filter((entry) => parts.services.includes(entry.serviceKind))
      .map(toCandidate),
    gaps: haircut ? hairGaps(parts.profile) : [],
  };
}

function hairEvidence(profile: HairProfile | null): HairEvidence {
  return {
    length: lengthEvidence(profile),
    textureFamilies: textureEvidence(profile).families,
    textureEvidenceRefs: textureEvidence(profile).refs,
    densityGrade: densityEvidence(profile).grade,
    densityEvidenceRefs: densityEvidence(profile).refs,
    frizz: frizzEvidence(profile).grade,
    frizzEvidenceRefs: frizzEvidence(profile).refs,
    conflicts: conflictEvidence(profile),
  };
}

function lengthEvidence(profile: HairProfile | null): HairEvidence["length"] {
  const item = usableSlot(profile, "hair-length");
  const interval = item?.value ? lengthIntervalFromTerm(item.value.label) : null;
  if (!item || !interval) return null;
  return { ...interval, evidenceRefs: item.evidenceAssetIds };
}

function textureEvidence(profile: HairProfile | null): { families: readonly TextureFamily[] | null; refs: string[] } {
  const item = usableSlot(profile, "hair-type");
  const families = item?.value?.providerMapping ? textureFamiliesFromMapping(item.value.providerMapping) : null;
  return { families, refs: item?.evidenceAssetIds.slice() ?? [] };
}

function densityEvidence(profile: HairProfile | null): { grade: DensityGrade | null; refs: string[] } {
  const item = usableSlot(profile, "hair-density");
  const label = item?.value?.label ?? "";
  const grade = (densityGrades as readonly string[]).includes(label) ? label as DensityGrade : null;
  return { grade, refs: item?.evidenceAssetIds.slice() ?? [] };
}

function frizzEvidence(profile: HairProfile | null): { grade: FrizzGrade | null; refs: string[] } {
  const item = usableSlot(profile, "hair-frizziness");
  const label = item?.value?.label ?? "";
  const grade = (frizzGrades as readonly string[]).includes(label) ? label as FrizzGrade : null;
  return { grade, refs: item?.evidenceAssetIds.slice() ?? [] };
}

function conflictEvidence(profile: HairProfile | null): HairEvidence["conflicts"] {
  return Object.entries(HAIR_DIMENSIONS).flatMap(([capability, dimension]) => {
    const item = profile?.slots.find((slot) => slot.capability === capability);
    if (!item || !conflicting(item)) return [];
    return [{ dimension, evidenceRefs: item.evidenceAssetIds }];
  });
}

function hairGaps(profile: HairProfile | null): RealityInput["gaps"] {
  return Object.entries(HAIR_DIMENSIONS).flatMap(([capability, dimension]) => {
    const item = profile?.slots.find((slot) => slot.capability === capability) ?? null;
    if (usableSlot(profile, capability as HairProfileCapability)) return [];
    return [{
      service: "haircut" as const,
      dimension,
      nextAction: item?.nextAction === "retake" ? "retake" as const : "stylist_review" as const,
      evidenceRefs: item?.evidenceAssetIds ?? [],
    }];
  });
}

function beardEvidence(targets: readonly StoredTarget[]): RealityInput["beard"] {
  const stored = targets.find((target) => target.serviceKind === "beard");
  const fullness = stored?.confirmed.referenceFullness;
  const length = stored?.confirmed.length;
  const reportedFullness = fullness === "low" || fullness === "moderate" || fullness === "high" ? fullness : null;
  const reportedLength = length === "short" || length === "medium" || length === "long" ? coarseLengthInterval(length) : null;
  const inspiration = stored?.inspirationAssetId ?? null;
  return {
    fullness: reportedFullness,
    length: reportedLength,
    evidenceRefs: [
      ...(reportedFullness || reportedLength ? ["beard-report"] : []),
      ...(inspiration ? [inspiration] : []),
    ],
  };
}

function faceEvidence(plan: AnalysisPlan | null): RealityInput["face"] {
  const item = plan?.slots.find((slot) => slot.capability === "face-attributes");
  if (!item || item.status !== "current" || !item.value || !("faceShape" in item.value)) return null;
  return { shape: item.value.faceShape, evidenceRefs: item.evidenceAssetIds };
}

function toneEvidence(plan: AnalysisPlan | null): RealityInput["tones"] {
  const item = plan?.slots.find((slot) => slot.capability === "facial-color-tones");
  if (!item || item.status !== "current" || !item.value || !("hairColorName" in item.value) || !item.value.hairColorName) return null;
  return { hairColorName: item.value.hairColorName, evidenceRefs: item.evidenceAssetIds };
}

function fullnessForEngine(stored: StoredTarget): "low" | "high" | null {
  if (stored.serviceKind !== "haircut") return null;
  const fullness = stored.confirmed.referenceFullness;
  return fullness === "high" || fullness === "low" ? fullness : null;
}

function toTarget(
  stored: StoredTarget,
  goals: readonly string[],
  faceAvailable: boolean,
  catalogue: readonly CatalogueEntry[],
  priorities: readonly ConfirmedPriority[],
): RealityTarget {
  const length = stored.serviceKind === "beard" ? null : stored.confirmed.length;
  const texture = stored.confirmed.texture;
  const lengthLabel = length && length !== "unknown" ? length : null;
  const linked = catalogue.find((entry) => entry.id === stored.candidateId) ?? null;
  return {
    service: stored.serviceKind,
    length: lengthLabel ? coarseLengthInterval(lengthLabel) : null,
    lengthLabel,
    texture: texture && texture !== "unknown" ? texture : null,
    shade: stored.confirmed.shade ?? null,
    apparentFullness: fullnessForEngine(stored),
    fullnessEvidenceRefs: stored.serviceKind === "haircut" && (stored.confirmed.referenceFullness === "high" || stored.confirmed.referenceFullness === "low") ? ["target"] : [],
    fringe: fringeConstraint(stored.serviceKind, priorities),
    top: null,
    side: null,
    maintenance: linked && linked.serviceKind === stored.serviceKind ? targetMaintenance(linked) : null,
    proportionRequested: (stored.serviceKind === "haircut" && goals.some((goal) => /\b(proportion|silhouette)\b/i.test(goal))) || (stored.serviceKind === "beard" && faceAvailable),
    shadeSuggestionsRequested: stored.serviceKind === "colour" && (Boolean(stored.confirmed.shade) || goals.some((goal) => /\bshade\b/i.test(goal))),
    unsupported: stored.unsupported,
    limitationAcknowledged: false,
    evidenceRefs: ["target"],
  };
}

function toCandidate(entry: CatalogueEntry): RealityCandidate {
  return {
    id: entry.id,
    service: entry.serviceKind,
    enabled: true,
    preview: "supported",
    length: entry.length,
    texture: entry.texture,
    shade: entry.configuration.preset,
    maintenance: catalogueMaintenance(entry),
    apparentFullness: "unknown",
    labels: [entry.title, entry.length, entry.texture, entry.configuration.preset ?? ""].filter((label) => label !== "" && label !== "unknown"),
    editorial: true,
  };
}

function targetMaintenance(entry: CatalogueEntry): "low" | "moderate" | "high" | null {
  const maintenance = catalogueMaintenance(entry);
  return maintenance === "unknown" ? null : maintenance;
}

function catalogueMaintenance(entry: CatalogueEntry): "low" | "moderate" | "high" | "unknown" {
  return entry.maintenance ?? "unknown";
}

function fringeConstraint(service: ServiceKind, priorities: readonly ConfirmedPriority[]): string | null {
  if (service !== "haircut") return null;
  const match = priorities.find((priority) =>
    priority.confirmed
    && priority.category === "must_keep"
    && (priority.scope === "all" || priority.scope === "haircut")
    && /\bfringe\b/i.test(priority.text));
  return match?.text ?? null;
}

function usableSlot(profile: HairProfile | null, capability: HairProfileCapability): HairProfileSlot | null {
  const item = profile?.slots.find((slot) => slot.capability === capability) ?? null;
  if (!item || item.status !== "current" || item.value === null || conflicting(item)) return null;
  return item;
}

function conflicting(slot: HairProfileSlot): boolean {
  return (slot.uncertainty ?? "").includes("conflicting");
}
