import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { fixturePerson } from "../../src/domain/person.js";
import { emptyAnswers, selectLooks } from "../../src/domain/scoring.js";
import { llmRankLooks } from "../../src/server/demo/llm-rank.js";
import { liveOpenAITransport } from "../../src/server/providers/probe-clients.js";
import { isTransientTransportError, OpenAIClient, type OpenAITransport } from "../../src/server/providers/openai/client.js";

process.env.OPENAI_DEMO_LEDGER = path.join(mkdtempSync(path.join(tmpdir(), "hr-ledger-")), "ledger.json");

const COMPLETED = JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "{}" }] }], usage: { input_tokens: 10, output_tokens: 5 } });

function fetchFailed(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
}

type Step = { status: number; body?: string } | Error;

/** A transport that plays the given steps in order and counts the requests it received. */
function scripted(steps: readonly Step[]): { transport: OpenAITransport; calls: () => number } {
  let used = 0;
  return {
    calls: () => used,
    transport: async () => {
      const step = steps[Math.min(used, steps.length - 1)];
      used += 1;
      if (step instanceof Error) throw step;
      return { status: step?.status ?? 200, body: step?.body ?? COMPLETED };
    },
  };
}

function call(client: OpenAIClient, retryTransient: boolean) {
  return client.completeJson({ name: "demo_rank", model: "gpt-5.4", instructions: "x", schema: {}, userText: "{}", retryTransient });
}

test("a connect timeout is retried once and the second attempt can succeed", async () => {
  const plan = scripted([fetchFailed("UND_ERR_CONNECT_TIMEOUT"), { status: 200 }]);
  const result = await call(new OpenAIClient(plan.transport, "key", undefined, 1), true);
  assert.equal(result.kind, "completed");
  assert.equal(plan.calls(), 2);
});

test("every transient cause in the brief is retried exactly once, then reported with its cause", async () => {
  for (const error of [fetchFailed("UND_ERR_CONNECT_TIMEOUT"), fetchFailed("ECONNRESET"), fetchFailed("ETIMEDOUT"), new TypeError("fetch failed")]) {
    const plan = scripted([error]);
    const result = await call(new OpenAIClient(plan.transport, "key", undefined, 1), true);
    assert.equal(plan.calls(), 2, String(error.cause ?? error.message));
    assert.equal(result.kind, "uncertain");
    assert.match(result.kind === "uncertain" ? result.detail ?? "" : "", /^transport_TypeError.* after_retry$/);
  }
});

test("429 and 5xx get one retry; a second 429 is a rate limit and a second 5xx is uncertain with its status", async () => {
  const recovered = scripted([{ status: 503 }, { status: 200 }]);
  assert.equal((await call(new OpenAIClient(recovered.transport, "key", undefined, 1), true)).kind, "completed");
  assert.equal(recovered.calls(), 2);

  const limited = scripted([{ status: 429 }]);
  assert.deepEqual(await call(new OpenAIClient(limited.transport, "key", undefined, 1), true), { kind: "failed", code: "PROVIDER_RATE_LIMIT" });
  assert.equal(limited.calls(), 2);

  const down = scripted([{ status: 502 }]);
  assert.deepEqual(await call(new OpenAIClient(down.transport, "key", undefined, 1), true), { kind: "uncertain", detail: "status_502 after_retry" });
  assert.equal(down.calls(), 2);
});

test("errors that a second try cannot fix are never retried", async () => {
  for (const step of [{ status: 400 }, { status: 401 }, { status: 404 }, Object.assign(new Error("denied"), { code: "EACCES" }), Object.assign(new Error("aborted"), { name: "TimeoutError" })] as Step[]) {
    const plan = scripted([step]);
    await call(new OpenAIClient(plan.transport, "key", undefined, 1), true);
    assert.equal(plan.calls(), 1, JSON.stringify(step));
  }
});

test("a call that does not ask for a retry (vision, notes) is sent once", async () => {
  const plan = scripted([fetchFailed("ECONNRESET")]);
  const result = await call(new OpenAIClient(plan.transport, "key", undefined, 1), false);
  assert.equal(plan.calls(), 1);
  assert.deepEqual(result, { kind: "uncertain", detail: "transport_TypeError:ECONNRESET" });
});

test("the retry waits for the backoff before it sends again", async () => {
  const stamps: number[] = [];
  const transport: OpenAITransport = async () => {
    stamps.push(Date.now());
    if (stamps.length === 1) throw fetchFailed("ECONNRESET");
    return { status: 200, body: COMPLETED };
  };
  await call(new OpenAIClient(transport, "key", undefined, 120), true);
  assert.equal(stamps.length, 2);
  assert.ok((stamps[1] ?? 0) - (stamps[0] ?? 0) >= 100);
});

test("transient detection reads the undici cause code", () => {
  assert.equal(isTransientTransportError(fetchFailed("UND_ERR_SOCKET")), true);
  assert.equal(isTransientTransportError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isTransientTransportError("fetch failed"), false);
});

test("the live transport aborts a request that outlives its timeout", async () => {
  const realFetch = globalThis.fetch;
  let signalSeen = false;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    signalSeen = init?.signal instanceof AbortSignal;
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
  try {
    const plan = { calls: 0 };
    const counting: OpenAITransport = (input) => { plan.calls += 1; return liveOpenAITransport(30)(input); };
    const started = Date.now();
    const result = await call(new OpenAIClient(counting, "key", undefined, 1), true);
    assert.equal(signalSeen, true);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(result, { kind: "uncertain", detail: "transport_TimeoutError" });
    assert.equal(plan.calls, 1, "our own request timeout is not retried");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rank call that keeps hitting a connect timeout falls back to the deterministic list and logs the cause", async () => {
  const person = fixturePerson("fixture");
  const selection = selectLooks({ service: "haircut", person, answers: { ...emptyAnswers(), presentation: "masculine" }, likes: [] });
  const plan = scripted([fetchFailed("UND_ERR_CONNECT_TIMEOUT")]);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const outcome = await llmRankLooks({
      person,
      ranked: selection.ranked,
      fallback: selection.show,
      openai: new OpenAIClient(plan.transport, "key", undefined, 1),
      budgetUsd: 5,
    });
    assert.equal(outcome.path, "fallback");
    assert.deepEqual(outcome.show.map((look) => look.variant.key), selection.show.map((look) => look.variant.key));
    assert.equal(plan.calls(), 2);
    const lines = warn.mock.calls.map((entry) => String(entry.arguments[0]));
    assert.ok(lines.some((line) => line.startsWith("openai_retry name=demo_rank reason=transport_TypeError:UND_ERR_CONNECT_TIMEOUT")));
    assert.ok(lines.some((line) => line === 'demo_rank path=fallback cause="call uncertain" detail=transport_TypeError:UND_ERR_CONNECT_TIMEOUT after_retry'));
  } finally {
    warn.mock.restore();
  }
});
