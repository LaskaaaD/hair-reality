import assert from "node:assert/strict";
import { test } from "node:test";
import { liveRenderGate, RANKING_NOT_LLM_MESSAGE, savedRankPath } from "../../src/server/demo/render-gate.js";

test("render gate refuses live renders when the ranking path is fallback", () => {
  const gate = liveRenderGate({ live: true, recommendation: { rankPath: "fallback", rankNote: "timeout" } });
  assert.deepEqual(gate, { status: 409, code: "RANKING_NOT_LLM", message: RANKING_NOT_LLM_MESSAGE });
});

test("render gate treats an uncertain OpenAI call as not llm", () => {
  const gate = liveRenderGate({ live: true, recommendation: { rankPath: "fallback", rankNote: "call uncertain" } });
  assert.equal(gate?.code, "RANKING_NOT_LLM");
  assert.equal(savedRankPath({ rankPath: "uncertain" }), "fallback");
});

test("render gate refuses live renders when no ranking was saved", () => {
  assert.equal(liveRenderGate({ live: true, recommendation: null })?.status, 409);
  assert.equal(liveRenderGate({ live: true, recommendation: {} })?.status, 409);
});

test("render gate allows live renders when the ranking path is llm", () => {
  assert.equal(liveRenderGate({ live: true, recommendation: { rankPath: "llm", rankNote: "0 of 20 scores kept ours" } }), null);
});

test("render gate never blocks fixture renders that do not reach YouCam", () => {
  assert.equal(liveRenderGate({ live: false, recommendation: { rankPath: "fallback" } }), null);
});
