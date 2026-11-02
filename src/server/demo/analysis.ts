import type { ServiceKind } from "../../domain/catalogue.js";

export type AnalysisMode = "hackathon" | "salon";
export type AnalysisCapability = "hair-type" | "hair-density" | "hair-frizziness" | "face-attributes" | "facial-color-tones";

export function analysisCapabilities(service: ServiceKind, mode: AnalysisMode, lean: boolean): AnalysisCapability[] {
  if (mode === "salon") return [];
  if (service === "haircut") {
    return lean ? ["hair-type", "hair-density"] : ["hair-type", "hair-density", "hair-frizziness", "face-attributes"];
  }
  if (service === "colour") return lean ? [] : ["facial-color-tones"];
  return lean ? [] : ["face-attributes"];
}
