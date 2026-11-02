import assert from "node:assert/strict";
import { test } from "node:test";
import { compareLooks, fallbackCompareNotes } from "../../src/server/demo/compare-notes.js";
import { fixturePerson } from "../../src/domain/person.js";

const looks = [
  { key: "a", title: "Soft crop", score: 83, label: "realistic", reasons: ["Suits wavy hair.", "Keeps the forehead open."] },
  { key: "b", title: "Textured fringe", score: 80, label: "realistic", reasons: [] },
];

test("fallback notes keep every style and flag the lower fit", () => {
  const notes = fallbackCompareNotes(looks);
  assert.equal(notes.source, "fallback");
  assert.deepEqual(notes.notes.map((note) => note.key), ["a", "b"]);
  assert.match(notes.notes[1]!.cons[0]!, /3 points lower/);
  assert.equal(notes.notes[0]!.pros.length, 2);
});

test("without a model client the comparison falls back and spends nothing", async () => {
  const result = await compareLooks({ sessionId: "s", looks, person: fixturePerson(), openai: null, budgetUsd: 6 });
  assert.equal(result.source, "fallback");
  assert.equal(result.notes.length, 2);
});
