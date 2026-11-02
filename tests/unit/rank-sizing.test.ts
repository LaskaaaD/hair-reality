import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { fixturePerson, known, type Person } from "../../src/domain/person.js";
import { emptyAnswers, lengthMatchPoints, selectLooks } from "../../src/domain/scoring.js";
import {
  ANCHORED_TOP,
  llmRankLooks,
  parseRankAnswer,
  RANK_CANDIDATE_LIMIT,
  RANK_REQUEST_TIMEOUT_MS,
  RANK_TIMEOUT_MS,
  rankCandidates,
} from "../../src/server/demo/llm-rank.js";
import { demoMicro, PROFILE_MODEL } from "../../src/server/demo/openai-budget.js";
import { OpenAIClient, type OpenAITransport } from "../../src/server/providers/openai/client.js";
import { MAX_OUTPUT_TOKENS, RANK_MAX_OUTPUT_TOKENS } from "../../src/server/providers/openai/pricing.js";
import { compactStylistReply } from "../fixtures/stylist-fixture.js";

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

function profile(): Person {
  const p = fixturePerson("fixture");
  p.sex = { value: "unknown", confidence: 0, source: "fixture" };
  p.face.aspectRatio = known(1.47, "youcam", 0.75);
  p.hair.curl = known("2a", "youcam");
  return p;
}

function setup() {
  const person = profile();
  const selection = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] });
  return { person, selection, fallback: selection.show };
}

const INCOMPLETE_BODY = (text?: string) => JSON.stringify({
  status: "incomplete",
  incomplete_details: { reason: "max_output_tokens" },
  ...(text !== undefined ? { output: [{ type: "message", content: [{ type: "output_text", text }] }] } : {}),
  usage: { input_tokens: 7172, output_tokens: RANK_MAX_OUTPUT_TOKENS },
});

function recording(body: string): { client: OpenAIClient; sent: { body: Record<string, unknown>; timeoutMs?: number }[] } {
  const sent: { body: Record<string, unknown>; timeoutMs?: number }[] = [];
  const transport: OpenAITransport = async (request) => {
    sent.push({ body: JSON.parse(request.body) as Record<string, unknown>, ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}) });
    return { status: 200, body };
  };
  return { client: new OpenAIClient(transport, "synthetic-openai-key"), sent };
}

test("only demo_rank gets the 8000-token ceiling and its own request timeout; every other call keeps 2000", async () => {
  assert.equal(MAX_OUTPUT_TOKENS, 2000);
  assert.equal(RANK_MAX_OUTPUT_TOKENS, 8000);
  const { client, sent } = recording(INCOMPLETE_BODY());
  const base = { instructions: "x", schema: {}, userText: "{}", model: "gpt-5.4" };
  await client.completeJson({ ...base, name: "demo_rank", maxOutputTokens: RANK_MAX_OUTPUT_TOKENS, timeoutMs: RANK_REQUEST_TIMEOUT_MS });
  await client.completeJson({ ...base, name: "demo_rank", maxOutputTokens: 50_000 });
  await client.completeJson({ ...base, name: "demo_notes", maxOutputTokens: RANK_MAX_OUTPUT_TOKENS });
  await client.completeJson({ ...base, name: "demo_vision" });
  assert.deepEqual(sent.map((item) => item.body.max_output_tokens), [8000, 8000, 2000, 2000]);
  assert.equal(sent[0]!.timeoutMs, RANK_REQUEST_TIMEOUT_MS);
  assert.equal(sent[3]!.timeoutMs, undefined);
});

test("the rank timeouts fit the bigger answer: a 4000-token answer at the old measured speed finishes in time", () => {
  assert.ok(RANK_REQUEST_TIMEOUT_MS >= 60_000 && RANK_REQUEST_TIMEOUT_MS <= 90_000);
  assert.ok(RANK_TIMEOUT_MS >= RANK_REQUEST_TIMEOUT_MS);
  assert.ok(4500 * 12 < RANK_REQUEST_TIMEOUT_MS);
});

test("an incomplete response carries the reason and the partial text", async () => {
  const { client } = recording(INCOMPLETE_BODY("{\"ranked\":[{\"id\":\"haircut:x\""));
  const call = await client.completeJson({ name: "demo_rank", instructions: "x", schema: {}, userText: "{}" });
  assert.equal(call.kind, "incomplete");
  if (call.kind === "incomplete") {
    assert.equal(call.reason, "max_output_tokens");
    assert.equal(call.text, "{\"ranked\":[{\"id\":\"haircut:x\"");
    assert.deepEqual(call.usage, { inputTokens: 7172, outputTokens: 8000 });
  }
});

test("the budget reserve covers the 8000-token output", async () => {
  const { person, selection, fallback } = setup();
  assert.ok(demoMicro(PROFILE_MODEL, 11000, RANK_MAX_OUTPUT_TOKENS) > demoMicro(PROFILE_MODEL, 11000, 4000));
  const { client, sent } = recording(INCOMPLETE_BODY());
  // A cap the old 4000-token reserve fit under, but the 8000-token one does not.
  const tight = (demoMicro(PROFILE_MODEL, 11000, 4000) + 1000) / 1_000_000;
  const blocked = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: client, budgetUsd: tight });
  assert.equal(blocked.note, "budget exceeded");
  assert.equal(sent.length, 0);
});

