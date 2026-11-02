/**
 * Normalise research-import hairstyles into data/styles/haircuts.json plus generated
 * ranking copy and demo-media index. Re-run after research-import changes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const legacyByTemplate = JSON.parse(
  readFileSync(join(root, "scripts", "catalogue-legacy-ids.json"), "utf8"),
);

/** Preserve persona / test behaviour for verified YouCam template ids. */
const LEGACY_VARIANT_PATCHES = {
  all_long_straight_black: {
    title: "Long Blunt",
    requirements: {
      topCm: 40,
      frontCm: 36,
      sidesCm: 30,
      densityMin: 3,
      blunt: true,
      curl: ["1", "2a"],
    },
    reference: { kind: "youcam", templateId: "all_long_straight_black" },
  },
  female_long_boho_waves: {
    requirements: { needsExtension: true, topCm: 36, frontCm: 32, sidesCm: 28 },
    reference: { kind: "youcam", templateId: "female_long_boho_waves" },
  },
  all_short_bob: { reference: { kind: "youcam", templateId: "all_short_bob" } },
  male_short_curly: {
    requirements: { curl: ["2a", "2b", "2c", "3a", "3b", "3c"] },
    reference: { kind: "youcam", templateId: "male_short_curly" },
  },
};

const PREFERRED_LEGACY_VARIANT_BY_TEMPLATE = {
  male_textured_crop: "crop--textured-crop",
  all_tousled_waves: "flow--bro-flow",
  male_tousled_cut: "fringe--textured-fringe",
  male_short_curly: "crop--curly-crop",
  all_messy_tapered_fade: "quiff--messy-quiff",
};

// Only photos whose length class and cut match the style; middle-part-short and crew-cut were removed as mismatches.
// Template thumbnails that show different hair than the style: the card shows no photo rather than the wrong one.
const UNLINKED_THUMBNAIL_VARIANT_IDS = new Set([
  "curtains--middle-part-short", "curtains--middle-part-with-taper",
  "asian-fringe--japanese-mash-cut", "asian-fringe--mash-with-two-block",
  "undercut--disconnected-undercut", "undercut--side-swept-undercut", "undercut--undercut-fade", "undercut--undercut-fringe-forward", "undercut--shaved-sides-long-top",
]);

// Round 21: own front-facing reference photo per style (style key -> file in public/demo-media/catalog/men/).
const MEN_OWN_PHOTO_BY_KEY = JSON.parse(readFileSync(join(root, "public", "demo-media", "catalog", "men", "mapping.json"), "utf8"));
// Round 23: the same for feminine styles (style key -> file in public/demo-media/catalog/women/).
const WOMEN_OWN_PHOTO_BY_KEY = JSON.parse(readFileSync(join(root, "public", "demo-media", "catalog", "women", "mapping.json"), "utf8"));

const STYLE_DEMO_BY_VARIANT_ID = {
  "crop--french-crop": "style-french-crop.jpg",
  "curtains--90s-curtains": "style-curtain-medium.jpg",
  "flow--bro-flow": "style-bro-flow.jpg",
  "quiff--textured-quiff": "style-modern-quiff.jpg",
  "side-part--classic-side-part": "style-side-part.jpg",
  "slick-back--modern-slick-back": "style-slick-back.jpg",
  "pompadour--modern-pompadour": "style-pompadour.jpg",
  "mullet--modern-mullet": "style-modern-mullet.jpg",
  "bun-pony--top-knot": "style-man-bun.jpg",
  "crew--ivy-league": "style-ivy-league.jpg",
  "crop--textured-french-crop-low-taper": "style-french-crop.jpg",
  "crop--textured-caesar-low-taper": "style-textured-crop.jpg",
  "crop--side-swept-textured-crop": "style-textured-crop.jpg",
  "side-part--soft-side-part": "style-side-part.jpg",
  "buzz--buzz-with-skin-fade": "style-buzz-taper.jpg",
  "crop--caesar-cut": "style-caesar-short.jpg",
  "curly--curly-fade": "style-curly-top-fade.jpg",
  "taper--classic-taper": "style-low-taper.jpg",
};


