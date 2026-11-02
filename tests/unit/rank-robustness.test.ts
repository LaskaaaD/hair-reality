process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { personSchema, type Person } from "../../src/domain/person.js";
import { selectLooks, type Answers } from "../../src/domain/scoring.js";
import {
  ADAPT_NOTE_REPEATS,
  candidateFacts,
  dedupeAdaptNotes,
  llmRankLooks,
  parseRankAnswer,
  profileFacts,
  rankCandidates,
  STYLIST_INSTRUCTIONS,
  TEXT_LIMITS,
  truncateText,
} from "../../src/server/demo/llm-rank.js";
import { reviewRecommendations } from "../../src/server/demo/llm.js";
import { EXPECTED_TOP, recordedModel } from "../../scripts/replay-ranking.js";

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

const DIR = path.join("tests", "fixtures", "openai-live");
const RAW = readFileSync(path.join(DIR, "rank-answer-check13.json"), "utf8");
const CAPTURE = JSON.parse(readFileSync(path.join(DIR, "rank-profile-check13.json"), "utf8")) as { profile: unknown; answers: Answers; likes: string[] };
const person = personSchema.parse(CAPTURE.profile) as Person;

function setup() {
  const selection = selectLooks({ service: "haircut", person, answers: CAPTURE.answers, likes: CAPTURE.likes });
  return { selection, fallback: reviewRecommendations(selection.show) };
}

const norm = (text: string | null) => (text ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

test("check13: the real 20-entry answer with 719-char notes parses, notes truncated", () => {
  const raw = JSON.parse(RAW) as { notes: string };
  assert.ok(raw.notes.length > 600, "the recorded notes really overrun");
  const parsed = parseRankAnswer(RAW);
  assert.ok(parsed);
  assert.equal(parsed.ranked.length, 20);
  assert.ok(parsed.notes && parsed.notes.length <= TEXT_LIMITS.notes && raw.notes.startsWith(parsed.notes));
});

test("over-long r, a and b are shortened at a word boundary; min lengths, scores and ids stay strict", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
  const entry = { id: "x", s: { hb: 1, fc: 1, hl: 1, hp: 1, ls: 1, ft: 1, tr: 1 }, v: "good", a: long(80), r: long(80), b: long(80) };
  const parsed = parseRankAnswer(JSON.stringify({ ranked: [entry], notes: long(300) }));
  assert.ok(parsed);
  const out = parsed.ranked[0]!;
  assert.ok(out.reason.length <= TEXT_LIMITS.reason && out.tellYourBarber!.length <= TEXT_LIMITS.barber && out.adaptNote!.length <= TEXT_LIMITS.adapt);
  assert.match(out.reason, /word\d+$/, "ends on a whole word");
  assert.equal(truncateText("Short enough.", 50), "Short enough.");
  assert.equal(parseRankAnswer(JSON.stringify({ ranked: [{ ...entry, r: "short" }] })), null);
  assert.equal(parseRankAnswer(JSON.stringify({ ranked: [{ ...entry, s: { ...entry.s, hb: "x" } }] })), null);
  assert.equal(parseRankAnswer(JSON.stringify({ ranked: [{ ...entry, id: "" }] })), null);
});

test("check13 through llmRankLooks: path llm, 20 entries, top 10 holds at least 7 of the reference list", async () => {
  const { selection, fallback } = setup();
  const model = recordedModel(RAW);
  const out = await llmRankLooks({ person, ranked: selection.ranked, fallback, openai: model.client, budgetUsd: 6, answers: CAPTURE.answers });
  assert.equal(out.path, "llm");
  assert.ok(out.show.length >= 10 && out.show.length <= fallback.length);
  const top10 = out.show.slice(0, 10).map((look) => look.variant.title);
  const overlap = EXPECTED_TOP.filter((title) => top10.includes(title));
  assert.ok(overlap.length >= 7, `${overlap.length}/10: ${top10.join(", ")}`);
  assert.equal((JSON.parse(out.rawAnswer!) as { ranked: unknown[] }).ranked.length, 20);
  console.log("CHECK13 TOP10", out.show.slice(0, 10).map((look) => `${look.variant.title} ${look.score}`).join(" | "));
});

