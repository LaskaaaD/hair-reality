import type { CaptureRole } from "./capture.js";
import type { AnalysisCapability } from "./face-colour.js";

/** Anatomical capture roles required before an analysis job can be started. */
export const analysisCaptureRoles: Record<AnalysisCapability, readonly CaptureRole[]> = {
  "hair-type": ["current_front", "current_right", "current_left"],
  "hair-frizziness": ["current_front", "current_right", "current_left"],
  "hair-length": ["current_length"],
  "hair-density": ["current_density"],
  "face-attributes": ["current_face"],
  "facial-color-tones": ["current_face"],
};