/** Per-cut attributes for the masculine catalogue, derived from the research params (never from titles). */
function deriveMenAttrs(v) {
  const p = v.params ?? {};
  const top = v.approx_length_cm?.top ?? p.top ?? 8;
  const fringe = p.fringe ?? "none";
  const fade = p.fade ?? "none";
  const sideKey = p.sides ?? "g2";
  const sideLen = v.approx_length_cm?.sides ?? sideCm(sideKey);
  const volUp = ["up", "up_back", "up_center"].includes(fringe) || p.volume === "high" || ["volume", "volume_shine", "spiky", "spiky_bleach", "spiky_hard"].includes(p.tex);
  let sides;
  if (["high", "very_high", "temple", "burst", "taper_high"].includes(fade)) sides = sideKey === "skin" || sideLen <= 0.15 ? "skin" : "high";
  else if (["mid", "taper_mid", "drop"].includes(fade)) sides = "mid";
  else if (["low", "taper", "taper_low"].includes(fade)) sides = "low-taper";
  else if (sideKey === "skin" || sideLen <= 0.15) sides = "skin";
  else if (sideLen <= 1) sides = "mid";
  else sides = "scissor";
  const height = volUp ? Math.min(1, 0.55 + Math.max(0, Math.min(12, top - 6)) * 0.03) : top <= 3 ? 0.05 : Math.min(0.35, 0.08 + top * 0.02);
  const widthBySides = { skin: 0.08, high: 0.12, mid: 0.2, "low-taper": 0.3, scissor: 0.4 };
  const width = Math.min(0.6, widthBySides[sides] + (top >= 14 ? 0.08 : 0) + (volUp ? -0.05 : 0));
  const coverByFringe = { none: 0.05, back: 0.08, up: 0.08, up_back: 0.08, up_center: 0.08, swept: 0.38, side_long: 0.45, feathered: 0.45, see_through: 0.42, curtain: 0.5, comma: 0.5, choppy: 0.5, forward: 0.55, curl_forward: 0.55, blunt: 0.65, blunt_line: 0.7 };
  let fringeCover = coverByFringe[fringe] ?? 0.3;
  if (fringe === "forward" && top <= 3) fringeCover = 0.7;
  if (fringe === "forward" && p.part === "side") fringeCover = 0.4;
  let fringeType;
  if (["none", "back", "up", "up_back", "up_center"].includes(fringe)) fringeType = "none";
  else if (fringe === "curtain" || (p.part === "middle" && fringe === "forward")) fringeType = "curtain";
  else if (["swept", "side_long", "feathered"].includes(fringe) || (fringe === "forward" && p.part === "side")) fringeType = "swept";
  else if (["blunt", "blunt_line"].includes(fringe) || (fringe === "forward" && top <= 3)) fringeType = "blunt";
  else fringeType = "textured";
  const tolerance = { none: 0.8, swept: 0.8, textured: 0.6, curtain: 0.5, blunt: 0.2 }[fringeType];
  const sensitive = String(v.works_with_cowlicks ?? "").toLowerCase().startsWith("no");
  return {
    height: Math.round(height * 100) / 100,
    width: Math.round(width * 100) / 100,
    fringeCover: Math.round(fringeCover * 100) / 100,
    sides,
    fringeType,
    cowlickTolerance: Math.round((sensitive ? Math.max(0.1, tolerance - 0.2) : tolerance) * 100) / 100,
  };
}

/** Realistic French crop: a mid fade with a textured, not blunt, fringe. */
const MEN_RECORD_PATCHES = {
  "crop--french-crop": { params: { fringe: "forward", sides: "g2" }, approx_length_cm: { sides: 0.6 } },
};

/** Modern variants a barber would pick for an oval/oblong face; cloned from a research record, params changed. */
const EXTRA_MEN = [
  { id: "crop--textured-french-crop-low-taper", name: "Textured French crop with low taper", base: "crop--french-crop", template: "male_textured_crop", params: { top: 4, sides: "g2", fade: "taper_low", fringe: "choppy", tex: "texturized" } },
  { id: "crop--soft-french-crop-scissor-sides", name: "Soft French crop with scissor sides", base: "crop--french-crop", template: "male_tousled_cut", params: { top: 5, sides: "sc3", fade: "none", fringe: "choppy", tex: "texturized" } },
  { id: "two-block--korean-two-block-curtain-fringe", name: "Korean two-block with curtain fringe", base: "two-block--classic-two-block", template: "male_textured_comma", params: { top: 9, sides: "g2", fade: "taper_low", fringe: "curtain", part: "middle", tex: "texturized" } },
  { id: "curtains--short-curtains-low-taper", name: "Short curtains with low taper", base: "curtains--middle-part-with-taper", template: "male_tousled_cut", params: { top: 7, sides: "g2", fade: "taper_low", fringe: "curtain", part: "middle", tex: "texturized" } },
  { id: "crop--textured-caesar-low-taper", name: "Textured Caesar with low taper", base: "crop--caesar-cut", template: "male_textured_crop", params: { top: 3.5, sides: "g2", fade: "taper_low", fringe: "forward", tex: "texturized" } },
  { id: "crop--side-swept-textured-crop", name: "Side-swept textured crop", base: "crop--textured-crop", template: "male_textured_crop", params: { top: 5, sides: "g2", fade: "taper_low", fringe: "swept", part: "side", tex: "texturized" } },
  { id: "side-part--soft-side-part", name: "Soft side part", base: "side-part--classic-side-part", template: "male_tousled_cut", params: { top: 7, sides: "sc3", fade: "none", fringe: "swept", part: "side", tex: "texturized" } },
];

const men = JSON.parse(readFileSync(join(root, "research-import", "hairstyles-men.json"), "utf8"));
const women = JSON.parse(readFileSync(join(root, "research-import", "hairstyles-women.json"), "utf8"));
const imagesMen = JSON.parse(readFileSync(join(root, "research-import", "catalog-images.json"), "utf8"));
const imagesWomen = JSON.parse(
  readFileSync(join(root, "research-import", "catalog-images-women.json"), "utf8"),
);
const youcamIndex = JSON.parse(
  readFileSync(join(root, "public", "demo-media", "youcam", "index.json"), "utf8"),
);
const youcamCategoryById = new Map(youcamIndex.map((entry) => [entry.id, entry.category]));

