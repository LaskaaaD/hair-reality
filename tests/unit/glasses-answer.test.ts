import assert from "node:assert/strict";
import { test } from "node:test";
import { fixturePerson } from "../../src/domain/person.js";
import { applyAnswers, emptyAnswers } from "../../src/domain/scoring.js";

test("glasses read from photos taken without glasses count for nothing; only the client's answer does", () => {
  const person = fixturePerson();
  person.context.glasses = { value: false, confidence: 0.99, source: "vision" };
  const unanswered = applyAnswers(person, emptyAnswers());
  assert.equal(unanswered.context.glasses.value, "unknown");
  assert.equal(unanswered.context.glasses.confidence, 0);
  assert.equal(applyAnswers(person, { ...emptyAnswers(), glassesDaily: "yes" }).context.glasses.value, true);
  assert.equal(applyAnswers(person, { ...emptyAnswers(), glassesDaily: "no" }).context.glasses.value, false);
});
