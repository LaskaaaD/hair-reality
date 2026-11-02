process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixturePerson, known, personSchema, type Person } from "../../src/domain/person.js";
import { recessionOf, MILD_RECESSION_MIN_CONFIDENCE } from "../../src/domain/feasibility.js";
import { CLAUSE_WORDS, reasonPhrases, varyReasonsInOrder } from "../../src/domain/reason-variety.js";
import { emptyAnswers, FREE_TRIM_CM, growthPoints, scoreVariant, shorteningPenalty, selectLooks, type Answers } from "../../src/domain/scoring.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { restoreVisionFields } from "../../src/server/demo/llm.js";
import { mergeRanking, type RankAnswer } from "../../src/server/demo/llm-rank.js";
import { renderCacheBypassed } from "../../src/server/demo/render-cache.js";
import { runReplay } from "../../scripts/replay-ranking.js";

/** The reason-variety guarantee covers the first page of the top-50 list; the cards behind "Show more" may share stock clauses. */
const FIRST_PAGE = 16;

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

const DIR = path.join("tests", "fixtures", "openai-live");
const read = (file: string) => JSON.parse(readFileSync(path.join(DIR, file), "utf8").replace(/^﻿/, "")) as { profile: unknown; answers: Answers; likes: string[]; rawRank: string };
const CHECK14 = read("rank-capture-check14.json");
const V11 = read("rank-capture-v11.json");
const CHECK14_ANSWER = JSON.parse((JSON.parse(readFileSync(path.join(DIR, "rank-answer-check14.json"), "utf8").replace(/^﻿/, "")) as { rawAnswer: string }).rawAnswer) as unknown;

/** The ten styles a barber would expect near the top for this client (general domain knowledge: textured crops and fringes, curtains, mod, side part, ivy). */
const REFERENCE = [
  "textured-french-crop-low-taper", "short-curtains-low-taper", "mod-cut-60s", "textured-caesar-low-taper", "korean-two-block-curtain-fringe",
  "messy-fringe", "soft-french-crop-scissor-sides", "side-swept-textured-crop", "soft-side-part", "ivy-league",
];
const CROPS = ["textured-french-crop-low-taper", "textured-caesar-low-taper"];
const overlap = (rows: readonly { key: string }[]) => rows.slice(0, 10).filter((row) => REFERENCE.some((id) => row.key.endsWith(`--${id}`))).length;

const CASES = [
  { name: "check-14 (growth forward@0.72)", capture: CHECK14, blendReply: CHECK14_ANSWER },
  { name: "v11 (growth side@0.70)", capture: V11, blendReply: JSON.parse(V11.rawRank) as unknown },
];

for (const { name, capture, blendReply } of CASES) {
  const person = personSchema.parse(capture.profile) as Person;
  const replay = (llm: "none" | "recorded") => runReplay({ llm, person, answers: capture.answers, likes: capture.likes, ...(llm === "recorded" ? { rankReply: blendReply } : {}) });

  test(`${name}: blended path shows at least 7 of the 10 reference styles, both crops in the top 15, no feminine style`, async () => {
    const result = await replay("recorded");
    assert.equal(result.path, "llm");
    console.log(`R17 ${name} blend`, overlap(result.rows), result.rows.slice(0, 10).map((row) => `${row.rank}. ${row.key.split(":")[1]} ${row.fit}`).join(" | "));
    assert.ok(overlap(result.rows) >= 7, `overlap ${overlap(result.rows)}`);
    for (const id of CROPS) {
      const rank = result.rows.find((row) => row.key.endsWith(`--${id}`))?.rank ?? 99;
      assert.ok(rank <= 15, `${id} at ${rank}`);
    }
    assert.ok(result.rows.every((row) => row.look.variant.affinity !== "feminine"));
  });

  test(`${name}: rules path (no model) shows at least 7 of the 10 reference styles with the crops in the top 15`, async () => {
    const result = await replay("none");
    console.log(`R17 ${name} rules`, overlap(result.rows), result.rows.slice(0, 10).map((row) => `${row.rank}. ${row.key.split(":")[1]} ${row.fit}`).join(" | "));
    assert.ok(overlap(result.rows) >= 7, `overlap ${overlap(result.rows)}`);
    for (const id of CROPS) assert.ok((result.rows.find((row) => row.key.endsWith(`--${id}`))?.rank ?? 99) <= 15, id);
    assert.ok(result.rows.every((row) => row.look.variant.affinity !== "feminine"));
  });
}

const variantOf = (id: string) => {
  const variant = loadStyles().find((style) => style.key.endsWith(`--${id}`));
  assert.ok(variant, id);
  return variant;
};

