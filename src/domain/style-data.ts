import haircutsCatalogue from "../shared/haircuts.catalogue.json" with { type: "json" };

const faces = { oval: 0.9, round: 0.75, square: 0.8, heart: 0.85, long: 0.8 };
const anyStrand = ["fine", "medium", "coarse"] as const;

function variant(
  id: string,
  title: string,
  script: string,
  reference: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return { id, title, stylistScript: script, reference, ...extra };
}

function youcam(templateId: string) {
  return { kind: "youcam", templateId };
}

function brief(text: string) {
  return { kind: "brief", brief: text };
}

export const styleDocuments = {
  haircuts: haircutsCatalogue,
  beards: {
    families: [
      {
        id: "beard",
        service: "beard",
        affinity: "masculine",
        defaults: {
          requirements: {
            curl: ["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"],
            densityMin: 1,
            frontCm: null,
            topCm: null,
            sidesCm: null,
            strand: anyStrand,
            blunt: false,
            needsExtension: false,
          },
          geometry: { addsHeight: 0.05, addsWidth: 0.3, coversForehead: 0, softensJaw: 0.2 },
          compatibility: faces,
          lifestyle: { stylingMinutes: 3, blowdryer: false, maintenanceWeeks: 2 },
          bodyHint: "Beard width changes how wide the jaw reads.",
          beardFullness: "medium",
        },
        variants: [
          variant("all_shaved", "Shaved", "Clean shave. No beard density required.", youcam("all_shaved"), { beardFullness: "none", lifestyle: { stylingMinutes: 5, blowdryer: false, maintenanceWeeks: 1 } }),
          variant("all_mustache", "Mustache", "Mustache only, cheeks shaved.", youcam("all_mustache"), { beardFullness: "light" }),
          variant("all_soul_patch", "Soul Patch", "Small soul patch under the lip.", youcam("all_soul_patch"), { beardFullness: "light" }),
          variant("all_goatee", "Goatee", "Goatee on the chin and moustache, cheeks clear.", youcam("all_goatee"), { beardFullness: "medium", geometry: { addsHeight: 0.15, addsWidth: 0.15, coversForehead: 0, softensJaw: 0.1 } }),
          variant("all_anchor", "Anchor", "Anchor beard, moustache joined to a short chin beard.", youcam("all_anchor"), { beardFullness: "medium" }),
          variant("all_circle", "Circle Beard", "Circle beard, rounded chin, cheeks off.", youcam("all_circle"), { beardFullness: "medium" }),
          variant("all_chin_curtain", "Chin Curtain", "Chin curtain, jaw line only, no moustache.", youcam("all_chin_curtain"), { beardFullness: "medium", geometry: { addsHeight: 0, addsWidth: 0.45, coversForehead: 0, softensJaw: 0.05 } }),
          variant("all_mutton_chops", "Mutton Chops", "Mutton chops, wide sideburns, clean chin.", youcam("all_mutton_chops"), { beardFullness: "medium" }),
          variant("all_bandholz", "Bandholz", "Full Bandholz. Cheeks and chin need even growth.", youcam("all_bandholz"), { beardFullness: "full", lifestyle: { stylingMinutes: 5, blowdryer: false, maintenanceWeeks: 4 }, geometry: { addsHeight: 0.25, addsWidth: 0.55, coversForehead: 0, softensJaw: 0.1 } }),
          variant("all_long_bandholz", "Long Bandholz", "Long full beard. Patchy cheeks will show.", youcam("all_long_bandholz"), { beardFullness: "full" }),
          variant("all_garibaldi", "Garibaldi", "Round full Garibaldi, even cheek growth.", youcam("all_garibaldi"), { beardFullness: "full" }),
          variant("all_ducktail", "Ducktail", "Ducktail, full cheeks tapering to a point.", youcam("all_ducktail"), { beardFullness: "full" }),
        ],
      },
    ],
  },
  colours: {
    families: [
      {
        id: "colour",
        service: "colour",
        affinity: "either",
        defaults: {
          requirements: {
            curl: ["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c"],
            densityMin: 1,
            frontCm: null,
            topCm: null,
            sidesCm: null,
            strand: anyStrand,
            blunt: false,
            needsExtension: false,
          },
          geometry: { addsHeight: 0, addsWidth: 0, coversForehead: 0, softensJaw: 0 },
          compatibility: { oval: 0.8, round: 0.8, square: 0.8, heart: 0.8, long: 0.8 },
          lifestyle: { stylingMinutes: 8, blowdryer: false, maintenanceWeeks: 6 },
          bodyHint: null,
          beardFullness: null,
        },
        variants: [
          colour("Jet Black", 1, "#1b1b1b", "cool", "Jet black gloss. No lift."),
          colour("Chocolate Brown", 3, "#4a2c1a", "warm", "Chocolate brown, close to a natural level 3."),
          colour("Burgundy", 4, "#6e2430", "warm", "Burgundy gloss. Darker bases take it more easily than a lift."),
          colour("Copper Red", 6, "#b65a33", "warm", "Copper. More than three levels lighter than the current colour needs a treatment plan."),
          colour("Honey Blonde", 7, "#c4a574", "warm", "Honey blonde. Check the lift against the current level and any box dye."),
          colour("Ash Gray", 7, "#b7b7b7", "cool", "Ash gray. Warm undertones need toning, not just a gloss."),
          colour("Rose Gold", 8, "#c48b8b", "warm", "Rose gold. This is a light result and a high-maintenance tone."),
          colour("Platinum Blonde", 10, "#f3efe4", "cool", "Platinum. A lift this far is a correction, not one gloss."),
        ],
      },
    ],
  },
};

function colour(preset: string, level: number, swatch: string, undertone: string, script: string) {
  return variant(
    preset,
    preset,
    `${script} Target about level ${level}, ${undertone} undertone.`,
    brief(`${preset} colour reference, level ${level}, ${undertone} undertone.`),
    { colourLevel: level, swatch, preset },
  );
}
