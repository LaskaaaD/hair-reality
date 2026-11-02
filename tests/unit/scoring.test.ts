import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStyles, variantByKey } from "../../src/domain/knowledge-base.js";
import { fixturePerson, type Person } from "../../src/domain/person.js";
import { interviewPlan } from "../../src/domain/interview.js";
import { applyEvidence, fixtureAnalysis } from "../../src/domain/profile.js";
import { ACCOUNT_PROBE_UNITS } from "../../src/server/providers/youcam/contract.js";
import {
  ACCOUNT_UNITS,
  GROWTH_CM_PER_MONTH,
  applyRanking,
  emptyAnswers,
  estimatedUnits,
  fallbackCapabilities,
  scoreVariant,
  rankRawTotal,
  selectLooks,
} from "../../src/domain/scoring.js";

const styles = loadStyles();

test("account unit table matches probe prices and the hackathon session stays under 40", () => {
  assert.deepEqual(ACCOUNT_UNITS, ACCOUNT_PROBE_UNITS);
  assert.equal(estimatedUnits("haircut", false), 21);
  assert.equal(estimatedUnits("colour", false), 23);
  assert.equal(estimatedUnits("beard", false), 16);
  assert.ok(estimatedUnits("haircut", false) <= 40);
  assert.ok(estimatedUnits("haircut", true) < estimatedUnits("haircut", false));
  assert.ok(styles.filter((entry) => entry.service === "haircut").length >= 500);
  assert.ok(styles.filter((entry) => entry.service === "haircut" && entry.affinity !== "feminine").length >= 200);
  assert.ok(styles.filter((entry) => entry.familyId === "two-block").length >= 8);
});

test("missing length becomes a growth goal and face shape cannot exclude a style", () => {
  const person = fixtureAnalysis();
  const blunt = variantByKey("haircut:all_long_straight_black", styles);
  assert.ok(blunt);
  const blocked = scoreVariant(person, emptyAnswers(), blunt, true);
  assert.equal(blocked.excluded, false);
  assert.equal(blocked.label, "realistic");
  assert.equal(blocked.growth?.missingCm, 12);
  assert.equal(blocked.growth?.months, Math.ceil(12 / GROWTH_CM_PER_MONTH));
  const round: Person = structuredClone(person);
  round.face.shape = { value: "round", confidence: 0.9, source: "fixture" };
  assert.equal(scoreVariant(round, emptyAnswers(), blunt, true).excluded, false);
  const curly = variantByKey("haircut:male_short_curly", styles);
  assert.ok(curly);
  // The fixture person has wavy (2b) hair: a curly-hair style is excluded by the texture rule, not by face shape, unless asked for.
  assert.equal(scoreVariant(person, emptyAnswers(), curly, false).excluded, true);
  assert.equal(scoreVariant(person, emptyAnswers(), curly, true).excluded, false);
  assert.equal(scoreVariant(round, emptyAnswers(), curly, true).excluded, false);
  const extension = variantByKey("haircut:female_long_boho_waves", styles);
  assert.ok(extension);
  const lifted = scoreVariant(person, emptyAnswers(), extension, false);
  assert.equal(lifted.excluded, false);
  assert.equal(lifted.label, "needs-treatment");
});

test("a man only sees men's and unisex cuts, and a woman only sees women's and unisex cuts", () => {
  const person = fixturePerson();
  person.hair.lengthCm = { value: 12, confidence: 0.9, source: "fixture" };
  person.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  const bob = variantByKey("haircut:all_short_bob", styles);
  const crop = variantByKey("haircut:male_textured_crop", styles);
  assert.ok(bob && crop);
  assert.equal(scoreVariant(person, emptyAnswers(), bob, false).excluded, false);
  assert.equal(scoreVariant(person, emptyAnswers(), crop, false).excluded, false);
  const men = selectLooks({
    service: "haircut",
    person,
    answers: { ...emptyAnswers(), presentation: "masculine" },
    likes: ["haircut:all_short_bob"],
    styles,
  });
  const women = selectLooks({
    service: "haircut",
    person,
    answers: { ...emptyAnswers(), presentation: "feminine" },
    likes: ["haircut:male_textured_crop"],
    styles,
  });
  for (const look of [...men.show, ...men.ranked, ...men.goals, ...men.explain]) {
    assert.notEqual(look.variant.affinity, "feminine");
  }
  for (const look of [...women.show, ...women.ranked, ...women.goals, ...women.explain]) {
    assert.notEqual(look.variant.affinity, "masculine");
  }
  assert.ok(men.ranked.some((look) => look.variant.affinity === "masculine"));
  assert.ok(women.ranked.some((look) => look.variant.affinity === "feminine"));
  const recordedMale = structuredClone(person);
  recordedMale.sex = { value: "male", confidence: 1, source: "answer" };
  const fromSex = selectLooks({ service: "haircut", person: recordedMale, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [], styles });
  assert.equal(fromSex.ranked.some((look) => look.variant.affinity === "feminine"), false);
});

