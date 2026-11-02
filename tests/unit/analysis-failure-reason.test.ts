import assert from "node:assert/strict";
import { test } from "node:test";
import { failureLogLine, providerSideFailure, retakeReadingNotice, retakeSlotFor } from "../../src/server/demo/jobs.js";

// Round 7: all three blocking tasks failed with PROVIDER_UNAVAILABLE before submission (0 units), yet the UI blamed the front photo.
const v7 = [
  { capability: "hair-type", status: "failed", error_code: "PROVIDER_UNAVAILABLE" },
  { capability: "hair-density", status: "failed", error_code: "PROVIDER_UNAVAILABLE" },
  { capability: "face-attributes", status: "failed", error_code: "PROVIDER_UNAVAILABLE" },
];

test("a provider outage is not reported as a bad front photo", () => {
  assert.equal(providerSideFailure(v7), true);
  assert.equal(retakeSlotFor(v7), null);
  assert.doesNotMatch(retakeReadingNotice(v7), /front photo/);
  assert.match(retakeReadingNotice(v7), /could not be reached/);
});

test("a real photo rejection still asks for a front retake", () => {
  const rejected = [
    { capability: "hair-type", status: "succeeded", error_code: null },
    { capability: "face-attributes", status: "failed", error_code: "INVALID_PHOTO" },
  ];
  assert.equal(providerSideFailure(rejected), false);
  assert.equal(retakeSlotFor(rejected), "front");
  assert.match(retakeReadingNotice(rejected), /front photo/);
});

test("the failure log line carries code, stage detail and the raw provider error", () => {
  const line = failureLogLine("face-attributes", { code: "INVALID_PHOTO", detail: "task_error=error_face_angle_leftward", providerError: "error_face_angle_leftward" });
  assert.match(line, /capability=face-attributes code=INVALID_PHOTO detail=task_error=error_face_angle_leftward providerError=error_face_angle_leftward/);
  assert.match(failureLogLine("hair-type", { code: "PROVIDER_UNAVAILABLE" }), /detail=- providerError=-$/);
});
