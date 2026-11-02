import { HAIR_COLOR_PRESETS } from "../providers/youcam/contract.js";
import type { ServiceKind } from "../../shared/consultations.js";

export type CatalogueSeed = {
  key: string;
  serviceKind: ServiceKind;
  title: string;
  provenance: "youcam" | "fixture";
  providerReference: string | null;
  length: "short" | "medium" | "long" | "unknown";
  texture: "straight" | "wavy" | "curly" | "unknown";
  configuration: Record<string, string>;
};

const haircutIds = [
  ["male_short_curly", "Short Curly", "short", "curly"],
  ["all_short_bob", "Short Bob", "short", "unknown"],
  ["all_short_feather_cut", "Short Feather Cut", "short", "unknown"],
  ["female_bobcut_curly", "Bobcut Curly", "unknown", "curly"],
  ["female_medium_straight", "Medium Straight", "medium", "straight"],
  ["all_medium_curve_hair", "Medium Curve Hair", "medium", "unknown"],
  ["female_long_wavy", "Long Wavy", "long", "wavy"],
  ["female_long_straight", "Long Straight", "long", "straight"],
  ["female_long_spiral_curls", "Long Spiral Curls", "long", "curly"],
  ["female_long_boho_waves", "Long Boho Waves", "long", "wavy"],
  ["all_long_straight_black", "Long Straight Black", "long", "straight"],
  ["all_long_wavy_blonde", "Long Wavy Blonde", "long", "wavy"],
] as const;

const beardIds = [
  ["all_shaved", "Shaved"],
  ["all_anchor", "Anchor"],
  ["all_circle", "Circle"],
  ["all_mustache", "Mustache"],
  ["all_goatee", "Goatee"],
  ["all_bandholz", "Bandholz"],
] as const;

const colourPresets = [
  "Jet Black",
  "Chocolate Brown",
  "Honey Blonde",
  "Platinum Blonde",
  "Ash Gray",
  "Rose Gold",
] as const;

export const verifiedTemplateIds = {
  haircut: haircutIds.map((row) => row[0]),
  beard: beardIds.map((row) => row[0]),
};

export const catalogueSeed: readonly CatalogueSeed[] = [
  ...haircutIds.map((row) => template("haircut", row[0], row[1], row[2], row[3])),
  ...beardIds.map((row) => template("beard", row[0], row[1], "unknown", "unknown")),
  ...colourPresets.map((preset) => ({
    key: `colour:${preset}`,
    serviceKind: "colour" as const,
    title: preset,
    provenance: "fixture" as const,
    providerReference: null,
    length: "unknown" as const,
    texture: "unknown" as const,
    configuration: { preset },
  })),
];

export function catalogueBindingError(entry: CatalogueSeed): string | null {
  const keys = Object.keys(entry.configuration);
  if (keys.some((key) => key === "prompt" || key === "density" || key === "exactLength")) return "unsupported control";
  if (entry.serviceKind === "colour") {
    if (entry.provenance !== "fixture" || entry.providerReference !== null) return "colour binding";
    if (keys.length !== 1 || !(colourPresets as readonly string[]).includes(entry.configuration.preset ?? "")) return "colour preset";
    if (!(HAIR_COLOR_PRESETS as readonly string[]).includes(entry.configuration.preset ?? "")) return "unknown preset";
    return null;
  }
  const reference = entry.providerReference;
  if (entry.provenance !== "youcam" || reference === null || reference.startsWith("synthetic-template-")) return "template binding";
  const allowed = (entry.serviceKind === "haircut" ? verifiedTemplateIds.haircut : verifiedTemplateIds.beard) as readonly string[];
  if (!allowed.includes(reference) || entry.configuration.template_id !== reference || keys.length !== 1) return "template configuration";
  return null;
}

const counts = {
  haircut: catalogueSeed.filter((entry) => entry.serviceKind === "haircut").length,
  colour: catalogueSeed.filter((entry) => entry.serviceKind === "colour").length,
  beard: catalogueSeed.filter((entry) => entry.serviceKind === "beard").length,
};
if (counts.haircut !== 12 || counts.colour !== 6 || counts.beard !== 6) {
  throw new Error("Catalogue coverage is incomplete");
}
const invalid = catalogueSeed.map((entry) => catalogueBindingError(entry)).find((error) => error !== null);
if (invalid) throw new Error(`Catalogue binding is not supported: ${invalid}`);

function template(
  serviceKind: "haircut" | "beard",
  id: string,
  title: string,
  length: CatalogueSeed["length"],
  texture: CatalogueSeed["texture"],
): CatalogueSeed {
  return {
    key: `${serviceKind}:${id}`,
    serviceKind,
    title,
    provenance: "youcam",
    providerReference: id,
    length,
    texture,
    configuration: { template_id: id },
  };
}
