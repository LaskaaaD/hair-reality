export const YOUCAM_CONTRACT_VERSION = "youcam-s2s-2026-10-11";
export const CONTRACT_VERIFIED_ON = "2026-10-11";
export const TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RESULT_URL_RETENTION_MS = 2 * 60 * 60 * 1000;

export const YOUCAM_CAPABILITIES = [
  "hair-type",
  "hair-length",
  "hair-density",
  "hair-frizziness",
  "face-attributes",
  "facial-color-tones",
  "hairstyle",
  "hair-color",
  "beard",
] as const;

export type YouCamCapability = (typeof YOUCAM_CAPABILITIES)[number];

export const GENERIC_FILE_PATH = "/s2s/v2.0/file";
export const VERIFIED_IMAGE_CONTENT_TYPE = "image/jpg";

export type PhotoRole = "front" | "right" | "left" | "density" | "length" | "face" | "source" | "reference";

type CapabilityContract = {
  taskPost: string;
  taskPoll: string;
  filePost: string | null;
  fileRoute: "openapi" | "unverified";
  photos: readonly PhotoRole[];
  liveBlockers: readonly string[];
  result: "analysis" | "image";
};

export const CAPABILITY_CONTRACTS: Record<YouCamCapability, CapabilityContract> = {
  "hair-type": {
    taskPost: "/s2s/v2.0/task/hair-type-detection",
    taskPoll: "/s2s/v2.0/task/hair-type-detection/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["front", "right", "left"],
    liveBlockers: [],
    result: "analysis",
  },
  "hair-length": {
    taskPost: "/s2s/v2.0/task/hair-length-detection",
    taskPoll: "/s2s/v2.0/task/hair-length-detection/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["length"],
    liveBlockers: [],
    result: "analysis",
  },
  "hair-density": {
    taskPost: "/s2s/v2.0/task/hair-density-detection",
    taskPoll: "/s2s/v2.0/task/hair-density-detection/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["density"],
    liveBlockers: [],
    result: "analysis",
  },
  "hair-frizziness": {
    taskPost: "/s2s/v2.0/task/hair-frizziness-detection",
    taskPoll: "/s2s/v2.0/task/hair-frizziness-detection/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["front", "right", "left"],
    liveBlockers: [],
    result: "analysis",
  },
  "face-attributes": {
    taskPost: "/s2s/v2.0/task/face-attr-analysis",
    taskPoll: "/s2s/v2.0/task/face-attr-analysis/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["face"],
    liveBlockers: [],
    result: "analysis",
  },
  "facial-color-tones": {
    taskPost: "/s2s/v2.0/task/skin-tone-analysis",
    taskPoll: "/s2s/v2.0/task/skin-tone-analysis/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["face"],
    liveBlockers: [],
    result: "analysis",
  },
  hairstyle: {
    taskPost: "/s2s/v2.1/task/hair-transfer",
    taskPoll: "/s2s/v2.1/task/hair-transfer/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["source"],
    liveBlockers: [],
    result: "image",
  },
  "hair-color": {
    taskPost: "/s2s/v2.0/task/hair-color",
    taskPoll: "/s2s/v2.0/task/hair-color/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["source"],
    liveBlockers: [],
    result: "image",
  },
  beard: {
    taskPost: "/s2s/v2.0/task/beard-style",
    taskPoll: "/s2s/v2.0/task/beard-style/{task_id}",
    filePost: GENERIC_FILE_PATH,
    fileRoute: "openapi",
    photos: ["source"],
    liveBlockers: [],
    result: "image",
  },
};

export const HAIR_TYPE_MAPPINGS = [
  "1 to 2a",
  "2a to 2b",
  "2b to 2c",
  "2c to 3a",
  "3a to 3b",
  "3b to 3c",
  "3c to 4a",
  "4a to 4b",
  "4b to 4c",
] as const;

export const HAIR_TYPE_TERMS = [
  "Straight to Slight Wavy",
  "Slight to Medium Wavy",
  "Medium to Thick Wavy",
  "Thick Wavy to Loose Curls",
  "Loose to Medium Curls",
  "Medium to Tight Curls",
  "Tight Curls to Kinky Soft",
  "Kinky Soft to Coily",
  "Coily to Extremely Coily",
] as const;

export const HAIR_LENGTH_TERMS = [
  "above the ears",
  "ear length",
  "ear length or longer",
  "short hair",
  "short hair or longer",
  "above chest",
  "above chest or longer",
  "long hair",
] as const;

export const HAIR_DENSITY_TERMS = [
  "Extremely Low Density",
  "Low Density",
  "Medium Density",
  "High Density",
] as const;

export const FRIZZ_TERMS = ["Not Frizzy", "Slightly Frizzy", "Frizzy", "Extreme Frizzy"] as const;

export const FACE_ANGLE_LEVELS = ["strict", "high", "medium", "low", "flexible"] as const;

export const FACE_FEATURE_LABELS = [
  "faceShape",
  "eyeShape",
  "eyeSize",
  "eyeAngle",
  "eyeDistance",
  "eyelid",
  "eyebrowShape",
  "eyebrowThickness",
  "eyebrowDistance",
  "eyebrowShortness",
  "lipShape",
  "noseWidth",
  "noseLength",
  "cheekbones",
  "horizontalThird",
  "verticalFifth",
  "faceAspectRatio",
  "eyeAspectRatio",
  "eyebrowArch",
  "eyeHeightToEyebrowDistance",
  "noseAspectRatio",
  "noseWidthToMouthWidth",
  "noseToLipToChin",
  "upperLipToLowerLip",
] as const;

export const STYLING_FACE_FEATURES = [
  "faceShape",
  "faceAspectRatio",
  "horizontalThird",
  "verticalFifth",
] as const;

