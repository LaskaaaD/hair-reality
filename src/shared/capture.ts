import type { ServiceKind } from "./consultations.js";
import type { ProviderName } from "./assets.js";

export const captureRoles = [
  "current_front",
  "current_right",
  "current_left",
  "current_density",
  "current_length",
  "current_face",
  "beard",
] as const;

export type CaptureRole = (typeof captureRoles)[number];

export const tripletRoles = ["current_front", "current_right", "current_left"] as const;

const captureRoleSet = new Set<string>(captureRoles);

export function isCaptureRole(value: string): value is CaptureRole {
  return captureRoleSet.has(value);
}

export function capturePlan(input: {
  services: readonly ServiceKind[];
  facialProportions: boolean;
}): CaptureRole[] {
  const wanted = new Set<CaptureRole>();
  if (input.services.includes("haircut")) {
    for (const role of tripletRoles) wanted.add(role);
    wanted.add("current_density");
    wanted.add("current_length");
  }
  if (input.services.includes("colour")) wanted.add("current_front");
  if (input.services.includes("colour") || input.facialProportions) wanted.add("current_face");
  if (input.services.includes("beard")) wanted.add("beard");
  return captureRoles.filter((role) => wanted.has(role));
}

export type ShotGuidance = {
  title: string;
  steps: readonly string[];
  measured: false;
};

export function shotGuidance(role: CaptureRole): ShotGuidance {
  const honesty = "This page does not measure the angle, face size or lighting. A saved photograph is not an accepted pose.";
  const guides: Record<CaptureRole, readonly string[]> = {
    current_front: [
      "Face the camera with both eyes visible. The provider's stated front range is within about 10° of straight.",
      "Keep your head level. Include the whole face and the upper edge of the hair.",
      "The capture guide asks for the face to fill about half to four-fifths of the width.",
      "Use even light and avoid a strong shadow across the face.",
    ],
    current_right: [
      "Turn your head toward your own right shoulder, about 45°, as if saying no. Keep it level, without tilting up, down or sideways.",
      "The provider's error text asks for a side turn of more than 15°. It does not state a maximum.",
      "This preview is mirrored, like a bathroom mirror, so your nose moves toward the right edge of the preview.",
      "The saved photograph is not flipped. In that file your nose points toward the left edge.",
      "Include the whole face and the upper edge of the hair. Use even light.",
    ],
    current_left: [
      "Turn your head toward your own left shoulder, about 45°, and keep it level.",
      "The provider's error text asks for a side turn of more than 15°. It does not state a maximum.",
      "In the mirrored preview your nose moves toward the left edge.",
      "The saved photograph is not flipped. In that file your nose points toward the right edge.",
      "Include the whole face and the upper edge of the hair. Use even light.",
    ],
    current_density: [
      "Hold the camera above your head and tip your chin down about 45° so the crown is visible.",
      "This is a different photograph from the front and side views. A side profile does not replace it.",
    ],
    current_length: [
      "Show the full length of the hair, including the ends.",
      "This stays a separate photograph. The front view is not reused as the length view.",
    ],
    current_face: [
      "Move hair off the forehead so the face is unobstructed.",
      "This photograph is only for face or colour suggestions. It does not replace the natural-hair front view.",
      "Use even light, with both eyes visible.",
    ],
    beard: [
      "Face the camera so the beard and lower face are visible.",
      "A side photograph does not replace this view. A scalp photograph is not used for beard.",
    ],
  };
  const titles: Record<CaptureRole, string> = {
    current_front: "Front",
    current_right: "Your right",
    current_left: "Your left",
    current_density: "Crown",
    current_length: "Full hair length",
    current_face: "Unobstructed face",
    beard: "Beard",
  };
  return { title: titles[role], steps: [...guides[role], honesty], measured: false };
}

export function captureConsentStatement(providers: readonly ProviderName[]): string {
  const names = providers.map((provider) => provider === "youcam" ? "YouCam (Perfect Corp)" : "OpenAI");
  return `I agree that the saved photographs listed with this permission may be sent to ${names.join(" and ")} for the analyses this consultation needs. Saving a photograph does not send it. This permission does not publish the photographs.`;
}

export const cameraKitDecision = {
  adopted: false,
  scriptHost: "plugins-media.makeupar.com",
  modesReviewed: ["hairtype", "hairfrizziness", "hairdensity", "hairlength"],
  reason: "The SDK is loaded from a Perfect Corp host. The published init sample does not include this application's backend API key, and it does not prove that camera frames stay on the device. Beard and a separate unobstructed-face role are not listed modes. This application keeps the camera preview local and uses upload when the camera is denied.",
} as const;
