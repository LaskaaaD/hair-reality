const faces = { oval: 0.9, round: 0.72, square: 0.78, heart: 0.84, long: 0.62 };
const straight = ["1", "2a", "2b"] as const;
const wavy = ["2a", "2b", "2c"] as const;

type Fit = {
  direction: "forward" | "side" | "back" | "any";
  cowlick: "sensitive" | "ok";
  hairline: "cover" | "either" | "show";
  mass: "light" | "medium" | "heavy";
};

type Cut = {
  id: string;
  title: string;
  top: number;
  front: number;
  sides: number;
  curl?: readonly string[];
  minutes: number;
  dryer: boolean;
  weeks: number;
  height: number;
  width: number;
  fringe: number;
  fit: Fit;
  script: string;
  template?: string;
  longFace?: number;
};

const cuts: Cut[] = [
  { id: "side-swept-fringe", title: "Side-Swept Fringe", top: 8, front: 7, sides: 2, minutes: 6, dryer: false, weeks: 5, height: 0.15, width: 0.35, fringe: 0.7, fit: { direction: "forward", cowlick: "sensitive", hairline: "cover", mass: "light" }, longFace: 0.92, script: "Side-swept fringe, top 7-9 cm, low taper, fringe across the forehead." },
  { id: "textured-fringe", title: "Textured Fringe", top: 7, front: 6, sides: 2, minutes: 5, dryer: false, weeks: 5, height: 0.12, width: 0.32, fringe: 0.65, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "light" }, longFace: 0.9, script: "Textured fringe, top 6-8 cm, low taper, piecey not blunt." },
  { id: "mop-top", title: "Mop Top", top: 12, front: 10, sides: 8, minutes: 4, dryer: false, weeks: 8, height: 0.1, width: 0.4, fringe: 0.75, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "medium" }, longFace: 0.86, script: "Mop top, rounded fringe, top 10-14 cm, sides left longer." },
  { id: "caesar", title: "Caesar", top: 3, front: 2, sides: 1, minutes: 2, dryer: false, weeks: 3, height: 0.05, width: 0.2, fringe: 0.8, fit: { direction: "forward", cowlick: "sensitive", hairline: "cover", mass: "light" }, script: "Caesar, short forward fringe, top about 3 cm, tight sides." },
  { id: "comma-fringe", title: "Comma Fringe", top: 6, front: 5, sides: 2, curl: wavy, minutes: 5, dryer: false, weeks: 5, height: 0.15, width: 0.28, fringe: 0.6, fit: { direction: "side", cowlick: "sensitive", hairline: "cover", mass: "light" }, script: "Comma fringe, one curved piece over the brow, top 5-7 cm." },
  { id: "scissor-fringe", title: "Scissor Fringe", top: 8, front: 7, sides: 3, minutes: 6, dryer: true, weeks: 6, height: 0.12, width: 0.3, fringe: 0.6, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "medium" }, script: "Scissor-cut fringe, top 7-9 cm, natural sides, no skin fade." },
  { id: "bro-flow", title: "Bro Flow", top: 16, front: 12, sides: 4, minutes: 5, dryer: false, weeks: 8, height: 0.2, width: 0.4, fringe: 0.45, fit: { direction: "forward", cowlick: "ok", hairline: "either", mass: "medium" }, template: "all_tousled_waves", script: "Bro flow, medium length pushed back or parted, top at least 14 cm." },
  { id: "messy-side-part", title: "Messy Side Part", top: 8, front: 6, sides: 3, minutes: 6, dryer: true, weeks: 5, height: 0.2, width: 0.25, fringe: 0.3, fit: { direction: "side", cowlick: "ok", hairline: "either", mass: "medium" }, script: "Messy side part, top 7-9 cm, lived-in, not slicked." },
  { id: "long-ivy", title: "Long Ivy", top: 10, front: 6, sides: 3, minutes: 6, dryer: true, weeks: 6, height: 0.15, width: 0.22, fringe: 0.25, fit: { direction: "side", cowlick: "ok", hairline: "either", mass: "medium" }, script: "Longer Ivy, side part, top about 10 cm, tapered neck." },
  { id: "executive-side", title: "Executive Side Part", top: 6, front: 4, sides: 2, minutes: 8, dryer: true, weeks: 4, height: 0.15, width: 0.18, fringe: 0.1, fit: { direction: "side", cowlick: "ok", hairline: "show", mass: "medium" }, script: "Executive side part, neat, top 5-7 cm, short scissor sides." },
  { id: "short-shag", title: "Short Shag", top: 10, front: 8, sides: 4, curl: wavy, minutes: 4, dryer: false, weeks: 8, height: 0.15, width: 0.45, fringe: 0.45, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "medium" }, template: "all_face_framing_shag_cut", script: "Short shag, choppy layers, top about 10 cm, soft face frame." },
  { id: "layered-flow", title: "Layered Flow", top: 14, front: 10, sides: 6, minutes: 5, dryer: false, weeks: 8, height: 0.18, width: 0.4, fringe: 0.35, fit: { direction: "forward", cowlick: "ok", hairline: "either", mass: "medium" }, script: "Layered medium flow, top 12-16 cm, movement through the ends." },
  { id: "mini-quiff", title: "Mini Quiff", top: 7, front: 4, sides: 2, minutes: 8, dryer: true, weeks: 5, height: 0.45, width: 0.22, fringe: 0.15, fit: { direction: "back", cowlick: "ok", hairline: "show", mass: "medium" }, script: "Mini quiff, small front lift, top 6-8 cm, short sides." },
  { id: "comb-over", title: "Comb Over", top: 8, front: 5, sides: 2, minutes: 7, dryer: true, weeks: 5, height: 0.15, width: 0.3, fringe: 0.4, fit: { direction: "side", cowlick: "sensitive", hairline: "cover", mass: "medium" }, script: "Comb-over, hair directed across the forehead, top 7-9 cm." },
  { id: "soft-bowl", title: "Soft Bowl", top: 8, front: 6, sides: 5, minutes: 4, dryer: false, weeks: 6, height: 0.08, width: 0.42, fringe: 0.8, fit: { direction: "forward", cowlick: "sensitive", hairline: "cover", mass: "medium" }, script: "Softened bowl, rounded fringe, sides left long enough to bend." },
  { id: "regulation", title: "Regulation", top: 3, front: 2, sides: 1, minutes: 2, dryer: false, weeks: 3, height: 0.05, width: 0.1, fringe: 0.05, fit: { direction: "any", cowlick: "ok", hairline: "show", mass: "light" }, script: "Regulation cut, top about 3 cm, tight taper, no style product required." },
  { id: "disconnected-crop", title: "Disconnected Crop", top: 6, front: 5, sides: 1, minutes: 5, dryer: false, weeks: 4, height: 0.15, width: 0.28, fringe: 0.55, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "light" }, script: "Disconnected crop, textured top, skin-short sides, short fringe." },
  { id: "low-quiff", title: "Low Quiff", top: 8, front: 4, sides: 2, minutes: 10, dryer: true, weeks: 5, height: 0.5, width: 0.22, fringe: 0.1, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, script: "Low quiff, controlled front lift, top 7-9 cm, needs a dryer." },
  { id: "high-quiff", title: "High Quiff", top: 12, front: 5, sides: 2, minutes: 12, dryer: true, weeks: 4, height: 0.85, width: 0.22, fringe: 0.05, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, longFace: 0.35, script: "High quiff, strong front height, top 10-14 cm, short sides." },
  { id: "classic-pompadour", title: "Classic Pompadour", top: 12, front: 4, sides: 2, minutes: 15, dryer: true, weeks: 4, height: 0.9, width: 0.25, fringe: 0.05, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, longFace: 0.3, script: "Classic pompadour, hair lifted back off the forehead, top at least 12 cm." },
  { id: "low-pompadour", title: "Low Pompadour", top: 8, front: 4, sides: 2, minutes: 12, dryer: true, weeks: 5, height: 0.55, width: 0.22, fringe: 0.08, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, script: "Low pompadour, modest height, top 8-10 cm, product and dryer." },
  { id: "slick-back", title: "Slick Back", top: 8, front: 3, sides: 2, minutes: 10, dryer: true, weeks: 5, height: 0.25, width: 0.15, fringe: 0, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, longFace: 0.4, script: "Slick back, forehead clear, top 7-10 cm, needs product." },
  { id: "slick-undercut", title: "Slick Undercut", top: 8, front: 3, sides: 1, minutes: 10, dryer: true, weeks: 4, height: 0.3, width: 0.15, fringe: 0, fit: { direction: "back", cowlick: "sensitive", hairline: "show", mass: "heavy" }, script: "Slick undercut, disconnected short sides, top combed back." },
  { id: "faux-hawk", title: "Faux Hawk", top: 8, front: 3, sides: 1, minutes: 8, dryer: true, weeks: 4, height: 0.55, width: 0.12, fringe: 0.05, fit: { direction: "back", cowlick: "ok", hairline: "show", mass: "medium" }, script: "Faux hawk, narrow lifted strip, short sides, top 6-9 cm." },
  { id: "high-and-tight", title: "High and Tight", top: 2, front: 1, sides: 0.5, minutes: 1, dryer: false, weeks: 2, height: 0.05, width: 0.08, fringe: 0, fit: { direction: "any", cowlick: "ok", hairline: "show", mass: "light" }, script: "High and tight, very short sides, slightly longer top." },
  { id: "flat-top", title: "Flat Top", top: 4, front: 2, sides: 1, minutes: 8, dryer: true, weeks: 3, height: 0.2, width: 0.3, fringe: 0.05, fit: { direction: "any", cowlick: "sensitive", hairline: "show", mass: "heavy" }, script: "Flat top, squared crown, needs density and a clipper finish." },
  { id: "burst-mullet", title: "Burst Mullet", top: 12, front: 8, sides: 2, minutes: 6, dryer: true, weeks: 6, height: 0.35, width: 0.25, fringe: 0.3, fit: { direction: "back", cowlick: "ok", hairline: "either", mass: "medium" }, script: "Burst mullet, short sides, longer nape, top 10-14 cm." },
  { id: "center-flow", title: "Center Part Flow", top: 18, front: 14, sides: 10, minutes: 5, dryer: false, weeks: 10, height: 0.1, width: 0.45, fringe: 0.4, fit: { direction: "forward", cowlick: "ok", hairline: "cover", mass: "medium" }, script: "Center part, medium-long, top at least 16 cm, soft ends." },
  { id: "messy-taper", title: "Messy Taper", top: 6, front: 4, sides: 2, minutes: 4, dryer: false, weeks: 5, height: 0.15, width: 0.28, fringe: 0.35, fit: { direction: "forward", cowlick: "ok", hairline: "either", mass: "light" }, template: "all_messy_tapered_fade", script: "Messy taper, textured top 5-7 cm, low fade, no hard part." },
];

export const extraMaleFamilies = cuts.map((cut) => ({
  id: cut.id,
  service: "haircut" as const,
  affinity: "masculine" as const,
  defaults: {
    requirements: {
      curl: cut.curl ?? straight,
      densityMin: cut.fit.mass === "heavy" ? 3 : 2,
      frontCm: cut.front,
      topCm: cut.top,
      sidesCm: cut.sides,
      strand: ["fine", "medium", "coarse"],
      blunt: false,
      needsExtension: false,
    },
    geometry: { addsHeight: cut.height, addsWidth: cut.width, coversForehead: cut.fringe, softensJaw: 0.15 },
    compatibility: { ...faces, ...(cut.longFace ? { long: cut.longFace } : {}) },
    lifestyle: { stylingMinutes: cut.minutes, blowdryer: cut.dryer, maintenanceWeeks: cut.weeks },
    bodyHint: null,
    beardFullness: null,
    fit: cut.fit,
  },
  variants: [{
    id: cut.id,
    title: cut.title,
    stylistScript: cut.script,
    reference: cut.template ? { kind: "youcam" as const, templateId: cut.template } : { kind: "asset" as const, file: `${cut.id}.jpg` },
  }],
}));
