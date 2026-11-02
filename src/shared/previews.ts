export type HaircutProposal = {
  candidateId: string;
  title: string;
  length: string | null;
  texture: string | null;
  shade: string | null;
  referenceFullness: string | null;
  unsupported: string[];
};

export type HaircutAlternative = {
  candidateId: string;
  title: string;
  retained: string[];
  changed: string[];
  note: string | null;
  colourRole: "dream" | "possible_first_step" | "lower_complexity" | null;
};

export type StoredPreview = {
  id: string;
  candidateId: string | null;
  sourceVersion: number | null;
  freshness: string;
  stale: boolean;
  selected: boolean;
  resultAssetId: string | null;
  limits: string[];
  providerVersion: string | null;
};

export type HaircutFinding = {
  ruleId: string;
  dimension: string;
  outcome: string;
  reason: string;
};

export type HaircutPreviewService = {
  serviceId: string;
  kind: "haircut" | "colour" | "beard";
  sourceAssetId: string | null;
  inputVersion: number;
  dream: HaircutProposal | null;
  alternatives: HaircutAlternative[];
  findings: HaircutFinding[];
  previews: StoredPreview[];
  pendingCandidateIds: string[];
};

export type HaircutPreviewScreen = {
  consultationId: string;
  version: number;
  sourceAssetId: string | null;
  services: HaircutPreviewService[];
};

export const PREVIEW_DISCLOSURE = "Visual preview — actual results depend on your hair and your stylist's assessment.";
export const UNSUPPORTED_PREVIEW_NOTE = "This adjustment is described in your plan but is not represented by the selected preview.";

export function readHaircutPreviewScreen(body: unknown): HaircutPreviewScreen | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const data = body.data;
  if (typeof data.consultationId !== "string" || typeof data.version !== "number" || !Array.isArray(data.services)) return null;
  if (data.sourceAssetId !== null && typeof data.sourceAssetId !== "string") return null;
  return data as HaircutPreviewScreen;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
