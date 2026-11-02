import assert from "node:assert/strict";
import { test } from "node:test";
import { analysisPlanQuery } from "../../src/shared/face-colour.js";
import { buildRequestPlan, includesScalpAnalysis } from "../../src/server/profiles/request-plan.js";
import type { HairProfileInput } from "../../src/server/profiles/hair-profile.js";

const face = "11111111-1111-4111-8111-111111111111";
const front = "22222222-2222-4222-8222-222222222222";

const completeFace = {
  faceshape: "Heart",
  facialratio: {
    horizontal_third: [31, 35, 34],
    vertical_fifth: [13, 19, 28, 19, 21],
    face_aspect_ratio: [1000, 1431],
  },
  eyebrow: { shape: "arched" },
  agegender: { age: 30, gender: "male" },
  attractiveness: 0.8,
};

const completeTones = {
  skin_color: "#b08f76",
  hair_color: "#B56637",
  hair_color_name: "Auburn",
  eye_color: "#4f4453",
  eye_color_name: "Other",
  eyebrow_color: "#5b575a",
  lip_color: "#905657",
};

test("analysis choices stay off unless the client opts in", () => {
  assert.equal(analysisPlanQuery({ silhouette: false, tones: false }), "silhouette=0&tones=0");
  assert.equal(analysisPlanQuery({ silhouette: true, tones: false }), "silhouette=1&tones=0");
  assert.equal(analysisPlanQuery({ silhouette: false, tones: true }), "silhouette=0&tones=1");
});

test("face and colour profiles keep only silhouette and tone fields", () => {
  const plan = buildRequestPlan(input({
    services: ["haircut"],
    assets: [asset(face, "current_face"), asset(front, "current_front")],
    observations: [
      observation("face-attributes", [face], completeFace),
      observation("facial-color-tones", [face], completeTones),
    ],
  }), { silhouette: true, tones: true });
  const faceSlot = plan.slots.find((item) => item.capability === "face-attributes");
  const toneSlot = plan.slots.find((item) => item.capability === "facial-color-tones");
  assert.equal(faceSlot?.status, "current");
  assert.deepEqual(faceSlot?.value, {
    faceShape: "Heart",
    horizontalThird: [31, 35, 34],
    verticalFifth: [13, 19, 28, 19, 21],
    faceAspectRatio: [1000, 1431],
  });
  assert.equal(JSON.stringify(faceSlot).includes("agegender"), false);
  assert.equal(JSON.stringify(faceSlot).includes("eyebrow"), false);
  assert.equal(JSON.stringify(faceSlot).includes("attractiveness"), false);
  assert.equal(JSON.stringify(faceSlot).includes("gender"), false);
  assert.equal(toneSlot?.status, "current");
  assert.equal(toneSlot?.value && "hairColorName" in toneSlot.value ? toneSlot.value.hairColorName : null, "Auburn");
  assert.deepEqual(plan.coverage, ["face-attributes", "facial-color-tones"]);
  assert.equal(plan.schedule.includes("face-attributes"), false);
});

test("an incomplete optional result stays unknown", () => {
  const plan = buildRequestPlan(input({
    services: ["colour"],
    assets: [asset(face, "current_face")],
    observations: [observation("face-attributes", [face], { faceshape: "Oval", facialratio: { horizontal_third: [33, 33, 33] } })],
  }), { silhouette: true, tones: true });
  const faceSlot = plan.slots.find((item) => item.capability === "face-attributes");
  assert.equal(faceSlot?.status, "unknown");
  assert.equal(faceSlot?.value, null);
  assert.equal(faceSlot?.nextAction, "stylist_review");
  assert.equal(plan.schedule.includes("face-attributes"), false);
});

test("a beard-only request plan does not schedule scalp analysis", () => {
  const plan = buildRequestPlan(input({
    services: ["beard"],
    assets: [asset(face, "current_face"), asset(front, "current_front")],
    observations: [],
  }), { silhouette: true, tones: true });
  assert.equal(includesScalpAnalysis(plan.schedule), false);
  assert.deepEqual(plan.schedule, ["face-attributes", "facial-color-tones"]);
  assert.equal(plan.slots.every((item) => item.enabled), true);

  const paused = buildRequestPlan(input({
    services: ["beard"],
    assets: [asset(face, "current_face")],
    observations: [],
  }), { silhouette: false, tones: false });
  assert.deepEqual(paused.schedule, []);
  assert.deepEqual(paused.coverage, ["face-attributes", "facial-color-tones"]);
  assert.equal(paused.slots.every((item) => item.enabled === false && item.status === "unknown"), true);
});

test("a frontal hair photograph is not reused as the unobstructed face", () => {
  const plan = buildRequestPlan(input({
    services: ["beard"],
    assets: [asset(front, "current_front")],
    observations: [observation("face-attributes", [front], completeFace)],
  }), { silhouette: true, tones: false });
  const faceSlot = plan.slots.find((item) => item.capability === "face-attributes");
  assert.equal(faceSlot?.status, "unknown");
  assert.equal(faceSlot?.value, null);
  assert.equal(plan.schedule.includes("face-attributes"), false);
});

function input(overrides: Pick<HairProfileInput, "services" | "assets" | "observations">): HairProfileInput {
  return { presentation: "real", jobs: [], ...overrides };
}

function asset(id: string, role: string): HairProfileInput["assets"][number] {
  return { id, role, deleted: false, createdAt: "2026-10-11T10:00:00.000Z" };
}

function observation(capability: string, inputAssetIds: string[], values: Record<string, unknown>): HairProfileInput["observations"][number] {
  return { capability, source: "youcam", values, uncertainty: null, observedAt: "2026-10-11T10:05:00.000Z", inputAssetIds };
}
