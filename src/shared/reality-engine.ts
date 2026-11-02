import type { ColourHistory, ConfirmedPriority } from "./client-brief.js";
import type { ServiceKind } from "./consultations.js";

export const ENGINE_VERSION = "reality-engine-2026-10-12";
export const RULE_VERSION = "rc-2026-10-12";

export const lengthPoints = ["above the ears", "ear length", "short hair", "above chest", "long hair"] as const;
export type LengthPoint = (typeof lengthPoints)[number];
export type LengthInterval = { from: LengthPoint; to: LengthPoint | null };

export const coarseLengths = ["short", "medium", "long"] as const;
export type CoarseLength = (typeof coarseLengths)[number];
export const textureFamilies = ["straight", "wavy", "curly"] as const;
export type TextureFamily = (typeof textureFamilies)[number];
export const densityGrades = ["Extremely Low Density", "Low Density", "Medium Density", "High Density"] as const;
export type DensityGrade = (typeof densityGrades)[number];
export const frizzGrades = ["Not Frizzy", "Slightly Frizzy", "Frizzy", "Extreme Frizzy"] as const;
export type FrizzGrade = (typeof frizzGrades)[number];

export const ruleIds = [
  "RC-001", "RC-002", "RC-003", "RC-004", "RC-005", "RC-006", "RC-007", "RC-008",
  "RC-009", "RC-010", "RC-011", "RC-012", "RC-013", "RC-014", "RC-015", "RC-016",
] as const;
export type RuleId = (typeof ruleIds)[number];

export type FindingOutcome = "compatible" | "potential_mismatch" | "unknown" | "stylist_review_required";
export type FindingSection = "feasibility" | "style" | "preference";
export type NextAction = "retake" | "stylist_review" | "offer_alternative" | "acknowledge" | "none";

export type RealityFinding = {
  service: ServiceKind;
  section: FindingSection;
  dimension: string;
  outcome: FindingOutcome;
  reason: string;
  evidenceRefs: string[];
  ruleId: RuleId;
  ruleVersion: typeof RULE_VERSION;
  nextAction: NextAction;
};

export type ColourRole = "dream" | "possible_first_step" | "lower_complexity";

export type RealityAlternative = {
  candidateId: string;
  service: ServiceKind;
  retained: string[];
  changed: string[];
  mismatchRuleIds: RuleId[];
  preview: "supported" | "unavailable";
  colourRole: ColourRole | null;
  note: string | null;
  editorial: boolean;
};

export type ExcludedCandidate = {
  candidateId: string;
  service: ServiceKind;
  conflicts: { category: "must_keep" | "dont_want"; text: string; evidenceRef: string }[];
};

export type RealityResult = {
  engineVersion: typeof ENGINE_VERSION;
  findings: RealityFinding[];
  alternatives: RealityAlternative[];
  excluded: ExcludedCandidate[];
};

export type RealityCandidate = {
  id: string;
  service: ServiceKind;
  enabled: boolean;
  preview: "supported" | "unavailable";
  length: CoarseLength | "unknown";
  texture: TextureFamily | "unknown";
  shade: string | null;
  maintenance: "low" | "moderate" | "high" | "unknown";
  apparentFullness: "low" | "high" | "unknown";
  labels: readonly string[];
  editorial: boolean;
};

export type RealityTarget = {
  service: ServiceKind;
  length: LengthInterval | null;
  lengthLabel: CoarseLength | null;
  texture: TextureFamily | null;
  shade: string | null;
  apparentFullness: "low" | "high" | null;
  fullnessEvidenceRefs: readonly string[];
  fringe: string | null;
  top: string | null;
  side: string | null;
  maintenance: "low" | "moderate" | "high" | null;
  proportionRequested: boolean;
  shadeSuggestionsRequested: boolean;
  unsupported: readonly string[];
  limitationAcknowledged: boolean;
  evidenceRefs: readonly string[];
};

export type HairEvidence = {
  length: (LengthInterval & { evidenceRefs: readonly string[] }) | null;
  textureFamilies: readonly TextureFamily[] | null;
  textureEvidenceRefs: readonly string[];
  densityGrade: DensityGrade | null;
  densityEvidenceRefs: readonly string[];
  frizz: FrizzGrade | null;
  frizzEvidenceRefs: readonly string[];
  conflicts: readonly { dimension: string; evidenceRefs: readonly string[] }[];
};

