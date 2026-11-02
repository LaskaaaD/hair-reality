import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analysisOutcome,
  captureStamp,
  clipProviderReason,
  crownReadingNotice,
  retakeReadingNotice,
  retakeSlotFor,
} from "../../src/server/demo/jobs.js";

const done = [
  { capability: "hair-type", status: "succeeded" },
  { capability: "face-attributes", status: "succeeded" },
  { capability: "hair-density", status: "failed" },
];

test("a failed crown reading does not fail the analysis when the front succeeded", () => {
  assert.equal(analysisOutcome(done), "ready");
  assert.equal(retakeSlotFor(done), null);
  assert.match(crownReadingNotice(done) ?? "", /crown photo/);
  assert.match(crownReadingNotice(done) ?? "", /front photo was accepted/);
});

test("a failed front still asks for a retake, and an open job stays running", () => {
  const frontFailed = [
    { capability: "hair-type", status: "succeeded" },
    { capability: "face-attributes", status: "failed" },
    { capability: "hair-density", status: "succeeded" },
  ];
  assert.equal(analysisOutcome(frontFailed), "failed");
  assert.equal(retakeSlotFor(frontFailed), "front");
  assert.match(retakeReadingNotice(frontFailed), /front photo/);
  assert.equal(crownReadingNotice(frontFailed), null);
  assert.equal(analysisOutcome([...done, { capability: "hair-density", status: "running" }]), "running");
});

test("provider reasons stay short and a vision stamp still matches the capture", () => {
  const stamp = "a".repeat(64);
  assert.equal(captureStamp(`${stamp}:vision`), stamp);
  assert.equal(captureStamp("not-a-stamp"), null);
  assert.equal(clipProviderReason("  No face was detected in the source image.  "), "No face was detected in the source image.");
  assert.equal(clipProviderReason("x".repeat(400))?.length, 180);
  assert.equal(clipProviderReason("   "), null);
});