const GUARD_CM = { g0: 0.15, "g0.5": 0.15, g1: 0.3, "g1.5": 0.45, g2: 0.6, g3: 1.0, g4: 1.3, skin: 0, braided: 0.5 };

function sideCm(sides) {
  if (typeof sides === "number") return sides;
  if (sides in GUARD_CM) return GUARD_CM[sides];
  if (typeof sides === "string" && sides.startsWith("sc")) return Number(sides.slice(2)) || 1;
  return 1;
}

const MEN_RESEARCH_COUNT = men.variants.length;
for (const record of men.variants) {
  const patch = MEN_RECORD_PATCHES[record.id];
  if (!patch) continue;
  record.params = { ...record.params, ...patch.params };
  record.approx_length_cm = { ...record.approx_length_cm, ...patch.approx_length_cm };
}
const extraReferenceById = new Map();
for (const extra of EXTRA_MEN) {
  const base = men.variants.find((record) => record.id === extra.base);
  if (!base) throw new Error(`Unknown base ${extra.base}`);
  const clone = structuredClone(base);
  clone.id = extra.id;
  clone.name = extra.name;
  clone.aliases = [];
  clone.reference_images = [];
  clone.params = { ...base.params, ...extra.params };
  clone.approx_length_cm = { top: extra.params.top, sides: sideCm(extra.params.sides), back: base.approx_length_cm?.back ?? 1 };
  men.variants.push(clone);
  extraReferenceById.set(extra.id, { kind: "youcam", templateId: extra.template });
}

function slugFamily(id) {
  return String(id).replace(/_/g, "-").slice(0, 40);
}

function curlFromHairTypes(types) {
  const set = new Set();
  for (const t of types ?? ["straight"]) {
    if (t === "straight") ["1", "2a", "2b"].forEach((c) => set.add(c));
    else if (t === "wavy") ["2a", "2b", "2c"].forEach((c) => set.add(c));
    else if (t === "curly") ["3a", "3b", "3c"].forEach((c) => set.add(c));
    else if (t === "coily") ["4a", "4b", "4c"].forEach((c) => set.add(c));
    else ["1", "2a", "2b", "2c", "3a"].forEach((c) => set.add(c));
  }
  return [...set];
}

function densityMin(densityText) {
  const d = String(densityText ?? "").toLowerCase();
  if (d.includes("low")) return 1;
  if (d.includes("medium-high") || d.includes("medium+")) return 3;
  return 2;
}

function geometryFromVariant(v) {
  const top = v.approx_length_cm?.top ?? v.approx_length_cm?.longest ?? v.params?.top ?? 8;
  const fringe = v.params?.fringe ?? v.params?.bangs ?? "forward";
  const fade = v.params?.fade ?? "none";
  const volUp = ["up", "up_back", "up_center"].includes(fringe) || v.params?.volume === "high";
  const hasClipperSides = v.params?.sides !== undefined || v.params?.nape === "clipper";
  const shortSides = hasClipperSides && sideCm(v.params?.sides ?? "g2") <= 0.6 && fade !== "none";
  let addsHeight = volUp ? 0.55 : top <= 3 ? 0.08 : 0.2;
  let addsWidth = shortSides ? 0.15 : top >= 14 ? 0.4 : 0.28;
  let coversForehead = [
    "forward",
    "blunt",
    "choppy",
    "comma",
    "curtain",
    "see_through",
    "blunt_line",
    "wispy",
    "side_swept",
    "micro",
  ].includes(fringe)
    ? 0.55
    : volUp
      ? 0.1
      : 0.25;
  let softensJaw = top >= 18 ? 0.35 : addsWidth >= 0.35 ? 0.2 : 0.12;
  if (top <= 1.5) {
    addsHeight = 0.05;
    addsWidth = 0.1;
    coversForehead = 0;
  }
  return {
    addsHeight: Math.min(1, Math.max(0, addsHeight)),
    addsWidth: Math.min(1, Math.max(0, addsWidth)),
    coversForehead: Math.min(1, Math.max(0, coversForehead)),
    softensJaw: Math.min(1, Math.max(0, softensJaw)),
  };
}

function compatibilityFromVariant(v) {
  const base = { oval: 0.82, round: 0.76, square: 0.78, heart: 0.8, long: 0.74 };
  for (const row of v.face_shapes_flatter ?? []) {
    const shape = normalizeFace(row.shape);
    if (shape) base[shape] = Math.min(0.98, (base[shape] ?? 0.8) + 0.08);
  }
  for (const row of v.face_shapes_avoid ?? []) {
    const shape = normalizeFace(row.shape);
    if (shape) base[shape] = Math.max(0.55, (base[shape] ?? 0.75) - 0.1);
  }
  return base;
}

function normalizeFace(raw) {
  const s = String(raw).toLowerCase();
  if (s.includes("oblong") || s.includes("long")) return "long";
  if (s.includes("round")) return "round";
  if (s.includes("square")) return "square";
  if (s.includes("heart")) return "heart";
  if (s.includes("diamond")) return "heart";
  if (s.includes("oval")) return "oval";
  return null;
}

