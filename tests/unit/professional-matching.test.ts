import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-pro-ledger-")), "ledger.json");

import { assessFeasibility, curlSteps, GROWTH_CM_PER_MONTH, MAX_GOAL_MONTHS } from "../../src/domain/feasibility.js";
import { loadStyles, type StyleVariant } from "../../src/domain/knowledge-base.js";
import { curlCodes, fixturePerson, known, type Person } from "../../src/domain/person.js";
import { barberTaste, canRender, compareLooks, CRITERIA_MAX, CRITERION_KEYS, emptyAnswers, fitFromComponents, selectLooks, spreadTiedDisplayScores, tasteApplies, type Answers } from "../../src/domain/scoring.js";
import { FRINGE_HEAVY_MIN, isFringeHeavy, isTextureBuilt } from "../../src/domain/style-traits.js";
import { formatFit, roundFit } from "../../src/shared/fit.js";
import { fitScoreForCard } from "../../src/client/flow/flow-mappers.js";
import { consultationAnswers, FIT_RUBRIC, llmRankLooks, mergeRanking, parseRankAnswer, profileFacts, rankCandidates, STYLIST_INSTRUCTIONS } from "../../src/server/demo/llm-rank.js";
import { buildRankCapture, readRankCapture, writeRankCapture } from "../../src/server/demo/rank-capture.js";
import { cardFrom } from "../../src/server/demo/routes.js";
import { applyVisionDetailed, readVision } from "../../src/server/demo/vision.js";
import { EXPECTED_TOP, evalProfiles, replayCapture, replayProfile, recordedModel, runReplay } from "../../scripts/replay-ranking.js";
import { curlyDenseMan, recedingThinMan, wavyWoman } from "../fixtures/eval-profiles.js";
import { stylistEntry } from "../fixtures/stylist-fixture.js";

const styles = loadStyles();
const haircuts = styles.filter((style) => style.service === "haircut");
const masculine: Answers = { ...emptyAnswers(), presentation: "masculine" };
const byTitle = (title: string): StyleVariant => {
  const found = haircuts.find((style) => style.title === title);
  assert.ok(found, title);
  return found;
};

function man(): Person {
  const person = fixturePerson("fixture");
  person.hair.curl = known("2a", "vision", 0.8);
  person.hair.density = known(3, "youcam", 0.85);
  person.hair.diameter = known("medium", "vision", 0.7);
  person.hair.lengthCm = known(10, "vision", 0.8);
  person.hair.topCm = known(10, "vision", 0.8);
  person.hair.frontCm = known(9, "vision", 0.8);
  person.hair.sideCm = known(3, "vision", 0.8);
  return person;
}

const check = (person: Person, variant: StyleVariant, answers: Answers = masculine, liked = false) =>
  assessFeasibility(person, answers, variant, { liked, presentation: "masculine", acceptsPresentation: true });

// 3. Catalogue attributes ---------------------------------------------------------------------------------------

test("catalogue: every style has every attribute the hard filters read, with valid values", () => {
  const fades = ["none", "low", "mid", "high", "skin"];
  const crowns = ["short", "in-between", "long"];
  const recessions = ["none", "mild", "moderate", "advanced"];
  assert.ok(styles.length > 500);
  for (const style of styles) {
    const t = style.traits;
    const label = style.key;
    assert.ok(fades.includes(t.fadeHeight), `${label} fadeHeight`);
    assert.ok(crowns.includes(t.crownLength), `${label} crownLength`);
    assert.ok(recessions.includes(t.recessionMax), `${label} recessionMax`);
    assert.ok(t.fringeWeight >= 0 && t.fringeWeight <= 1, `${label} fringeWeight`);
    assert.ok(["none", "split", "side", "textured", "blunt"].includes(t.fringeKind), `${label} fringeKind`);
    assert.ok(t.minDensity >= 1 && t.maxDensity <= 4 && t.minDensity <= t.maxDensity, `${label} density range`);
    assert.equal(typeof t.bulkSensitive, "boolean", `${label} bulkSensitive`);
    for (const zone of ["front", "top", "sides"] as const) assert.ok(t.minLengthCm[zone] === null || t.minLengthCm[zone]! >= 0, `${label} min length ${zone}`);
    assert.ok(curlCodes.indexOf(t.curlRange.min) >= 0 && curlCodes.indexOf(t.curlRange.min) <= curlCodes.indexOf(t.curlRange.max), `${label} curlRange`);
    if (style.service === "haircut") assert.ok(style.requirements.curl.every((code) => curlSteps(code, t.curlRange) === 0), `${label} curlRange covers its requirements`);
  }
  const quiffs = haircuts.filter((style) => /pompadour|slick back|quiff/i.test(style.title));
  assert.ok(quiffs.length > 3 && quiffs.every((style) => style.traits.recessionMax === "mild" || style.traits.recessionMax === "none"), "swept-back cuts tolerate little recession");
  assert.ok(haircuts.some((style) => style.traits.fadeHeight === "skin") && haircuts.some((style) => style.traits.crownLength === "in-between"));
});