export type RealityInput = {
  services: readonly ServiceKind[];
  hair: HairEvidence | null;
  beard: { fullness: "low" | "moderate" | "high" | null; length: LengthInterval | null; evidenceRefs: readonly string[] } | null;
  face: { shape: string; evidenceRefs: readonly string[] } | null;
  tones: { hairColorName: string | null; evidenceRefs: readonly string[] } | null;
  history: ColourHistory | null;
  maintenance: "low" | "moderate" | "high" | "unspecified" | null;
  priorities: readonly ConfirmedPriority[];
  targets: readonly RealityTarget[];
  candidates: readonly RealityCandidate[];
  gaps: readonly { service: ServiceKind; dimension: string; nextAction: "retake" | "stylist_review"; evidenceRefs: readonly string[] }[];
};

const TERM_INTERVALS: Record<string, LengthInterval> = {
  "above the ears": { from: "above the ears", to: "above the ears" },
  "ear length": { from: "ear length", to: "ear length" },
  "ear length or longer": { from: "ear length", to: null },
  "short hair": { from: "short hair", to: "short hair" },
  "short hair or longer": { from: "short hair", to: null },
  "above chest": { from: "above chest", to: "above chest" },
  "above chest or longer": { from: "above chest", to: null },
  "long hair": { from: "long hair", to: "long hair" },
};

const MAPPING_FAMILIES: Record<string, readonly TextureFamily[]> = {
  "1 to 2a": ["straight", "wavy"],
  "2a to 2b": ["wavy"],
  "2b to 2c": ["wavy"],
  "2c to 3a": ["wavy", "curly"],
  "3a to 3b": ["curly"],
  "3b to 3c": ["curly"],
  "3c to 4a": ["curly"],
  "4a to 4b": ["curly"],
  "4b to 4c": ["curly"],
};

const HAIR_DIMENSIONS = ["length", "texture", "density", "frizz"] as const;
const MATERIAL_HISTORY = ["dyed", "boxDye", "henna", "bleach", "keratin", "permOrRelaxer", "reportedDamage"] as const;

export function lengthIntervalFromTerm(term: string): LengthInterval | null {
  return TERM_INTERVALS[term] ?? null;
}

export function coarseLengthInterval(label: CoarseLength): LengthInterval {
  if (label === "short") return { from: "above the ears", to: "short hair" };
  if (label === "medium") return { from: "ear length", to: "above chest" };
  return { from: "long hair", to: "long hair" };
}

export function textureFamiliesFromMapping(mapping: string): readonly TextureFamily[] | null {
  return MAPPING_FAMILIES[mapping] ?? null;
}

export function evaluateReality(input: RealityInput): RealityResult {
  const ranked = rankAll(input);
  const findings = [
    ...gapFindings(input),
    ...lengthFindings(input),
    ...fullnessFindings(input),
    ...textureFindings(input),
    ...maintenanceFindings(input),
    ...priorityFindings(ranked.excluded),
    ...frizzFindings(input),
    ...historyFindings(input),
    ...beardFindings(input),
    ...faceFindings(input),
    ...toneFindings(input),
    ...representationFindings(input),
  ].sort(compareFindings);
  return {
    engineVersion: ENGINE_VERSION,
    findings,
    alternatives: ranked.alternatives,
    excluded: ranked.excluded,
  };
}

function gapFindings(input: RealityInput): RealityFinding[] {
  const findings: RealityFinding[] = [];
  for (const gap of input.gaps) {
    if (!input.services.includes(gap.service)) continue;
    findings.push(finding(gap.service, "feasibility", gap.dimension, "unknown", "A required observation is missing or invalid.", gap.evidenceRefs, "RC-001", gap.nextAction));
  }
  if (!input.services.includes("haircut")) return findings;
  for (const dimension of HAIR_DIMENSIONS) {
    if (findings.some((item) => item.service === "haircut" && item.dimension === dimension)) continue;
    if (observationMissing(input, dimension)) {
      findings.push(finding("haircut", "feasibility", dimension, "unknown", "A required observation is missing or invalid.", evidenceForGap(input, dimension), "RC-001", "stylist_review"));
    }
  }
  for (const service of input.services) {
    if (!input.targets.some((target) => target.service === service)) {
      findings.push(finding(service, "feasibility", "target", "unknown", "A required observation is missing or invalid.", [], "RC-001", "stylist_review"));
    }
  }
  return findings;
}

function lengthFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("haircut") || observationMissing(input, "length")) return [];
  const target = targetFor(input, "haircut");
  const current = input.hair?.length;
  if (!target || !current) return [];
  const refs = [...current.evidenceRefs, ...target.evidenceRefs];
  const precise = target.fringe !== null || target.top !== null || target.side !== null;
  if (precise || target.length === null || overlaps(current, target.length)) {
    return [finding("haircut", "feasibility", "coarse_length", "unknown", "The coarse ranges do not establish a precise length. A stylist confirms what is practical.", refs, "RC-003", "stylist_review")];
  }
  if (entirelyAbove(target.length, current)) {
    return [finding("haircut", "feasibility", "coarse_length", "potential_mismatch", "The target coarse length sits entirely above the current range. A shorter candidate or grow-out can be discussed. No length is converted to a finer unit.", refs, "RC-002", "offer_alternative")];
  }
  if (noAddedLength(target.length, current)) {
    return [finding("haircut", "feasibility", "coarse_length", "compatible", "The coarse target does not require added length. The detailed cut remains uncertain.", refs, "RC-004", "none")];
  }
  return [finding("haircut", "feasibility", "coarse_length", "unknown", "The coarse ranges do not establish a precise length. A stylist confirms what is practical.", refs, "RC-003", "stylist_review")];
}

function fullnessFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("haircut") || observationMissing(input, "density")) return [];
  const grade = input.hair?.densityGrade;
  const target = targetFor(input, "haircut");
  if (!grade || !target || target.apparentFullness !== "high") return [];
  if (grade !== "Extremely Low Density" && grade !== "Low Density") return [];
  return [finding("haircut", "feasibility", "fullness", "potential_mismatch", "The image-based density grade is low and the reference fullness is a separate visual observation that looks high. These are different evidence types. Expect less mass than the reference.", [...(input.hair?.densityEvidenceRefs ?? []), ...target.fullnessEvidenceRefs], "RC-005", "offer_alternative")];
}

function textureFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("haircut") || observationMissing(input, "texture")) return [];
  const families = input.hair?.textureFamilies;
  const target = targetFor(input, "haircut");
  if (!families || families.length === 0 || !target?.texture) return [];
  if (families.includes(target.texture)) return [];
  return [finding("haircut", "feasibility", "texture", "potential_mismatch", "The texture families do not overlap. Styling can be discussed. The client's preference is not ruled out.", [...(input.hair?.textureEvidenceRefs ?? []), ...target.evidenceRefs], "RC-006", "stylist_review")];
}

function maintenanceFindings(input: RealityInput): RealityFinding[] {
  if (input.maintenance !== "low") return [];
  return input.services.flatMap((service) => {
    const target = targetFor(input, service);
    if (target?.maintenance !== "high") return [];
    return [finding(service, "preference", "maintenance", "potential_mismatch", "The target maintenance is high and the client asked for low maintenance. A lower-maintenance candidate is preferred.", target.evidenceRefs, "RC-007", "offer_alternative")];
  });
}

function priorityFindings(excluded: readonly ExcludedCandidate[]): RealityFinding[] {
  return excluded.flatMap((candidate) => candidate.conflicts.map((conflict) => finding(
    candidate.service,
    "preference",
    "priority",
    "potential_mismatch",
    `${conflict.category === "must_keep" ? "Must keep" : "Don't want"} "${conflict.text}" conflicts with candidate ${candidate.candidateId}.`,
    [conflict.evidenceRef],
    "RC-008",
    "none",
  )));
}

function frizzFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("haircut") || observationMissing(input, "frizz")) return [];
  const frizz = input.hair?.frizz;
  const target = targetFor(input, "haircut");
  if (!frizz || frizz === "Not Frizzy" || target?.texture !== "straight") return [];
  return [finding("haircut", "style", "styling", "unknown", "A frizz observation and a smooth target make the styling uncertain. This is not a damage diagnosis.", [...(input.hair?.frizzEvidenceRefs ?? []), ...target.evidenceRefs], "RC-009", "stylist_review")];
}

function historyFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("colour")) return [];
  const findings: RealityFinding[] = [];
  const history = input.history;
  if (!history) {
    findings.push(finding("colour", "feasibility", "colour_history", "stylist_review_required", "Colour history is unanswered. Ask for the history or a professional consultation.", [], "RC-010", "stylist_review"));
  } else {
    const unknown = MATERIAL_HISTORY.filter((key) => history[key] === "unknown");
    if (unknown.length > 0) {
      findings.push(finding("colour", "feasibility", "colour_history", "stylist_review_required", `Colour history is unknown for ${unknown.join(", ")}. Unknown is not a no.`, unknown.map((key) => `history:${key}`), "RC-010", "stylist_review"));
    }
    const reported = reportedTreatments(history);
    if (reported.length > 0) {
      findings.push(finding("colour", "feasibility", "reported_treatment", "stylist_review_required", `The client reported ${reported.map((item) => item.label).join(", ")}. A professional assessment should keep that report.`, reported.map((item) => `history:${item.key}`), "RC-012", "stylist_review"));
    }
  }
  if (needsColourReview(input)) {
    const target = targetFor(input, "colour");
    const refs = [...(input.history ? ["history:dyed"] : []), ...(input.tones?.evidenceRefs ?? []), ...(target?.evidenceRefs ?? [])];
    findings.push(finding("colour", "feasibility", "lightening", "stylist_review_required", "Prior dark dye or a lighter requested shade needs a stylist to discuss complexity.", refs, "RC-011", "stylist_review"));
  }
  return findings;
}

function beardFindings(input: RealityInput): RealityFinding[] {
  if (!input.services.includes("beard")) return [];
  const target = targetFor(input, "beard");
  const beard = input.beard;
  const refs = beard?.evidenceRefs ?? [];
  const findings: RealityFinding[] = [];
  if (target?.apparentFullness) {
    if (!beard?.fullness) findings.push(beardGap("fullness", refs));
    else if (beard.fullness === "low" && target.apparentFullness === "high") {
      findings.push(finding("beard", "feasibility", "fullness", "potential_mismatch", "The beard report does not establish the requested fullness. Scalp density is not used.", refs, "RC-013", "stylist_review"));
    }
  }
  if (target?.length) {
    if (!beard?.length) findings.push(beardGap("length", refs));
    else if (entirelyAbove(target.length, beard.length)) {
      findings.push(finding("beard", "feasibility", "length", "potential_mismatch", "The beard report does not establish the requested length. Scalp density is not used.", refs, "RC-013", "stylist_review"));
    }
  }
  if (!target?.apparentFullness && !target?.length && !beard?.fullness && !beard?.length) findings.push(beardGap("fullness", refs));
  return findings;
}

function faceFindings(input: RealityInput): RealityFinding[] {
  const target = input.targets.find((item) => item.proportionRequested);
  if (!target || !input.face || !input.services.includes(target.service)) return [];
  const shape = input.face.shape.trim().toLowerCase();
  const contrary = applicablePriorities(input, target.service).some((priority) => priority.category === "dont_want" && priority.text.trim().toLowerCase() === shape);
  if (contrary) return [];
  return [finding(target.service, "style", "silhouette", "unknown", `Optional silhouette note from the recorded face shape ${input.face.shape}. It does not score the face and does not prohibit a preference.`, input.face.evidenceRefs, "RC-014", "none")];
}

function toneFindings(input: RealityInput): RealityFinding[] {
  const target = targetFor(input, "colour");
  if (!input.services.includes("colour") || !target?.shadeSuggestionsRequested || !input.tones?.hairColorName) return [];
  return [finding("colour", "style", "shade", "unknown", "Recorded colour tones are comparison starting points. Client priorities outrank this note. A stylist reviews any direction.", input.tones.evidenceRefs, "RC-015", "stylist_review")];
}

