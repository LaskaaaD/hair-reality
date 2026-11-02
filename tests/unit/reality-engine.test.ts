import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ColourHistory, ConfirmedPriority } from "../../src/shared/client-brief.js";
import {
  coarseLengthInterval,
  evaluateReality,
  lengthIntervalFromTerm,
  textureFamiliesFromMapping,
  type RealityCandidate,
  type RealityInput,
  type RealityTarget,
} from "../../src/shared/reality-engine.js";

const lengthEvidence = ["asset-length"];
const densityEvidence = ["scalp-density"];

const clearHistory: ColourHistory = {
  naturalColour: { state: "unknown" },
  dyed: "no",
  boxDye: "no",
  henna: "no",
  bleach: "no",
  treatmentDate: { state: "unknown" },
  keratin: "no",
  permOrRelaxer: "no",
  reportedDamage: "no",
};

function target(overrides: Partial<RealityTarget> & Pick<RealityTarget, "service">): RealityTarget {
  return {
    length: lengthIntervalFromTerm("long hair"),
    lengthLabel: "long",
    texture: "straight",
    shade: null,
    apparentFullness: null,
    fullnessEvidenceRefs: [],
    fringe: null,
    top: null,
    side: null,
    maintenance: "moderate",
    proportionRequested: false,
    shadeSuggestionsRequested: false,
    unsupported: [],
    limitationAcknowledged: false,
    evidenceRefs: ["target"],
    ...overrides,
  };
}

function candidate(overrides: Partial<RealityCandidate> & Pick<RealityCandidate, "id" | "service">): RealityCandidate {
  return {
    enabled: true,
    preview: "supported",
    length: "long",
    texture: "straight",
    shade: null,
    maintenance: "moderate",
    apparentFullness: "unknown",
    labels: [],
    editorial: true,
    ...overrides,
  };
}

function input(overrides: Partial<RealityInput> = {}): RealityInput {
  return {
    services: ["haircut"],
    hair: {
      length: { ...lengthIntervalFromTerm("long hair")!, evidenceRefs: lengthEvidence },
      textureFamilies: ["straight"],
      textureEvidenceRefs: ["asset-texture"],
      densityGrade: "Medium Density",
      densityEvidenceRefs: densityEvidence,
      frizz: "Not Frizzy",
      frizzEvidenceRefs: ["asset-frizz"],
      conflicts: [],
    },
    beard: null,
    face: null,
    tones: null,
    history: null,
    maintenance: "unspecified",
    priorities: [],
    targets: [target({ service: "haircut" })],
    candidates: [candidate({ id: "cut-a", service: "haircut" })],
    gaps: [],
    ...overrides,
  };
}

function byRule(result: ReturnType<typeof evaluateReality>, ruleId: string) {
  return result.findings.filter((item) => item.ruleId === ruleId);
}

test("missing and conflicting observations stay unknown and never compatible", () => {
  const missing = evaluateReality(input({
    hair: null,
    targets: [],
    candidates: [],
  }));
  assert.equal(missing.findings.every((item) => item.outcome !== "compatible"), true);
  assert.equal(byRule(missing, "RC-001").length >= 4, true);
  assert.equal(byRule(missing, "RC-004").length, 0);

  const conflicting = evaluateReality(input({
    hair: {
      ...input().hair!,
      conflicts: [{ dimension: "length", evidenceRefs: ["asset-length-conflict"] }],
    },
  }));
  const length = byRule(conflicting, "RC-001").find((item) => item.dimension === "length");
  assert.equal(length?.outcome, "unknown");
  assert.deepEqual(length?.evidenceRefs, ["asset-length-conflict"]);
  assert.equal(byRule(conflicting, "RC-004").length, 0);

  const retake = evaluateReality(input({
    hair: null,
    gaps: [{ service: "haircut", dimension: "length", nextAction: "retake", evidenceRefs: ["asset-length"] }],
  }));
  assert.equal(byRule(retake, "RC-001").find((item) => item.dimension === "length")?.nextAction, "retake");
});

