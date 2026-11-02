import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { faceShapeLabel, firstSixWords, personalizedRankingReason } from "../../src/domain/ranking-reason.js";
import { fixturePerson, jordanPerson, ninaPerson } from "../../src/domain/person.js";
import { applyProfileOverrides } from "../../src/domain/profile-overrides.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import {
  GENERIC_RANKING_REASON_PATTERNS,
  RANKABLE_STYLE_BY_KEY,
  rankableStyleEntryForKey,
} from "../../src/shared/ranking-style-data.js";

function rankableHaircutKeys(): string[] {
  return loadStyles()
    .filter((variant) => variant.service === "haircut")
    .map((variant) => variant.key)
    .sort();
}

function isGenericReason(reason: string): boolean {
  return GENERIC_RANKING_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

function isBobOrLob(key: string, title: string, familyId: string): boolean {
  const blob = `${key} ${title} ${familyId}`.toLowerCase();
  return blob.includes("bob") || blob.includes("lob") || blob.includes("bixie");
}

function reasonStructure(reason: string, title: string): string {
  return reason.replaceAll(title, "%STYLE%").replace(/\s+/g, " ").trim().toLowerCase();
}

function isBowlOrMullet(key: string, title: string, familyId: string): boolean {
  const blob = `${key} ${title} ${familyId}`.toLowerCase();
  return blob.includes("bowl") || blob.includes("mullet");
}

function profileTopFive() {
  const styles = loadStyles();
  const finePerson = fixturePerson();
  finePerson.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  finePerson.hair.diameter = { value: "fine", confidence: 0.9, source: "fixture" };
  finePerson.face.shape = { value: "long", confidence: 0.9, source: "fixture" };
  finePerson.hair.lengthCm = { value: 14, confidence: 0.9, source: "fixture" };
  finePerson.hair.growthDirection = { value: "forward", confidence: 0.9, source: "fixture" };

  const fine = selectLooks({
    service: "haircut",
    person: finePerson,
    answers: { ...emptyAnswers(), presentation: "masculine", stylingMinutes: "15" },
    likes: [],
    styles,
  }).show.slice(0, 5);

  const curly = selectLooks({
    service: "haircut",
    person: jordanPerson(),
    answers: { ...emptyAnswers(), presentation: "masculine", stylingMinutes: "5", keep: "length" },
    likes: [],
    styles,
  }).show.slice(0, 5);

  const bob = selectLooks({
    service: "haircut",
    person: ninaPerson(),
    answers: { ...emptyAnswers(), presentation: "feminine", stylingMinutes: "15" },
    likes: ["haircut:all_short_bob"],
    styles,
  }).show.slice(0, 5);

  return { fine, curly, bob, styles };
}

test("every rankable haircut has a specific catalogue reason entry", () => {
  const keys = rankableHaircutKeys();
  assert.equal(keys.length, Object.keys(RANKABLE_STYLE_BY_KEY).length);
  for (const key of keys) {
    const entry = rankableStyleEntryForKey(key);
    assert.ok(entry, `missing ranking entry for ${key}`);
    assert.ok(entry.reason.trim().length > 24, `reason too short for ${key}`);
    assert.ok(!isGenericReason(entry.reason), `generic reason for ${key}: ${entry.reason}`);
  }
});

test("no ranking reason contains brackets, raw attribute underscores, or all-caps codes", () => {
  const styles = loadStyles().filter((variant) => variant.service === "haircut");
  const profiles = [
    { person: fixturePerson(), answers: { ...emptyAnswers(), presentation: "masculine" as const } },
    { person: jordanPerson(), answers: { ...emptyAnswers(), presentation: "masculine" as const } },
    { person: ninaPerson(), answers: { ...emptyAnswers(), presentation: "feminine" as const } },
  ];

  const assertCleanReason = (reason: string, context: string) => {
    assert.equal(reason.includes("("), false, `${context} contains "(": ${reason}`);
    assert.equal(reason.includes(")"), false, `${context} contains ")": ${reason}`);
    assert.equal(reason.includes("["), false, `${context} contains "[": ${reason}`);
    assert.equal(reason.includes("]"), false, `${context} contains "]": ${reason}`);
    assert.equal(reason.includes("_"), false, `${context} contains raw underscore attribute: ${reason}`);
    assert.equal(/\b[A-Z]{2,}\b/.test(reason), false, `${context} contains all-caps code: ${reason}`);
  };

  for (const [key, entry] of Object.entries(RANKABLE_STYLE_BY_KEY)) {
    assertCleanReason(entry.reason, `RANKABLE_STYLE_BY_KEY[${key}]`);
  }

  for (const { person, answers } of profiles) {
    for (const variant of styles) {
      const dynamicReason = personalizedRankingReason(person, answers, variant, false);
      assertCleanReason(dynamicReason, `personalizedRankingReason(${variant.key})`);
    }
    const selection = selectLooks({
      service: "haircut",
      person,
      answers,
      likes: [],
      styles,
    });
    for (const look of [...selection.show, ...selection.goals]) {
      for (const reason of look.reasons) {
        assertCleanReason(reason, `selectLooks(${look.variant.key})`);
      }
    }
  }
});

test("personalized ranking reasons use the profile face shape, not a wrong template", () => {
  const person = ninaPerson();
  assert.equal(faceShapeLabel(person), "oval");
  const variant = loadStyles().find((item) => item.key === "haircut:bowl--classic-bowl-cut");
  assert.ok(variant);
  const reason = personalizedRankingReason(person, emptyAnswers(), variant, false);
  assert.ok(!/long face/i.test(reason));
  assert.ok(/oval/i.test(reason));
  assert.ok(reason.length > 24);
});

test("contrasting profiles get different top fives and bob interest surfaces bobs", () => {
  const { fine, curly, bob } = profileTopFive();

  const fineKeys = fine.map((look) => look.variant.key);
  const curlyKeys = curly.map((look) => look.variant.key);
  const bobKeys = bob.map((look) => look.variant.key);

  assert.notDeepEqual(fineKeys, curlyKeys);
  assert.notDeepEqual(fineKeys, bobKeys);
  assert.notDeepEqual(curlyKeys, bobKeys);

  const bobCount = bob.filter((look) =>
    isBobOrLob(look.variant.key, look.variant.title, look.variant.familyId),
  ).length;
  assert.ok(bobCount >= 3, `expected at least 3 bobs/lobs in bob top five, got ${bobCount}: ${bobKeys.join(", ")}`);

  for (const look of [...fine, ...curly, ...bob]) {
    assert.ok(look.reasons[0]);
    assert.ok(!/strong match for a long face/i.test(look.reasons[0]));
  }
});

test("top five scores spread, reasons differ, and fine long-face avoids bowl or mullet", () => {
  const { fine, curly, bob } = profileTopFive();

  for (const [label, looks] of [
    ["fine long face", fine],
    ["curly masculine", curly],
    ["bob interest", bob],
  ] as const) {
    assert.ok(looks.every((look) => look.score >= 0 && look.score <= 100), `${label}: Fit outside 0-100`);
    assert.ok(looks.every((look, index) => index === 0 || looks[index - 1]!.score >= look.score), `${label}: Fit rises down the list`);

    const structures = looks.map((look) => reasonStructure(look.reasons[0] ?? "", look.variant.title));
    assert.equal(
      new Set(structures).size,
      structures.length,
      `${label}: duplicate reason structures: ${structures.join(" | ")}`,
    );
  }

  const badFine = fine.filter((look) =>
    isBowlOrMullet(look.variant.key, look.variant.title, look.variant.familyId),
  );
  assert.equal(badFine.length, 0, `bowl/mullet in fine long-face top five: ${badFine.map((l) => l.variant.key).join(", ")}`);
});

test("within one ranking no two reasons share the same first 6 words and Fit is honest 0-100", () => {
  const styles = loadStyles();
  const femLongFine = applyProfileOverrides(
    {
      ...ninaPerson(),
      hair: {
        ...ninaPerson().hair,
        diameter: { value: "fine", confidence: 0.9, source: "fixture" },
      },
    },
    { length: "Long", hairType: "Straight", density: "Medium-light" },
  );

  const sampleProfiles = [
    {
      name: "masculine",
      person: fixturePerson(),
      answers: { ...emptyAnswers(), presentation: "masculine" as const, stylingMinutes: "15" as const },
    },
    {
      name: "curly",
      person: jordanPerson(),
      answers: { ...emptyAnswers(), presentation: "masculine" as const, stylingMinutes: "5" as const },
    },
    {
      name: "feminine long fine",
      person: femLongFine,
      answers: { ...emptyAnswers(), presentation: "feminine" as const, strand: "fine" as const, stylingMinutes: "15" as const },
    },
  ];

  for (const profile of sampleProfiles) {
    const selection = selectLooks({
      service: "haircut",
      person: profile.person,
      answers: profile.answers,
      likes: [],
      styles,
      limit: 16,
    });

    const top5Scores = selection.show.slice(0, 5).map((look) => look.score);
    assert.ok(top5Scores.every((score) => score >= 0 && score <= 100), `${profile.name}: Fit outside 0-100 (${top5Scores.join(", ")})`);
    assert.ok(top5Scores[0]! < 100 || selection.show[0]!.liked, `${profile.name}: top Fit pinned to 100`);


    const rankingLooks = [...selection.show, ...selection.goals];
    const seenFirstSix = new Map<string, string>();
    for (const look of rankingLooks) {
      const reason = look.reasons[0] ?? "";
      const prefix = firstSixWords(reason);
      assert.equal(
        seenFirstSix.has(prefix),
        false,
        `${profile.name}: duplicate first 6 words "${prefix}" between "${seenFirstSix.get(prefix)}" and "${reason}"`,
      );
      seenFirstSix.set(prefix, reason);
    }
  }
});
