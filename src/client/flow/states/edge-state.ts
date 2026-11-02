import type { DemoRequestError } from "../../api.js";

export type EdgeStateKind =
  | "camera-permission-denied"
  | "no-camera"
  | "unsupported-image"
  | "too-dark"
  | "face-not-visible"
  | "multiple-faces"
  | "hair-covered"
  | "blurry"
  | "failed-analysis"
  | "api-unavailable";

export type EdgeStateCopy = {
  title: string;
  body: string;
  primaryLabel: string;
  secondaryLabel?: string;
};

const COPY: Record<EdgeStateKind, EdgeStateCopy> = {
  "camera-permission-denied": {
    title: "Camera access is blocked",
    body: "Allow camera access in your browser settings, or upload a photo instead.",
    primaryLabel: "Try again",
    secondaryLabel: "Upload instead",
  },
  "no-camera": {
    title: "No camera found",
    body: "This device does not expose a camera we can use. Upload a clear photo instead.",
    primaryLabel: "Upload a photo",
    secondaryLabel: "Learn more",
  },
  "unsupported-image": {
    title: "We can't use this image",
    body: "Upload a JPG, PNG or WebP photograph under 9 MB.",
    primaryLabel: "Choose another file",
    secondaryLabel: "Back to instructions",
  },
  "too-dark": {
    title: "Photo too dark",
    body: "We can't clearly see your hair density. Retake near a window or under soft daylight.",
    primaryLabel: "Retake photo",
  },
  "face-not-visible": {
    title: "Face not visible",
    body: "Centre your face and shoulders in the frame so we can read your hairline.",
    primaryLabel: "Retake photo",
  },
  "multiple-faces": {
    title: "Multiple faces detected",
    body: "Use a photo with one person, or crop so only you are in frame.",
    primaryLabel: "Choose another photo",
    secondaryLabel: "Back to instructions",
  },
  "hair-covered": {
    title: "Hair is covered",
    body: "Remove hats or hoods so your natural hair is visible.",
    primaryLabel: "Retake photo",
  },
  blurry: {
    title: "Photo looks blurry",
    body: "Hold the camera steady and tap to focus before you capture.",
    primaryLabel: "Retake photo",
  },
  "failed-analysis": {
    title: "We couldn't analyse this photo right now",
    body: "Something went wrong while reading your photos. Try again or use another angle.",
    primaryLabel: "Try again",
    secondaryLabel: "Use another photo",
  },
  "api-unavailable": {
    title: "Our AI is taking a short break",
    body: "We're experiencing high demand. Wait a minute and try again.",
    primaryLabel: "Retry",
    secondaryLabel: "Back to photos",
  },
};

export function edgeStateCopy(kind: EdgeStateKind): EdgeStateCopy {
  return COPY[kind];
}

function messageHints(message: string): EdgeStateKind | null {
  const lower = message.toLowerCase();
  if (lower.includes("too dark") || lower.includes("dark")) return "too-dark";
  if (lower.includes("multiple face") || lower.includes("more than one face")) return "multiple-faces";
  if (lower.includes("face") && (lower.includes("visible") || lower.includes("detect"))) return "face-not-visible";
  if (lower.includes("blur")) return "blurry";
  if (lower.includes("hat") || lower.includes("covered") || lower.includes("hood")) return "hair-covered";
  if (lower.includes("jpeg") || lower.includes("png") || lower.includes("webp") || lower.includes("format")) {
    return "unsupported-image";
  }
  return null;
}

export function edgeStateFromMessage(message: string): EdgeStateKind | null {
  return messageHints(message);
}

export function edgeStateFromDemoError(error: DemoRequestError): EdgeStateKind | null {
  if (error.code === "rate_limited" || error.status === 402) return "api-unavailable";
  if (error.code === "analysis_failed" || error.code === "retake") {
    return messageHints(error.message) ?? "failed-analysis";
  }
  if (error.code === "invalid_input") {
    return messageHints(error.message) ?? "unsupported-image";
  }
  return messageHints(error.message);
}

export function edgeStateFromAnalysisNotice(notice: string | null | undefined): EdgeStateKind | null {
  if (!notice) return null;
  return messageHints(notice) ?? "failed-analysis";
}
