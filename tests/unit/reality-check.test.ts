import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogueEntry, StoredTarget } from "../../src/shared/catalogue.js";
import { evidenceLabel, presentFinding } from "../../src/shared/reality-check.js";
import { evaluateReality } from "../../src/shared/reality-engine.js";
import { assembleHairProfile } from "../../src/server/profiles/hair-profile.js";
import { assembleRealityInput } from "../../src/server/reality/assemble.js";

const front = "11111111-1111-4111-8111-111111111111";
const right = "22222222-2222-4222-8222-222222222222";
const left = "33333333-3333-4333-8333-333333333333";
const length = "44444444-4444-4444-8444-444444444444";
const density = "66666666-6666-4666-8666-666666666666";

test("assembled evidence matches the engine and does not reuse scalp density for a beard", () => {
  const profile = assembleHairProfile({
    presentation: "fixture",
    services: ["haircut", "beard"],
    assets: [
      photo(front, "current_front"),
      photo(right, "current_right"),
      photo(left, "current_left"),
      photo(length, "current_length"),
      photo(density, "current_density"),
    ],
    observations: [
      observed("hair-length", [length], { term: "above the ears" }),
      observed("hair-type", [front, right, left], { mapping: "3a to 3b", term: "Loose to Medium Curls" }),
      observed("hair-density", [density], { term: "Low Density" }),
      observed("hair-frizziness", [front, right, left], { term: "Not Frizzy", mapping: 0 }),
    ],
    jobs: [],
  });
  const target: StoredTarget = {
    serviceKind: "haircut",
    sourceKind: "catalogue",
    candidateId: null,
    title: "Long Straight",
    description: null,
    inspirationAssetId: null,
    confirmed: { length: "long", texture: "straight" },
    unsupported: ["12 cm fringe"],
    proposals: [],
  };
  const catalogue: CatalogueEntry[] = [{
    id: "77777777-7777-4777-8777-777777777777",
    serviceKind: "haircut",
    title: "Short Curly",
    provenance: "youcam",
    providerReference: "male_short_curly",
    length: "short",
    texture: "curly",
    configuration: { templateId: "male_short_curly", preset: null },
    unsupported: ["prompt", "density", "exact length"],
  }];
  const haircut = evaluateReality(assembleRealityInput({
    services: ["haircut"],
    profile,
    plan: null,
    history: null,
    preferences: null,
    targets: [target],
    catalogue,
  }));
  const limitation = haircut.findings.find((finding) => finding.ruleId === "RC-016");
  assert.equal(limitation?.outcome, "unknown");
  assert.match(limitation?.reason ?? "", /12 cm fringe/);
  assert.equal(haircut.findings.some((finding) => finding.outcome === "compatible" && finding.ruleId === "RC-004"), false);
  const added = haircut.findings.find((finding) => finding.ruleId === "RC-002");
  assert.equal(added?.outcome, "potential_mismatch");
  assert.equal(presentFinding(added ?? haircut.findings[0]!).evidence.some((item) => item.label === "Photograph" || item.label === "Target"), true);
  assert.equal(JSON.stringify(haircut).includes("\"score\""), false);

  const beard = evaluateReality(assembleRealityInput({
    services: ["beard"],
    profile,
    plan: null,
    history: {
      naturalColour: { state: "unknown" },
      dyed: "unknown",
      boxDye: "no",
      henna: "no",
      bleach: "no",
      treatmentDate: { state: "unknown" },
      keratin: "no",
      permOrRelaxer: "no",
      reportedDamage: "no",
    },
    preferences: null,
    targets: [],
    catalogue: [],
  }));
  assert.equal(beard.findings.some((finding) => finding.evidenceRefs.includes(density)), false);
  assert.equal(beard.findings.some((finding) => finding.ruleId === "RC-010"), false);
  assert.equal(evidenceLabel(`history:henna`), "Colour history (henna)");
});

test("an explicit maintenance tag and an ordinary don't-want phrase change the assembled assessment", () => {
  const longId = "88888888-8888-4888-8888-888888888888";
  const shortId = "99999999-9999-4999-8999-999999999999";
  const profile = assembleHairProfile({
    presentation: "fixture",
    services: ["haircut"],
    assets: [photo(length, "current_length")],
    observations: [observed("hair-length", [length], { term: "above the ears" })],
    jobs: [],
  });
  const catalogue: CatalogueEntry[] = [
    { ...entry(longId, "Long Wavy", "long", "wavy"), maintenance: "high" },
    entry(shortId, "Short Curly", "short", "curly"),
  ];
  const assessed = assess(profile, catalogue, longId);
  assert.equal(assessed.findings.some((finding) => finding.ruleId === "RC-007"), true);
  assert.equal(assessed.findings.some((finding) => finding.ruleId === "RC-003"), true);
  assert.equal(assessed.findings.some((finding) => finding.ruleId === "RC-004"), false);
  assert.equal(assessed.excluded.some((item) => item.candidateId === shortId), true);
  assert.equal(assessed.alternatives.some((item) => item.candidateId === shortId), false);

  const untagged = assess(profile, [
    entry(longId, "Long Wavy", "long", "wavy"),
    entry(shortId, "Short Curly", "short", "curly"),
  ], longId);
  assert.equal(untagged.findings.some((finding) => finding.ruleId === "RC-007"), false);
});

function assess(
  profile: ReturnType<typeof assembleHairProfile>,
  catalogue: CatalogueEntry[],
  longId: string,
) {
  return evaluateReality(assembleRealityInput({
    services: ["haircut"],
    profile,
    plan: null,
    history: null,
    preferences: {
      maintenance: "low",
      stylingWillingness: "moderate",
      goals: [],
      priorities: [
        { scope: "haircut", text: "Keep the fringe", category: "must_keep", confirmed: true },
        { scope: "haircut", text: "I do not want curly hair", category: "dont_want", confirmed: true },
      ],
      proposals: [],
    },
    targets: [{
      serviceKind: "haircut",
      sourceKind: "catalogue",
      candidateId: longId,
      title: "Long Wavy",
      description: null,
      inspirationAssetId: null,
      confirmed: { length: "long", texture: "wavy" },
      unsupported: [],
      proposals: [],
    }],
    catalogue,
  }));
}

function entry(id: string, title: string, lengthLabel: "short" | "long", texture: "wavy" | "curly"): CatalogueEntry {
  return {
    id,
    serviceKind: "haircut",
    title,
    provenance: "youcam",
    providerReference: title.toLowerCase().replaceAll(" ", "_"),
    length: lengthLabel,
    texture,
    configuration: { templateId: title.toLowerCase().replaceAll(" ", "_"), preset: null },
    unsupported: [],
  };
}

function photo(id: string, role: string) {
  return { id, role, deleted: false, createdAt: "2026-10-12T00:00:00.000Z" };
}

function observed(capability: string, inputAssetIds: string[], values: Record<string, unknown>) {
  return { capability, source: "fixture", values, uncertainty: null, observedAt: "2026-10-12T00:00:00.000Z", inputAssetIds };
}
