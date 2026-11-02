import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaletteItem } from "../../src/client/api.js";
import { fitScoreForCard } from "../../src/client/flow/flow-mappers.js";
import { groupRankingCards } from "../../src/client/flow/ranking-groups.js";
import { fixturePerson, known, ninaPerson, type Person } from "../../src/domain/person.js";
import { collapseRepeatedWords, faceReadsLong } from "../../src/domain/ranking-reason.js";
import { emptyAnswers, needsPresentationAnswer, resolvedPresentation, selectLooks, type Answers, type ScoredVariant } from "../../src/domain/scoring.js";

/** Oval/slightly oblong face, straight to slightly wavy hair falling forward, no sex reading, no hair length. */
function manProfile(): Person {
  const p = fixturePerson("fixture");
  p.sex = { value: "unknown", confidence: 0, source: "fixture" };
  p.face.aspectRatio = known(1.47, "youcam", 0.75);
  p.hair.curl = known("2a", "youcam");
  p.hair.density = known(3, "youcam");
  p.hair.growthDirection = known("forward", "youcam");
  p.hair.lengthCm = { value: "unknown", confidence: 0, source: "youcam" };
  return p;
}

function everyLook(selection: ReturnType<typeof selectLooks>): ScoredVariant[] {
  return [...selection.show, ...selection.goals, ...selection.explain, ...selection.ranked];
}

function titles(looks: readonly ScoredVariant[]): string[] {
  return looks.map((look) => look.variant.title);
}

/** What the wizard sends when a man picks "Men". */
function menAnswers(): Answers {
  return { ...emptyAnswers(), presentation: "masculine" };
}

test("an unanswered presentation is never guessed from hair length, beard or jaw", () => {
  const answers = emptyAnswers();
  assert.equal(resolvedPresentation(manProfile(), answers), null);
  const bearded = manProfile();
  bearded.facialHair.style = known("short", "youcam");
  bearded.hair.lengthCm = known(6, "vision", 0.9);
  assert.equal(resolvedPresentation(bearded, answers), null);
  // Fixture and vision readings carry no confident sex, so only the answer decides.
  assert.equal(resolvedPresentation(fixturePerson(), answers), null);
  assert.equal(resolvedPresentation(manProfile(), { ...answers, presentation: "masculine" }), "masculine");
  assert.equal(resolvedPresentation(manProfile(), { ...answers, presentation: "feminine" }), "feminine");
  assert.equal(resolvedPresentation(manProfile(), { ...answers, presentation: "either" }), "either");
});

test("a confident sex reading stands in for an unanswered question, a weak one does not", () => {
  const answers = emptyAnswers();
  const woman = ninaPerson();
  woman.sex = known("female", "youcam", 0.9);
  assert.equal(resolvedPresentation(woman, answers), "feminine");
  const man = manProfile();
  man.sex = known("male", "youcam", 0.9);
  assert.equal(resolvedPresentation(man, answers), "masculine");
  man.sex = known("male", "youcam", 0.3);
  assert.equal(resolvedPresentation(man, answers), null);
  // The answer always wins over a reading.
  man.sex = known("male", "youcam", 0.9);
  assert.equal(resolvedPresentation(man, { ...answers, presentation: "feminine" }), "feminine");
});

test("vision failed and no answer: no women's-only style anywhere, and haircuts wait for the answer", () => {
  const person = manProfile();
  const selection = selectLooks({ service: "haircut", person, answers: emptyAnswers(), likes: [], referenceIds: ["r1"] });
  assert.deepEqual(selection.ranked.map((look) => look.variant.key), ["reference:r1"]);
  for (const look of everyLook(selection)) {
    assert.equal(look.variant.affinity === "feminine" || look.variant.affinity === "masculine", false, look.variant.title);
  }
  assert.equal(needsPresentationAnswer("haircut", person, emptyAnswers()), true);
  assert.equal(needsPresentationAnswer("haircut", person, menAnswers()), false);
  assert.equal(needsPresentationAnswer("colour", person, emptyAnswers()), false);
  assert.equal(needsPresentationAnswer("beard", person, emptyAnswers()), false);
});