// 1. The "will not cut" penalty counts only the shortening beyond an ordinary trim.
test("canShorten no: a cut at or above the hair costs nothing, a modest trim is free, a big chop is charged per cm up to 5", () => {
  const person = (top: number | "unknown"): Person => {
    const base = fixturePerson();
    return { ...base, hair: { ...base.hair, topCm: top === "unknown" ? { value: "unknown", confidence: 0, source: "vision" } : known(top, "vision", 0.8), lengthCm: { value: "unknown", confidence: 0, source: "vision" } } };
  };
  const no: Answers = { ...emptyAnswers(), canShorten: "no" };
  const crop = variantOf("textured-french-crop-low-taper");
  const topNeeded = crop.requirements.topCm ?? 0;
  assert.equal(shorteningPenalty(person(8), no, crop), 0, "8 cm hair to a 4 cm minimum is within an ordinary trim");
  assert.equal(shorteningPenalty(person(topNeeded + FREE_TRIM_CM), no, crop), 0);
  assert.equal(shorteningPenalty(person(topNeeded + FREE_TRIM_CM + 1), no, crop), 1);
  assert.equal(shorteningPenalty(person(40), no, crop), 5, "capped");
  assert.equal(shorteningPenalty(person(2), no, crop), 0, "hair shorter than the cut needs is not a shortening");
  assert.equal(shorteningPenalty(person("unknown"), no, crop), 0);
  assert.equal(shorteningPenalty(person(40), { ...no, canShorten: "yes" }, crop), 0);
});

test("lifestyle of the crops is no longer 5 below the soft side part for a client with 8 cm on top who will not cut shorter", () => {
  const person = personSchema.parse(V11.profile) as Person;
  const answers = { ...V11.answers, canShorten: "no" } as Answers;
  const score = (id: string) => scoreVariant(person, answers, variantOf(id), false).components.lifestyle;
  assert.ok(score("soft-side-part") - score("textured-french-crop-low-taper") <= 0);
  assert.ok(score("soft-side-part") - score("textured-caesar-low-taper") <= 1);
});

// 3. Vision stability.
test("growth forward or side under 0.75 confidence scores as the average of both; at 0.75 and over it is one direction", () => {
  assert.equal(growthPoints("side", "side", 0.7), 1.5);
  assert.equal(growthPoints("side", "side", 0.75), 3);
  assert.equal(growthPoints("forward", "side", 0.72), 1.5);
  assert.equal(growthPoints("forward", "forward", 0.72), 3);
  assert.equal(growthPoints("forward", "back", 0.72), -2.5);
  assert.equal(growthPoints("forward", "back", 0.9), -5);
  assert.equal(growthPoints("back", "forward", 0.5), -5, "back is not part of the blend");
});

test("a forward and a side reading at 0.70 differ by no more than the cut's own fall, not by a whole direction", () => {
  const withGrowth = (value: "forward" | "side"): Person => {
    const base = personSchema.parse(V11.profile) as Person;
    return { ...base, hair: { ...base.hair, growthDirection: known(value, "vision", 0.7) } };
  };
  const hair = (person: Person, id: string) => scoreVariant(person, V11.answers, variantOf(id), false).components.hairBehavior;
  for (const id of [...CROPS, "soft-side-part"]) assert.ok(Math.abs(hair(withGrowth("forward"), id) - hair(withGrowth("side"), id)) <= 0.5, id);
});

test("mild recession counts only from 0.65 confidence; moderate and advanced from 0.5", () => {
  const withRecession = (value: "mild" | "moderate", confidence: number): Person => {
    const base = fixturePerson();
    return { ...base, hair: { ...base.hair, recession: known(value, "vision", confidence) } };
  };
  assert.equal(MILD_RECESSION_MIN_CONFIDENCE, 0.65);
  assert.equal(recessionOf(withRecession("mild", 0.57)), null);
  assert.equal(recessionOf(withRecession("mild", 0.65)), "mild");
  assert.equal(recessionOf(withRecession("moderate", 0.57)), "moderate");
});

test("mild recession never marks a forward textured crop or fringe down and lifts it", () => {
  const base = personSchema.parse(V11.profile) as Person;
  const mild = { ...base, hair: { ...base.hair, recession: known("mild" as const, "vision", 0.8) } };
  const hairline = (person: Person, id: string) => scoreVariant(person, V11.answers, variantOf(id), false).components.hairline;
  for (const id of [...CROPS, "messy-fringe", "soft-french-crop-scissor-sides"]) {
    assert.ok(hairline(mild, id) >= hairline(base, id), `${id} is not marked down`);
  }
  assert.ok(hairline(mild, "textured-caesar-low-taper") >= hairline(base, "textured-caesar-low-taper"));
});