test("check13: the repeated adapt note stays on the first 2 entries; replacements are our own note or null", () => {
  const { selection } = setup();
  const parsed = parseRankAnswer(RAW)!;
  const maxRepeat = (notes: (string | null)[]) => {
    const map = new Map<string, number>();
    for (const note of notes) if (note) map.set(norm(note), (map.get(norm(note)) ?? 0) + 1);
    return Math.max(0, ...map.values());
  };
  assert.ok(maxRepeat(parsed.ranked.map((entry) => entry.adaptNote)) > ADAPT_NOTE_REPEATS, "the recorded answer repeats one note");
  const candidates = rankCandidates(selection.ranked);
  const deduped = dedupeAdaptNotes(parsed, candidates);
  assert.ok(maxRepeat(deduped.ranked.map((entry) => entry.adaptNote)) <= ADAPT_NOTE_REPEATS);
  const repeated = parsed.ranked.map((entry) => norm(entry.adaptNote)).find((note, _, all) => note && all.filter((item) => item === note).length > 2)!;
  const kept = deduped.ranked.filter((entry) => norm(entry.adaptNote) === repeated).map((entry) => entry.id);
  assert.deepEqual(kept, parsed.ranked.filter((entry) => norm(entry.adaptNote) === repeated).slice(0, 2).map((entry) => entry.id));
  for (const [index, entry] of deduped.ranked.entries()) {
    if (entry.adaptNote === parsed.ranked[index]!.adaptNote) continue;
    const look = candidates.find((item) => item.variant.key === entry.id);
    assert.ok(entry.adaptNote === null || look?.feasibility.adaptNotes.includes(entry.adaptNote), "replaced by our own adapt note or null");
  }
});

test("prompt: style-specific adapt notes, unknown means not measured, the verdict is authoritative", () => {
  assert.match(STYLIST_INSTRUCTIONS, /specific to the style/);
  assert.match(STYLIST_INSTRUCTIONS, /never repeat one note across styles/);
  assert.match(STYLIST_INSTRUCTIONS, /"unknown" in the profile means not measured/);
  assert.match(STYLIST_INSTRUCTIONS, /feasibility verdict f is authoritative/);
  assert.match(STYLIST_INSTRUCTIONS, /Never downgrade a pass/);
  assert.match(STYLIST_INSTRUCTIONS, /notes only/);
});

test("profile payload: every filter-relevant field has value, source and confidence; unknown is explicit", () => {
  const facts = profileFacts(person, CAPTURE.answers) as Record<string, Record<string, unknown>>;
  for (const key of ["recession", "cowlickCrown", "cowlickFront", "growthDirection", "occipital", "neck", "hairline", "lengthCm", "frontCm", "topCm", "sideCm"]) {
    assert.ok(facts[key], `${key} present`);
    for (const part of ["value", "confidence", "source"]) assert.ok(part in facts[key]!, `${key}.${part}`);
  }
  for (const key of ["recession", "occipital", "neck"]) assert.equal(facts[key]!.value, "unknown", `${key} is explicit unknown`);
  assert.equal(facts.cowlickCrown!.value, true);
  assert.equal(facts.growthDirection!.value, "forward");
  assert.deepEqual(facts.zoneLengthsCm, { top: 8, front: 7, sides: 3.5, overall: 7, crown: "unknown" });
  assert.equal(facts.unknownMeans, "not measured");
});

test("candidate payload: per-zone minimum lengths, the verdict and months to grow", () => {
  const { selection } = setup();
  const [look] = rankCandidates(selection.ranked);
  const facts = candidateFacts(look!) as { minL: Record<string, unknown>; f: string; gm: unknown };
  assert.deepEqual(Object.keys(facts.minL).sort(), ["front", "sides", "top"]);
  assert.ok(facts.f === "pass" || facts.f === "adapt");
  assert.equal(facts.gm, null);
});

test("payload size: profile plus 28 candidates stay well within the input budget", () => {
  const { selection } = setup();
  const payload = JSON.stringify({ profile: profileFacts(person, CAPTURE.answers), candidates: rankCandidates(selection.ranked).map(candidateFacts) });
  const tokens = Math.ceil((payload.length + STYLIST_INSTRUCTIONS.length) / 4);
  console.log("PAYLOAD TOKENS ~", tokens);
  assert.ok(tokens < 11000);
});