// 1. Hard feasibility filters -----------------------------------------------------------------------------------

test("filters: curl one step outside adapts, two or more fail unless liked or permed, and shrinkage turns length into a goal", () => {
  const person = man();
  const smooth = byTitle("Classic side part");
  assert.equal(check(person, smooth).status, "pass");
  person.hair.curl = known("3a", "vision", 0.8);
  const near = check(person, smooth);
  assert.equal(near.status, "adapt");
  assert.ok(near.checks.some((c) => c.check === "curl" && c.status === "adapt"));
  person.hair.curl = known("3b", "vision", 0.8);
  const far = check(person, smooth);
  assert.equal(far.status, "fail");
  assert.match(far.failReason ?? "", /curl/i);
  assert.equal(check(person, smooth, masculine, true).checks.find((c) => c.check === "curl")?.status, "adapt", "a liked style is adapted, not failed, on the curl step count");
  assert.equal(check(person, smooth, { ...masculine, chemical: "permed" }).checks.some((c) => c.check === "curl" && c.status === "fail"), false);
  // Shrinkage: 7 cm of 3b hair reads as 4.9 cm, so a 10 cm top is a grow-out goal.
  const long = haircuts.find((style) => style.requirements.curl.includes("3b") && (style.requirements.topCm ?? 0) >= 10);
  assert.ok(long, "a curl-friendly style with 10 cm or more on top exists");
  person.hair.topCm = known(7, "vision", 0.9);
  person.hair.frontCm = known(7, "vision", 0.9);
  person.hair.lengthCm = known(7, "vision", 0.9);
  const goal = check(person, long);
  assert.equal(goal.status === "goal" || goal.status === "fail", true);
  if (goal.status === "goal") {
    const months = Math.ceil(goal.growth!.missingCm / GROWTH_CM_PER_MONTH);
    assert.equal(goal.growth!.months, months);
    assert.match(goal.growth!.text, /sprung back/, "the note says the curl springs back");
  }
  person.hair.curl = known("1", "vision", 0.9);
  const straight = check(person, long);
  assert.ok(!straight.growth || straight.growth.missingCm < (goal.growth?.missingCm ?? 99), "straight hair loses nothing to shrinkage");
});

test("filters: a grow-out longer than the cap fails, a shorter one is a goal", () => {
  const person = man();
  person.hair.lengthCm = known(3, "answer", 1);
  person.hair.topCm = known(3, "answer", 1);
  person.hair.frontCm = known(3, "answer", 1);
  const goals = haircuts.filter((style) => style.affinity !== "feminine" && style.requirements.curl.includes("2a")).map((style) => check(person, style));
  const goal = goals.find((result) => result.status === "goal");
  const fail = goals.find((result) => result.checks.some((c) => c.check === "length" && c.status === "fail"));
  assert.ok(goal?.growth && goal.growth.months <= MAX_GOAL_MONTHS);
  assert.ok(fail, "a style more than the cap away fails");
  assert.equal(fail!.growth, null, "a failed style carries no grow-out plan");
});

test("filters: density and strand thickness", () => {
  const person = man();
  person.hair.density = known(1, "youcam", 0.9);
  const heavy = haircuts.find((style) => style.affinity !== "feminine" && style.fit.mass === "heavy" && style.requirements.densityMin >= 2 && style.requirements.curl.includes("2a") && !style.requirements.needsExtension);
  assert.ok(heavy);
  person.hair.topCm = known(40, "vision", 0.9);
  person.hair.frontCm = known(40, "vision", 0.9);
  person.hair.lengthCm = known(40, "vision", 0.9);
  person.hair.sideCm = known(40, "vision", 0.9);
  assert.equal(check(person, heavy).status, "fail");
  assert.match(check(person, heavy).failReason ?? "", /density/i);
  person.hair.density = known(4, "youcam", 0.9);
  person.hair.diameter = known("coarse", "vision", 0.9);
  const bulky = haircuts.find((style) => style.affinity !== "feminine" && style.traits.bulkSensitive && style.requirements.curl.includes("2a"));
  assert.ok(bulky);
  assert.ok(check(person, bulky).checks.some((c) => c.check === "density" && c.status === "adapt"), "dense coarse hair on a bulk-sensitive cut needs weight taken out");
});