function fitFromVariant(v) {
  const fringe = v.params?.fringe ?? v.params?.bangs ?? "forward";
  let direction = "any";
  if (["forward", "blunt", "choppy", "comma", "curtain", "see_through", "wispy"].includes(fringe)) direction = "forward";
  else if (["back", "slick"].includes(fringe)) direction = "back";
  else if (["up", "up_back", "up_center"].includes(fringe)) direction = "back";
  else if (fringe === "side" || fringe === "side_swept" || v.params?.part === "side") direction = "side";
  const cowlick =
    String(v.works_with_cowlicks ?? "").toLowerCase().startsWith("no") ? "sensitive" : "ok";
  let hairline = "either";
  if (coversForeheadGuess(v) >= 0.45) hairline = "cover";
  else if (coversForeheadGuess(v) < 0.12) hairline = "show";
  const isWomen = v.approx_length_cm?.longest !== undefined;
  const topLen = v.approx_length_cm?.top ?? v.approx_length_cm?.longest ?? 0;
  const mass =
    (isWomen ? topLen >= 45 : topLen >= 14) || String(v.density ?? "").includes("heavy")
      ? "heavy"
      : "medium";
  return { direction, cowlick, hairline, mass };
}

function coversForeheadGuess(v) {
  return geometryFromVariant(v).coversForehead;
}

function lifestyleFromVariant(v) {
  const minutes = Number(v.daily_styling_min ?? 5);
  const weeks = Array.isArray(v.barber_visit_weeks)
    ? v.barber_visit_weeks[1] ?? v.barber_visit_weeks[0]
    : Array.isArray(v.salon_visit_weeks)
      ? v.salon_visit_weeks[1] ?? v.salon_visit_weeks[0]
      : 5;
  const products = Array.isArray(v.products) ? v.products : [];
  const blowdryer = minutes >= 8 || products.some((p) => /dryer|blow/i.test(String(p)));
  return {
    stylingMinutes: Math.min(60, Math.max(1, Math.round(minutes))),
    blowdryer,
    maintenanceWeeks: Math.min(52, Math.max(1, Math.round(Number(weeks) || 5))),
  };
}

function requirementsFromVariant(v, familyDefaults) {
  const top = v.approx_length_cm?.top ?? v.approx_length_cm?.longest ?? familyDefaults.top ?? 8;
  const hasExplicitSides =
    v.approx_length_cm?.sides !== undefined ||
    v.params?.sides !== undefined ||
    familyDefaults.sides !== undefined;
  const sides = hasExplicitSides
    ? (v.approx_length_cm?.sides ?? sideCm(v.params?.sides ?? familyDefaults.sides ?? "g2"))
    : v.params?.nape === "clipper" || v.length_category === "buzz"
      ? 0.6
      : Math.max(4, Math.round(top * 0.75));
  const front = v.approx_length_cm?.fringe ?? Math.max(0, top - 1);
  const fringe = v.params?.fringe ?? v.params?.bangs ?? "";
  return {
    curl: curlFromHairTypes(v.hair_types),
    densityMin: densityMin(v.density),
    frontCm: Math.round(front * 10) / 10,
    topCm: Math.round(top * 10) / 10,
    sidesCm: Math.round(sides * 10) / 10,
    strand: ["fine", "medium", "coarse"],
    blunt: ["blunt", "blunt_line"].includes(fringe) || v.params?.perimeter === "blunt",
    needsExtension: Boolean(v.params?.extensions),
  };
}

function cleanVariantTitle(rawName) {
  if (rawName === "TWA (teeny weeny afro)") return "Teeny weeny afro";
  if (rawName === "Short natural TWA crop") return "Short natural afro crop";
  return String(rawName)
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\bTWA\b/g, "afro")
    .replace(/\s+/g, " ")
    .trim();
}

const WHY_PHRASE_BY_RAW = {
  "fringe shortens face": "softens vertical length across the forehead",
  "covers wide forehead": "gently frames a wider forehead for balanced proportions",
  "tight sides narrow the head": "keeps the sides neat and tucked in to slim the silhouette",
  "symmetry suits balanced face": "follows a clean, symmetrical outline that flatters balanced features",
  "frames cheekbones": "angles softly around the cheekbones to highlight your bone structure",
  universal: "keeps an easy, versatile silhouette that suits your natural proportions",
  "vertical volume elongates": "adds subtle lift through the crown to lengthen the silhouette",
  "height balances strong jaw": "builds soft height on top to balance a defined jawline",
  "exposes features": "opens up the face cleanly so your features take centre stage",
  "fills narrow temples": "leaves gentle fullness at the temples for a balanced outline",
  "nothing to hide": "keeps a clean, open perimeter that highlights balanced proportions",
  "strong jaw emphasised": "pairs a crisp outline with your natural jawline",
  "clean lines": "uses a neat, structured perimeter that keeps the silhouette sharp",
  "side width balances length": "adds soft fullness through the sides to balance a longer face",
  "length softens angles": "uses flowing length to soften angular corners around the jaw",
  "balanced proportions suit most cuts (CK, Cosmopolitan)":
    "keeps a balanced, easy silhouette that flatters your natural proportions",
  "length/angles/side part elongate (CK, Cosmopolitan)":
    "uses angled framing to create a longer, more balanced line",
  "soft layers/waves or curtain/side bangs soften jaw (CK, PopSugar, Cosmopolitan)":
    "uses soft movement and face-framing pieces to soften the jawline",
  "weight at jaw/lob length or soft fringe balances forehead (CK, PopSugar)":
    "places gentle fullness near the jawline to balance the forehead",
  "fringe fills forehead, chin/collarbone length adds jaw width (CK, PopSugar)":
    "frames the forehead softly while adding flattering fullness around the chin",
  "chin bob, curtain bangs and side width shorten (PopSugar, CK, Vogue)":
    "adds soft width through the sides and fringe to balance a longer face",
  "collarbone length with soft layers below jaw (PopSugar)":
    "falls gracefully past the jawline with soft layers that flatter your features",
};

