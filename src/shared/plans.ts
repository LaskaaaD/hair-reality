export const INDEPENDENT_PREVIEW_CAPTION = "Independent preview. This is not a combined result.";
export const UNREPRESENTED_ADJUSTMENT = "This adjustment is described in your plan but is not represented by the selected preview.";

export type PlanPreview = {
  id: string | null;
  title: string | null;
  resultAssetId: string | null;
  caption: string;
  unavailableReason: string | null;
  representationLimit: string | null;
};

export type PlanService = {
  kind: "haircut" | "colour" | "beard";
  targetTitle: string | null;
  unsupported: string[];
  findings: { ruleId: string; outcome: string; reason: string }[];
  preview: PlanPreview;
  stylistNote: string | null;
};

export type PlanSnapshot = {
  services: PlanService[];
  history: unknown;
  priorities: unknown;
  changeSummary: string;
};

export type PublishedPlan = {
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  snapshotHash: string;
  snapshot: PlanSnapshot;
  published: boolean;
};

export function readPublishedPlan(body: unknown): PublishedPlan | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const data = body.data;
  if (typeof data.revisionId !== "string" || typeof data.revisionNumber !== "number" || typeof data.snapshotHash !== "string") return null;
  if (!isRecord(data.snapshot) || !Array.isArray(data.snapshot.services)) return null;
  return data as PublishedPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