test("filters: recession, front cowlick and crown whorl", () => {
  const slick = haircuts.find((style) => /^Classic pompadour$/.test(style.title))!;
  const crop = haircuts.find((style) => style.title === "Textured French crop with low taper")!;
  const person = man();
  person.hair.recession = known("moderate", "vision", 0.8);
  assert.equal(check(person, slick).status, "fail");
  assert.notEqual(check(person, crop).status, "fail");
  person.hair.recession = known("advanced", "vision", 0.8);
  const advanced = haircuts.filter((style) => style.affinity !== "feminine" && check(person, style).status !== "fail" && check(person, style).status !== "goal");
  assert.ok(advanced.length > 0 && advanced.every((style) => style.traits.recessionMax === "advanced"), "only crops, buzz and shaved cuts remain");
  person.hair.recession = known("mild", "vision", 0.8);
  assert.equal(check(person, slick).checks.some((c) => c.check === "recession"), false, "a cut that tolerates mild recession is not changed by it");
  // A reading under the confidence floor is a guess: no filter uses it.
  person.hair.recession = known("advanced", "vision", 0.3);
  assert.equal(check(person, slick).checks.some((c) => c.check === "recession"), false);
  person.hair.recession = { value: "unknown", confidence: 0, source: "vision" };
  assert.equal(check(person, slick).checks.some((c) => c.check === "recession"), false);

  const fringe = haircuts.find((style) => style.affinity !== "feminine" && style.traits.fringeWeight > 0.6 && style.traits.fringeKind !== "split" && style.traits.fringeKind !== "side");
  assert.ok(fringe, "a heavy full-fringe style exists");
  const cowlick = man();
  cowlick.hair.cowlickFront = known(true, "vision", 0.8);
  assert.ok(check(cowlick, fringe).checks.some((c) => c.check === "cowlick" && c.status === "adapt"));
  cowlick.hair.cowlickFront = known(true, "vision", 0.3);
  assert.equal(check(cowlick, fringe).checks.some((c) => c.check === "cowlick"), false);

  const whorl = man();
  whorl.hair.cowlickCrown = known(true, "vision", 0.8);
  const highFade = haircuts.find((style) => style.affinity !== "feminine" && (style.traits.fadeHeight === "high" || style.traits.fadeHeight === "skin"))!;
  assert.ok(check(whorl, highFade).checks.some((c) => c.check === "crown" && c.status === "adapt"), "crown whorl against a high fade");
  const inBetween = haircuts.find((style) => style.affinity !== "feminine" && style.traits.crownLength === "in-between" && style.traits.fadeHeight !== "high" && style.traits.fadeHeight !== "skin")!;
  assert.ok(check(whorl, inBetween).checks.some((c) => c.check === "crown" && c.status === "adapt"), "crown whorl at the in-between length");
});

test("filters: a failed style never reaches ranking, the model or a render, and goals go to the grow-out group", () => {
  const { person } = replayProfile();
  const answers = masculine;
  const selection = selectLooks({ service: "haircut", person: { ...person, hair: { ...person.hair, recession: known("moderate", "vision", 0.8) } }, answers, likes: [] });
  const failed = selection.ranked.filter((look) => look.feasibility.status === "fail");
  assert.ok(failed.length > 5);
  for (const look of failed) {
    assert.equal(look.excluded, true);
    assert.equal(canRender(look), false);
    assert.ok(look.feasibility.failReason && look.feasibility.failReason.length > 10, "a plain reason");
    assert.ok(!selection.show.some((item) => item.variant.key === look.variant.key));
    assert.ok(!selection.goals.some((item) => item.variant.key === look.variant.key));
    assert.ok(!rankCandidates(selection.ranked).some((item) => item.variant.key === look.variant.key));
  }
  for (const look of selection.goals) assert.equal(look.feasibility.status, "goal");
  assert.ok(selection.goals.length > 0);
  for (const look of rankCandidates(selection.ranked)) assert.ok(look.feasibility.status === "pass" || look.feasibility.status === "adapt");
});

// 2. Profile: both readings kept --------------------------------------------------------------------------------

test("profile: YouCam and vision readings stay side by side with source and confidence, and the LLM sees both", () => {
  const { person } = replayProfile();
  assert.ok(person.candidates?.density?.some((c) => c.source === "youcam" && c.value === 3));
  assert.ok(person.candidates?.density?.some((c) => c.source === "vision"));
  const facts = profileFacts(person, masculine) as Record<string, { value: unknown; confidence: number; source: string; readings: Record<string, { value: unknown; confidence: number }> }>;
  assert.deepEqual(Object.keys(facts.density!.readings).sort(), ["vision", "youcam"]);
  assert.equal(facts.density!.readings.youcam!.confidence, 0.85);
  assert.equal(facts.curl!.source, "vision");
  // A disagreement is flagged for the model.
  const disagree = curlyDenseMan().person;
  const curly = profileFacts(disagree) as Record<string, { disagree?: boolean; readings: Record<string, { value: unknown }> }>;
  assert.equal(curly.curl!.disagree, true);
  assert.deepEqual([curly.curl!.readings.youcam!.value, curly.curl!.readings.vision!.value], ["3b", "3a"]);
});