function representationFindings(input: RealityInput): RealityFinding[] {
  return input.targets.flatMap((target) => {
    if (!input.services.includes(target.service) || target.unsupported.length === 0) return [];
    return [finding(target.service, "feasibility", "representation", "unknown", `The provider configuration cannot express: ${target.unsupported.join("; ")}. The written instruction stays.`, target.evidenceRefs, "RC-016", target.limitationAcknowledged ? "none" : "acknowledge")];
  });
}

function rankAll(input: RealityInput): { alternatives: RealityAlternative[]; excluded: ExcludedCandidate[] } {
  const alternatives: RealityAlternative[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const service of input.services) {
    const target = targetFor(input, service);
    const pool = input.candidates.filter((candidate) => candidate.service === service && candidate.enabled);
    for (const candidate of pool) {
      const conflicts = conflictsFor(candidate, input);
      if (conflicts.length > 0) excluded.push({ candidateId: candidate.id, service, conflicts });
    }
    const eligible = pool.filter((candidate) => conflictsFor(candidate, input).length === 0);
    eligible.sort((left, right) => compareCandidates(left, right, input, target));
    const chosen = eligible.slice(0, 3).map((candidate) => explain(candidate, input, target));
    alternatives.push(...assignColourRoles(service, chosen, target));
  }
  excluded.sort((left, right) => compareText(left.candidateId, right.candidateId));
  return { alternatives, excluded };
}

function explain(candidate: RealityCandidate, input: RealityInput, target: RealityTarget | null): RealityAlternative {
  const kept: string[] = [];
  const changed: string[] = [];
  if (target?.lengthLabel && candidate.length !== "unknown") {
    (candidate.length === target.lengthLabel ? kept : changed).push("length");
  }
  if (target?.texture && candidate.texture !== "unknown") {
    (candidate.texture === target.texture ? kept : changed).push("texture");
  }
  if (target?.shade && candidate.shade) {
    (candidate.shade.toLowerCase() === target.shade.toLowerCase() ? kept : changed).push("shade");
  }
  return {
    candidateId: candidate.id,
    service: candidate.service,
    retained: kept,
    changed,
    mismatchRuleIds: mismatchRules(candidate, input, target),
    preview: candidate.preview,
    colourRole: null,
    note: null,
    editorial: candidate.editorial,
  };
}

function assignColourRoles(service: ServiceKind, alternatives: RealityAlternative[], target: RealityTarget | null): RealityAlternative[] {
  if (service !== "colour") return alternatives;
  let dreamUsed = false;
  let stepUsed = false;
  return alternatives.map((alternative) => {
    const requested = target?.shade !== null && target?.shade !== undefined && alternative.retained.includes("shade");
    if (requested && !dreamUsed) {
      dreamUsed = true;
      return { ...alternative, colourRole: "dream", note: "Editorial catalogue starting point for the requested shade. A stylist reviews it. This is not a predicted colour result." };
    }
    if (!stepUsed) {
      stepUsed = true;
      return { ...alternative, colourRole: "possible_first_step", note: "Possible first step for discussion. Professional review is required. This is not a predicted colour result." };
    }
    return { ...alternative, colourRole: "lower_complexity", note: "Lower-complexity direction for discussion. Professional review is required. This is not a predicted colour result." };
  });
}

function compareCandidates(left: RealityCandidate, right: RealityCandidate, input: RealityInput, target: RealityTarget | null): number {
  const penalty = preferencePenalty(left, input, target) - preferencePenalty(right, input, target);
  if (penalty !== 0) return penalty;
  const retainedDelta = countRetained(right, target) - countRetained(left, target);
  if (retainedDelta !== 0) return retainedDelta;
  const mismatchDelta = mismatchRules(left, input, target).length - mismatchRules(right, input, target).length;
  if (mismatchDelta !== 0) return mismatchDelta;
  return compareText(left.id, right.id);
}

function preferencePenalty(candidate: RealityCandidate, input: RealityInput, target: RealityTarget | null): number {
  return addedLength(candidate, input, target) || (input.maintenance === "low" && candidate.maintenance === "high") ? 1 : 0;
}

