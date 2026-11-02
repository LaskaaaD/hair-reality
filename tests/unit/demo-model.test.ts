import assert from "node:assert/strict";
import { test } from "node:test";
import { variantByKey } from "../../src/domain/knowledge-base.js";
import { fixturePerson, unknownPerson } from "../../src/domain/person.js";
import { scoreVariant, emptyAnswers } from "../../src/domain/scoring.js";
import { applyModelNotes } from "../../src/server/demo/llm.js";
import { applyVision, fixtureVision } from "../../src/server/demo/vision.js";

test("vision fills only unknown fields and leaves a confident reading alone", () => {
  const blank = unknownPerson("youcam");
  const filled = applyVision(blank, {
    ...fixtureVision(),
    growthDirection: "left",
    cowlickFront: true,
    cowlickCrown: null,
    hairline: "high",
    glasses: false,
    lengthCm: 12,
    confidence: 0.86,
  });
  assert.equal(filled.hair.growthDirection.value, "side");
  assert.equal(filled.hair.growthDirection.source, "vision");
  assert.equal(filled.hair.cowlickFront.value, true);
  assert.equal(filled.hair.cowlickCrown.value, "unknown");
  assert.equal(filled.hair.hairline.value, "high");
  assert.equal(filled.context.glasses.value, false);
  assert.equal(filled.hair.lengthCm.value, 12);
  assert.equal(filled.hair.curl.value, "unknown");

  const skipped = applyVision(blank, { ...fixtureVision(), confidence: 0.4, lengthCm: 30 });
  assert.equal(skipped.hair.lengthCm.value, "unknown");

  const known = fixturePerson("youcam");
  const kept = applyVision(known, {
    ...fixtureVision(),
    growthDirection: "back",
    cowlickFront: false,
    cowlickCrown: false,
    hairline: "low",
    glasses: true,
    lengthCm: 4,
    confidence: 0.8,
  });
  assert.equal(kept.hair.lengthCm.value, known.hair.lengthCm.value);
  assert.equal(kept.hair.lengthCm.source, known.hair.lengthCm.source);
});

test("model notes can reorder and rewrite the stylist line without changing score or label", () => {
  const first = variantByKey("haircut:male_textured_crop");
  const second = variantByKey("haircut:male_short_curly");
  assert.ok(first && second);
  const person = fixturePerson();
  const scored = [first, second].map((variant) => scoreVariant(person, emptyAnswers(), variant, false));
  const reviewed = applyModelNotes(scored, [second.id, first.id], [
    { id: second.id, line: "Keep the curl and ask for a short shape that follows the head." },
  ]);
  assert.deepEqual(reviewed.map((item) => item.variant.id), [second.id, first.id]);
  assert.equal(reviewed[0]?.score, scored[1]?.score);
  assert.equal(reviewed[0]?.label, scored[1]?.label);
  assert.equal(reviewed[1]?.score, scored[0]?.score);
  assert.equal(reviewed[1]?.label, scored[0]?.label);
  assert.match(reviewed[0]?.stylistScript ?? "", /Keep the curl/);
  assert.equal(reviewed[1]?.stylistScript, scored[0]?.stylistScript);
});