test("profile: the questionnaire answer is a third reading and wins the resolved value", () => {
  const { person } = replayProfile();
  const facts = profileFacts(person, { ...masculine, strand: "coarse" }) as Record<string, { value: unknown; source: string; readings: Record<string, unknown> }>;
  assert.equal(facts.diameter!.value, "coarse");
  assert.equal(facts.diameter!.source, "answer");
  assert.ok("vision" in facts.diameter!.readings && "answer" in facts.diameter!.readings);
  assert.deepEqual(consultationAnswers({ ...masculine, stylingMinutes: "5" }).stylingMinutesPerDay, "5");
});

test("vision: recession, crown whorl and the back of the head are read defensively", () => {
  const base = JSON.parse(readFileSync(path.join("tests", "fixtures", "user-replay", "vision-reply-v9.json"), "utf8")) as Record<string, unknown>;
  const read = readVision({ ...base, recession: "Receding", crownWhorl: true, occipital: "flatter", fieldConfidence: { ...(base.fieldConfidence as object), recession: 0.8, crownWhorl: 0.7, occipital: 0.6 } });
  assert.ok(read);
  assert.equal(read.reading.recession, "moderate");
  const merged = applyVisionDetailed(replayProfile().person, read.reading).person;
  assert.equal(merged.hair.recession?.value, "moderate");
  assert.equal(merged.hair.cowlickCrown.value, true, "the crown whorl feeds the crown cowlick when that was unread");
  assert.equal(merged.head.occipital.value, "flat");
  // Garbage and unknown values drop only that field, and an unknown is never used by a hard filter.
  const bad = readVision({ ...base, recession: "gigantic", crownWhorl: "maybe", occipital: 7 });
  assert.ok(bad && bad.rejected.some((issue) => issue.field === "recession"));
  assert.equal(bad.reading.recession, "unknown");
  const none = applyVisionDetailed(replayProfile().person, bad.reading).person;
  assert.ok(!none.hair.recession || none.hair.recession.value === "unknown");
  assert.equal(check(none, byTitle("Classic pompadour")).checks.some((c) => c.check === "recession"), false);
});

// 4. Weights ---------------------------------------------------------------------------------------------------

test("weights: hair 30, face 25, hairline 15, head 10, lifestyle 10, features 5, trend 5, and every score stays inside its maximum", () => {
  assert.deepEqual(CRITERIA_MAX, { hairBehavior: 30, face: 25, hairline: 15, head: 10, lifestyle: 10, features: 5, trend: 5 });
  assert.equal(CRITERION_KEYS.reduce((sum, key) => sum + CRITERIA_MAX[key], 0), 100);
  for (const text of ["30 hair behaviour", "25 face balance", "15 hairline", "10 head", "10 lifestyle", "5 features", "5 2026 trend"]) assert.ok(FIT_RUBRIC.includes(text), text);
  const { person } = replayProfile();
  const ranked = selectLooks({ service: "haircut", person, answers: masculine, likes: [] }).ranked;
  for (const look of ranked) for (const key of CRITERION_KEYS) assert.ok(look.components[key] >= 0 && look.components[key] <= CRITERIA_MAX[key], `${look.variant.title} ${key}=${look.components[key]}`);
});

test("weights: each adapt costs hair-behaviour points, so a clean cut ranks above the same cut that needs a change", () => {
  const { person } = replayProfile();
  const plain = selectLooks({ service: "haircut", person, answers: masculine, likes: [] }).ranked.find((look) => look.variant.title === "Short curtains with low taper")!;
  const withWhorl = selectLooks({ service: "haircut", person: { ...person, hair: { ...person.hair, cowlickCrown: known(true, "vision", 0.8) } }, answers: masculine, likes: [] }).ranked.find((look) => look.variant.title === "Short curtains with low taper")!;
  assert.equal(plain.feasibility.status, "pass");
  assert.equal(withWhorl.feasibility.status, "adapt");
  assert.ok(withWhorl.components.hairBehavior < plain.components.hairBehavior);
  assert.ok(withWhorl.score < plain.score);
});

// 5. LLM ranking -----------------------------------------------------------------------------------------------