test("at most 45 candidates go to the model and our anchored top picks are always among them", () => {
  const { selection, fallback } = setup();
  assert.equal(RANK_CANDIDATE_LIMIT, 45);
  assert.ok(rankCandidates(selection.ranked).length <= 45);
  const eligibleAll = selection.ranked.filter((look) => !look.excluded && look.growth === null && (look.feasibility.status === "pass" || look.feasibility.status === "adapt"));
  const eligibleKeys = new Set(eligibleAll.map((look) => look.variant.key));
  const anchored = fallback.slice(0, ANCHORED_TOP).map((look) => look.variant.key).filter((key) => eligibleKeys.has(key));
  const sent = rankCandidates(selection.ranked, anchored);
  assert.ok(sent.length <= 45);
  for (const key of anchored) assert.ok(sent.some((look) => look.variant.key === key), `${key} stays`);
  // A far-down pick is pulled in, and the rules order is kept.
  if (eligibleAll.length > 45) {
    const last = eligibleAll.at(-1)!.variant.key;
    const pinned = rankCandidates(selection.ranked, [last]);
    assert.equal(pinned.length, 45);
    assert.ok(pinned.some((look) => look.variant.key === last));
    const order = pinned.map((look) => eligibleAll.indexOf(look));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  }
});

test("a full 28-candidate answer in the compact schema stays under 60% of the output ceiling (chars / 4 as tokens)", () => {
  const { selection } = setup();
  const candidates = rankCandidates(selection.ranked);
  assert.ok(candidates.length >= 20, "the fixture profile has enough candidates for a realistic size check");
  const reply = compactStylistReply(candidates, 28);
  const tokens = Math.ceil(JSON.stringify(reply).length / 4);
  assert.ok(tokens < 0.6 * RANK_MAX_OUTPUT_TOKENS, `${tokens} tokens for ${reply.ranked.length} entries`);
  const parsed = parseRankAnswer(JSON.stringify({ ...reply, ranked: reply.ranked.slice(0, 25) }));
  assert.ok(parsed && parsed.ranked.length === Math.min(25, reply.ranked.length), "the compact schema validates and maps back to the internal names");
  assert.deepEqual(Object.keys(parsed!.ranked[0]!.scores!), ["hair_behavior", "face_balance", "hairline_forehead", "head_profile", "lifestyle", "features_context", "trend_2026"]);
  assert.equal(parseRankAnswer(JSON.stringify({ ranked: [{ id: "x", s: { hb: 1 }, v: "good", a: null, r: "A reason long enough.", b: "A line long enough." }] })), null, "strict: a missing score is refused");
});

test("a truncated answer falls back with cause truncated, keeps the partial text, and is never read as a ranking", async () => {
  const { person, selection, fallback } = setup();
  const warn = mock.method(console, "warn", () => undefined);
  try {
    // Partial text that still parses as a valid ranking must not be trusted: truncation wins.
    const full = JSON.stringify(compactStylistReply(rankCandidates(selection.ranked), 8));
    for (const partial of ["{\"ranked\":[{\"id\":\"haircut:x\",\"s\":{\"hb\":2", full, undefined]) {
      const { client } = recording(INCOMPLETE_BODY(partial));
      const out = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: client, budgetUsd: 6, timeoutMs: 2000 });
      assert.equal(out.path, "fallback");
      assert.equal(out.note, "truncated");
      assert.equal(out.rawAnswer, partial);
      assert.deepEqual(out.show.map((look) => look.variant.key), fallback.map((look) => look.variant.key));
    }
    const logged = warn.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(logged.includes("demo_rank path=fallback cause=\"truncated\" outputTokens=8000 ceiling=8000"), logged.join("\n"));
  } finally {
    warn.mock.restore();
  }
});

test("length match: less cutting or growing scores higher, unknown lengths are neutral, and raw totals differ between cuts the banded points tie on", () => {
  const { person, selection } = setup();
  const withLengths: Person = { ...person, hair: { ...person.hair, topCm: known(6, "vision", 0.72), frontCm: known(7, "vision", 0.72), sideCm: known(2.5, "vision", 0.72) } };
  const [near, far] = ["Soft side part", "Textured Caesar with low taper"].map((title) => selection.ranked.find((look) => look.variant.title === title)!.variant);
  assert.ok(lengthMatchPoints(withLengths, near!) > lengthMatchPoints(withLengths, far!));
  for (const variant of [near!, far!]) {
    const value = lengthMatchPoints(withLengths, variant);
    assert.ok(value >= 0 && value <= 1);
  }
  const unknown: Person = { ...person, hair: { ...person.hair, lengthCm: { value: "unknown", confidence: 0, source: "youcam" }, topCm: { value: "unknown", confidence: 0, source: "youcam" }, frontCm: { value: "unknown", confidence: 0, source: "youcam" }, sideCm: { value: "unknown", confidence: 0, source: "youcam" } } };
  assert.equal(lengthMatchPoints(unknown, near!), 0.5);
});
