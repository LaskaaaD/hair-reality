import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-replay-test-")), "ledger.json");

import { known, type Person } from "../../src/domain/person.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { isSmoothCurl, isVeryCurly, needsStraightHair, needsTexturedHair } from "../../src/domain/texture-rules.js";
import { rankCandidates, FIT_RUBRIC, llmRankLooks, profileFacts } from "../../src/server/demo/llm-rank.js";
import { readRenderCache, writeRenderCache } from "../../src/server/demo/render-cache.js";
import { referenceCacheStyle } from "../../src/server/demo/reference-photo.js";
import { stylistEntry } from "../fixtures/stylist-fixture.js";
import { acceptance, baselineAcceptance, reasonsOk, recordedModel, replayProfile, runReplay } from "../../scripts/replay-ranking.js";

const EVERY_FIELD = ["growthDirection", "cowlickFront", "cowlickCrown", "hairline", "lengthCm", "frontCm", "topCm", "sideCm", "curl", "diameter", "density", "faceShape", "faceRatio", "jaw", "forehead", "glasses", "foreheadWidth", "ears"];

/** The real model left the crown cowlick unread (null, confidence 0.2), so 17 of the 18 fields merge. */
const READ_FIELDS = EVERY_FIELD.filter((key) => key !== "cowlickCrown");

test("replay: every field the live vision reading gave reaches the merged profile with its confidence", () => {
  const { person, filled, skipped } = replayProfile();
  assert.deepEqual([...filled].sort(), [...READ_FIELDS].sort());
  assert.deepEqual(skipped, ["cowlickCrown: model gave unknown", "recession: model gave unknown", "occipital: model gave unknown", "facialHair: model gave unknown"]);
  const facts = profileFacts(person);
  for (const key of READ_FIELDS) {
    const entry = facts[key] as { value: unknown; confidence: number } | null;
    assert.ok(entry, `${key} missing from the merged profile`);
    assert.ok(entry.confidence >= 0.5, `${key} lost its confidence`);
  }
  assert.equal(person.face.shape.value, "oval");
  assert.equal(person.hair.curl.value, "2a");
  assert.equal(person.hair.growthDirection.value, "side");
  assert.equal(person.hair.cowlickFront.value, true);
  assert.equal(person.hair.diameter.value, "medium");
  assert.equal(person.hair.density.value, 3);
  assert.equal(person.hair.frontCm.value, 7);
  assert.equal(person.hair.topCm.value, 6);
  assert.equal(person.hair.sideCm.value, 2.5);
});

function withCurl(curl: string): Person {
  const { person } = replayProfile();
  person.hair.curl = known(curl as never, "vision", 0.9);
  return person;
}

test("texture: straight and slightly wavy hair never ranks a perm, wave, loc, twist, afro or coil style", () => {
  const styles = loadStyles().filter((style) => style.service === "haircut");
  const textured = styles.filter((style) => needsTexturedHair(style));
  assert.ok(textured.length > 20, "the rule finds the textured styles");
  for (const curl of ["1", "2a", "2b"]) {
    const ranked = selectLooks({ service: "haircut", person: withCurl(curl), answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] }).ranked.filter((look) => !look.excluded);
    assert.deepEqual(ranked.filter((look) => needsTexturedHair(look.variant, curl)).map((look) => look.variant.title), [], `curl ${curl}`);
  }
  const names = textured.map((style) => style.title.toLowerCase()).join("|");
  for (const word of ["360 waves", "perm", "locs", "twist", "afro", "jheri"]) assert.ok(names.includes(word), `${word} is recognised as texture-requiring`);
});

test("texture: asking for it (a liked style) lifts the exclusion", () => {
  const person = withCurl("1");
  const perm = loadStyles().find((style) => /perm/i.test(style.title) && style.affinity !== "feminine")!;
  const blocked = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] }).ranked.find((look) => look.variant.key === perm.key)!;
  assert.equal(blocked.excluded, true);
  const liked = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [perm.key] }).ranked.find((look) => look.variant.key === perm.key)!;
  assert.equal(liked.excluded, false);
});

test("texture: very curly hair never ranks a style that needs straight hair", () => {
  assert.equal(isSmoothCurl("2c"), true);
  assert.equal(isVeryCurly("4a"), true);
  const ranked = selectLooks({ service: "haircut", person: withCurl("4b"), answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] }).ranked.filter((look) => !look.excluded);
  assert.ok(ranked.length > 10);
  assert.deepEqual(ranked.filter((look) => needsStraightHair(look.variant)).map((look) => look.variant.title), []);
});

test("replay: acceptance holds on the deterministic path and the recorded model path, and every shown card has a specific reason", async () => {
  for (const llm of ["none", "recorded"] as const) {
    const result = await runReplay({ llm });
    for (const item of acceptance(result.rows, result.person, result.ranked, result.spot)) assert.equal(item.ok, true, `${llm}: ${item.name}: ${item.detail}`);
    assert.ok(result.rows.length >= 15);
    for (const row of result.rows.slice(0, 15)) assert.ok(row.reason.trim().length >= 24, `${llm}: ${row.title} has no specific reason`);
    assert.equal(reasonsOk(result.rows), true);
  }
});

