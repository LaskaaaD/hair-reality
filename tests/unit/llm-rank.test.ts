import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fixturePerson, known, type Person } from "../../src/domain/person.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import { llmRankLooks, rankCandidates, RANK_CANDIDATE_LIMIT } from "../../src/server/demo/llm-rank.js";
import { applyVision, FIELD_CONFIDENCE_KEYS, fixtureVision, visionReadingSchema } from "../../src/server/demo/vision.js";
import type { OpenAIClient } from "../../src/server/providers/openai/client.js";

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

function profile(): Person {
  const p = fixturePerson("fixture");
  p.sex = { value: "unknown", confidence: 0, source: "fixture" };
  p.face.aspectRatio = known(1.47, "youcam", 0.75);
  p.face.foreheadWidth = known("wide", "vision", 0.8);
  p.hair.curl = known("2a", "youcam");
  p.hair.growthDirection = known("forward", "youcam");
  p.hair.lengthCm = { value: "unknown", confidence: 0, source: "youcam" };
  return p;
}

function mock(reply: () => unknown): { client: OpenAIClient; calls: { name: string; userText: string }[] } {
  const calls: { name: string; userText: string }[] = [];
  const client = {
    async completeJson(input: { name: string; userText: string }) {
      calls.push({ name: input.name, userText: input.userText });
      const body = reply();
      if (body === "fail") return { kind: "failed", code: "PROVIDER_RATE_LIMIT" };
      if (body === "hang") return new Promise(() => undefined);
      return { kind: "completed", text: JSON.stringify(body), usage: { inputTokens: 5000, outputTokens: 900 } };
    },
  } as unknown as OpenAIClient;
  return { client, calls };
}

function setup() {
  const person = profile();
  const selection = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] });
  return { person, selection, fallback: selection.show };
}

test("candidates sent to the model are gender-filtered, bounded, and exclude growth and blocked cuts", () => {
  const { selection } = setup();
  const candidates = rankCandidates(selection.ranked);
  assert.ok(candidates.length > 0 && candidates.length <= RANK_CANDIDATE_LIMIT);
  for (const look of candidates) {
    assert.notEqual(look.variant.affinity, "feminine");
    assert.equal(look.excluded, false);
    assert.equal(look.growth, null);
  }
});

test("the llm path ranks only given ids, keeps close scores and overrides far ones and hard-rule failures", async () => {
  const { person, selection, fallback } = setup();
  const candidates = rankCandidates(selection.ranked);
  // The model may only re-score the diversity-filtered shortlist (fallback), so the scored ids come from it.
  const [first, second, third] = fallback.filter((look) => candidates.some((item) => item.variant.key === look.variant.key));
  const pompadour = selection.ranked.find((look) => look.variant.title === "Classic pompadour")!;
  const withPompadour = [...candidates.slice(0, 5), pompadour];
  const reply = {
    ranked: [
      { id: second!.variant.key, fit: second!.score + 3, reason: "Soft fringe and a low taper keep some width at the sides." },
      { id: "haircut:not-in-the-list", fit: 99, reason: "A made up cut the list never had." },
      { id: first!.variant.key, fit: first!.score - 30, reason: "Too pessimistic, so our own score should win." },
      { id: pompadour.variant.key, fit: 95, reason: "Tall and bold, which the long-face rule rejects." },
      { id: third!.variant.key, fit: third!.score, reason: "Moderate top with partial forehead framing." },
    ],
  };
  const { client, calls } = mock(() => reply);
  const out = await llmRankLooks({ person, ranked: [...withPompadour, ...selection.ranked], fallback, openai: client, budgetUsd: 6 });
  assert.equal(out.path, "llm", out.note);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "demo_rank");
  assert.ok(!calls[0]!.userText.includes("not-in-the-list"));
  const keys = out.show.map((look) => look.variant.key);
  assert.ok(!keys.includes("haircut:not-in-the-list"));
  assert.equal(new Set(keys).size, keys.length);
  const byKey = new Map(out.show.map((look) => [look.variant.key, look]));
  assert.equal(byKey.get(second!.variant.key)!.score <= second!.score + 3, true);
  assert.equal(byKey.get(first!.variant.key)!.reasons[0], "Too pessimistic, so our own score should win.");
  assert.ok(byKey.get(first!.variant.key)!.score >= first!.score - 1, "far-off llm score replaced by ours");
  assert.ok((byKey.get(pompadour.variant.key)?.score ?? 0) <= pompadour.score, "hard rule keeps our score");
  for (let i = 1; i < out.show.length; i += 1) assert.ok(out.show[i - 1]!.score >= out.show[i]!.score);
});

test("a failed, malformed, empty or over-budget call falls back to the deterministic list", async () => {
  const { person, selection, fallback } = setup();
  const run = (reply: () => unknown, budgetUsd = 6) => llmRankLooks({ person, ranked: selection.ranked, fallback, openai: mock(reply).client, budgetUsd, timeoutMs: 100 });
  for (const reply of [() => "fail", () => ({ nope: true }), () => ({ ranked: [] }), () => "hang"]) {
    const out = await run(reply);
    assert.equal(out.path, "fallback");
    assert.deepEqual(out.show.map((look) => look.variant.key), fallback.map((look) => look.variant.key));
  }
  const broke = await run(() => ({ ranked: [] }), 0);
  assert.equal(broke.path, "fallback");
  assert.equal(broke.note, "budget exceeded");
});

test("merged vision applies per-field confidence and rejects invalid values", () => {
  const base = profile();
  const reading = visionReadingSchema.parse({
    ...fixtureVision(),
    curl: "2b",
    foreheadWidth: "wide",
    ears: "prominent",
    confidence: 0.8,
    fieldConfidence: Object.fromEntries(FIELD_CONFIDENCE_KEYS.map((key) => [key, key === "ears" ? 0.4 : 0.9])),
  });
  const merged = applyVision(base, reading);
  assert.equal(merged.face.foreheadWidth?.value, "wide");
  assert.equal(merged.head.ears?.value, "unknown", "a field below 0.7 is not merged");
  assert.equal(visionReadingSchema.safeParse({ ...reading, curl: "9z" }).success, false);
  assert.equal(visionReadingSchema.safeParse({ ...reading, faceShape: "diamond" }).success, false);
});

test("one of our top picks the model leaves out stays in the race at our own score", async () => {
  const { person, selection, fallback } = setup();
  const candidateKeys = new Set(rankCandidates(selection.ranked).map((look) => look.variant.key));
  const lower = fallback.slice(4).filter((look) => candidateKeys.has(look.variant.key)).slice(0, 4);
  const reply = { ranked: lower.map((look) => ({ id: look.variant.key, fit: look.score, reason: `A specific reason for ${look.variant.title} on this profile.` })) };
  const out = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: mock(() => reply).client, budgetUsd: 6, timeoutMs: 1000 });
  assert.equal(out.path, "llm");
  const top = out.show.slice(0, 10).map((look) => look.variant.key);
  for (const look of fallback.slice(0, 4)) assert.ok(top.includes(look.variant.key), `${look.variant.title} stays in the top 10`);
});