test("llm: the consultation schema parses, a legacy answer only keeps its reasons, and an invalid one is refused", () => {
  const fixture = JSON.parse(readFileSync(path.join("tests", "fixtures", "user-replay", "llm-rank-reply.json"), "utf8")) as unknown;
  const parsed = parseRankAnswer(JSON.stringify(fixture));
  assert.ok(parsed && parsed.ranked.length >= 10 && parsed.ranked.every((entry) => entry.scores && entry.tellYourBarber));
  const legacy = parseRankAnswer(readFileSync(path.join("tests", "fixtures", "user-replay", "llm-rank-reply-v1.json"), "utf8"));
  assert.ok(legacy && legacy.ranked.every((entry) => entry.scores === null && entry.tellYourBarber === null));
  assert.equal(parseRankAnswer("not json"), null);
  assert.equal(parseRankAnswer(JSON.stringify({ ranked: [{ id: "x", reason: "short" }] })), null);
  // A score over its maximum is clamped, never trusted past it.
  const over = parseRankAnswer(JSON.stringify({ ranked: [{ ...(fixture as { ranked: object[] }).ranked[0], scores: { hair_behavior: 99, face_balance: 99, hairline_forehead: 99, head_profile: 99, lifestyle: 99, features_context: 99, trend_2026: 99 } }] }));
  assert.deepEqual(Object.values(over!.ranked[0]!.scores!), [30, 25, 15, 10, 10, 5, 5]);
  assert.ok(STYLIST_INSTRUCTIONS.includes("senior barber-stylist") && !/within \d+ points/.test(STYLIST_INSTRUCTIONS), "persona set and the 8-point tolerance gone");
});

test("llm: the blend has no 8-point clamp, a failed style cannot be brought back, and a skip verdict only demotes", () => {
  const { person } = replayProfile();
  const selection = selectLooks({ service: "haircut", person, answers: masculine, likes: [] });
  const candidates = rankCandidates(selection.ranked);
  const [a, b, c, d] = candidates;
  const failed = selection.ranked.find((look) => look.excluded)!;
  const answer = {
    ranked: [
      stylistEntry(a!, "A reason that names the client and the style.", { hair_behavior: -10 }),
      { ...stylistEntry(failed, "A failed style the model tries to bring back anyway."), id: failed.variant.key },
      { ...stylistEntry(b!, "Another reason that names the client and the style."), verdict: "skip" as const },
      stylistEntry(c!, "A third reason that names the client and the style."),
      stylistEntry(d!, "A fourth reason that names the client and the style."),
    ],
  };
  const merged = mergeRanking(person, candidates, parseRankAnswer(JSON.stringify(answer))!)!;
  const out = new Map(merged.show.map((look) => [look.variant.key, look]));
  assert.equal(out.get(a!.variant.key)!.components.hairBehavior, Math.round(a!.components.hairBehavior - 5), "a 10-point criterion move is averaged to 5, not clamped to 8 total");
  assert.equal(out.has(failed.variant.key), false, "a failed style is not brought back");
  assert.equal(merged.show.at(-1)!.variant.key, b!.variant.key, "a skip verdict moves the style to the end");
  assert.ok(out.has(b!.variant.key), "and never removes it");
});

test("llm: the fixture stylist reply replays through the real path, keeps the render gate on llm, and stores the barber line on the card", async () => {
  const result = await runReplay({ llm: "recorded" });
  assert.equal(result.path, "llm", result.note);
  const lines = result.rows.filter((row) => row.look.tellYourBarber);
  assert.ok(lines.length >= 10);
  for (const row of lines) {
    const card = cardFrom(row.look, false) as { tellYourBarber: string | null };
    assert.equal(card.tellYourBarber, row.look.tellYourBarber);
    assert.doesNotMatch(card.tellYourBarber ?? "", /\bcm\b|\bmm\b|\bguard\b|\bclipper\b/i);
  }
  const rules = await runReplay({ llm: "none" });
  assert.equal((cardFrom(rules.rows[0]!.look, false) as { tellYourBarber: string | null }).tellYourBarber, null);
  const failing = await runReplay({ llm: "failing" });
  assert.equal(failing.path, "fallback");
});

test("llm: the old recorded model answer still replays, with its reasons only", async () => {
  const legacy = JSON.parse(readFileSync(path.join("tests", "fixtures", "user-replay", "llm-rank-reply-v1.json"), "utf8")) as unknown;
  const result = await runReplay({ llm: "recorded", rankReply: legacy });
  assert.equal(result.path, "llm", result.note);
  const rules = await runReplay({ llm: "none" });
  assert.deepEqual(result.rows.slice(0, 5).map((row) => row.look.components), result.rows.slice(0, 5).map((row) => rules.rows.find((r) => r.key === row.key)?.look.components ?? row.look.components), "the legacy answer does not move any score");
});

test("capture: version 2 stores the side-by-side profile and the barber lines, and a version 1 capture still replays", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hr-cap2-"));
  const { person } = replayProfile();
  const model = recordedModel(JSON.parse(readFileSync(path.join("tests", "fixtures", "user-replay", "llm-rank-reply.json"), "utf8")));
  const selection = selectLooks({ service: "haircut", person, answers: masculine, likes: [] });
  const fallback = selection.show;
  const ranking = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: model.client, budgetUsd: 6, answers: masculine });
  assert.equal(ranking.path, "llm");
  const capture = buildRankCapture({ person, ranking, answers: masculine, likes: [] });
  assert.equal(capture.version, 2);
  assert.ok(Object.keys(capture.tellYourBarber ?? {}).length >= 10);
  const file = writeRankCapture(capture, "session-x", dir);
  const read = readRankCapture(file);
  assert.equal(read.version, 2);
  const replayed = await replayCapture(read);
  assert.equal(replayed.path, "llm");
  const old = readRankCapture(writeRankCapture({ ...capture, version: 1, rawRank: readFileSync(path.join("tests", "fixtures", "user-replay", "llm-rank-reply-v1.json"), "utf8") }, "session-y", dir));
  assert.equal((await replayCapture(old)).path, "llm");
});