function countRetained(candidate: RealityCandidate, target: RealityTarget | null): number {
  let count = 0;
  if (target?.lengthLabel && candidate.length === target.lengthLabel) count += 1;
  if (target?.texture && candidate.texture === target.texture) count += 1;
  if (target?.shade && candidate.shade?.toLowerCase() === target.shade.toLowerCase()) count += 1;
  return count;
}

function mismatchRules(candidate: RealityCandidate, input: RealityInput, target: RealityTarget | null): RuleId[] {
  const rules: RuleId[] = [];
  if (addedLength(candidate, input, target)) rules.push("RC-002");
  if (candidate.service === "haircut" && !observationMissing(input, "density") && isLowDensity(input.hair?.densityGrade ?? null) && candidate.apparentFullness === "high") rules.push("RC-005");
  if (candidate.service === "haircut" && target?.texture && candidate.texture !== "unknown" && input.hair?.textureFamilies && !input.hair.textureFamilies.includes(candidate.texture) && !observationMissing(input, "texture")) rules.push("RC-006");
  if (input.maintenance === "low" && candidate.maintenance === "high") rules.push("RC-007");
  return rules;
}

function addedLength(candidate: RealityCandidate, input: RealityInput, target: RealityTarget | null): boolean {
  if (candidate.service !== "haircut" || candidate.length === "unknown" || !target || observationMissing(input, "length")) return false;
  const current = input.hair?.length;
  if (!current) return false;
  return entirelyAbove(coarseLengthInterval(candidate.length), current);
}

function conflictsFor(candidate: RealityCandidate, input: RealityInput): ExcludedCandidate["conflicts"] {
  const labels = new Set(candidateLabels(candidate));
  const knownLabels = knownPriorityLabels(input);
  const conflicts: ExcludedCandidate["conflicts"] = [];
  for (const priority of applicablePriorities(input, candidate.service)) {
    if (priority.category !== "must_keep" && priority.category !== "dont_want") continue;
    const text = priority.text.trim().toLowerCase();
    const tokens = mentionedLabels(text, knownLabels);
    const contradicted = priority.category === "dont_want"
      ? tokens.some((token) => labels.has(token))
      : tokens.some((token) => explicitMiss(candidate, token, knownLabels));
    if (!contradicted) continue;
    conflicts.push({
      category: priority.category,
      text: priority.text,
      evidenceRef: `priority:${priority.scope}:${priority.category}:${priority.text}`,
    });
  }
  return conflicts;
}

function knownPriorityLabels(input: RealityInput): Set<string> {
  const labels = new Set<string>([...textureFamilies, ...coarseLengths]);
  for (const candidate of input.candidates) {
    for (const label of candidateLabels(candidate)) labels.add(label);
  }
  return labels;
}

