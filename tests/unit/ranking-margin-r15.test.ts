process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { RecommendationCard } from "../../src/client/api.js";
import { applyReservedMargin, RESERVED_SLOT_MARGIN } from "../../src/client/flow/ranking-groups.js";
import { personSchema, type Person } from "../../src/domain/person.js";
import type { Answers } from "../../src/domain/scoring.js";
import { runReplay } from "../../scripts/replay-ranking.js";

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

const DIR = path.join("tests", "fixtures", "openai-live");
const CHECK14 = JSON.parse(readFileSync(path.join(DIR, "rank-answer-check14.json"), "utf8").replace(/^﻿/, "")) as { rawAnswer: string };
const CAPTURE = JSON.parse(readFileSync(path.join(DIR, "rank-profile-check13.json"), "utf8")) as { profile: unknown; answers: Answers; likes: string[] };

test("check14 replay: Textured Caesar is shown, the top-50 list, 2+ bolder and 2+ goals, everyday Fit strictly descending", async () => {
  const person = personSchema.parse(CAPTURE.profile) as Person;
  const result = await runReplay({ llm: "recorded", person, answers: CAPTURE.answers, likes: CAPTURE.likes, rankReply: JSON.parse(CHECK14.rawAnswer) });
  assert.equal(result.path, "llm");
  const { rows } = result;
  console.log("CHECK14 SHOWN", rows.map((row) => `${row.rank}. ${row.key} ${row.fit} ${row.group}`).join(" | "));
  assert.ok(rows.some((row) => row.key.endsWith("crop--textured-caesar-low-taper")), "Textured Caesar is shown");
  assert.ok(rows.length >= 40 && rows.length <= 50, `${rows.length} cards`);
  assert.ok(rows.filter((row) => row.group === "bolder").length >= 2, "at least 2 bolder");
  const goals = rows.filter((row) => (row.look.feasibility.status === "goal"));
  assert.ok(goals.length >= 2, "at least 2 goals");
  const everyday = rows.filter((row) => row.group !== "bolder" && row.look.feasibility.status !== "goal");
  everyday.forEach((row, index) => { if (index > 0) assert.ok(everyday[index - 1]!.fit > row.fit, `${row.title} falls below the card before it`); });
});

const card = (key: string, score: number, extra: Partial<RecommendationCard> = {}) => ({ key, score, ...extra }) as unknown as RecommendationCard;
const fit = (c: { score: number }) => c.score;

test("margin: 1.9 Fit keeps the reserved card, 2.0 displaces it", () => {
  const [a, b, c] = [card("a", 70), card("b", 71), card("c", 72)];
  const reserved = [a, b, c];
  const floor = [b, c];
  assert.equal(RESERVED_SLOT_MARGIN, 2);
  assert.deepEqual(applyReservedMargin({ reserved, floor, challengers: [card("x", 71.9)], contestFit: fit }), reserved);
  const out = applyReservedMargin({ reserved, floor, challengers: [card("x", 72)], contestFit: fit });
  assert.deepEqual(out.map((item) => item.key).sort(), ["b", "c", "x"]);
});

test("margin: the floor is never displaced; worst reserved go first, to the best challengers first", () => {
  const reserved = [card("r1", 60), card("r2", 65), card("r3", 70), card("r4", 75)];
  const floor = [reserved[2]!, reserved[3]!];
  const challengers = [card("x1", 90), card("x2", 80), card("x3", 77)];
  const out = applyReservedMargin({ reserved, floor, challengers, contestFit: fit });
  assert.deepEqual(out.map((item) => item.key).sort(), ["r3", "r4", "x1", "x2"]);
  // A floor card is safe even against a far better challenger, and the count never changes.
  const only = applyReservedMargin({ reserved: floor, floor, challengers, contestFit: fit });
  assert.deepEqual(only, floor);
});