test("length rules distinguish added length, overlap and a cut that needs no added length", () => {
  const current = lengthIntervalFromTerm("above the ears");
  assert.ok(current);
  const longer = evaluateReality(input({
    hair: { ...input().hair!, length: { ...current, evidenceRefs: lengthEvidence } },
    targets: [target({ service: "haircut", length: coarseLengthInterval("long"), lengthLabel: "long" })],
  }));
  const added = byRule(longer, "RC-002")[0];
  assert.equal(added?.outcome, "potential_mismatch");
  assert.equal(added?.nextAction, "offer_alternative");
  assert.doesNotMatch(added?.reason ?? "", /centimetre|\bcm\b/i);
  assert.deepEqual(added?.evidenceRefs, [...lengthEvidence, "target"]);

  const open = lengthIntervalFromTerm("short hair or longer");
  assert.ok(open);
  const overlap = evaluateReality(input({
    hair: { ...input().hair!, length: { ...open, evidenceRefs: lengthEvidence } },
    targets: [target({ service: "haircut", length: coarseLengthInterval("medium"), lengthLabel: "medium" })],
  }));
  assert.equal(byRule(overlap, "RC-003")[0]?.outcome, "unknown");
  assert.equal(byRule(overlap, "RC-002").length, 0);

  const precise = evaluateReality(input({
    targets: [target({ service: "haircut", length: lengthIntervalFromTerm("long hair"), fringe: "short fringe" })],
  }));
  assert.equal(byRule(precise, "RC-003")[0]?.outcome, "unknown");
  assert.equal(byRule(precise, "RC-004").length, 0);

  const shorter = evaluateReality(input({
    targets: [target({ service: "haircut", length: coarseLengthInterval("short"), lengthLabel: "short" })],
  }));
  const compatible = byRule(shorter, "RC-004")[0];
  assert.equal(compatible?.outcome, "compatible");
  assert.match(compatible?.reason ?? "", /detailed cut remains uncertain/i);
  assert.equal(byRule(shorter, "RC-002").length, 0);
});

test("low density and high reference fullness stay different evidence types", () => {
  const mismatch = evaluateReality(input({
    hair: { ...input().hair!, densityGrade: "Low Density" },
    targets: [target({ service: "haircut", apparentFullness: "high", fullnessEvidenceRefs: ["inspiration-fullness"] })],
  }));
  const finding = byRule(mismatch, "RC-005")[0];
  assert.equal(finding?.outcome, "potential_mismatch");
  assert.match(finding?.reason ?? "", /different evidence types/i);
  assert.deepEqual(finding?.evidenceRefs, ["scalp-density", "inspiration-fullness"]);

  const sameGrade = evaluateReality(input({
    hair: { ...input().hair!, densityGrade: "High Density" },
    targets: [target({ service: "haircut", apparentFullness: "high", fullnessEvidenceRefs: ["inspiration-fullness"] })],
  }));
  assert.equal(byRule(sameGrade, "RC-005").length, 0);
});

test("texture mismatch does not fire for an overlapping family and does not erase a preference", () => {
  const mapped = textureFamiliesFromMapping("1 to 2a");
  assert.deepEqual(mapped, ["straight", "wavy"]);
  const overlap = evaluateReality(input({
    hair: { ...input().hair!, textureFamilies: mapped },
    targets: [target({ service: "haircut", texture: "wavy" })],
  }));
  assert.equal(byRule(overlap, "RC-006").length, 0);

  const different = evaluateReality(input({
    hair: { ...input().hair!, textureFamilies: ["curly"] },
    targets: [target({ service: "haircut", texture: "straight" })],
    priorities: [priority("all", "must_keep", "curly")],
  }));
  const texture = byRule(different, "RC-006")[0];
  assert.equal(texture?.outcome, "potential_mismatch");
  assert.match(texture?.reason ?? "", /preference is not ruled out/i);
  assert.equal(different.excluded.some((item) => item.conflicts.some((conflict) => conflict.text === "curly")), true);
});