test("a full beard is blocked when growth is patchy, and a big colour lift is labelled", () => {
  const person = fixtureAnalysis();
  const full = variantByKey("beard:all_bandholz", styles);
  const light = variantByKey("beard:all_goatee", styles);
  assert.ok(full && light);
  const answers = { ...emptyAnswers(), beardGrowth: "patchy" as const };
  assert.equal(scoreVariant(person, answers, full, true).excluded, true);
  assert.equal(scoreVariant(person, answers, light, false).excluded, false);
  const platinum = variantByKey("colour:Platinum Blonde", styles);
  const black = variantByKey("colour:Jet Black", styles);
  assert.ok(platinum && black);
  assert.equal(scoreVariant(person, emptyAnswers(), platinum, false).label, "needs-treatment");
  assert.equal(scoreVariant(person, emptyAnswers(), platinum, false).excluded, false);
  assert.equal(scoreVariant(person, emptyAnswers(), black, false).label, "realistic");
});

test("diversify keeps at most two variants from one family and a ranking cannot change scores", () => {
  const person = fixturePerson();
  person.hair.curl = { value: "2b", confidence: 0.9, source: "fixture" };
  person.hair.lengthCm = { value: 14, confidence: 0.9, source: "fixture" };
  const selected = selectLooks({
    service: "haircut",
    person,
    answers: { ...emptyAnswers(), stylingMinutes: "15", presentation: "either" },
    likes: [],
    styles,
    limit: 5,
  });
  const families = selected.show.map((look) => look.variant.familyId);
  for (const family of new Set(families)) {
    assert.ok(families.filter((item) => item === family).length <= 4, family);
  }
  const before = selected.show.map((look) => look.score);
  const ranked = applyRanking(selected.show, [...selected.show].reverse().map((look) => look.variant.id));
  assert.deepEqual(ranked.map((look) => look.score), [...before].reverse());
  assert.deepEqual(ranked.map((look) => look.label), [...selected.show].reverse().map((look) => look.label));
});

test("a straight fine long face ranks a fringe above a high pompadour, and the top ten stays diverse", () => {
  const person = fixturePerson();
  person.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  person.hair.diameter = { value: "fine", confidence: 0.9, source: "fixture" };
  person.hair.density = { value: 2, confidence: 0.9, source: "fixture" };
  person.hair.lengthCm = { value: 14, confidence: 0.9, source: "fixture" };
  person.face.shape = { value: "long", confidence: 0.9, source: "fixture" };
  person.hair.growthDirection = { value: "forward", confidence: 0.9, source: "fixture" };
  const fringe = variantByKey("haircut:male_textured_comma", styles);
  const pompadour = variantByKey("haircut:pompadour--classic-pompadour", styles);
  assert.ok(fringe && pompadour);
  const fringeScore = scoreVariant(person, emptyAnswers(), fringe, false);
  const pompadourScore = scoreVariant(person, emptyAnswers(), pompadour, false);
  assert.ok(fringeScore.score > pompadourScore.score + 8);
  assert.ok(fringeScore.components.face > pompadourScore.components.face);
  assert.ok(fringeScore.reasons.length >= 2);
  const selected = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [], styles });
  assert.equal(selected.show.length, 50);
  // Masculine ranking concentrates on crop, fringe, curtain and two-block cuts (3 per family at most), so six families is the floor.
  assert.ok(new Set(selected.show.map((look) => look.variant.familyId)).size >= 6);
  const rawScores = selected.ranked.map((look) => rankRawTotal(look));
  for (let index = 1; index < rawScores.length; index += 1) {
    const previous = rawScores[index - 1] ?? 0;
    const current = rawScores[index] ?? 0;
    const before = selected.ranked[index - 1]!;
    const after = selected.ranked[index]!;
    // Equal totals fall back to the hair criterion, then the face criterion, then the id.
    const parts = (look: typeof before) => [look.components.hairBehavior, look.components.face];
    const byParts = parts(before).map((value, part) => value - parts(after)[part]!).find((diff) => diff !== 0) ?? 0;
    assert.ok(previous > current || (previous === current && (byParts > 0 || (byParts === 0 && before.variant.id <= after.variant.id))));
  }
});

test("a slightly long oval ranks a low crop above a high fade and a tall pompadour", () => {
  const person = fixturePerson();
  person.face.shape = { value: "oval", confidence: 0.9, source: "vision" };
  person.face.aspectRatio = { value: 1.5, confidence: 0.9, source: "vision" };
  person.hair.curl = { value: "1", confidence: 0.9, source: "vision" };
  person.hair.growthDirection = { value: "forward", confidence: 0.9, source: "vision" };
  person.hair.lengthCm = { value: 12, confidence: 0.9, source: "vision" };
  person.hair.topCm = { value: 10, confidence: 0.9, source: "vision" };
  const crop = variantByKey("haircut:male_textured_crop", styles);
  const fade = variantByKey("haircut:fade--high-fade", styles);
  const tall = variantByKey("haircut:pompadour--classic-pompadour", styles);
  assert.ok(crop && fade && tall);
  const answers = { ...emptyAnswers(), presentation: "masculine" as const };
  const cropScore = scoreVariant(person, answers, crop, false);
  const fadeScore = scoreVariant(person, answers, fade, false);
  const tallScore = scoreVariant(person, answers, tall, false);
  assert.ok(cropScore.score > fadeScore.score);
  assert.ok(cropScore.score > tallScore.score);
  assert.ok((cropScore.reasons[0] ?? "").length > 20);
  const c = cropScore.components;
  const sum = c.hairBehavior + c.face + c.hairline + c.head + c.lifestyle + c.features + c.trend + 0.5 * (c.goals + c.taste);
  assert.equal(cropScore.score, Math.round(((sum * 100) / 114.5) * 10) / 10);
  const selected = selectLooks({ service: "haircut", person, answers, likes: [], styles });
  assert.equal(selected.ranked.some((look) => look.variant.affinity === "feminine"), false);
});