// 6. Evaluation profiles (rules only, no model) ------------------------------------------------------------------

const BOTTOM_SET = /pompadour|quiff|high and tight|disconnected undercut|faux hawk|high fade|skin\/bald fade/i;

test("eval: the reference client's own list leads the rules-only ranking and the tall high-fade shapes stay out of the top 15", async () => {
  const result = await runReplay({ llm: "none", visionFile: "vision-reply-v9.json" });
  const top10 = result.rows.slice(0, 10).map((row) => row.title);
  const overlap = EXPECTED_TOP.filter((title) => top10.includes(title));
  assert.ok(overlap.length >= 7, `${overlap.length} of 10 overlap: ${top10.join(", ")}`);
  const bad = result.rows.slice(0, 15).filter((row) => BOTTOM_SET.test(row.title));
  assert.deepEqual(bad.map((row) => row.title), []);
  const rankedBad = result.ranked.filter((look) => BOTTOM_SET.test(look.variant.title));
  assert.ok(rankedBad.every((look) => result.ranked.indexOf(look) >= 15), "also outside the first 15 of the full ranking");
  const curtains = result.rows.find((row) => row.title === "Short curtains with low taper")!;
  assert.notEqual(curtains.group, "grow-out", "curtains are a now cut, not a goal");
  assert.equal(curtains.look.feasibility.status, "pass");
});

test("eval: a curly dense man gets curl-built cuts first and nothing that needs straight hair", async () => {
  const profile = curlyDenseMan();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  const live = result.ranked.filter((look) => !look.excluded);
  for (const look of live) {
    assert.ok(curlSteps("3b", look.variant.traits.curlRange) <= 1, `${look.variant.title} is more than a step from 3b`);
  }
  const all = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] }).ranked;
  assert.ok(all.some((look) => look.excluded && look.variant.title === "Classic pompadour"), "straight-hair slick shapes fail");
  assert.ok(result.rows.slice(0, 10).every((row) => curlCodes.indexOf(row.look.variant.traits.curlRange.max) > curlCodes.indexOf("2c")), "no cut built only for straight to wavy hair in the top 10");
  const top10 = result.rows.slice(0, 10);
  assert.ok(top10.filter((row) => /curly|afro|twist|sponge|waves/i.test(row.title)).length >= 3, top10.map((row) => row.title).join(", "));
  assert.ok(top10.some((row) => /curly top taper|curly fringe|afro|twist/i.test(row.title)), "a curly top taper, curly fringe, afro or twist cut is in the top 10");
  const facts = profileFacts(profile.person) as { curl: { disagree?: boolean } };
  assert.equal(facts.curl.disagree, true, "the model is told YouCam and vision disagree on the curl");
  // Shrinkage: no style with a tall top is offered as a now cut.
  assert.ok(live.filter((look) => look.growth === null).every((look) => (look.variant.requirements.topCm ?? 0) <= 7 * 0.7 + 3.5 + 0.5 || look.variant.requirements.needsExtension), "shrunk 7 cm of curl is about 5 cm");
});

test("eval: a receding thin man gets crops and Caesar cuts first, no heavy fringe, slick-back or pompadour in the top 10", async () => {
  const profile = recedingThinMan();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  const top10 = result.rows.slice(0, 10);
  assert.deepEqual(top10.filter((row) => /slick|pompadour|quiff|comb over/i.test(row.title)).map((row) => row.title), []);
  assert.deepEqual(top10.filter((row) => row.look.variant.traits.fringeWeight > 0.6 || row.look.variant.traits.fringeKind === "blunt").map((row) => row.title), []);
  const top3 = top10.slice(0, 3);
  assert.ok(top3.every((row) => (row.look.variant.requirements.topCm ?? 99) <= 4.5), `top 3: ${top3.map((row) => row.title).join(", ")}`);
  // Round 12: the barber taste no longer lifts crops on this profile, so the purpose-built thin-hair cut may lead; it is still a short textured crop, which is what the name check stood for.
  assert.ok(top3.slice(0, 2).every((row) => /crop|caesar|buzz/i.test(row.title) || (row.look.variant.traits.fringeKind === "textured" && (row.look.variant.requirements.topCm ?? 99) <= 4.5)));
  const swept = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] }).ranked.filter((look) => /pompadour|slick back|quiff/i.test(look.variant.title) && look.variant.traits.recessionMax === "mild");
  assert.ok(swept.length > 5 && swept.every((look) => look.excluded), "every swept-back or tall style fails on moderate recession");
});

