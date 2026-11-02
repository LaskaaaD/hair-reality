import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FEASIBILITY_LABELS,
  feasibilityLabel,
  scoreRingTone,
  scoreToFeasibilityTier,
  scoreToVerdict,
} from "../../src/client/design/feasibility.js";

describe("design feasibility helpers", () => {
  it("maps scores to the five board tiers", () => {
    assert.equal(scoreToFeasibilityTier(94), "highly_feasible");
    assert.equal(scoreToFeasibilityTier(75), "realistic");
    assert.equal(scoreToFeasibilityTier(60), "possible");
    assert.equal(scoreToFeasibilityTier(45), "challenging");
    assert.equal(scoreToFeasibilityTier(20), "not_recommended");
  });

  it("clamps out-of-range scores", () => {
    assert.equal(scoreToFeasibilityTier(-5), "not_recommended");
    assert.equal(scoreToFeasibilityTier(150), "highly_feasible");
  });

  it("returns human labels", () => {
    assert.equal(feasibilityLabel(88), FEASIBILITY_LABELS.highly_feasible);
    assert.equal(feasibilityLabel(40), FEASIBILITY_LABELS.challenging);
  });

  it("maps ring tone bands", () => {
    assert.equal(scoreRingTone(80), "high");
    assert.equal(scoreRingTone(55), "mid");
    assert.equal(scoreRingTone(30), "low");
  });

  it("returns short verdict copy", () => {
    assert.equal(scoreToVerdict(92), "Works today");
    assert.equal(scoreToVerdict(44), "Grow first");
  });
});
