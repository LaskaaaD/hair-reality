process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fitScoreForCard } from "../../src/client/flow/flow-mappers.js";
import { groupRankingCards, mergeRankingCards } from "../../src/client/flow/ranking-groups.js";
import type { Person } from "../../src/domain/person.js";
import { PALETTE_LIMIT, selectLooks } from "../../src/domain/scoring.js";
import { cardFrom } from "../../src/server/demo/routes.js";
import { MALE_ANSWERS, replayProfile, runReplay } from "../../scripts/replay-ranking.js";

const card = (look: Parameters<typeof cardFrom>[0]) => cardFrom(look, false) as never;

function uiCards(person: Person) {
  const selection = selectLooks({ service: "haircut", person, answers: MALE_ANSWERS, likes: [] });
  const palette = selectLooks({ service: "haircut", person, answers: MALE_ANSWERS, likes: [], limit: PALETTE_LIMIT });
  const recommendations = selection.show.map(card);
  const goals = selection.goals.map(card);
  const merged = mergeRankingCards(recommendations, goals, palette.show.map(card), palette.ranked.map(card));
  const original = new Map(palette.ranked.map((look) => [look.variant.key, look.score]));
  return { original, recommendations, goals, ordered: groupRankingCards(merged).flatMap((section) => section.cards) };
}

test("merge: a palette filler never pushes out a ranked recommendation with a higher Fit", () => {
  const { person } = replayProfile();
  const { original, recommendations, goals, ordered } = uiCards(person);
  // Shown Fit is spread so the list falls strictly; the contest between a filler and a ranked card is on the Fit each had before that.
  const fit = (c: { key: string }) => original.get(c.key) ?? fitScoreForCard(c as never);
  const shown = new Set(ordered.map((c: { key: string }) => c.key));
  const own = new Set([...recommendations, ...goals].map((c: { key: string }) => c.key));
  const fillers = ordered.filter((c: { key: string }) => !own.has(c.key));
  const dropped = recommendations.filter((c: { key: string }) => !shown.has(c.key));
  const bestDropped = Math.max(-1, ...dropped.map((c) => fit(c)));
  for (const filler of fillers) assert.ok(fit(filler) >= bestDropped, `${(filler as { title: string }).title} (${fit(filler)}) displaced a ranked card with Fit ${bestDropped}`);
  assert.ok(ordered.length <= PALETTE_LIMIT);
});

test("hair: layered wolf, shag and mullet shapes lose hair points on straight hair, and keep them on wavy-curly hair", () => {
  const { person } = replayProfile();
  const hairOf = (p: Person, title: string) => selectLooks({ service: "haircut", person: p, answers: MALE_ANSWERS, likes: [] }).ranked.find((look) => look.variant.title === title)!.components.hairBehavior;
  const straight: Person = { ...person, hair: { ...person.hair, curl: { value: "2a", confidence: 0.8, source: "vision" } } };
  const wavy: Person = { ...person, hair: { ...person.hair, curl: { value: "3a", confidence: 0.8, source: "vision" } } };
  for (const title of ["Short wolf cut", "Classic 80s mullet"]) {
    assert.ok(hairOf(straight, title) <= hairOf(straight, "Textured French crop with low taper") - 4, `${title} keeps full hair points on straight hair`);
    assert.ok(hairOf(wavy, title) > hairOf(straight, title), `${title} is penalised on curly hair too`);
  }
});

test("merge: palette extras are spread like ranked cards, so a tie costs the later card one step of 0.1", () => {
  const { person } = replayProfile();
  const palette = selectLooks({ service: "haircut", person, answers: MALE_ANSWERS, likes: [], limit: PALETTE_LIMIT });
  const all = palette.ranked.filter((look) => !look.excluded).map(card) as Array<{ key: string; score: number }>;
  const ranked = all.slice(0, 6).map((c) => ({ ...c, score: 70 }));
  const extras = all.slice(6, 16).map((c) => ({ ...c, score: 70 }));
  const merged = mergeRankingCards(ranked as never, [], extras as never, [...ranked, ...extras] as never);
  const fits = merged.map((c) => fitScoreForCard(c));
  assert.ok(fits.length > 6);
  fits.forEach((fit, index) => { if (index > 0) assert.ok(fits[index - 1]! > fit, `tie at ${index}: ${fits.join(",")}`); });
  assert.equal(merged[0]!.key, ranked[0]!.key);
});

test("replay v9 (recorded live rawVision + rawRank): the whole shown list, palette extras included, falls strictly in Fit", { skip: !existsSync(path.join("live-test", "openai-v9.json")) && "live-test/openai-v9.json is not in this checkout" }, async () => {
  const live = JSON.parse(readFileSync(path.join("live-test", "openai-v9.json"), "utf8")) as { rawVision: string; rawRank: string };
  const replay = await runReplay({ llm: "recorded", visionReply: JSON.parse(live.rawVision), rankReply: JSON.parse(live.rawRank) });
  const recommendations = replay.rows.filter((row) => row.look.growth === null).map((row) => card(row.look));
  const goals = replay.rows.filter((row) => row.look.growth !== null).map((row) => ({ ...(card(row.look) as object), missingCm: row.look.growth?.missingCm ?? null }) as never);
  const palette = selectLooks({ service: "haircut", person: replay.person, answers: MALE_ANSWERS, likes: [], limit: PALETTE_LIMIT });
  const merged = mergeRankingCards(recommendations, goals, palette.show.map(card), palette.ranked.map(card));
  const ordered = groupRankingCards(merged).flatMap((section) => section.cards);
  assert.ok(ordered.length >= 12, `only ${ordered.length} cards shown`);
  const fits = ordered.map((c) => fitScoreForCard(c));
  fits.forEach((fit, index) => { if (index > 0) assert.ok(fits[index - 1]! > fit, `Fit does not fall at #${index + 1}: ${fits.join(",")}`); });
  assert.ok(ordered.every((c) => (c as { affinity?: string }).affinity !== "feminine"));
});