test("eval: a woman with wavy hair gets no men's styles at all, and long styles beyond the grow-out cap are not offered", async () => {
  const profile = wavyWoman();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  assert.ok(result.ranked.length > 50);
  assert.deepEqual(result.ranked.filter((look) => look.variant.affinity === "masculine").map((look) => look.variant.title), []);
  assert.deepEqual(result.rows.filter((row) => row.look.variant.affinity === "masculine").map((row) => row.title), []);
  const top10 = result.rows.slice(0, 10).map((row) => row.title);
  assert.ok(top10.filter((title) => /shag|lob|bob|bangs|layer|wolf|butterfly/i.test(title)).length >= 4, top10.join(", "));
  const nowOrGoal = result.ranked.filter((look) => !look.excluded);
  assert.ok(nowOrGoal.every((look) => look.growth === null || look.growth.months <= MAX_GOAL_MONTHS));
  const pixie = result.ranked.find((look) => /pixie/i.test(look.variant.title) && !look.excluded);
  assert.ok(pixie && pixie.growth === null, "a pixie is a now cut: hair can always go shorter");
});

// 7. Round 12 --------------------------------------------------------------------------------------------------------

test("round 12: a curly dense man's top 5 is all texture-built, no straight-built cut leads, and a combed-part cut fails on curls", async () => {
  const profile = curlyDenseMan();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  const top5 = result.rows.slice(0, 5);
  assert.ok(top5.every((row) => isTextureBuilt(row.look.variant.traits)), `top 5: ${top5.map((row) => row.title).join(", ")}`);
  const bestTexture = result.rows.findIndex((row) => isTextureBuilt(row.look.variant.traits));
  assert.equal(bestTexture, 0, "the best texture-built cut is the first card");
  const straightCrops = result.rows.filter((row) => row.look.variant.familyId === "crop" && !isTextureBuilt(row.look.variant.traits));
  assert.ok(straightCrops.every((row) => row.rank > bestTexture + 1), "no straight-built crop is above the best texture-built cut");
  const all = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] }).ranked;
  const ivy = all.find((look) => look.variant.title === "Ivy League")!;
  assert.equal(ivy.feasibility.status, "fail");
  assert.match(ivy.feasibility.failReason ?? "", /combed part/);
  assert.equal(ivy.variant.traits.combedPart, true);
  // One step outside is still an adapt (3a), and the client can keep a style they asked for.
  const nearer = curlyDenseMan().person;
  nearer.hair.curl = known("3a", "vision", 0.8);
  assert.equal(check(nearer, byTitle("Ivy League")).checks.find((c) => c.check === "curl")?.status, "adapt");
  assert.notEqual(check(profile.person, byTitle("Ivy League"), profile.answers, true).checks.find((c) => c.check === "curl")?.status, "fail");
  // The rule is general: every combed-part cut fails on 3b, and no texture-built cut is flagged.
  const combed = haircuts.filter((style) => style.traits.combedPart && style.affinity !== "feminine");
  assert.ok(combed.length >= 1 && combed.every((style) => !isTextureBuilt(style.traits)));
  assert.ok(combed.every((style) => check(profile.person, style, profile.answers).status === "fail"));
});

test("round 12: no fringe-heavy cut is in a receding thin man's top 10", async () => {
  assert.equal(FRINGE_HEAVY_MIN, 0.5, "fringe-heavy starts at half the forehead covered");
  const profile = recedingThinMan();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  const top10 = result.rows.slice(0, 10);
  assert.equal(top10.length, 10);
  assert.deepEqual(top10.filter((row) => isFringeHeavy(row.look.variant.traits)).map((row) => row.title), []);
  // A heavy fringe over a thinning front on thin hair fails with a plain reason; a style the client asked for stays, adapted.
  const everything = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] }).ranked;
  assert.ok(everything.filter((look) => isFringeHeavy(look.variant.traits)).length > 3, "fringe-heavy cuts exist");
  const failed = everything.filter((look) => isFringeHeavy(look.variant.traits) && look.feasibility.checks.some((c) => c.check === "recession" && c.status === "fail"));
  assert.ok(failed.length > 3 && failed.every((look) => look.feasibility.checks.some((c) => c.check === "recession" && /fringe/.test(c.note))));
  const messy = byTitle("Messy fringe");
  assert.equal(check(profile.person, messy, profile.answers, true).checks.find((c) => c.check === "recession")?.status, "adapt");
  // Short crops cover as much forehead (fringeWeight) but are not fringe-heavy.
  assert.equal(isFringeHeavy(byTitle("Textured French crop with low taper").traits), false);
  assert.equal(isFringeHeavy(byTitle("Messy fringe").traits), true);
});