test("curly hair and the answered maintenance, direction, and length each move one component", () => {
  const straight = fixturePerson();
  straight.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  straight.hair.lengthCm = { value: 16, confidence: 0.9, source: "fixture" };
  const curly = structuredClone(straight);
  curly.hair.curl = { value: "4a", confidence: 0.9, source: "fixture" };
  const straightTop = selectLooks({ service: "haircut", person: straight, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [], styles }).show.map((look) => look.variant.id);
  const curlyTop = selectLooks({ service: "haircut", person: curly, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [], styles }).show.map((look) => look.variant.id);
  assert.notDeepEqual(straightTop, curlyTop);
  const crop = variantByKey("haircut:male_textured_crop", styles);
  const quiff = variantByKey("haircut:quiff--classic-quiff", styles);
  assert.ok(crop && quiff);
  const forward = structuredClone(straight);
  forward.hair.growthDirection = { value: "forward", confidence: 1, source: "answer" };
  const back = structuredClone(forward);
  back.hair.growthDirection = { value: "back", confidence: 1, source: "answer" };
  assert.ok(scoreVariant(forward, emptyAnswers(), crop, false).components.hairBehavior > scoreVariant(back, emptyAnswers(), crop, false).components.hairBehavior);
  const dense = structuredClone(straight);
  dense.hair.density = { value: 4, confidence: 1, source: "youcam" };
  const thin = structuredClone(straight);
  thin.hair.density = { value: 1, confidence: 1, source: "youcam" };
  assert.ok(scoreVariant(dense, emptyAnswers(), quiff, false).components.hairBehavior > scoreVariant(thin, emptyAnswers(), quiff, false).components.hairBehavior);
  const covered = structuredClone(straight);
  covered.hair.hairline = { value: "receded", confidence: 1, source: "vision" };
  assert.ok(scoreVariant(covered, emptyAnswers(), crop, false).components.hairline > scoreVariant(covered, emptyAnswers(), quiff, false).components.hairline);
  const short = structuredClone(straight);
  short.hair.lengthCm = { value: 3, confidence: 1, source: "youcam" };
  short.hair.topCm = { value: 3, confidence: 1, source: "youcam" };
  assert.ok(scoreVariant(straight, emptyAnswers(), crop, false).components.lifestyle > scoreVariant(short, emptyAnswers(), crop, false).components.lifestyle);
  const quick = { ...emptyAnswers(), stylingMinutes: "5" as const, blowdryer: "no" as const };
  const patient = { ...emptyAnswers(), stylingMinutes: "30" as const, blowdryer: "yes" as const };
  assert.ok(scoreVariant(straight, patient, quiff, false).components.lifestyle > scoreVariant(straight, quick, quiff, false).components.lifestyle);
});

test("low confidence adds a question and salon mode calls YouCam only as a fallback", () => {
  const ready = fixturePerson();
  assert.equal(interviewPlan(ready, "colour").some((question) => question.id === "cowlick"), false);
  assert.equal(fallbackCapabilities(ready, "haircut").length, 0);
  const gap = fixturePerson();
  gap.hair.cowlickFront = { value: "unknown", confidence: 0, source: "fixture" };
  gap.hair.curl = { value: "unknown", confidence: 0.2, source: "vision" };
  assert.equal(interviewPlan(gap, "colour").some((question) => question.id === "cowlick"), true);
  // A haircut asks a short fixed list: glasses (the photos are taken without them) and forehead always, never cowlick, strand, dryer or hair state.
  const haircutIds = interviewPlan(gap, "haircut").map((question) => question.id);
  for (const id of ["glassesDaily", "forehead", "presentation", "stylingMinutes", "facialHair", "chemical"]) assert.ok(haircutIds.includes(id), id);
  for (const id of ["cowlick", "strand", "blowdryer", "naturalState"]) assert.equal(haircutIds.includes(id), false, id);
  assert.deepEqual(fallbackCapabilities(gap, "haircut"), ["hair-type"]);
  const evidence = applyEvidence(gap, "hair-type", { mapping: "2a to 2b" });
  assert.equal(evidence.hair.curl.value, "2b");
  assert.equal(evidence.hair.curl.source, "youcam");
});