const EFFECT_PHRASE_BY_RAW = {
  youthful: "keeps the outline fresh and effortless around your features",
  "hides forehead": "frames the forehead softly for a balanced profile",
  "slims face": "creates a sleeker vertical line through the sides",
  softens: "brings gentle movement that softens your features",
  "adds height": "builds light lift at the crown to flatter your proportions",
  "mature/sharp": "gives a clean, polished structure that frames the face",
  "babyface/K-style": "uses soft, airy texture to frame the face gently",
  "masculine/mature": "pairs structured sides with a clean, classic top",
  "shows head shape": "follows the natural curve of the head for a neat silhouette",
  "softens/artistic": "adds relaxed, natural movement around the cheekbones",
  "shortens forehead": "breaks up forehead length with soft front framing",
  "adds volume": "builds natural fullness and body through the crown",
  "elongates (diagonal line)": "creates a flattering diagonal line that lengthens the profile",
  "softens/frames face": "frames your face with soft, flattering movement",
  "ends look thicker": "gives the ends a fuller, healthier-looking weight line",
  elongates: "creates a clean vertical line that flatters your face shape",
};

function stylistScriptFor(v) {
  const title = cleanVariantTitle(v.name);
  const top = v.approx_length_cm?.top ?? v.approx_length_cm?.longest ?? v.params?.top ?? 8;
  const lc = v.length_category ?? "medium";
  return `${title}: ${lc} shape, about ${top} cm on top, finished for the client's texture.`;
}

function reasonForVariant(v) {
  const title = cleanVariantTitle(v.name);
  const top = Math.max(1, Math.round(v.approx_length_cm?.top ?? v.approx_length_cm?.longest ?? 8));
  const minutes = Math.max(1, Math.round(Number(v.daily_styling_min ?? 5)));
  const weeksRaw = Array.isArray(v.barber_visit_weeks)
    ? v.barber_visit_weeks[1] ?? v.barber_visit_weeks[0]
    : Array.isArray(v.salon_visit_weeks)
      ? v.salon_visit_weeks[1] ?? v.salon_visit_weeks[0]
      : 5;
  const weeks = Math.max(2, Math.round(Number(weeksRaw) || 5));
  const flatters = Array.isArray(v.face_shapes_flatter) ? v.face_shapes_flatter : [];
  const specificFlatter =
    flatters.find(
      (f) =>
        f?.why &&
        !/balanced proportions suit most cuts|universal/i.test(String(f.why)),
    ) ?? flatters[0];
  const effect = v.visual_effects?.[0];
  const mappedEffect = effect ? EFFECT_PHRASE_BY_RAW[effect] : null;
  if (mappedEffect && (!specificFlatter?.why || /balanced proportions suit most cuts|universal/i.test(String(specificFlatter.why)))) {
    return `${title} ${mappedEffect} in about ${minutes} minutes of daily styling.`;
  }
  if (specificFlatter?.why) {
    const rawWhy = specificFlatter.why.trim().replace(/\.$/, "");
    const mapped = WHY_PHRASE_BY_RAW[rawWhy];
    if (mapped && !/balanced proportions suit most cuts|universal/i.test(rawWhy)) {
      return `${title} ${mapped} while keeping daily styling around ${minutes} minutes.`;
    }
  }
  let hash = 0;
  for (const ch of String(v.id ?? title)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const templates = [
    `${title} frames your features at around ${top} cm with a clean ${minutes}-minute daily routine.`,
    `${title} shapes ${top} cm of length into soft movement that holds between ${weeks}-week salon visits.`,
    `${title} balances crown and jawline proportions while keeping daily styling near ${minutes} minutes.`,
    `${title} pairs an easy ${weeks}-week trim schedule with flattering movement around your cheekbones.`,
    `${title} uses ${top} cm of tailored length to flatter your facial outline without heavy morning upkeep.`,
    `${title} keeps a light, wearable outline around your features with roughly ${minutes} minutes of styling.`,
  ];
  return templates[hash % templates.length];
}

function listCatalogFiles(gender) {
  const dir = join(root, "public", "demo-media", "catalog", gender);
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith(".jpg")).map((f) => f.replace(/\.jpg$/, "")));
}