test("vision failed and the male answer: 0 feminine styles in ranking, goals, palette extras and fallback", () => {
  const failedVision = fixturePerson("fixture");
  failedVision.sex = { value: "unknown", confidence: 0, source: "fixture" };
  for (const person of [failedVision, manProfile(), ninaPerson()]) {
    for (const likes of [[], ["haircut:all_short_bob"]]) {
      const selection = selectLooks({ service: "haircut", person, answers: menAnswers(), likes, limit: 24 });
      assert.ok(selection.show.length > 0 && selection.ranked.length > 0);
      for (const look of everyLook(selection)) assert.notEqual(look.variant.affinity, "feminine", look.variant.title);
    }
  }
});

test("a masculine profile gets 0 feminine styles in ranking, groups, goals and extras", () => {
  const person = manProfile();
  const variants: Partial<Answers>[] = [{}, { stylingMinutes: "5" }, { canGrow: "yes" }, { forehead: "cover" }];
  for (const patch of variants) {
    const answers = { ...menAnswers(), ...patch };
    const selection = selectLooks({ service: "haircut", person, answers, likes: [], limit: 24 });
    assert.ok(selection.show.length > 0 && selection.ranked.length > 0);
    for (const look of everyLook(selection)) {
      assert.notEqual(look.variant.affinity, "feminine", `${look.variant.title} is a women's style`);
    }
  }
});

test("a feminine reading gets no masculine styles, and only an explicit Both mixes them", () => {
  const woman = ninaPerson();
  const selection = selectLooks({ service: "haircut", person: woman, answers: { ...emptyAnswers(), presentation: "feminine" }, likes: [] });
  for (const look of everyLook(selection)) assert.notEqual(look.variant.affinity, "masculine", look.variant.title);
  const both = selectLooks({ service: "haircut", person: woman, answers: { ...emptyAnswers(), presentation: "either" }, likes: [] });
  assert.ok(new Set(both.ranked.map((look) => look.variant.affinity)).size > 1);
});

test("the masculine top 15 follows a barber's read of an oval/oblong face", () => {
  const selection = selectLooks({ service: "haircut", person: manProfile(), answers: menAnswers(), likes: [] });
  const top = titles(selection.ranked.slice(0, 15));
  const favoured = /crop|curtain|mod cut|caesar|two block|korean|messy fringe|textured fringe|side part|ivy|middle part|ear tuck|taper/i;
  assert.ok(top.filter((title) => favoured.test(title)).length >= 11, top.join(", "));
  const avoided = /pompadour|quiff|faux hawk|high and tight|disconnected|mohawk|flat top|skin|high fade/i;
  assert.deepEqual(top.filter((title) => avoided.test(title)), []);
  const bottom = titles(selection.ranked.slice(-60)).join(" | ");
  for (const title of ["Classic pompadour", "Faux hawk", "High and tight", "Quiff with fade"]) assert.ok(bottom.includes(title), title);
});

test("shown Fit never rises as the ranking goes down", () => {
  const selection = selectLooks({ service: "haircut", person: manProfile(), answers: menAnswers(), likes: [] });
  const live = selection.show;
  for (let i = 1; i < live.length; i += 1) assert.ok(live[i - 1]!.score >= live[i]!.score, `${live[i - 1]!.variant.title} < ${live[i]!.variant.title}`);
});

test("the first E3 group holds the highest Fit styles", () => {
  const selection = selectLooks({ service: "haircut", person: manProfile(), answers: menAnswers(), likes: [] });
  const cards = selection.ranked.slice(0, 16).map((look) => ({
    key: look.variant.key,
    title: look.variant.title,
    score: look.score,
    label: look.label,
    reasons: look.reasons,
    stylistScript: "",
    stylingMinutes: look.stylingMinutes,
    maintenanceWeeks: look.maintenanceWeeks,
    components: look.components,
    confidence: look.confidence,
    missingCm: look.growth?.missingCm ?? null,
    months: look.growth?.months ?? null,
    lengthBand: "short" as const,
    family: look.variant.familyId,
    feasible: true,
    imageUrl: null,
  })) as unknown as PaletteItem[];
  const sections = groupRankingCards(cards);
  const best = Math.max(...cards.map(fitScoreForCard));
  assert.equal(fitScoreForCard(sections[0]!.cards[0]!), best);
  const firstMin = Math.min(...sections[0]!.cards.map(fitScoreForCard));
  for (const later of sections.slice(1)) for (const card of later.cards) assert.ok(fitScoreForCard(card) <= firstMin, `${card.title} buried below a lower Fit`);
  const heads = sections.map((section) => fitScoreForCard(section.cards[0]!));
  assert.deepEqual(heads, [...heads].sort((a, b) => b - a));
});

