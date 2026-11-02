import type { ServiceKind } from "./consultations.js";
import type { NextAction, RealityFinding } from "./reality-engine.js";

export type PublicFinding = {
  service: ServiceKind;
  section: "feasibility" | "style" | "preference";
  dimension: string;
  outcome: "compatible" | "potential_mismatch" | "unknown" | "stylist_review_required";
  reason: string;
  evidence: { ref: string; label: string }[];
  ruleId: RealityFinding["ruleId"];
  ruleVersion: RealityFinding["ruleVersion"];
  nextAction: NextAction;
};

export type PublicAlternative = {
  candidateId: string;
  service: ServiceKind;
  title: string | null;
  retained: string[];
  changed: string[];
  preview: "supported" | "unavailable";
  colourRole: "dream" | "possible_first_step" | "lower_complexity" | null;
  note: string | null;
  editorial: boolean;
};

export type RealityService = {
  kind: ServiceKind;
  state: "missing" | "current" | "stale" | "review_required";
  currentAssetId: string | null;
  inspirationAssetId: string | null;
  targetTitle: string | null;
  findings: PublicFinding[];
  alternatives: PublicAlternative[];
  excluded: { candidateId: string; conflicts: { category: "must_keep" | "dont_want"; text: string }[] }[];
};

export type RealityCheck = {
  version: number;
  services: RealityService[];
};

const outcomeLabels: Record<PublicFinding["outcome"], string> = {
  compatible: "Compatible",
  potential_mismatch: "Potential mismatch",
  unknown: "Unknown",
  stylist_review_required: "Stylist review required",
};

const actionLabels: Record<NextAction, string> = {
  retake: "Retake the photograph",
  stylist_review: "Ask a stylist",
  offer_alternative: "Consider another option",
  acknowledge: "Acknowledge the limitation",
  none: "No further action",
};

export function outcomeLabel(outcome: PublicFinding["outcome"]): string {
  return outcomeLabels[outcome];
}

export function nextActionLabel(action: NextAction): string {
  return actionLabels[action];
}

export function evidenceLabel(ref: string): string {
  if (ref === "target") return "Target";
  if (ref.startsWith("history:")) return `Colour history (${ref.slice("history:".length)})`;
  if (ref.startsWith("priority:")) return `Priority: ${ref.split(":").at(-1) ?? "priority"}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref)) return "Photograph";
  return "Recorded evidence";
}

export function presentFinding(finding: RealityFinding): PublicFinding {
  return {
    service: finding.service,
    section: finding.section,
    dimension: finding.dimension,
    outcome: finding.outcome,
    reason: finding.reason,
    evidence: finding.evidenceRefs.map((ref) => ({ ref, label: evidenceLabel(ref) })),
    ruleId: finding.ruleId,
    ruleVersion: finding.ruleVersion,
    nextAction: finding.nextAction,
  };
}

export function staysText(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "No confirmed attribute is retained.";
}

export function changesText(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "No confirmed attribute changes.";
}

export function whyText(note: string | null): string {
  return note ?? "It is a catalogue option for this service. A stylist still reviews it.";
}

export function readRealityCheckBody(body: unknown): RealityCheck | null {
  if (!isRecord(body) || !isRecord(body.data) || typeof body.data.version !== "number" || !Array.isArray(body.data.services)) return null;
  return body.data as RealityCheck;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
