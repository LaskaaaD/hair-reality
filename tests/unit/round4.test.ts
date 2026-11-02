import assert from "node:assert/strict";
import { test } from "node:test";
import { fitScoreForCard } from "../../src/client/flow/flow-mappers.js";
import { groupRankingCards } from "../../src/client/flow/ranking-groups.js";
import { fixturePerson, known, unknownPerson } from "../../src/domain/person.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import { applyVisionDetailed, readVision } from "../../src/server/demo/vision.js";

/** What the model realistically returns: mixed case, a "Type" prefix on the curl, numeric strings, 0-100 confidences. */
const REALISTIC_VISION = {
  growthDirection: "Forward",
  cowlickFront: false,
  cowlickCrown: true,
  hairline: "Average",
  glasses: false,
  lengthCm: 7,
  frontCm: 8,
  topCm: 7,
  sideCm: 3,
  curl: "Type 2A",
  diameter: "Medium",
  density: "3",
  faceShape: "Oval",
  faceRatio: "1.38",
  jaw: "Average",
  forehead: "High",
  foreheadWidth: "average",
  ears: "average",
  confidence: 0.8,
  fieldConfidence: {
    growthDirection: 0.7, cowlickFront: 0.6, cowlickCrown: 0.6, hairline: 0.75, glasses: 0.95, length: 0.7, curl: 0.8,
    diameter: 0.6, density: 0.85, faceShape: 0.8, faceRatio: 0.75, jaw: 0.65, forehead: 0.7, foreheadWidth: 0.6, ears: 0.6,
  },
};

test("a realistic vision answer fills face shape, ratio, forehead, hairline, curl, fall and density with confidence", () => {
  const read = readVision(REALISTIC_VISION);
  assert.ok(read);
  assert.deepEqual(read.rejected, []);
  const blank = unknownPerson("youcam");
  blank.hair.density = known(3, "youcam", 0.6);
  const { person, filled } = applyVisionDetailed(blank, read.reading);
  assert.equal(person.face.shape.value, "oval");
  assert.equal(person.face.aspectRatio.value, 1.38);
  assert.equal(person.face.forehead.value, "high");
  assert.equal(person.hair.hairline.value, "average");
  assert.equal(person.hair.curl.value, "2a");
  assert.equal(person.hair.growthDirection.value, "forward");
  assert.equal(person.hair.density.value, 3);
  assert.equal(person.hair.density.confidence, 0.85);
  assert.equal(person.face.shape.confidence, 0.8);
  assert.equal(person.face.shape.source, "vision");
  const names = filled.map((item) => item.field);
  for (const field of ["faceShape", "faceRatio", "forehead", "hairline", "curl", "growthDirection", "density"]) {
    assert.ok(names.includes(field), `${field} was not merged`);
  }
});

test("a vision beard reading fills facial hair, and 'clean shaven' maps to none", () => {
  const stubble = readVision({ ...REALISTIC_VISION, facialHair: "Stubble", fieldConfidence: { ...REALISTIC_VISION.fieldConfidence, facialHair: 0.8 } });
  assert.ok(stubble);
  const merged = applyVisionDetailed(unknownPerson("youcam"), stubble.reading);
  assert.equal(merged.person.facialHair.style.value, "stubble");
  assert.equal(merged.person.facialHair.style.source, "vision");
  assert.ok(merged.filled.some((item) => item.field === "facialHair"));
  const shaved = readVision({ ...REALISTIC_VISION, facialHair: "clean shaven" });
  assert.equal(shaved?.reading.facialHair, "none");
});

test("one bad vision field is reported by name and does not drop the others", () => {
  const read = readVision({ ...REALISTIC_VISION, faceShape: "egg-shaped", confidence: 85 });
  assert.ok(read);
  assert.deepEqual(read.rejected.map((item) => item.field), ["faceShape"]);
  assert.equal(read.reading.confidence, 0.85);
  assert.equal(read.reading.curl, "2a");
});