const catalogMen = listCatalogFiles("men");
const catalogWomen = listCatalogFiles("women");

const imageMeta = new Map();
for (const row of [...imagesMen.variants, ...imagesWomen.variants]) {
  imageMeta.set(row.variant_id, row);
}

function isGenderCompatibleYoucam(templateId, gender) {
  const category = youcamCategoryById.get(templateId);
  if (!category) return false;
  if (gender === "men") return category === "Male";
  if (gender === "women") return category === "Female";
  return true;
}

function referenceFor(variantId, v, gender) {
  const reference = referenceForRaw(variantId, v, gender);
  // A legacy shared style-*.jpg asset gives way to the style's own men's photo, so it renders as a colour-preserving reference.
  if (reference.kind === "asset" && reference.file.startsWith("style-") && MEN_OWN_PHOTO_BY_KEY[`haircut:${variantId}`]) {
    return { kind: "brief", brief: (imageMeta.get(variantId)?.prompt ?? `${v.name} hairstyle reference portrait.`).slice(0, 400) };
  }
  // A style whose template thumbnail was unlinked as a mismatch never falls back to that template for a render either.
  if (reference.kind === "youcam" && UNLINKED_THUMBNAIL_VARIANT_IDS.has(variantId)) {
    return { kind: "brief", brief: (imageMeta.get(variantId)?.prompt ?? `${v.name} hairstyle reference portrait.`).slice(0, 400) };
  }
  return reference;
}

function referenceForRaw(variantId, v, gender) {
  const catalogSet = gender === "women" ? catalogWomen : catalogMen;
  if (catalogSet.has(variantId)) {
    return { kind: "asset", file: `${variantId}.jpg` };
  }
  const meta = imageMeta.get(variantId);
  const rawTemplateId = meta?.template_match?.template_id ?? null;
  const templateId =
    rawTemplateId && isGenderCompatibleYoucam(rawTemplateId, gender) ? rawTemplateId : null;
  if (templateId && legacyByTemplate[templateId]) {
    return { kind: "youcam", templateId };
  }
  if (templateId) {
    return { kind: "youcam", templateId };
  }
  const styleDemoFile = STYLE_DEMO_BY_VARIANT_ID[variantId];
  if (styleDemoFile) {
    return { kind: "asset", file: styleDemoFile };
  }
  const prompt = meta?.prompt ?? `${v.name} hairstyle reference portrait.`;
  return { kind: "brief", brief: prompt.slice(0, 400) };
}

/** Ivy League used to publish as the legacy key crew-cut, which read like the plain Crew cut; it keeps its own id. */
const NO_LEGACY_ID_VARIANTS = new Set(["crew--ivy-league"]);

function resolveVariantId(variantId, reference, usedIds, gender) {
  let safe = variantId.replace(/[^A-Za-z0-9 _-]/g, "-").slice(0, 79);
  if (usedIds.has(`haircut:${safe}`)) {
    const suffix = gender === "women" ? "-w" : "-m";
    safe = `${safe.slice(0, 77)}${suffix}`;
  }
  const candidates = [];
  if (NO_LEGACY_ID_VARIANTS.has(variantId)) return safe;
  if (reference.kind === "youcam" && legacyByTemplate[reference.templateId]) {
    const preferred = PREFERRED_LEGACY_VARIANT_BY_TEMPLATE[reference.templateId];
    if (!preferred || preferred === variantId) {
      candidates.push(legacyByTemplate[reference.templateId]);
    }
  }
  if (reference.kind === "asset" && legacyByTemplate[`asset:${reference.file}`]) {
    candidates.push(legacyByTemplate[`asset:${reference.file}`]);
  }
  for (const id of candidates) {
    if (!usedIds.has(`haircut:${id}`)) return id;
  }
  return safe;
}

function familyMap(families, gender) {
  const map = new Map();
  for (const f of families) {
    map.set(f.id, { ...f, gender });
  }
  return map;
}

const menFamilyById = familyMap(men.families, "men");
const womenFamilyById = familyMap(women.families, "women");

const familiesOut = new Map();

const rankingReasons = {};
const mediaIndex = {};
const llmCatalogue = [];

/** App face shapes; research also uses oblong, diamond and pear. */
const APP_FACE_SHAPES = ["oval", "round", "square", "heart", "long"];
function normalizeFaceShape(raw) {
  const text = String(raw).toLowerCase();
  if (text.includes("oblong") || text.includes("long")) return "long";
  if (text.includes("round")) return "round";
  if (text.includes("square")) return "square";
  if (text.includes("heart")) return "heart";
  if (text.includes("oval")) return "oval";
  return null;
}
function faceShapeList(items) {
  const shapes = new Set();
  for (const item of items ?? []) {
    const shape = normalizeFaceShape(item.shape);
    if (shape) shapes.add(shape);
  }
  return APP_FACE_SHAPES.filter((shape) => shapes.has(shape));
}

