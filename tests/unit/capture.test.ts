import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { cameraKitDecision, captureConsentStatement, capturePlan, shotGuidance, tripletRoles } from "../../src/shared/capture.js";
import { preparePhotos } from "../../src/server/providers/youcam/prepare.js";

test("capture plans follow the service and keep the three-view order", () => {
  assert.deepEqual(capturePlan({ services: ["haircut"], facialProportions: false }), [
    "current_front",
    "current_right",
    "current_left",
    "current_density",
    "current_length",
  ]);
  assert.deepEqual(
    capturePlan({ services: ["haircut"], facialProportions: false }).slice(0, 3),
    [...tripletRoles],
  );
  assert.deepEqual(capturePlan({ services: ["colour"], facialProportions: false }), ["current_front", "current_face"]);
  assert.deepEqual(capturePlan({ services: ["beard"], facialProportions: false }), ["beard"]);
  assert.deepEqual(capturePlan({ services: ["beard"], facialProportions: true }), ["current_face", "beard"]);
  assert.deepEqual(capturePlan({ services: ["haircut", "colour", "beard"], facialProportions: true }), [
    "current_front",
    "current_right",
    "current_left",
    "current_density",
    "current_length",
    "current_face",
    "beard",
  ]);
  assert.equal(shotGuidance("current_front").measured, false);
  assert.match(shotGuidance("current_right").steps.join(" "), /not flipped/);
  assert.match(shotGuidance("current_left").steps.join(" "), /mirrored preview/);
  assert.equal(shotGuidance("current_length").steps.some((step) => step.includes("not reused")), true);
  assert.equal(cameraKitDecision.adopted, false);
  assert.match(captureConsentStatement(["youcam"]), /Saving a photograph does not send it/);
});

test("type and frizz preparation equalizes unequal frames without stretching", async () => {
  const sizes = [
    { role: "front", width: 400, height: 500 },
    { role: "right", width: 360, height: 480 },
    { role: "left", width: 320, height: 400 },
  ];
  const photos = await Promise.all(sizes.map(async (size) => ({
    role: size.role,
    bytes: await sharp({
      create: { width: size.width, height: size.height, channels: 3, background: "#888888" },
    }).jpeg().toBuffer(),
  })));
  const prepared = await preparePhotos("hair-type", photos);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.deepEqual(prepared.photos.map((photo) => photo.role), ["front", "right", "left"]);
  assert.deepEqual(prepared.photos.map((photo) => [photo.width, photo.height]), [
    [400, 500],
    [400, 500],
    [400, 500],
  ]);
});