test("high maintenance against a low-maintenance preference offers another candidate", () => {
  const result = evaluateReality(input({
    maintenance: "low",
    targets: [target({ service: "haircut", maintenance: "high" })],
    candidates: [
      candidate({ id: "high-cut", service: "haircut", maintenance: "high" }),
      candidate({ id: "low-cut", service: "haircut", maintenance: "low", length: "short" }),
    ],
  }));
  assert.equal(byRule(result, "RC-007")[0]?.outcome, "potential_mismatch");
  assert.equal(result.alternatives[0]?.candidateId, "low-cut");
  assert.equal(byRule(evaluateReality(input({ maintenance: "unspecified", targets: [target({ service: "haircut", maintenance: "high" })] })), "RC-007").length, 0);
});

test("must-keep and don't-want exclusions stay visible and scoped", () => {
  const result = evaluateReality(input({
    services: ["haircut", "colour"],
    priorities: [priority("haircut", "dont_want", "long"), priority("colour", "must_keep", "Honey Blonde")],
    targets: [
      target({ service: "haircut" }),
      target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Honey Blonde" }),
    ],
    history: clearHistory,
    candidates: [
      candidate({ id: "long-cut", service: "haircut", labels: ["long"] }),
      candidate({ id: "short-cut", service: "haircut", length: "short" }),
      candidate({ id: "blonde", service: "colour", length: "unknown", texture: "unknown", shade: "Honey Blonde" }),
      candidate({ id: "black", service: "colour", length: "unknown", texture: "unknown", shade: "Jet Black" }),
    ],
  }));
  assert.deepEqual(result.excluded.map((item) => item.candidateId), ["black", "long-cut"]);
  assert.equal(result.excluded.find((item) => item.candidateId === "long-cut")?.conflicts[0]?.text, "long");
  assert.equal(result.alternatives.some((item) => item.candidateId === "long-cut"), false);
  assert.equal(result.alternatives.some((item) => item.candidateId === "short-cut"), true);
  assert.equal(result.alternatives.some((item) => item.candidateId === "blonde"), true);
  assert.equal(byRule(result, "RC-008").every((item) => item.evidenceRefs.length === 1), true);
  const flexible = evaluateReality(input({
    priorities: [priority("all", "flexible", "long")],
    candidates: [candidate({ id: "long-cut", service: "haircut", labels: ["long"] })],
  }));
  assert.equal(flexible.excluded.length, 0);
});

test("frizz plus a smooth target is styling uncertainty without a damage diagnosis", () => {
  const result = evaluateReality(input({
    hair: { ...input().hair!, frizz: "Frizzy" },
    targets: [target({ service: "haircut", texture: "straight" })],
  }));
  const finding = byRule(result, "RC-009")[0];
  assert.equal(finding?.outcome, "unknown");
  assert.equal(finding?.section, "style");
  assert.doesNotMatch(finding?.reason ?? "", /damaged/i);
  assert.equal(byRule(evaluateReality(input({ hair: { ...input().hair!, frizz: "Not Frizzy" } })), "RC-009").length, 0);
});

test("unknown colour history is not a no, and reported treatments stay specific", () => {
  const unanswered = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: null,
    targets: [target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Jet Black" })],
    candidates: [],
  }));
  assert.equal(byRule(unanswered, "RC-010")[0]?.outcome, "stylist_review_required");
  assert.equal(byRule(unanswered, "RC-012").length, 0);

  const unknownDye = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: { ...clearHistory, dyed: "unknown" },
    targets: [target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Jet Black" })],
    candidates: [],
  }));
  const unknown = byRule(unknownDye, "RC-010")[0];
  assert.match(unknown?.reason ?? "", /dyed/);
  assert.equal(unknown?.reason.includes("unknown is not a no") || unknown?.reason.includes("Unknown is not a no"), true);
  assert.equal(byRule(unknownDye, "RC-004").length, 0);

  const reported = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: { ...clearHistory, henna: "yes", bleach: "yes", reportedDamage: "yes" },
    targets: [target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Jet Black" })],
    candidates: [],
  }));
  const treatment = byRule(reported, "RC-012")[0];
  assert.equal(treatment?.outcome, "stylist_review_required");
  assert.match(treatment?.reason ?? "", /henna/);
  assert.match(treatment?.reason ?? "", /bleach/);
  assert.match(treatment?.reason ?? "", /reported damage/);
  assert.deepEqual(treatment?.evidenceRefs, ["history:henna", "history:bleach", "history:reportedDamage"]);
  assert.doesNotMatch(treatment?.reason ?? "", /formula|guaranteed|session/i);
});