/** One compact record per style for the LLM ranking step: what the cut is and who it suits, with no marketing copy. */
function llmRecord({ key, variantId, familyId, research, entry, gender, image }) {
  const flatter = faceShapeList(research.face_shapes_flatter);
  const avoided = faceShapeList(research.face_shapes_avoid);
  // A shape listed on both sides is ambiguous: leave it out of both lists (the raw notes keep the detail).
  const suits = flatter.filter((shape) => !avoided.includes(shape));
  const avoid = avoided.filter((shape) => !flatter.includes(shape));
  const effects = research.visual_effects ?? [];
  const card = research.barber_card ?? research.stylist_card ?? {};
  const length = research.approx_length_cm ?? {};
  const topCm = length.top ?? length.longest ?? entry.requirements?.topCm ?? null;
  const hairTypes = research.hair_types ?? [];
  const description = [
    `${entry.title}: a ${research.length_category ?? "medium"} ${gender === "women" ? "feminine" : "masculine"} cut${topCm !== null ? `, about ${topCm} cm on top or longest` : ""}.`,
    hairTypes.length ? `Works on ${hairTypes.join(", ")} hair, density ${research.density ?? "any"}.` : null,
    effects.length ? `Effect: ${effects.join(", ")}.` : null,
    suits.length ? `Flatters ${suits.join(", ")} faces.` : null,
    avoid.length ? `Avoid on ${avoid.join(", ")} faces.` : null,
    `Styling about ${entry.lifestyle?.stylingMinutes ?? research.daily_styling_min ?? 5} min a day, visit every ${(research.salon_visit_weeks ?? research.barber_visit_weeks ?? [4, 6]).join("-")} weeks.`,
  ].filter(Boolean).join(" ");
  return {
    key,
    id: variantId,
    title: entry.title,
    gender: gender === "women" ? "feminine" : "masculine",
    family: familyId,
    image,
    description,
    suitsFaceShapes: suits,
    avoidFaceShapes: avoid,
    faceShapeNotes: [...(research.face_shapes_flatter ?? []).map((item) => ({ shape: item.shape, suits: true, why: item.why })), ...(research.face_shapes_avoid ?? []).map((item) => ({ shape: item.shape, suits: false, why: item.why }))],
    faceShapeScores: entry.compatibility,
    hairTypes,
    curlCodes: entry.requirements?.curl ?? [],
    densityNeeded: research.density ?? "any",
    densityMin: entry.requirements?.densityMin ?? null,
    lengthCm: { front: entry.requirements?.frontCm ?? null, top: entry.requirements?.topCm ?? null, sides: entry.requirements?.sidesCm ?? null },
    lengthCategory: research.length_category ?? null,
    visualEffects: effects,
    cowlicks: research.works_with_cowlicks ?? null,
    stylingMinutes: entry.lifestyle?.stylingMinutes ?? null,
    maintenance: research.maintenance ?? null,
    maintenanceWeeks: entry.lifestyle?.maintenanceWeeks ?? null,
    brief: card,
  };
}
const seenKeys = new Set();

function affinityFor(genderPresentation) {
  if (genderPresentation === "women") return "feminine";
  if (genderPresentation === "men") return "masculine";
  return "either";
}