test("a vision recession and occipital reading survive a later YouCam refresh of the profile", () => {
  const vision = fixturePerson();
  vision.hair.recession = known("mild", "vision", 0.7);
  vision.head.occipital = known("round", "vision", 0.6);
  const refreshed = fixturePerson();
  delete (refreshed.hair as { recession?: unknown }).recession;
  refreshed.head.occipital = { value: "unknown", confidence: 0, source: "youcam" };
  const merged = restoreVisionFields(vision, refreshed);
  assert.equal(merged.hair.recession?.value, "mild");
  assert.equal(merged.head.occipital.value, "round");
});

// 2. Blend: lifestyle is averaged even when the two sides are far apart.
test("blend: a lifestyle score the model sets far above ours is averaged, while another criterion that far apart keeps ours", () => {
  const person = personSchema.parse(V11.profile) as Person;
  const ranked = selectLooks({ service: "haircut", person, answers: V11.answers, likes: [] }).ranked.filter((look) => !look.excluded);
  const look = ranked[0]!;
  const ours = look.components;
  const scores = { hair_behavior: ours.hairBehavior, face_balance: ours.face, hairline_forehead: ours.hairline, head_profile: ours.head, lifestyle: Math.min(10, ours.lifestyle + 9), features_context: ours.features, trend_2026: ours.trend };
  const lowLifestyle = { ...look, components: { ...look.components, lifestyle: 0 } };
  const answer: RankAnswer = { ranked: [look, ranked[1]!, ranked[2]!].map((item, index) => ({ id: item.variant.key, scores: index === 0 ? { ...scores, hair_behavior: Math.max(0, ours.hairBehavior - 20) } : scores, verdict: "great", adaptNote: null, reason: `Reason number ${index} names something particular here`, tellYourBarber: null })) };
  const merged = mergeRanking(person, [lowLifestyle, ranked[1]!, ranked[2]!], answer);
  assert.ok(merged);
  const first = merged.show.find((item) => item.variant.key === look.variant.key)!;
  assert.equal(first.components.lifestyle, Math.round((0 + Math.min(10, ours.lifestyle + 9)) / 2));
  assert.equal(first.components.hairBehavior, ours.hairBehavior, "a far hair-behaviour score keeps ours");
});

// 5. Reasons: a clause used in one card is replaced in the next.
test("a stock clause is used in one card only: the next card gets another reason", () => {
  const person = personSchema.parse(V11.profile) as Person;
  const looks = selectLooks({ service: "haircut", person, answers: V11.answers, likes: [] }).show.slice(0, 6);
  const stock = "though your hair falls to the side, so the front needs a touch of product to stay where this cut puts it";
  const ordered = looks.map((look) => ({ ...look, reasons: [`${look.variant.title} is a cut with a neat shape, ${stock}.`] }));
  const out = varyReasonsInOrder(ordered, person, V11.answers);
  const clauses = out.map((look) => new Set(reasonPhrases(look.reasons[0] ?? "", look.variant.title, CLAUSE_WORDS)));
  assert.ok(out[0]!.reasons[0]!.includes(stock) || !out.slice(1).some((look) => look.reasons[0]!.includes(stock)));
  const counts = new Map<string, number>();
  for (const set of clauses) for (const clause of set) counts.set(clause, (counts.get(clause) ?? 0) + 1);
  const repeated = [...counts].filter(([, count]) => count > 1);
  assert.deepEqual(repeated, [], `repeated clauses: ${repeated.map(([clause]) => clause).join(" / ")}`);
});

test("no clause of 8 words appears in two of the shown reasons on either replay", async () => {
  for (const { capture, blendReply } of CASES) {
    const person = personSchema.parse(capture.profile) as Person;
    for (const llm of ["none", "recorded"] as const) {
      const result = await runReplay({ llm, person, answers: capture.answers, likes: capture.likes, ...(llm === "recorded" ? { rankReply: blendReply } : {}) });
      const counts = new Map<string, string[]>();
      for (const row of result.rows.slice(0, FIRST_PAGE)) for (const clause of new Set(reasonPhrases(row.reason, row.title, CLAUSE_WORDS))) counts.set(clause, [...(counts.get(clause) ?? []), row.title]);
      const repeated = [...counts].filter(([, titles]) => titles.length > 1);
      assert.equal(repeated.length, 0, `${llm}: ${repeated.map(([clause, titles]) => `"${clause}" in ${titles.join(", ")}`).join(" | ")}`);
    }
  }
});

// 6. Render cache bypass.
test("RENDER_CACHE_BYPASS=1 bypasses the render cache read; anything else leaves it on", () => {
  assert.equal(renderCacheBypassed({ RENDER_CACHE_BYPASS: "1" }), true);
  assert.equal(renderCacheBypassed({ RENDER_CACHE_BYPASS: "0" }), false);
  assert.equal(renderCacheBypassed({ RENDER_CACHE_BYPASS: "" }), false);
  assert.equal(renderCacheBypassed({}), false);
  assert.match(readFileSync(".env.example", "utf8"), /^RENDER_CACHE_BYPASS=$/m);
});
