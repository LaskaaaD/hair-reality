import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { variantByKey } from "../../src/domain/knowledge-base.js";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { OpenAIClient } from "../../src/server/providers/openai/client.js";
import { createFixtureOpenAIClient } from "../../src/server/providers/openai/fixture.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";

const { Pool } = pg;

const WOMENS = "haircut:all_short_bob";
const MENS = "haircut:male_short_curly";

type App = { base: string; close: () => Promise<void> };

let pool: InstanceType<typeof Pool>;
let config: ReturnType<typeof loadConfig>;
let storageRoot: string;
let restoreNetwork: () => void;
let jpeg: Buffer;
const open: App[] = [];

before(async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  storageRoot = await mkdtemp(path.join(tmpdir(), "hr-gender-"));
  config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-gender-journal-")),
    DELETION_JOURNAL_MODE: "local",
    BUDGET_PHASE: "development",
    YOUCAM_DEV_CAP: "500",
    YOUCAM_DEMO_CAP: "300",
    YOUCAM_TOTAL_CAP: "800",
    YOUCAM_RESERVE: "200",
    OPENAI_BUDGET_USD: "5",
    TRUST_PROXY: "0",
  });
  restoreNetwork = installFixtureNetworkGuard("127.0.0.1");
  jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#aa6644" } }).jpeg().toBuffer();
});

after(async () => {
  restoreNetwork?.();
  for (const app of open) await app.close();
  await pool?.end();
});

async function start(openai: OpenAIClient): Promise<string> {
  const app = createApp(config, storageRoot, { pool, storage: createPrivateStorage(storageRoot), openai, demoIpLimit: new AttemptWindow(100, 60_000) });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = baseUrl(server);
  open.push({ base, close: () => closeServer(server) });
  return base;
}

/** A model that never answers: vision fails after its attempts, as in a timeout. */
function brokenModel(): OpenAIClient {
  return new OpenAIClient(async () => { throw new TypeError("fetch failed"); }, "fixture", undefined, 1);
}

type Client = { call: (method: string, route: string, body?: unknown) => Promise<{ status: number; data: any }> }; // eslint-disable-line

