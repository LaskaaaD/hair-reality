import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { applyProfileOverrides, personForRanking } from "../../src/domain/profile-overrides.js";
import { fixturePerson } from "../../src/domain/person.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import { readProfileOverrides } from "../../src/server/demo/store.js";

const styles = loadStyles();

test("applyProfileOverrides maps goal Fix labels onto analysis readings", () => {
  const person = fixturePerson();
  person.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  const updated = applyProfileOverrides(person, { hairType: "Coily" });
  assert.equal(updated.hair.curl.value, "4a");
  assert.equal(updated.hair.curl.source, "answer");
});

test("profile overrides change ranking input order", () => {
  const person = fixturePerson();
  person.hair.curl = { value: "1", confidence: 0.9, source: "fixture" };
  const answers = { ...emptyAnswers(), presentation: "masculine" as const };
  const baseline = selectLooks({ service: "haircut", person, answers, likes: [], styles }).show.map((look) => look.variant.key);
  const withOverride = selectLooks({
    service: "haircut",
    person: personForRanking(person, { hairType: "Coily" }),
    answers,
    likes: [],
    styles,
  }).show.map((look) => look.variant.key);
  assert.notDeepEqual(baseline, withOverride);
});

test("readProfileOverrides round-trips from stored answers json", () => {
  const stored = {
    stylingMinutes: "15",
    profileOverrides: { hairType: "Wavy", density: "High" },
  };
  assert.deepEqual(readProfileOverrides(stored), { hairType: "Wavy", density: "High" });
});
