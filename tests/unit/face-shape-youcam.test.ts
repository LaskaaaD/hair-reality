import assert from "node:assert/strict";
import test from "node:test";
import { applyEvidence, unknownAnalysis } from "../../src/domain/profile.js";
import { mapAnalysisToProfileFields } from "../../src/client/flow/flow-mappers.js";

test("a YouCam face shape is shown as YouCam named it, while scoring keeps its own category", () => {
  const person = applyEvidence(unknownAnalysis("youcam"), "face-attributes", { faceshape: "Diamond" });
  assert.equal(person.face.youcamShape?.value, "Diamond");
  assert.equal(person.face.shape.value, "heart");
  const field = mapAnalysisToProfileFields(person as never).find((entry) => entry.id === "faceShape");
  assert.equal(field?.value, "Diamond");
});