function mentionedLabels(text: string, labels: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const ordered = [...labels].filter((label) => label.length >= 3).sort((left, right) => right.length - left.length);
  for (const label of ordered) {
    const pattern = new RegExp(`\\b${escapeRegExp(label)}\\b`, "i");
    if (pattern.test(text)) found.push(label);
  }
  return found;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitMiss(candidate: RealityCandidate, text: string, knownLabels: ReadonlySet<string>): boolean {
  if ((textureFamilies as readonly string[]).includes(text)) return candidate.texture !== "unknown" && candidate.texture !== text;
  if ((coarseLengths as readonly string[]).includes(text)) return candidate.length !== "unknown" && candidate.length !== text;
  if (candidate.shade === null || !knownLabels.has(text)) return false;
  return candidate.shade.trim().toLowerCase() !== text;
}

function candidateLabels(candidate: RealityCandidate): string[] {
  return [...candidate.labels, candidate.texture, candidate.length, candidate.shade ?? ""]
    .map((label) => label.trim().toLowerCase())
    .filter((label) => label !== "" && label !== "unknown");
}

function applicablePriorities(input: RealityInput, service: ServiceKind): ConfirmedPriority[] {
  return input.priorities.filter((priority) => priority.confirmed && (priority.scope === "all" || priority.scope === service));
}

function observationMissing(input: RealityInput, dimension: (typeof HAIR_DIMENSIONS)[number]): boolean {
  if (input.hair?.conflicts.some((conflict) => conflict.dimension === dimension)) return true;
  if (!input.hair) return true;
  if (dimension === "length") return input.hair.length === null;
  if (dimension === "texture") return input.hair.textureFamilies === null || input.hair.textureFamilies.length === 0;
  if (dimension === "density") return input.hair.densityGrade === null;
  return input.hair.frizz === null;
}

function evidenceForGap(input: RealityInput, dimension: string): string[] {
  return input.hair?.conflicts.find((conflict) => conflict.dimension === dimension)?.evidenceRefs.slice() ?? [];
}

function targetFor(input: RealityInput, service: ServiceKind): RealityTarget | null {
  return input.targets.find((target) => target.service === service) ?? null;
}

function reportedTreatments(history: ColourHistory): { key: (typeof MATERIAL_HISTORY)[number]; label: string }[] {
  const labels: Record<(typeof MATERIAL_HISTORY)[number], string> = {
    dyed: "dye",
    boxDye: "box dye",
    henna: "henna",
    bleach: "bleach",
    keratin: "keratin",
    permOrRelaxer: "perm or relaxer",
    reportedDamage: "reported damage",
  };
  return MATERIAL_HISTORY.filter((key) => key !== "dyed" && history[key] === "yes").map((key) => ({ key, label: labels[key] }));
}

function needsColourReview(input: RealityInput): boolean {
  const target = targetFor(input, "colour");
  const dark = isDarkName(input.history?.naturalColour.state === "known" ? input.history.naturalColour.value : null) || isDarkName(input.tones?.hairColorName ?? null);
  const lightTarget = isLightShade(target?.shade ?? null);
  const priorDarkDye = input.history?.dyed === "yes" && dark;
  return priorDarkDye || (dark && lightTarget);
}

function isDarkName(value: string | null): boolean {
  return value !== null && /\b(black|brown|dark)\b/i.test(value);
}

function isLightShade(value: string | null): boolean {
  return value !== null && /\b(blonde|platinum|ash gray|rose gold)\b/i.test(value);
}

function isLowDensity(grade: DensityGrade | null): boolean {
  return grade === "Extremely Low Density" || grade === "Low Density";
}

function beardGap(dimension: string, evidenceRefs: readonly string[]): RealityFinding {
  return finding("beard", "feasibility", dimension, "unknown", "Beard fullness or length is not established by beard photographs or reports. Scalp density is not used.", evidenceRefs, "RC-013", "stylist_review");
}

function pointIndex(point: LengthPoint): number {
  return lengthPoints.indexOf(point);
}

function upperBound(interval: LengthInterval): number | null {
  return interval.to === null ? null : pointIndex(interval.to);
}

function overlaps(left: LengthInterval, right: LengthInterval): boolean {
  const leftUpper = upperBound(left) ?? Number.POSITIVE_INFINITY;
  const rightUpper = upperBound(right) ?? Number.POSITIVE_INFINITY;
  return pointIndex(left.from) <= rightUpper && pointIndex(right.from) <= leftUpper;
}

function entirelyAbove(target: LengthInterval, current: LengthInterval): boolean {
  const currentUpper = upperBound(current);
  return currentUpper !== null && pointIndex(target.from) > currentUpper;
}

function noAddedLength(target: LengthInterval, current: LengthInterval): boolean {
  const targetUpper = upperBound(target);
  return targetUpper !== null && targetUpper <= pointIndex(current.from);
}

function finding(
  service: ServiceKind,
  section: FindingSection,
  dimension: string,
  outcome: FindingOutcome,
  reason: string,
  evidenceRefs: readonly string[],
  ruleId: RuleId,
  nextAction: NextAction,
): RealityFinding {
  return {
    service,
    section,
    dimension,
    outcome,
    reason,
    evidenceRefs: [...evidenceRefs],
    ruleId,
    ruleVersion: RULE_VERSION,
    nextAction,
  };
}

function compareFindings(left: RealityFinding, right: RealityFinding): number {
  const serviceDelta = compareText(left.service, right.service);
  if (serviceDelta !== 0) return serviceDelta;
  const ruleDelta = compareText(left.ruleId, right.ruleId);
  if (ruleDelta !== 0) return ruleDelta;
  return compareText(left.dimension, right.dimension);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
