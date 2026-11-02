process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { llmRankLooks } from "../../src/server/demo/llm-rank.js";
import { buildRankCapture, rankCaptureEnabled, readRankCapture, writeRankCapture } from "../../src/server/demo/rank-capture.js";
import { reviewRecommendations } from "../../src/server/demo/llm.js";
import { selectLooks } from "../../src/domain/scoring.js";
import { MALE_ANSWERS, recordedModel, replayCapture, replayProfile, runReplay } from "../../scripts/replay-ranking.js";

// live-test/ is gitignored (recorded live model replies); tests that replay it skip on a fresh clone.
const LIVE_PATH = path.join("live-test", "openai-v9.json");
const HAS_LIVE = existsSync(LIVE_PATH);
const LIVE = (HAS_LIVE ? JSON.parse(readFileSync(LIVE_PATH, "utf8")) : { rawVision: "{}", rawRank: "{}" }) as { rawVision: string; rawRank: string };

test("capture: RANK_CAPTURE=1 switches it on, nothing else does", () => {
  assert.equal(rankCaptureEnabled({ RANK_CAPTURE: "1" }), true);
  assert.equal(rankCaptureEnabled({ RANK_CAPTURE: "true" }), false);
  assert.equal(rankCaptureEnabled({}), false);
});

test("capture: a recommend call written to disk replays to the same order, path and Fit", { skip: !HAS_LIVE && "live-test/openai-v9.json is not in this checkout" }, async () => {
  const { person } = replayProfile("vision-reply.json", JSON.parse(LIVE.rawVision));
  const selection = selectLooks({ service: "haircut", person, answers: MALE_ANSWERS, likes: [] });
  const model = recordedModel(JSON.parse(LIVE.rawRank));
  const ranking = await llmRankLooks({ person, ranked: selection.ranked, fallback: reviewRecommendations(selection.show), openai: model.client, budgetUsd: 6 });
  assert.equal(ranking.path, "llm");
  assert.equal(ranking.rawAnswer, JSON.stringify(JSON.parse(LIVE.rawRank)));

  const dir = mkdtempSync(path.join(tmpdir(), "hr-capture-"));
  const file = writeRankCapture(buildRankCapture({ person, ranking, answers: MALE_ANSWERS, likes: [] }), "session-id-123", dir);
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{10}\.json$/);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("session-id-123"), "the session id never reaches the file");
  assert.ok(!/cookie|token|apikey|api_key|storageKey|imageUrl/i.test(text));

  const direct = await runReplay({ llm: "recorded", person, rankReply: JSON.parse(LIVE.rawRank) });
  const replayed = await replayCapture(readRankCapture(file));
  assert.equal(replayed.path, "llm");
  assert.deepEqual(replayed.rows.map((row) => [row.key, row.fit]), direct.rows.map((row) => [row.key, row.fit]));
  assert.equal(readRankCapture(file).rawRank, ranking.rawAnswer);
  assert.equal(readRankCapture(file).profile.hair.curl.value, person.hair.curl.value);
});

test("capture: a run whose model call failed replays the deterministic list", async () => {
  const { person } = replayProfile();
  const selection = selectLooks({ service: "haircut", person, answers: MALE_ANSWERS, likes: [] });
  const capture = buildRankCapture({ person, ranking: { path: "fallback", note: "call uncertain", show: [] }, answers: MALE_ANSWERS, likes: [] });
  assert.equal(capture.rawRank, null);
  const replayed = await replayCapture(capture);
  assert.equal(replayed.path, "deterministic");
  assert.equal(replayed.rows[0]!.key.length > 0, true);
  assert.ok(selection.show.length > 0);
});
