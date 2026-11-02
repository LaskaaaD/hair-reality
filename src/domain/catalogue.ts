// Hand-reviewed tags for provider template ids already verified in the account catalogue.
// Template thumbnails were not stored (the saved fixture redacts them), so this file is the
// reviewed source of truth. scripts/tag-catalogue.ts checks the invariants and can refresh tags
// only when a local thumbnail manifest and TAG_CATALOGUE_LIVE=1 are both present.

export type ServiceKind = "haircut" | "colour" | "beard";
export type LengthBand = "above-ears" | "ear" | "short" | "chest" | "long";
export type Texture = "straight" | "wavy" | "curly" | "coily";
export type FaceShape = "oval" | "round" | "square" | "heart" | "long";
export type BeardFullness = "none" | "light" | "medium" | "full";

export type StyleCandidate = {
  key: string;
  service: ServiceKind;
  title: string;
  providerReference: string | null;
  preset: string | null;
  presentation: "masculine" | "feminine" | "either";
  length: LengthBand | null;
  texture: Texture | null;
  fringe: boolean;
  layers: boolean;
  maintenance: "low" | "moderate" | "high";
  minCurrentLength: LengthBand | null;
  needsExtension: boolean;
  blunt: boolean;
  dailyHeat: boolean;
  faceBonus: readonly FaceShape[];
  colourLevel: number | null;
  swatch: string | null;
  beardFullness: BeardFullness | null;
};

const haircut = (
  id: string,
  title: string,
  fields: Pick<StyleCandidate, "presentation" | "length" | "texture" | "fringe" | "layers" | "maintenance" | "minCurrentLength" | "needsExtension" | "blunt" | "dailyHeat" | "faceBonus">,
): StyleCandidate => ({
  key: `haircut:${id}`,
  service: "haircut",
  title,
  providerReference: id,
  preset: null,
  colourLevel: null,
  swatch: null,
  beardFullness: null,
  ...fields,
});

const beard = (
  id: string,
  title: string,
  fullness: BeardFullness,
  maintenance: StyleCandidate["maintenance"],
  faceBonus: readonly FaceShape[],
): StyleCandidate => ({
  key: `beard:${id}`,
  service: "beard",
  title,
  providerReference: id,
  preset: null,
  presentation: "masculine",
  length: null,
  texture: null,
  fringe: false,
  layers: false,
  maintenance,
  minCurrentLength: null,
  needsExtension: false,
  blunt: false,
  dailyHeat: false,
  faceBonus,
  colourLevel: null,
  swatch: null,
  beardFullness: fullness,
});

const colour = (preset: string, level: number, swatch: string): StyleCandidate => ({
  key: `colour:${preset}`,
  service: "colour",
  title: preset,
  providerReference: null,
  preset,
  presentation: "either",
  length: null,
  texture: null,
  fringe: false,
  layers: false,
  maintenance: level >= 8 ? "high" : "moderate",
  minCurrentLength: null,
  needsExtension: false,
  blunt: false,
  dailyHeat: false,
  faceBonus: [],
  colourLevel: level,
  swatch,
  beardFullness: null,
});