test("dark dye and a lighter shade require review without a formula", () => {
  const result = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: { ...clearHistory, dyed: "yes", naturalColour: { state: "known", value: "black" } },
    tones: { hairColorName: "Jet Black", evidenceRefs: ["tones-hair"] },
    targets: [target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Platinum Blonde" })],
    candidates: [],
  }));
  const review = byRule(result, "RC-011")[0];
  assert.equal(review?.outcome, "stylist_review_required");
  assert.deepEqual(review?.evidenceRefs, ["history:dyed", "tones-hair", "target"]);
  assert.doesNotMatch(review?.reason ?? "", /formula|guaranteed|\d+\s+sessions/i);

  const sameDarkness = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: clearHistory,
    targets: [target({ service: "colour", length: null, lengthLabel: null, texture: null, shade: "Jet Black" })],
    candidates: [],
  }));
  assert.equal(byRule(sameDarkness, "RC-011").length, 0);
});

test("beard fullness uses beard evidence and ignores scalp density", () => {
  const missing = evaluateReality(input({
    services: ["beard"],
    hair: input().hair,
    beard: { fullness: null, length: null, evidenceRefs: ["beard-photo"] },
    targets: [target({ service: "beard", length: coarseLengthInterval("short"), lengthLabel: "short", texture: null, apparentFullness: "high" })],
    candidates: [candidate({ id: "anchor", service: "beard", length: "unknown", texture: "unknown" })],
  }));
  const gaps = byRule(missing, "RC-013");
  assert.equal(gaps.every((item) => item.outcome === "unknown"), true);
  assert.equal(gaps.every((item) => item.evidenceRefs.every((ref) => ref !== "scalp-density")), true);
  assert.equal(missing.findings.some((item) => item.evidenceRefs.includes("scalp-density")), false);

  const reported = evaluateReality(input({
    services: ["beard"],
    hair: input().hair,
    beard: { fullness: "low", length: lengthIntervalFromTerm("above the ears"), evidenceRefs: ["beard-report"] },
    targets: [target({ service: "beard", length: null, lengthLabel: null, texture: null, apparentFullness: "high" })],
    candidates: [],
  }));
  assert.equal(byRule(reported, "RC-013")[0]?.outcome, "potential_mismatch");
  assert.deepEqual(byRule(reported, "RC-013")[0]?.evidenceRefs, ["beard-report"]);
});

test("a face suggestion stays optional and yields to an explicit refusal", () => {
  const suggested = evaluateReality(input({
    face: { shape: "Heart", evidenceRefs: ["face-shape"] },
    targets: [target({ service: "haircut", proportionRequested: true })],
  }));
  const note = byRule(suggested, "RC-014")[0];
  assert.equal(note?.section, "style");
  assert.equal(note?.outcome, "unknown");
  assert.doesNotMatch(note?.reason ?? "", /attractiveness/i);
  assert.deepEqual(note?.evidenceRefs, ["face-shape"]);

  const refused = evaluateReality(input({
    face: { shape: "Heart", evidenceRefs: ["face-shape"] },
    priorities: [priority("haircut", "dont_want", "Heart")],
    targets: [target({ service: "haircut", proportionRequested: true })],
    candidates: [candidate({ id: "heart-cut", service: "haircut", labels: ["Heart"] })],
  }));
  assert.equal(byRule(refused, "RC-014").length, 0);
  assert.equal(refused.excluded[0]?.conflicts[0]?.text, "Heart");
});

