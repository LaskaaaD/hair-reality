import type { YouCamCapability } from "../providers/youcam/contract.js";

const CAPABILITY_BY_SERVICE = {
  haircut: "hairstyle",
  colour: "hair-color",
  beard: "beard",
} as const satisfies Record<"haircut" | "colour" | "beard", YouCamCapability>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function previewProviderConfiguration(input: {
  serviceKind: "haircut" | "colour" | "beard";
  candidateId: string;
  sourceAssetId: string;
  controls: Record<string, string>;
}): string {
  return JSON.stringify({
    capability: CAPABILITY_BY_SERVICE[input.serviceKind],
    candidateId: input.candidateId,
    controls: input.controls,
    views: { source: input.sourceAssetId },
  });
}

export function candidateIdFromJobConfiguration(configuration: string): string | null {
  if (configuration.startsWith("preview:")) {
    const legacy = configuration.slice("preview:".length);
    return UUID.test(legacy) ? legacy : null;
  }
  try {
    const parsed: unknown = JSON.parse(configuration);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("candidateId" in parsed)) return null;
    const id = parsed.candidateId;
    return typeof id === "string" && UUID.test(id) ? id : null;
  } catch {
    return null;
  }
}