test("round 12: the barber taste is off for curly, receding and women's profiles, and still counts for the straight-to-wavy client", async () => {
  for (const profile of [curlyDenseMan(), recedingThinMan(), wavyWoman()]) {
    assert.equal(tasteApplies(profile.person), false, profile.name);
    const ranked = selectLooks({ service: "haircut", person: profile.person, answers: profile.answers, likes: [] }).ranked;
    assert.ok(ranked.length > 50);
    assert.ok(ranked.every((look) => look.components.taste === 0), `${profile.name}: taste must be 0 everywhere`);
    assert.ok(haircuts.every((style) => barberTaste(profile.person, style) === 0), profile.name);
  }
  const { person } = replayProfile("vision-reply-v9.json");
  assert.equal(tasteApplies(person), true);
  const ranked = selectLooks({ service: "haircut", person, answers: masculine, likes: [] }).ranked;
  assert.ok(ranked.some((look) => look.components.taste > 0), "the reference client still gets the taste");
  // A hard-filter change on the hair itself switches taste off for that cut, whatever it is worth.
  const adapted = ranked.filter((look) => look.feasibility.checks.some((c) => ["curl", "density", "strand", "recession"].includes(c.check)));
  assert.ok(adapted.every((look) => look.components.taste === 0));
  // A reading under the confidence floor is not used, a woman's reading and a receded hairline switch it off.
  const guess = structuredClone(person);
  guess.hair.curl = known("1", "vision", 0.3);
  assert.equal(tasteApplies(guess), false);
  const female = structuredClone(person);
  female.sex = known("female", "answer", 1);
  assert.equal(tasteApplies(female), false);
  const receded = structuredClone(person);
  receded.hair.recession = known("moderate", "vision", 0.8);
  assert.equal(tasteApplies(receded), false);
  const result = await runReplay({ llm: "none", visionFile: "vision-reply-v9.json" });
  const overlap = EXPECTED_TOP.filter((title) => result.rows.slice(0, 10).some((row) => row.title === title));
  assert.ok(overlap.length >= 7, `${overlap.length} of 10 overlap`);
});

test("round 12: Fit is the real score to one decimal, strictly falling, in a deterministic order, on the server and the client", async () => {
  // Server: a tie steps down by 0.1, never by a whole point, and a real gap is kept as it is.
  const base = selectLooks({ service: "haircut", person: replayProfile().person, answers: masculine, likes: [] }).ranked[0]!;
  const look = (score: number) => ({ ...base, score });
  const spread = spreadTiedDisplayScores([look(74.6), look(74.6), look(74.6), look(74.3), look(74.4)]);
  assert.deepEqual(spread.map((item) => item.score), [74.6, 74.5, 74.4, 74.3, 74.2]);
  assert.equal(roundFit(74.64), 74.6);
  assert.equal(formatFit(75), "75.0");
  for (const profile of evalProfiles()) {
    const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
    const fits = result.rows.map((row) => row.fit);
    fits.forEach((fit, index) => { if (index > 0) assert.ok(fits[index - 1]! > fit, `${profile.name}: ${fits[index - 1]} then ${fit} at #${index + 1}`); });
    assert.ok(fits.every((fit) => Math.abs(fit * 10 - Math.round(fit * 10)) < 1e-9), "one decimal");
    // The first card shows its real score: nothing was shaved off it.
    const first = result.rows[0]!;
    assert.equal(first.fit, roundFit(fitFromComponents(first.look.components, false)));
    // The order is the deterministic one: raw score, then hair, then face, then id.
    const live = result.ranked.filter((item) => !item.excluded);
    for (let index = 1; index < live.length; index += 1) assert.ok(compareLooks(live[index - 1]!, live[index]!) <= 0, `${profile.name}: ranked order at ${index}`);
  }
  // Client: the card reads its own score to one decimal.
  assert.equal(fitScoreForCard({ score: 74.62 } as never), 74.6);
  assert.equal(fitScoreForCard({ score: 130 } as never), 100);
});

test("round 12: the wavy woman's Textured crop and Wolf cut are women's catalogue entries, not men's styles leaking", async () => {
  const profile = wavyWoman();
  const result = await runReplay({ llm: "none", person: profile.person, answers: profile.answers });
  for (const title of ["Textured crop", "Wolf cut"]) {
    const row = result.rows.find((item) => item.title === title);
    assert.ok(row, `${title} is shown`);
    assert.equal(row.look.variant.affinity, "feminine", title);
    const men = haircuts.filter((style) => style.title === title && style.affinity === "masculine");
    assert.ok(men.length === 1 && men[0]!.key !== row.key, `${title} has a separate men's twin that is filtered out`);
  }
  assert.ok(result.rows.every((row) => row.look.variant.affinity !== "masculine"));
});