test("colour tones are starting points and a refused shade is not recommended", () => {
  const result = evaluateReality(input({
    services: ["colour"],
    hair: null,
    history: clearHistory,
    tones: { hairColorName: "Auburn", evidenceRefs: ["tones-hair"] },
    priorities: [priority("colour", "dont_want", "Honey Blonde")],
    targets: [target({
      service: "colour",
      length: null,
      lengthLabel: null,
      texture: null,
      shade: "Platinum Blonde",
      shadeSuggestionsRequested: true,
    })],
    candidates: [
      candidate({ id: "honey", service: "colour", length: "unknown", texture: "unknown", shade: "Honey Blonde" }),
      candidate({ id: "platinum", service: "colour", length: "unknown", texture: "unknown", shade: "Platinum Blonde" }),
      candidate({ id: "ash", service: "colour", length: "unknown", texture: "unknown", shade: "Ash Gray" }),
      candidate({ id: "rose", service: "colour", length: "unknown", texture: "unknown", shade: "Rose Gold" }),
    ],
  }));
  assert.equal(byRule(result, "RC-015")[0]?.outcome, "unknown");
  assert.equal(result.alternatives.some((item) => item.candidateId === "honey"), false);
  assert.equal(result.excluded[0]?.candidateId, "honey");
  assert.deepEqual(result.alternatives.map((item) => item.colourRole), ["dream", "possible_first_step", "lower_complexity"]);
  assert.match(result.alternatives[1]?.note ?? "", /professional review/i);
  assert.match(result.alternatives[2]?.note ?? "", /professional review/i);
  assert.doesNotMatch(result.alternatives.map((item) => item.note).join(" "), /predicted colour result is/i);
  for (const alternative of result.alternatives) assert.equal(alternative.editorial, true);
});

test("an unsupported written detail stays attached until it is acknowledged", () => {
  const pending = evaluateReality(input({
    targets: [target({ service: "haircut", unsupported: ["12 cm fringe"] })],
  }));
  const limitation = byRule(pending, "RC-016")[0];
  assert.equal(limitation?.outcome, "unknown");
  assert.equal(limitation?.nextAction, "acknowledge");
  assert.match(limitation?.reason ?? "", /12 cm fringe/);

  const acknowledged = evaluateReality(input({
    targets: [target({ service: "haircut", unsupported: ["12 cm fringe"], limitationAcknowledged: true })],
  }));
  assert.equal(byRule(acknowledged, "RC-016")[0]?.nextAction, "none");
  assert.match(byRule(acknowledged, "RC-016")[0]?.reason ?? "", /12 cm fringe/);
});

test("candidate order is deterministic, capped, and keeps an unavailable preview labelled", () => {
  const result = evaluateReality(input({
    targets: [target({ service: "haircut", length: coarseLengthInterval("long"), lengthLabel: "long", texture: "wavy" })],
    candidates: [
      candidate({ id: "c", service: "haircut", texture: "wavy" }),
      candidate({ id: "a", service: "haircut", texture: "wavy" }),
      candidate({ id: "d", service: "haircut", texture: "wavy", preview: "unavailable" }),
      candidate({ id: "b", service: "haircut", texture: "wavy" }),
      candidate({ id: "off", service: "haircut", texture: "wavy", enabled: false }),
      candidate({ id: "beard", service: "beard", texture: "unknown", length: "unknown" }),
    ],
  }));
  assert.deepEqual(result.alternatives.map((item) => item.candidateId), ["a", "b", "c"]);
  assert.equal(result.alternatives.some((item) => item.candidateId === "d"), false);
  assert.equal(result.alternatives.some((item) => item.candidateId === "off" || item.candidateId === "beard"), false);
  const labelled = evaluateReality(input({
    candidates: [candidate({ id: "waiting", service: "haircut", preview: "unavailable" })],
  }));
  assert.equal(labelled.alternatives[0]?.preview, "unavailable");
  assert.equal(JSON.stringify(result).includes("\"score\""), false);
  assert.doesNotMatch(JSON.stringify(result.alternatives), /percent|certainty/i);
});

test("the engine module does not reach the network or a database", () => {
  const source = readFileSync(new URL("../../src/shared/reality-engine.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']pg["']|node:http|node:net|\bfetch\s*\(/);
});

function priority(scope: ConfirmedPriority["scope"], category: ConfirmedPriority["category"], text: string): ConfirmedPriority {
  return { scope, category, text, confirmed: true };
}