async function session(base: string, photos = true): Promise<Client> {
  const started = await fetch(`${base}/api/v1/demo/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ service: "haircut", consent: true }),
  });
  assert.equal(started.status, 201);
  const cookie = cookieOf(started);
  const call = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}/api/v1/demo${route}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = await response.json() as { data?: unknown; error?: unknown };
    return { status: response.status, data: parsed.data ?? parsed.error ?? parsed };
  };
  if (photos) {
    for (const role of ["front", "left", "right", "crown"]) {
      const form = multipart(role, jpeg);
      const uploaded = await fetch(`${base}/api/v1/demo/session/photos`, { method: "POST", headers: { cookie, "content-type": form.type }, body: new Uint8Array(form.body) });
      assert.equal(uploaded.status, 201, role);
    }
  }
  return { call };
}

const wizardAnswers = (presentation: "masculine" | "feminine" | "either" | "auto") => ({
  stylingMinutes: "15", heatStyle: "sometimes", keep: "nothing",  canShorten: "no", canGrow: "no", facialHair: "unknown", presentation,
});

function visionFields(analysis: any): string[] { // eslint-disable-line
  const readings: Record<string, { source?: string } | undefined> = {
    shape: analysis.face?.shape, aspectRatio: analysis.face?.aspectRatio, jaw: analysis.face?.jaw, forehead: analysis.face?.forehead,
    foreheadWidth: analysis.face?.foreheadWidth, curl: analysis.hair?.curl, density: analysis.hair?.density, diameter: analysis.hair?.diameter,
    growthDirection: analysis.hair?.growthDirection, cowlickFront: analysis.hair?.cowlickFront, hairline: analysis.hair?.hairline,
    lengthCm: analysis.hair?.lengthCm, topCm: analysis.hair?.topCm, ears: analysis.head?.ears, glasses: analysis.context?.glasses,
  };
  return Object.entries(readings).filter(([, reading]) => reading?.source === "vision").map(([field]) => field);
}

function affinities(keys: readonly string[]): string[] {
  return keys.map((key) => variantByKey(key)?.affinity ?? "unknown");
}

test("fixture vision merges the recorded live reply, and a male answer then ranks 0 feminine styles on every surface", async () => {
  const base = await start(createFixtureOpenAIClient());
  const user = await session(base);
  const analysis = await user.call("POST", "/session/analyze", {});
  assert.equal(analysis.status, 200);
  const merged = visionFields(analysis.data.analysis);
  assert.ok(merged.length >= 15, `vision merged ${merged.length} fields: ${merged.join(", ")}`);
  assert.equal(analysis.data.analysis.hair.curl.value, "1");
  assert.equal(analysis.data.analysis.hair.density.source, "vision");
  assert.equal(analysis.data.analysis.sex.value, "unknown", "vision never supplies a sex, so the answer is what decides");

  assert.equal((await user.call("POST", "/session/answers", wizardAnswers("masculine"))).status, 200);
  const palette = (await user.call("GET", "/session/palette")).data as { top: { key: string }[]; all: { key: string }[] };
  assert.ok(palette.top.length > 0 && palette.all.length > 0);
  assert.equal(affinities([...palette.top, ...palette.all].map((item) => item.key)).includes("feminine"), false);

  const liked = await user.call("POST", "/session/likes", { templateIds: [WOMENS, MENS] });
  assert.deepEqual(liked.data.likes, [MENS]);

  const recommended = await user.call("POST", "/session/recommend", {});
  assert.equal(recommended.status, 200);
  const shown = [...recommended.data.recommendations, ...recommended.data.goals] as { key: string; renderable?: boolean }[];
  assert.ok(shown.length > 0);
  assert.equal(affinities(shown.map((item) => item.key)).includes("feminine"), false);

  // Renders cannot be requested outside the user's style set, and the refusal creates nothing.
  const refused = await user.call("POST", "/session/renders", { keys: [WOMENS] });
  assert.equal(refused.status, 400);
  assert.equal((await user.call("GET", "/session/results")).data.looks.length, 0);
  const allowed = await user.call("POST", "/session/renders", { keys: [shown.find((item) => item.renderable !== false)!.key] });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.looks.length, 1);
});

test("vision failed and a male answer: still 0 feminine styles, in ranking, goals, palette and renders", async () => {
  const base = await start(brokenModel());
  const user = await session(base);
  const analysis = await user.call("POST", "/session/analyze", {});
  assert.equal(analysis.status, 200);
  assert.deepEqual(visionFields(analysis.data.analysis), []);

  assert.equal((await user.call("POST", "/session/answers", wizardAnswers("masculine"))).status, 200);
  const palette = (await user.call("GET", "/session/palette")).data as { top: { key: string }[]; all: { key: string }[] };
  assert.ok(palette.top.length > 0);
  assert.equal(affinities([...palette.top, ...palette.all].map((item) => item.key)).includes("feminine"), false);

  const recommended = await user.call("POST", "/session/recommend", {});
  assert.equal(recommended.status, 200);
  const shown = [...recommended.data.recommendations, ...recommended.data.goals] as { key: string; renderable?: boolean }[];
  assert.ok(shown.length > 0);
  assert.equal(recommended.data.rankPath, "fallback");
  assert.equal(affinities(shown.map((item) => item.key)).includes("feminine"), false);

  assert.equal((await user.call("POST", "/session/renders", { keys: [WOMENS] })).status, 400);
  assert.equal((await user.call("POST", "/session/renders", { keys: [shown.find((item) => item.renderable !== false)!.key] })).status, 200);
});

test("vision failed and no gender answer: nothing is ranked or rendered, with a clear message", async () => {
  for (const openai of [brokenModel(), createFixtureOpenAIClient()]) {
    const user = await session(await start(openai));
    assert.equal((await user.call("POST", "/session/analyze", {})).status, 200);
    // The wizard sends "auto" until the client picks Men, Women or Both.
    assert.equal((await user.call("POST", "/session/answers", wizardAnswers("auto"))).status, 200);

    const palette = (await user.call("GET", "/session/palette")).data as { top: unknown[]; all: unknown[] };
    assert.deepEqual([palette.top.length, palette.all.length], [0, 0]);

    const recommended = await user.call("POST", "/session/recommend", {});
    assert.equal(recommended.status, 409);
    assert.match(JSON.stringify(recommended.data), /men's styles, women's styles or both/);

    for (const key of [WOMENS, MENS]) {
      const rendered = await user.call("POST", "/session/renders", { keys: [key] });
      assert.equal(rendered.status, 409, key);
      assert.match(JSON.stringify(rendered.data), /men's styles, women's styles or both/);
    }
    assert.equal((await user.call("GET", "/session/results")).data.looks.length, 0);

    // Likes outside any known style set are dropped too.
    assert.deepEqual((await user.call("POST", "/session/likes", { templateIds: [WOMENS, MENS] })).data.likes, []);
  }
});

test("renders: Soft and Classic side part no longer share a reference photo, so both render side by side", async () => {
  const SOFT = "haircut:side-part--soft-side-part";
  const CLASSIC = "haircut:side-part--classic-side-part";
  const user = await session(await start(createFixtureOpenAIClient()));
  assert.equal((await user.call("POST", "/session/analyze", {})).status, 200);
  assert.equal((await user.call("POST", "/session/answers", wizardAnswers("masculine"))).status, 200);
  assert.equal((await user.call("POST", "/session/recommend", {})).status, 200);
  const both = await user.call("POST", "/session/renders", { keys: [SOFT, CLASSIC] });
  assert.equal(both.status, 200);
  assert.notEqual(both.data.code, "same_reference_photo");
});

test("renders: a style whose feasibility is fail is refused with 409 not_on_your_hair before any job, preview or unit is created", async () => {
  // The fixture client reads straight hair (curl 1), so a style built on curls fails the hard texture filter.
  const user = await session(await start(createFixtureOpenAIClient()));
  assert.equal((await user.call("POST", "/session/analyze", {})).status, 200);
  assert.equal((await user.call("POST", "/session/answers", wizardAnswers("masculine"))).status, 200);
  assert.equal((await user.call("POST", "/session/recommend", {})).status, 200);
  const count = async (table: string) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const units = async () => Number((await pool.query("SELECT coalesce(sum(units), 0)::int AS n FROM demo_usage")).rows[0].n);
  const before = { jobs: await count("demo_jobs"), previews: await count("demo_previews"), usage: await count("demo_usage"), units: await units() };
  const refused = await user.call("POST", "/session/renders", { keys: [MENS] });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "not_on_your_hair");
  assert.match(refused.data.message, /does not work on your hair/);
  assert.equal(await count("demo_jobs"), before.jobs);
  assert.equal(await count("demo_previews"), before.previews);
  assert.equal(await count("demo_usage"), before.usage);
  assert.equal(await units(), before.units);
  assert.equal((await user.call("GET", "/session/results")).data.looks.length, 0);
});

test("recommend with RANK_CAPTURE=1 writes the rank inputs to a file that replays offline, and writes nothing without the flag", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { replayCapture } = await import("../../scripts/replay-ranking.js");
  const { readRankCapture } = await import("../../src/server/demo/rank-capture.js");
  const dir = await mkdtemp(path.join(tmpdir(), "hr-capture-int-"));
  const user = await session(await start(createFixtureOpenAIClient()));
  assert.equal((await user.call("POST", "/session/analyze", {})).status, 200);
  assert.equal((await user.call("POST", "/session/answers", wizardAnswers("masculine"))).status, 200);
  process.env.RANK_CAPTURE_DIR = dir;
  try {
    delete process.env.RANK_CAPTURE;
    assert.equal((await user.call("POST", "/session/recommend", {})).status, 200);
    assert.deepEqual(readdirSync(dir), []);
    process.env.RANK_CAPTURE = "1";
    const recommended = await user.call("POST", "/session/recommend", { regenerate: true });
    assert.equal(recommended.status, 200);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    const text = readFileSync(path.join(dir, files[0]!), "utf8");
    assert.ok(!/cookie|hr_demo|token/i.test(text));
    const capture = readRankCapture(path.join(dir, files[0]!));
    assert.equal(capture.rankPath, recommended.data.rankPath);
    const replayed = await replayCapture(capture);
    assert.ok(replayed.rows.length > 0);
    assert.equal(replayed.rows.some((row) => row.look.variant.affinity === "feminine"), false);
  } finally {
    delete process.env.RANK_CAPTURE;
    delete process.env.RANK_CAPTURE_DIR;
  }
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}`;
}

function cookieOf(response: Response): string {
  const header = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie()[0] : response.headers.get("set-cookie");
  const pair = header?.split(";")[0];
  if (!pair) throw new Error("missing session cookie");
  return pair;
}

function multipart(role: string, file: Buffer): { body: Buffer; type: string } {
  const boundary = "----hairreality";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\n${role}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n1\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  );
  return { body: Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}
