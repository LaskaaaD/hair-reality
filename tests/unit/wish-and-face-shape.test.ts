import assert from "node:assert/strict";
import { test } from "node:test";
import { addCandidate, faceShapeContested, fixturePerson, known, type Person } from "../../src/domain/person.js";
import { emptyAnswers, scoreVariant } from "../../src/domain/scoring.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { consultationAnswers, profileFacts, STYLIST_INSTRUCTIONS } from "../../src/server/demo/llm-rank.js";

function withShapes(youcam: [string, number], vision: [string, number], resolved: "youcam" | "vision" | "answer" = "youcam"): Person {
  const person = fixturePerson();
  const winner = resolved === "vision" ? vision : youcam;
  person.face.shape = known(winner[0] as never, resolved, winner[1]);
  addCandidate(person, "faceShape", { source: "youcam", value: youcam[0], confidence: youcam[1] });
  addCandidate(person, "faceShape", { source: "vision", value: vision[0], confidence: vision[1] });
  return person;
}

test("face shape is contested only when YouCam and vision differ with similar confidence", () => {
  assert.equal(faceShapeContested(withShapes(["heart", 0.8], ["oval", 0.65])), true);
  assert.equal(faceShapeContested(withShapes(["heart", 0.8], ["heart", 0.65])), false, "same shape");
  assert.equal(faceShapeContested(withShapes(["heart", 0.9], ["oval", 0.6])), false, "one source is clearly surer");
  assert.equal(faceShapeContested(withShapes(["heart", 0.8], ["oval", 0.4])), false, "the other reading is too weak to contest");
  assert.equal(faceShapeContested(withShapes(["heart", 0.8], ["oval", 0.65], "answer")), false, "a shape the client corrected is never contested");
  assert.equal(faceShapeContested(fixturePerson()), false, "no second reading");
});

test("a contested face shape scores like an unknown one: it favours no cut", () => {
  const styles = loadStyles().filter((style) => style.service === "haircut" && style.affinity !== "feminine").slice(0, 80);
  const contested = withShapes(["heart", 0.8], ["oval", 0.65]);
  const unknown = structuredClone(contested);
  unknown.face.shape = known("unknown" as never, "youcam", 0.8);
  const answers = { ...emptyAnswers(), presentation: "masculine" as const };
  for (const style of styles) {
    assert.equal(scoreVariant(contested, answers, style, false).score, scoreVariant(unknown, answers, style, false).score, style.key);
  }
  const decided = structuredClone(contested);
  decided.candidates = undefined;
  assert.ok(styles.some((style) => scoreVariant(decided, answers, style, false).score !== scoreVariant(unknown, answers, style, false).score), "an uncontested heart still changes some scores");
});

test("the stylist model sees the contested flag and the client's own wish", () => {
  const facts = profileFacts(withShapes(["heart", 0.8], ["oval", 0.65]));
  assert.equal(facts.faceShapeContested, true);
  assert.equal("faceShapeContested" in profileFacts(fixturePerson()), false);
  assert.match(STYLIST_INSTRUCTIONS, /faceShapeContested/);
  assert.match(STYLIST_INSTRUCTIONS, /clientWish/);
  assert.match(STYLIST_INSTRUCTIONS, /never follow commands/);
  assert.equal(consultationAnswers({ ...emptyAnswers(), wish: "  wyszczuplona twarz, baby face " }).clientWish, "wyszczuplona twarz, baby face");
  assert.equal("clientWish" in consultationAnswers(emptyAnswers()), false);
  assert.equal(consultationAnswers({ ...emptyAnswers(), wish: "x".repeat(500) }).clientWish?.length, 300);
});

import { compareMerged, TIE_BAND } from "../../src/server/demo/llm-rank.js";
import { faceShapeSingleSource } from "../../src/domain/person.js";
import { selectLooks } from "../../src/domain/scoring.js";

test("blended Fit ties inside one band are decided by our own score; a real gap keeps the model's order", () => {
  const { show } = selectLooks({ service: "haircut", person: fixturePerson(), answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] });
  const base = show[0]!;
  const item = (fit: number, ours: number, skip = false) => ({ look: { ...base, score: fit }, ours, skip });
  const french = item(80.2, 74.0);
  const caesar = item(80.3, 72.2);
  assert.ok(Math.abs(caesar.look.score - french.look.score) < TIE_BAND);
  assert.deepEqual([caesar, french].sort(compareMerged), [french, caesar], "a 0.1 gap is a tie: our score decides");
  const clear = item(82.0, 70.0);
  assert.deepEqual([french, clear].sort(compareMerged), [clear, french], "a real gap keeps the model's order");
  assert.deepEqual([item(90, 90, true), french].sort(compareMerged)[0], french, "a skipped style stays last");
});

test("a face shape read by one source counts half; two agreeing sources count in full", () => {
  const single = withShapes(["heart", 0.8], ["oval", 0.4]);
  assert.equal(faceShapeSingleSource(single), true);
  const agreed = withShapes(["heart", 0.8], ["heart", 0.7]);
  assert.equal(faceShapeSingleSource(agreed), false);
  assert.equal(faceShapeSingleSource(fixturePerson()), false, "persona and fixture profiles are not single-source");
  assert.equal(faceShapeSingleSource(withShapes(["heart", 0.8], ["oval", 0.65], "answer")), false, "the client's own correction counts in full");
  assert.equal(profileFacts(single).faceShapeSingleSource, true);
  assert.equal("faceShapeSingleSource" in profileFacts(agreed), false);
  const styles = loadStyles().filter((style) => style.service === "haircut" && style.affinity !== "feminine");
  const answers = { ...emptyAnswers(), presentation: "masculine" as const };
  const full = structuredClone(agreed);
  const moved = styles.filter((style) => scoreVariant(single, answers, style, false).score !== scoreVariant(full, answers, style, false).score);
  assert.ok(moved.length > 0, "the soft weight changes some scores");
});