for (const source of [
  { variants: men.variants, gender: "men" },
  { variants: women.variants, gender: "women" },
]) {
  for (const v of source.variants) {
    const familyRaw = v.family;
    const familyId = slugFamily(familyRaw);
    const fam =
      source.gender === "women" ? womenFamilyById.get(familyRaw) : menFamilyById.get(familyRaw);
    if (!fam) throw new Error(`Unknown family ${familyRaw} for ${v.id}`);
    const pd = fam.param_defaults ?? {};
    const variantAffinity = source.gender === "women" ? "feminine" : "masculine";
    if (!familiesOut.has(familyId)) {
      const stub = {
        name: fam.name,
        params: pd,
        hair_types: fam.hair_types,
        approx_length_cm: { top: pd.top, sides: sideCm(pd.sides), back: pd.back ?? pd.top },
        face_shapes_flatter: [],
        face_shapes_avoid: [],
        daily_styling_min: 5,
        barber_visit_weeks: [4, 6],
        density: "medium",
        works_with_cowlicks: "yes",
        length_category: "medium",
      };
      familiesOut.set(familyId, {
        id: familyId,
        service: "haircut",
        affinity: affinityFor(fam.gender_presentation ?? source.gender),
        defaults: {
          requirements: requirementsFromVariant(stub, pd),
          geometry: geometryFromVariant(stub),
          compatibility: { oval: 0.85, round: 0.76, square: 0.78, heart: 0.8, long: 0.74 },
          lifestyle: lifestyleFromVariant(stub),
          bodyHint: fam.notes ? String(fam.notes).slice(0, 180) : null,
          beardFullness: null,
          fit: fitFromVariant(stub),
        },
        variants: [],
      });
    } else if (familiesOut.get(familyId).affinity !== variantAffinity) {
      familiesOut.get(familyId).affinity = "either";
    }
    const reference = extraReferenceById.get(v.id) ?? referenceFor(v.id, v, source.gender);
    const variantId = extraReferenceById.has(v.id) ? v.id : resolveVariantId(v.id, reference, seenKeys, source.gender);
    const key = `haircut:${variantId}`;
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate key ${key} from research id ${v.id}`);
    }
    seenKeys.add(key);
    let entry = {
      id: variantId,
      title: cleanVariantTitle(v.name),
      affinity: variantAffinity,
      requirements: requirementsFromVariant(v, pd),
      geometry: geometryFromVariant(v),
      compatibility: compatibilityFromVariant(v),
      lifestyle: lifestyleFromVariant(v),
      fit: fitFromVariant(v),
      reference,
      stylistScript: stylistScriptFor(v),
    };
    const patch = LEGACY_VARIANT_PATCHES[variantId];
    if (patch) {
      entry = {
        ...entry,
        ...patch,
        requirements: { ...entry.requirements, ...(patch.requirements ?? {}) },
      };
    }
    if (variantAffinity === "masculine") {
      const attrs = deriveMenAttrs(v);
      entry.attrs = attrs;
      entry.geometry = { ...entry.geometry, addsHeight: attrs.height, addsWidth: attrs.width, coversForehead: attrs.fringeCover };
    }
    familiesOut.get(familyId).variants.push(entry);
    rankingReasons[key] = { reason: reasonForVariant(v, variantId) };
    let demoPath = null;
    const styleDemoOverride = STYLE_DEMO_BY_VARIANT_ID[v.id];
    if (styleDemoOverride && variantId === v.id) {
      const styleAsset = join(root, "public", "demo-media", styleDemoOverride);
      if (existsSync(styleAsset)) demoPath = styleDemoOverride;
    }
    if (!demoPath && reference.kind === "youcam") {
      const youcamFile = join(root, "public", "demo-media", "youcam", `${reference.templateId}.jpg`);
      if (existsSync(youcamFile)) demoPath = `youcam/${reference.templateId}.jpg`;
    } else if (!demoPath && reference.kind === "asset") {
      const gender = source.gender;
      const cat = join(root, "public", "demo-media", "catalog", gender, reference.file);
      const assets = join(root, "public", "demo-media", reference.file);
      if (existsSync(cat)) demoPath = `catalog/${gender}/${reference.file}`;
      else if (existsSync(assets)) demoPath = reference.file;
    }
    mediaIndex[key] = UNLINKED_THUMBNAIL_VARIANT_IDS.has(v.id) && demoPath?.startsWith("youcam/") ? null : demoPath;
    for (const [gender, byKey] of [["men", MEN_OWN_PHOTO_BY_KEY], ["women", WOMEN_OWN_PHOTO_BY_KEY]]) {
      const ownPhoto = byKey[key];
      if (!ownPhoto) continue;
      if (!existsSync(join(root, "public", "demo-media", "catalog", gender, ownPhoto))) throw new Error(`Missing ${gender} photo ${ownPhoto} for ${key}`);
      mediaIndex[key] = `catalog/${gender}/${ownPhoto}`;
    }
    llmCatalogue.push(llmRecord({ key, variantId, familyId, research: v, entry, gender: source.gender, image: mediaIndex[key] }));
  }
}

const families = [...familiesOut.values()].sort((a, b) => a.id.localeCompare(b.id));
const variantCount = families.reduce((n, f) => n + f.variants.length, 0);
if (variantCount !== 535 + EXTRA_MEN.length) {
  throw new Error(`Expected ${535 + EXTRA_MEN.length} variants, got ${variantCount}`);
}

const menCount = MEN_RESEARCH_COUNT;
const womenCount = women.variants.length;
if (menCount !== 256 || womenCount !== 279) {
  throw new Error(`Unexpected research counts: men ${menCount}, women ${womenCount}`);
}

const outHaircuts = { families };
const dataDir = join(root, "data", "styles");
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "haircuts.json"), JSON.stringify(outHaircuts, null, 2));
writeFileSync(
  join(root, "src", "shared", "haircuts.catalogue.json"),
  JSON.stringify(outHaircuts, null, 2),
);

writeFileSync(
  join(root, "src", "shared", "ranking-reasons.generated.json"),
  JSON.stringify(rankingReasons, null, 2),
);
writeFileSync(
  join(root, "src", "shared", "catalogue-media.generated.json"),
  JSON.stringify(mediaIndex, null, 2),
);

if (llmCatalogue.length !== variantCount) throw new Error(`LLM catalogue has ${llmCatalogue.length} records, expected ${variantCount}`);
llmCatalogue.sort((a, b) => a.key.localeCompare(b.key));
const llmJson = JSON.stringify({ version: 1, count: llmCatalogue.length, styles: llmCatalogue }, null, 2);
writeFileSync(join(dataDir, "haircuts-llm.json"), llmJson);
writeFileSync(join(root, "src", "shared", "haircuts.llm.json"), llmJson);

const hash = createHash("sha256").update(JSON.stringify(outHaircuts)).digest("hex").slice(0, 12);
console.log(`haircuts catalogue: ${families.length} families, ${variantCount} variants (sha ${hash})`);
console.log(`demo-media mapped: ${Object.values(mediaIndex).filter(Boolean).length} of ${variantCount}`);