export const HACKATHON_FACE_FEATURES = [
  "faceShape",
  "faceAspectRatio",
  "horizontalThird",
  "cheekbones",
  "noseToLipToChin",
] as const;

export const FACE_ATTRIBUTE_PRICE_TIERS = [
  { min: 1, max: 5, units: 10 },
  { min: 6, max: 14, units: 20 },
  { min: 15, max: 28, units: 30 },
] as const;

export function faceAttributeUnits(featureCount: number): number | null {
  const tier = FACE_ATTRIBUTE_PRICE_TIERS.find((item) => featureCount >= item.min && featureCount <= item.max);
  return tier ? tier.units : null;
}

export const ACCOUNT_PROBE_UNITS = {
  "hair-type": 2,
  "hair-length": 2,
  "hair-density": 1,
  "hair-frizziness": 2,
  "face-attributes": 10,
  "facial-color-tones": 20,
  hairstyle: 2,
  "hair-color": 1,
  beard: 2,
} as const satisfies Record<YouCamCapability, number>;

export const MINIMUM_HAIR_COLOR_MODE = "full" as const;

export function minimumProbeUnits(): number {
  return Object.values(ACCOUNT_PROBE_UNITS).reduce((sum, units) => sum + units, 0);
}

const STORAGE_ROLES: Record<YouCamCapability, readonly string[]> = {
  "hair-type": ["current_front", "current_right", "current_left"],
  "hair-frizziness": ["current_front", "current_right", "current_left"],
  "hair-length": ["current_length"],
  "hair-density": ["current_density"],
  "face-attributes": ["current_face"],
  "facial-color-tones": ["current_face"],
  hairstyle: ["current_front"],
  "hair-color": ["current_front"],
  beard: ["beard"],
};

export function storageRolesFor(capability: YouCamCapability): readonly string[] {
  return STORAGE_ROLES[capability];
}

/**
 * Stored capture roles stay anatomical. YouCam hair-type and hair-frizziness
 * slots are image-relative and are translated only at this boundary.
 *
 * Provenance, 2026-10-12, owner report from a set of accepted phone photos. No provider task
 * id for that success was stored in this repository, so none is recorded here.
 * The successful hair-type request put `obrot-w-lewo.jpg` (nose toward image
 * right; stored `current_left`) in provider slot `right`, and `obrot-w-prawo.jpg`
 * (nose toward image left; stored `current_right`) in provider slot `left`.
 * The anatomical pairing failed on the same triplet. Hair length used only
 * `przod.jpg` and is not a side-slot mapping. The same three-slot contract is
 * used for frizziness, but that capability has no successful live result.
 */
export function storedRoleForProviderSlot(capability: YouCamCapability, slot: PhotoRole): string | null {
  if (capability === "hair-type" || capability === "hair-frizziness") {
    if (slot === "front") return "current_front";
    if (slot === "right") return "current_left";
    if (slot === "left") return "current_right";
    return null;
  }
  const index = CAPABILITY_CONTRACTS[capability].photos.indexOf(slot);
  if (index < 0) return null;
  return STORAGE_ROLES[capability][index] ?? null;
}

export function providerSlotAssets<T extends { role: string }>(
  capability: YouCamCapability,
  assets: readonly T[],
): { slot: PhotoRole; asset: T }[] | null {
  const assigned: { slot: PhotoRole; asset: T }[] = [];
  for (const slot of CAPABILITY_CONTRACTS[capability].photos) {
    const stored = storedRoleForProviderSlot(capability, slot);
    if (!stored) return null;
    const asset = assets.find((item) => item.role === stored);
    if (!asset) return null;
    assigned.push({ slot, asset });
  }
  return assigned;
}

export const HAIR_COLOR_PRESETS = [
  "Jet Black",
  "Chocolate Brown",
  "Honey Blonde",
  "Platinum Blonde",
  "Ash Gray",
  "Rose Gold",
  "Burgundy",
  "Copper Red",
  "Lavender",
  "Teal Blue",
  "Dark Brown/Caramel Blonde",
  "Jet Black/Silver Gray",
  "Ash Brown/Lavender",
  "Rose Gold/Peach Blonde",
  "Burgundy/Magenta Pink",
  "Deep Blue/Teal Green",
  "Plum Purple/Pastel Lilac",
  "Copper Red/Golden Blonde",
  "Dark Gray/Ice Blonde",
  "Midnight Blue/Denim Blue",
] as const;

export const HAIRSTYLE_TEMPLATE_PATH = "/s2s/v2.1/task/template/hair-transfer";
export const BEARD_TEMPLATE_PATH = "/s2s/v2.0/task/template/beard-style";
export const FEATURE_COST_PATH = "/s2s/v2.0/credit/feature-cost";
export const CREDIT_BALANCE_PATH = "/s2s/v1.0/client/credit";
export const CREDIT_HISTORY_PATH = "/s2s/v1.0/client/credit/history";

export function isYouCamCapability(value: string): value is YouCamCapability {
  return (YOUCAM_CAPABILITIES as readonly string[]).includes(value);
}

export function singleYouCamCapability(configuration: string): YouCamCapability | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration);
  } catch {
    return null;
  }
  if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string" && isYouCamCapability(parsed[0])) {
    return parsed[0];
  }
  if (typeof parsed === "object" && parsed !== null && "capability" in parsed) {
    const capability = parsed.capability;
    if (typeof capability === "string" && isYouCamCapability(capability)) return capability;
  }
  return null;
}

export function youcamLiveBlocker(capability: YouCamCapability, hosts: readonly string[]): string | null {
  if (hosts.length === 0) return "transfer_allowlist_empty";
  const blocker = CAPABILITY_CONTRACTS[capability].liveBlockers[0];
  return blocker ?? null;
}