test("reasons never repeat an adjacent word", () => {
  assert.equal(collapseRepeatedWords("keeps natural natural hair looking effortless"), "keeps natural hair looking effortless");
  assert.equal(collapseRepeatedWords("Natural natural texture"), "Natural texture");
  for (const [person, presentation] of [[manProfile(), "masculine"], [ninaPerson(), "feminine"]] as const) {
    const selection = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation }, likes: [] });
    for (const look of everyLook(selection)) {
      for (const reason of look.reasons) assert.doesNotMatch(reason, /\b([a-z'-]+)\s+\1\b/i, reason);
    }
  }
});

function wideForeheadProfile(): Person {
  const p = manProfile();
  p.face.shape = known("oval", "vision", 0.8);
  p.face.foreheadWidth = known("wide", "vision", 0.8);
  p.hair.curl = known("2a", "vision", 0.8);
  return p;
}

test("one shared long-face rule: shape long or a ratio of 1.42 and up", () => {
  const person = manProfile();
  person.face.aspectRatio = known(1.41, "youcam");
  assert.equal(faceReadsLong(person), false);
  person.face.aspectRatio = known(1.42, "youcam");
  assert.equal(faceReadsLong(person), true);
  person.face.aspectRatio = known(1.2, "youcam");
  person.face.shape = known("long", "youcam");
  assert.equal(faceReadsLong(person), true);
});

test("deterministic top 10 for an oval/oblong face with a wide forehead matches a barber's list", () => {
  const selection = selectLooks({ service: "haircut", person: wideForeheadProfile(), answers: menAnswers(), likes: [] });
  const ranked = selection.ranked.filter((look) => !look.excluded);
  const expected = [
    /^Textured French crop with low taper$/, /^Short curtains/, /^Mod cut$/, /^Textured Caesar/, /^Korean two-block with curtain fringe$/,
    /^Messy fringe$/, /^Soft French crop with scissor sides$/, /^Side-swept textured crop$/, /^Soft side part$/, /^Ivy League$/,
  ];
  const top = titles(ranked.slice(0, 10));
  const hits = expected.filter((pattern) => top.some((title) => pattern.test(title))).length;
  assert.ok(hits >= 7, `${hits}/10 expected cuts in the top 10: ${top.join(", ")}`);

  const rest = ranked.length;
  const bottomQuarter = new Set(ranked.slice(Math.floor(rest * 0.75)).map((look) => look.variant.title));
  for (const title of ["Classic pompadour", "Faux hawk", "High and tight", "Quiff with fade", "Modern pompadour fade"]) {
    assert.ok(bottomQuarter.has(title), `${title} should sit in the bottom quarter`);
  }
  assert.ok([...bottomQuarter].some((title) => /disconnected|undercut/i.test(title)), "a disconnected undercut sits in the bottom quarter");
  for (const look of selection.ranked) assert.notEqual(look.variant.affinity, "feminine", look.variant.title);
});

test("shown Fit is the honest rubric total, not pinned to 90-95", () => {
  const selection = selectLooks({ service: "haircut", person: wideForeheadProfile(), answers: menAnswers(), likes: [] });
  const scores = selection.show.map((look) => look.score);
  assert.ok(scores[0]! < 95 || scores[0]! === Math.max(...scores));
  assert.ok(scores.every((score) => score >= 0 && score <= 100));
  assert.ok(selection.ranked.at(-1)!.score < 50, "the worst cut reads as a poor fit");
});
