import assert from "node:assert/strict";
import test from "node:test";
import { judgePose, measurePose, type PoseLandmark } from "../../src/client/flow/states/capture-pose.js";

const W = 1280;
const H = 720;

/** Builds the six landmarks the pose maths reads, for a head turned by yaw/pitch/roll degrees. */
function face(yaw: number, pitch = 0, roll = 0, size = 0.4): PoseLandmark[] {
  const marks: PoseLandmark[] = Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const halfWidth = 0.14;
  const halfHeight = size / 2;
  const tall = H / W;
  marks[234] = { x: 0.5 - halfWidth * Math.cos(rad(yaw)), y: 0.5, z: -halfWidth * Math.sin(rad(yaw)) };
  marks[454] = { x: 0.5 + halfWidth * Math.cos(rad(yaw)), y: 0.5, z: halfWidth * Math.sin(rad(yaw)) };
  marks[10] = { x: 0.5, y: 0.5 - (halfHeight * Math.cos(rad(pitch))), z: -halfHeight * tall * Math.sin(rad(pitch)) };
  marks[152] = { x: 0.5, y: 0.5 + (halfHeight * Math.cos(rad(pitch))), z: halfHeight * tall * Math.sin(rad(pitch)) };
  marks[33] = { x: 0.5 - 0.07, y: 0.5 - 0.07 * Math.sin(rad(roll)) / tall, z: 0 };
  marks[263] = { x: 0.5 + 0.07, y: 0.5 + 0.07 * Math.sin(rad(roll)) / tall, z: 0 };
  return marks;
}

function verdict(target: Parameters<typeof judgePose>[0], yaw: number, pitch = 0, roll = 0, size = 0.4) {
  const metrics = measurePose(face(yaw, pitch, roll, size), W, H);
  assert.ok(metrics);
  return judgePose(target, metrics, 130);
}

test("front photo is accepted only when the head faces the camera", () => {
  assert.equal(verdict("front", 0).ok, true);
  assert.equal(verdict("front", 3, 3, 3).ok, true);
  assert.equal(verdict("front", 25).ok, false);
  assert.equal(verdict("front", -25).ok, false);
  assert.match(verdict("front", 25).message, /right/);
});

test("side photos need a clear turn toward the named side", () => {
  assert.equal(verdict("left", 40).ok, true);
  assert.equal(verdict("left", 10).ok, false);
  assert.equal(verdict("left", -40).ok, false);
  assert.equal(verdict("right", -40).ok, true);
  assert.equal(verdict("right", 40).ok, false);
});

test("top-of-head photo needs the chin tipped down", () => {
  assert.equal(verdict("down", 0, 35).ok, true);
  assert.equal(verdict("down", 0, 0).ok, false);
  assert.match(verdict("down", 0, 0).message, /chin down/);
});

test("distance, centring, tilt and light are checked before the pose", () => {
  assert.match(verdict("front", 0, 0, 0, 0.2).message, /closer/);
  assert.match(verdict("front", 0, 0, 0, 0.9).message, /back/);
  assert.match(verdict("front", 0, 0, 20).message, /level/);
  const metrics = measurePose(face(0), W, H);
  assert.ok(metrics);
  assert.match(judgePose("front", metrics, 20).message, /light/);
  assert.match(judgePose("front", { ...metrics, centerX: 0.8 }, 130).message, /Centre/);
});

/** Column-major 4x4 with a head rotated about x (pitch) and y (yaw), as MediaPipe reports it. */
function matrix(pitch: number, yaw = 0): number[] {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const [cp, sp, cy, sy] = [Math.cos(rad(pitch)), Math.sin(rad(pitch)), Math.cos(rad(yaw)), Math.sin(rad(yaw))];
  const r = [
    [cy, 0, sy],
    [sp * sy, cp, -sp * cy],
    [-cp * sy, sp, cp * cy],
  ];
  const out = Array.from<number>({ length: 16 }).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) out[col * 4 + row] = r[row]?.[col] ?? 0;
  out[15] = 1;
  return out;
}

test("the transformation matrix decides the angles when MediaPipe provides it", () => {
  const tipped = measurePose(face(0), W, H, matrix(11));
  assert.ok(tipped);
  assert.ok(Math.abs(tipped.pitch - 11) < 0.5);
  const verdictTipped = judgePose("front", tipped, 130);
  assert.equal(verdictTipped.ok, false);
  assert.match(verdictTipped.message, /lens/);
  const level = measurePose(face(0), W, H, matrix(2));
  assert.ok(level);
  assert.equal(judgePose("front", level, 130).ok, true);
  const turned = measurePose(face(0), W, H, matrix(0, 37));
  assert.ok(turned);
  assert.equal(judgePose("left", turned, 130).ok, true);
});

test("measurePose gives up on incomplete landmarks", () => {
  assert.equal(measurePose([], W, H), null);
});
