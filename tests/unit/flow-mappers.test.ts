import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaletteItem } from "../../src/client/api.js";
import {
  fitScoreForCard,
  mapAnalysisToProfileFields,
  photoRoleForSlot,
  preferenceScoreForCard,
  previewSourceBadgeLabel,
  rankingGroupFor,
  realismLabelForCard,
  routeForSessionState,
  slotForPhotoRole,
  templateFilenameForStyleKey,
} from "../../src/client/flow/flow-mappers.js";

test("mapAnalysisToProfileFields uses Not sure for missing analysis", () => {
  const fields = mapAnalysisToProfileFields(null);
  assert.equal(fields.length, 6);
  assert.ok(fields.every((field) => field.value === "Not sure"));
});

test("preview source labels match contract", () => {
  assert.equal(previewSourceBadgeLabel("youcam"), "YouCam render");
  assert.equal(previewSourceBadgeLabel("cached"), "Cached demo render");
  assert.equal(previewSourceBadgeLabel("fixture"), "Test fixture");
  assert.equal(previewSourceBadgeLabel(null), null);
});

test("photo slot roles map to server roles", () => {
  assert.equal(photoRoleForSlot("down"), "crown");
  assert.equal(slotForPhotoRole("crown"), "down");
});

test("ranking helpers derive fit, preference and groups", () => {
  const card: PaletteItem = {
    key: "haircut:male_textured_crop",
    title: "Textured crop",
    score: 88,
    label: "realistic",
    reasons: ["Keeps your wave tidy."],
    stylistScript: "Ask for texture on top.",
    stylingMinutes: 5,
    maintenanceWeeks: 4,
    components: { hairBehavior: 20, face: 20, hairline: 5, head: 5, lifestyle: 5, features: 3, trend: 3, goals: 10 },
    confidence: 0.8,
    missingCm: null,
    months: null,
    lengthBand: "short",
    feasible: true,
    imageUrl: null,
  };
  assert.equal(rankingGroupFor(card), "less-styling");
  assert.equal(realismLabelForCard(card), "Works today");
  assert.equal(fitScoreForCard(card), 88);
  assert.equal(preferenceScoreForCard(card, true), 60);
  assert.equal(preferenceScoreForCard(card, false), null);
  assert.equal(templateFilenameForStyleKey(card.key), "catalog/men/male-textured-crop.jpg");
});

test("route guard sends users to the correct step", () => {
  assert.equal(
    routeForSessionState({
      hasFrontPhoto: false,
      analysisStatus: "ready",
      hasRecommendations: true,
      hasPreviews: false,
      target: "/demo/goal",
    }),
    "/demo",
  );
  assert.equal(
    routeForSessionState({
      hasFrontPhoto: true,
      analysisStatus: "ready",
      hasRecommendations: true,
      hasPreviews: false,
      target: "/demo/tryon",
    }),
    "/demo/results",
  );
});