export const styleCatalogue: readonly StyleCandidate[] = [
  haircut("male_short_curly", "Short Curly", {
    presentation: "masculine", length: "short", texture: "curly", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["round", "square"],
  }),
  haircut("male_gray_taper_fade", "Taper Fade", {
    presentation: "masculine", length: "above-ears", texture: "straight", fringe: false, layers: false,
    maintenance: "low", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["square", "oval"],
  }),
  haircut("male_textured_crop", "Textured Crop", {
    presentation: "masculine", length: "above-ears", texture: "straight", fringe: true, layers: true,
    maintenance: "low", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["round", "square"],
  }),
  haircut("male_textured_comma", "Textured Comma", {
    presentation: "masculine", length: "short", texture: "wavy", fringe: true, layers: true,
    maintenance: "moderate", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "heart"],
  }),
  haircut("male_afro", "Afro", {
    presentation: "masculine", length: "short", texture: "coily", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["round", "oval"],
  }),
  haircut("male_bald", "Bald", {
    presentation: "masculine", length: "above-ears", texture: "straight", fringe: false, layers: false,
    maintenance: "low", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "square", "long"],
  }),
  haircut("male_wavy_undercut", "Wavy Undercut", {
    presentation: "masculine", length: "short", texture: "wavy", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "ear", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["square", "oval"],
  }),
  haircut("male_tousled_cut", "Tousled Cut", {
    presentation: "masculine", length: "short", texture: "wavy", fringe: false, layers: true,
    maintenance: "low", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "round"],
  }),
  haircut("all_short_bob", "Short Bob", {
    presentation: "feminine", length: "short", texture: "straight", fringe: true, layers: true,
    maintenance: "low", minCurrentLength: "ear", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "heart"],
  }),
  haircut("all_short_feather_cut", "Short Feather Cut", {
    presentation: "feminine", length: "short", texture: "wavy", fringe: false, layers: true,
    maintenance: "low", minCurrentLength: "above-ears", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "square"],
  }),
  haircut("female_bobcut_curly", "Curly Bob", {
    presentation: "feminine", length: "short", texture: "curly", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "ear", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["round", "heart"],
  }),
  haircut("female_medium_straight", "Medium Straight", {
    presentation: "feminine", length: "chest", texture: "straight", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "short", needsExtension: false, blunt: false, dailyHeat: true,
    faceBonus: ["long", "oval"],
  }),
  haircut("all_medium_curve_hair", "Medium Curve", {
    presentation: "feminine", length: "chest", texture: "wavy", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "short", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "square"],
  }),
  haircut("female_long_wavy", "Long Wavy", {
    presentation: "feminine", length: "long", texture: "wavy", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "long", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "long"],
  }),
  haircut("female_long_straight", "Long Straight", {
    presentation: "feminine", length: "long", texture: "straight", fringe: false, layers: false,
    maintenance: "high", minCurrentLength: "long", needsExtension: false, blunt: true, dailyHeat: true,
    faceBonus: ["long"],
  }),
  haircut("female_long_spiral_curls", "Long Spiral Curls", {
    presentation: "feminine", length: "long", texture: "curly", fringe: false, layers: true,
    maintenance: "high", minCurrentLength: "long", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval"],
  }),
  haircut("female_long_boho_waves", "Long Boho Waves", {
    presentation: "feminine", length: "long", texture: "wavy", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "chest", needsExtension: true, blunt: false, dailyHeat: false,
    faceBonus: ["oval", "heart"],
  }),
  haircut("all_long_straight_black", "Long Blunt", {
    presentation: "feminine", length: "long", texture: "straight", fringe: false, layers: false,
    maintenance: "high", minCurrentLength: "long", needsExtension: false, blunt: true, dailyHeat: true,
    faceBonus: ["long"],
  }),
  haircut("all_long_wavy_blonde", "Long Wavy Blonde", {
    presentation: "feminine", length: "long", texture: "wavy", fringe: false, layers: true,
    maintenance: "moderate", minCurrentLength: "long", needsExtension: false, blunt: false, dailyHeat: false,
    faceBonus: ["oval"],
  }),
  beard("all_shaved", "Shaved", "none", "low", ["oval", "round", "square", "heart", "long"]),
  beard("all_mustache", "Mustache", "light", "low", ["oval", "long"]),
  beard("all_soul_patch", "Soul Patch", "light", "low", ["oval"]),
  beard("all_goatee", "Goatee", "medium", "low", ["round", "oval"]),
  beard("all_anchor", "Anchor", "medium", "moderate", ["square", "oval"]),
  beard("all_circle", "Circle Beard", "medium", "moderate", ["round", "square"]),
  beard("all_chin_curtain", "Chin Curtain", "medium", "moderate", ["long"]),
  beard("all_mutton_chops", "Mutton Chops", "medium", "moderate", ["long", "square"]),
  beard("all_bandholz", "Bandholz", "full", "high", ["oval", "long"]),
  beard("all_long_bandholz", "Long Bandholz", "full", "high", ["long"]),
  beard("all_garibaldi", "Garibaldi", "full", "high", ["oval"]),
  beard("all_ducktail", "Ducktail", "full", "high", ["long", "oval"]),
  colour("Jet Black", 1, "#1b1b1b"),
  colour("Chocolate Brown", 3, "#4a2c1a"),
  colour("Burgundy", 4, "#6e2430"),
  colour("Copper Red", 6, "#b65a33"),
  colour("Honey Blonde", 7, "#c4a574"),
  colour("Ash Gray", 7, "#b7b7b7"),
  colour("Rose Gold", 8, "#c48b8b"),
  colour("Platinum Blonde", 10, "#f3efe4"),
];

export function candidatesFor(service: ServiceKind): readonly StyleCandidate[] {
  return styleCatalogue.filter((entry) => entry.service === service);
}

export function candidateByKey(key: string): StyleCandidate | null {
  return styleCatalogue.find((entry) => entry.key === key) ?? null;
}