test("no perm or curl-adding style ranks for straight or slightly wavy hair unless asked", () => {
  const person = fixturePerson("fixture");
  person.sex = { value: "unknown", confidence: 0, source: "fixture" };
  person.hair.curl = known("1", "youcam");
  const permLike = (selection: ReturnType<typeof selectLooks>) =>
    [...selection.show, ...selection.goals, ...selection.ranked.filter((look) => !look.excluded)].filter((look) => /perm|curly|afro|twist|coil/i.test(look.variant.title));
  for (const curl of ["1", "2a"] as const) {
    person.hair.curl = known(curl, "youcam");
    assert.deepEqual(permLike(selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] })).map((look) => look.variant.title), []);
  }
  const wavy = fixturePerson("fixture");
  wavy.hair.curl = known("3a", "youcam");
  const all = selectLooks({ service: "haircut", person: wavy, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] }).ranked;
  assert.ok(all.some((look) => /curly|perm/i.test(look.variant.title) && !look.excluded));
  const asked = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), chemical: "permed", presentation: "masculine" }, likes: [] }).ranked;
  assert.ok(asked.some((look) => /perm/i.test(look.variant.title) && !look.excluded));
});

test("the whole E3 page is strictly descending by displayed Fit", () => {
  const card = (key: string, fit: number, stylingMinutes: number, missingCm: number | null) => ({
    key: `haircut:${key}`, title: key, score: fit, label: "realistic" as const, reasons: ["ok"], stylistScript: "",
    stylingMinutes, maintenanceWeeks: 6,
    components: { hairBehavior: fit - 30, face: 20, hairline: 5, head: 5, lifestyle: 8, features: 3, trend: 5, goals: 0 },
    confidence: 0.85, missingCm, months: missingCm ? 3 : null, lengthBand: "short" as const, feasible: true, imageUrl: null,
  });
  const cards = [
    card("a", 80, 2, null), card("b", 65, 2, null), card("c", 64, 12, null), card("d", 72, 12, null),
    card("e", 78, 5, 4), card("f", 70, 5, 4), card("g", 66, 20, null), card("h", 75, 20, null),
  ];
  const flat = groupRankingCards(cards).flatMap((section) => section.cards.map(fitScoreForCard));
  assert.equal(flat.length, cards.length);
  assert.deepEqual(flat, [...flat].sort((a, b) => b - a));
});

test("catalogue photos become references only for matching gender, and ref cache keys never collide with templates", async () => {
  const { catalogueReferenceFile, referenceCacheStyle } = await import("../../src/server/demo/reference-photo.js");
  const { renderCacheFileName } = await import("../../src/server/demo/render-cache.js");
  const { loadStyles } = await import("../../src/domain/knowledge-base.js");
  const styles = loadStyles().filter((style) => style.service === "haircut");
  const withPhoto = styles.filter((style) => catalogueReferenceFile(style) !== null);
  assert.ok(withPhoto.length >= 5, `only ${withPhoto.length} styles have an own photo`);
  for (const style of withPhoto) {
    const file = catalogueReferenceFile(style)!;
    if (file.startsWith("catalog/women/")) assert.notEqual(style.affinity, "masculine", style.key);
    else assert.notEqual(style.affinity, "feminine", style.key);
  }
  assert.equal(styles.filter((style) => style.reference.kind === "youcam" && catalogueReferenceFile(style) === null).length, 0);
  const file = catalogueReferenceFile(withPhoto[0]!)!;
  const key = withPhoto[0]!.key;
  const refName = renderCacheFileName("abc", key, referenceCacheStyle(file));
  const tplName = renderCacheFileName("abc", key, withPhoto[0]!.reference.kind === "youcam" ? String((withPhoto[0]!.reference as { templateId: string }).templateId) : null);
  assert.notEqual(refName, tplName);
  assert.match(refName, /__ref-/);
});