test("replay: with vision failed and the male answer nothing feminine is shown or ranked, and without the answer nothing is ranked", async () => {
  const failed = await runReplay({ llm: "none", visionFailed: true });
  assert.deepEqual(failed.filled, []);
  for (const item of baselineAcceptance(failed.rows, failed.ranked)) assert.equal(item.ok, true, `${item.name}: ${item.detail}`);
  const unanswered = await runReplay({ llm: "none", visionFailed: true, answers: emptyAnswers() });
  assert.equal(unanswered.rows.length, 0);
  assert.equal(unanswered.ranked.length, 0);
});

test("llm: the prompt carries the side-by-side profile, the rubric and the filtered candidates, and the guardrails hold", async () => {
  const { person } = replayProfile();
  const answers = { ...emptyAnswers(), presentation: "masculine" as const };
  const selection = selectLooks({ service: "haircut", person, answers, likes: [] });
  const fallback = selection.show;
  const candidates = rankCandidates(selection.ranked);
  const outsider = candidates.find((look) => !fallback.some((item) => item.variant.key === look.variant.key))!;
  const pompadour = selection.ranked.find((look) => look.variant.title === "Classic pompadour")!;
  const fitted = "A mocked reason that names the soft fringe and the forward growth.";
  const model = recordedModel({
    ranked: [
      stylistEntry(fallback[0]!, fitted, { hair_behavior: 3 }),
      stylistEntry(fallback[1]!, "A far-off criterion score that must be replaced by ours.", { face_balance: -24 }),
      stylistEntry(outsider, "Not part of the diversity-filtered shortlist, so it cannot be promoted.", { hair_behavior: 3 }),
      stylistEntry(pompadour, "Tall and bold, which the hard rules refuse for this client.", { face_balance: 20 }),
      stylistEntry(fallback[2]!, "Keeps some width at the sides and a short, easy top."),
    ],
    notes: "YouCam and vision agree on density; vision alone gave the lengths.",
  });
  const out = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: model.client, budgetUsd: 6, answers });
  assert.equal(out.path, "llm", out.note);
  assert.equal(model.prompts.length, 1);
  const prompt = model.prompts[0]!;
  assert.ok(prompt.includes(FIT_RUBRIC), "rubric");
  assert.ok(prompt.includes("senior barber-stylist"), "consultation persona");
  assert.ok(!/within \d+ points|ownFit/.test(prompt), "no tolerance rule and no anchoring score in the prompt");
  const sent = JSON.parse(prompt.slice(prompt.indexOf("{\"profile\""))) as { profile: Record<string, { value: unknown; source: string; readings: Record<string, unknown> }>; candidates: Record<string, unknown>[] };
  for (const key of READ_FIELDS) assert.ok(sent.profile[key], `profile.${key} sent to the model`);
  assert.deepEqual(Object.keys(sent.profile.density!.readings).sort(), ["vision", "youcam"], "YouCam's density stays next to the vision reading that won");
  assert.ok("vision" in sent.profile.curl!.readings, "the vision curl reading is sent");
  assert.equal(sent.candidates.length, candidates.length);
  for (const key of ["id", "t", "minL", "fh", "cr", "fr", "rm", "ah", "aw", "fd", "cu", "f"]) assert.ok(key in sent.candidates[0]!, `candidate.${key}`);
  assert.ok(sent.candidates.every((candidate) => ["pass", "adapt"].includes((candidate.f as string))), "only pass and adapt candidates are sent");
  const byKey = new Map(out.show.map((look) => [look.variant.key, look]));
  assert.equal(byKey.get(fallback[0]!.variant.key)!.reasons[0], fitted);
  assert.equal(byKey.get(fallback[0]!.variant.key)!.tellYourBarber, "Keep it textured on top and tidy at the neckline.");
  assert.equal(byKey.get(fallback[1]!.variant.key)!.components.face, selection.ranked.find((look) => look.variant.key === fallback[1]!.variant.key)!.components.face, "far-off criterion replaced by ours");
  assert.notEqual(byKey.get(outsider.variant.key)?.reasons[0], "Not part of the diversity-filtered shortlist, so it cannot be promoted.");
  assert.ok((byKey.get(pompadour.variant.key)?.score ?? 0) <= pompadour.score, "hard rule keeps our score");
  for (const look of out.show) assert.notEqual(look.variant.affinity, "feminine");
});

test("render cache: a template render is never served to a reference request, and another photo never shares an entry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hr-cache-"));
  const key = "haircut:crop--french-crop";
  const template = Buffer.from("template-render");
  const reference = Buffer.from("reference-render");
  const refStyle = referenceCacheStyle("style-french-crop.jpg");
  await writeRenderCache({ cacheDir: dir, contentHash: "photoA", candidateKey: key, templateId: "tpl_french_crop", bytes: template });
  await writeRenderCache({ cacheDir: dir, contentHash: "photoA", candidateKey: key, templateId: refStyle, bytes: reference });
  const read = (contentHash: string, templateId: string | null, samplePhotoHash: string | null = null) => readRenderCache({ cacheDir: dir, contentHash, candidateKey: key, templateId, samplePhotoHash });
  assert.deepEqual(await read("photoA", "tpl_french_crop"), template);
  assert.deepEqual(await read("photoA", refStyle), reference);
  assert.equal(await read("photoB", "tpl_french_crop"), null, "different photo");
  assert.equal(await read("photoB", refStyle), null, "different photo, reference");
  assert.equal(await read("photoA", referenceCacheStyle("style-other.jpg")), null, "different reference photo");
  assert.equal(await read("samplehash", refStyle, "samplehash"), null, "committed template seeds are never served to a reference request");
});
