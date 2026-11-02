import assert from "node:assert/strict";
import test from "node:test";
import { analysisCaptureRoles } from "../../src/shared/analysis-assets.js";
import { analysisCapabilities } from "../../src/shared/face-colour.js";
import { interpretationOperations } from "../../src/shared/jobs.js";
import {
  describeStoredFindings,
  fixtureInterpretationValues,
  interpretationPromptText,
  interpretationSummary,
  rankingCatalogueText,
} from "../../src/server/jobs/interpretation-request.js";
import { openAIOperations } from "../../src/server/providers/openai/contract.js";
import { storageRolesFor, type YouCamCapability } from "../../src/server/providers/youcam/contract.js";

test("analysis photographs stay on the anatomical capture roles", () => {
  assert.deepEqual(interpretationOperations, openAIOperations);
  for (const capability of analysisCapabilities) {
    assert.deepEqual(analysisCaptureRoles[capability], storageRolesFor(capability as YouCamCapability));
  }
});

test("fixture interpretation keeps deterministic findings and does not invent a choice", () => {
  const explanation = fixtureInterpretationValues({
    operation: "finding_explanation",
    text: "Explain the supplied findings.",
    evidenceIds: ["rc-007"],
    candidateIds: [],
    findings: [{ id: "rc-007", outcome: "fail", evidenceIds: ["rc-007"] }],
    imageAssetIds: [],
  });
  assert.equal(explanation.uncertainty, "deterministic_fallback");
  assert.match(JSON.stringify(explanation.values), /outcome fail/);
  const ranking = fixtureInterpretationValues({
    operation: "candidate_ranking",
    text: "Rank only the supplied catalogue candidates.",
    evidenceIds: [],
    candidateIds: ["11111111-1111-4111-8111-111111111111"],
    findings: [],
    imageAssetIds: [],
  });
  assert.deepEqual(ranking.values, { rankedIds: [], omittedIds: [] });
  assert.equal(ranking.uncertainty, "fixture_not_a_model");
  const catalogue = rankingCatalogueText([
    { id: "short-bob", title: "Short Bob", length: "short", texture: "straight" },
    { id: "long-curls", title: "Long Spiral Curls", length: "long", texture: "curly" },
  ]);
  assert.match(catalogue, /not a saved client preference/);
  assert.match(catalogue, /short-bob: Short Bob; length short; texture straight/);
  assert.match(catalogue, /long-curls: Long Spiral Curls; length long; texture curly/);
});

test("live summaries name ranked candidates and review flags without treating fixtures as a model", () => {
  const titles = new Map([["cut-short", "Short Bob"]]);
  const ranking = interpretationSummary("live", { rankedIds: ["cut-short"], omittedIds: [] }, null, titles);
  assert.match(ranking, /1\. Short Bob/);
  assert.equal(ranking.includes("cut-short"), false);
  const flags = interpretationSummary("live", {
    flags: [{ candidateId: "cut-short", visibleDifference: "The fringe differs.", reviewRequired: true }],
  }, null, titles);
  assert.match(flags, /Short Bob: The fringe differs\. Review required\./);
  const fixture = interpretationSummary("fixture", { rankedIds: ["cut-short"], omittedIds: [] }, "fixture_not_a_model", titles);
  assert.match(fixture, /did not call OpenAI/);
});

test("stored findings keep their reason and do not copy the rule id as evidence", () => {
  const photo = "11111111-1111-4111-8111-111111111111";
  const described = describeStoredFindings([{
    service: "haircut",
    ruleId: "RC-007",
    outcome: "potential_mismatch",
    dimension: "maintenance",
    reason: "The target maintenance is high.",
    nextAction: "offer_alternative",
    evidenceRefs: [photo, "history:dyed"],
  }], "haircut");
  assert.deepEqual(described.findings[0]?.evidenceIds, [photo]);
  assert.equal(described.findings[0]?.evidenceIds.includes("rc-007"), false);
  assert.match(described.narrative, /dimension maintenance/);
  assert.match(described.narrative, /The target maintenance is high/);
  assert.match(described.narrative, /Next action: offer_alternative/);
  const prompt = interpretationPromptText(
    "candidate_ranking",
    { description: "A short cut", title: null },
    ["dont_want: curly"],
    [],
    "",
    false,
  );
  assert.match(prompt, /dont_want: curly/);
  const deviation = interpretationPromptText("preview_deviation", { description: null, title: null }, [], [], "", false);
  assert.match(deviation, /No photograph was attached/);
  assert.match(deviation, /not a visual comparison/);
});
