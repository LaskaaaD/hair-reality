import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { advanceDemoJobs } from "../../src/server/demo/jobs.js";
import { sampleFrontPhotoHash, writeRenderCache } from "../../src/server/demo/render-cache.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import type { YouCamClient } from "../../src/server/providers/youcam/client.js";

const { Pool } = pg;

test("sample persona, render cache hits, fixture source, and timeout fallback", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-render-demo-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "hr-render-disk-"));
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    RENDER_CACHE_DIR: cacheDir,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-render-journal-")),
    DELETION_JOURNAL_MODE: "local",
    BUDGET_PHASE: "development",
    YOUCAM_DEV_CAP: "500",
    YOUCAM_DEMO_CAP: "300",
    YOUCAM_TOTAL_CAP: "800",
    YOUCAM_RESERVE: "200",
    OPENAI_BUDGET_USD: "5",
    TRUST_PROXY: "0",
  });
  const restore = installFixtureNetworkGuard("127.0.0.1");
  const storage = createPrivateStorage(storageRoot);
  const app = createApp(config, storageRoot, { pool, storage, demoIpLimit: new AttemptWindow(10, 60_000) });
  const server = createServer(app);
  await listen(server);
  const base = baseUrl(server);
  try {
    const sample = await send(base, "", "POST", "/api/v1/demo/personas/sample", {});
    assert.equal(sample.status, 201);
    const cookie = cookieOf(sample);
    const fixtureSessionId = ((await (await send(base, cookie, "GET", "/api/v1/demo/session")).json()) as { data: { id: string } }).data.id;
    const sessionView = await send(base, cookie, "GET", "/api/v1/demo/session");
    const sessionBody = await sessionView.json() as { data: { analysisStatus: string; looks: { status: string; source: string | null }[] } };
    assert.equal(sessionBody.data.analysisStatus, "ready");
    assert.equal(sessionBody.data.looks.length, 0);

    const rendered = await send(base, cookie, "POST", "/api/v1/demo/session/renders", { keys: ["haircut:side-part--classic-side-part"] });
    assert.equal(rendered.status, 200);
    const renderedBody = await rendered.json() as { data: { looks: { status: string; source: string | null }[] } };
    assert.ok(renderedBody.data.looks.length > 0);
    assert.equal(renderedBody.data.looks.filter((look) => look.status === "ready").every((look) => look.source === "fixture"), true);

    const results = await send(base, cookie, "GET", "/api/v1/demo/session/results");
    const resultsBody = await results.json() as { data: { looks: { source: string | null }[] } };
    assert.equal(resultsBody.data.looks.some((look) => look.source === "fixture"), true);

    const samples = await send(base, "", "GET", "/api/v1/demo/samples");
    const samplesBody = await samples.json() as { data: { sample: boolean } };
    assert.equal(samplesBody.data.sample, true);

    assert.equal((await send(base, "", "POST", "/api/v1/demo/personas/adrian", {})).status, 409);

    const hash = await sampleFrontPhotoHash();
    const cachedBytes = await sharp({ create: { width: 240, height: 300, channels: 3, background: "#667744" } }).jpeg().toBuffer();
    const candidateKey = "haircut:side-part--classic-side-part";
    await writeRenderCache({ cacheDir, contentHash: hash, candidateKey, templateId: "ref:side-part-classic-side-part", bytes: cachedBytes });

    const liveConfig = loadConfig({
      NODE_ENV: "development",
      PROVIDER_MODE: "live",
      APP_ORIGIN: "http://127.0.0.1:3000",
      SESSION_SECRET: "integration-session-secret-32chars",
      DATABASE_URL: testUrl,
      PRIVATE_STORAGE_DIR: storageRoot,
      RENDER_CACHE_DIR: cacheDir,
      YOUCAM_API_KEY: "integration-youcam-key-01234567890123456789012",
      OPENAI_API_KEY: "integration-openai-key-012345678901234567890",
      DELETION_JOURNAL_DIR: config.deletionJournalDir,
      DELETION_JOURNAL_MODE: "local",
      BUDGET_PHASE: "development",
      YOUCAM_DEV_CAP: "500",
      YOUCAM_DEMO_CAP: "300",
      YOUCAM_TOTAL_CAP: "800",
      YOUCAM_RESERVE: "200",
      OPENAI_BUDGET_USD: "5",
      TRUST_PROXY: "0",
    });
    const liveApp = createApp(liveConfig, storageRoot, { pool, storage });
    const liveServer = createServer(liveApp);
    await listen(liveServer);
    const liveBase = baseUrl(liveServer);
    try {
      const liveSample = await send(liveBase, "", "POST", "/api/v1/demo/personas/sample", {});
      assert.equal(liveSample.status, 201);
      const liveCookie = cookieOf(liveSample);
      const liveRender = await send(liveBase, liveCookie, "POST", "/api/v1/demo/session/renders", { keys: [candidateKey] });
      assert.equal(liveRender.status, 200);
      const liveBody = await liveRender.json() as { data: { looks: { candidateKey?: string; key?: string; status: string; source: string | null }[] } };
      const cachedLook = liveBody.data.looks.find((look) => look.key === candidateKey);
      assert.ok(cachedLook);
      assert.equal(cachedLook.status, "ready");
      assert.equal(cachedLook.source, "cached");
    } finally {
      await close(liveServer);
    }

    await pool.query(`DELETE FROM demo_jobs WHERE session_id <> $1`, [fixtureSessionId]);

    const sessionId = fixtureSessionId;
    await pool.query(
      `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key, detail)
       VALUES ($1, $2, $3, 'Timeout Style', 50, 'match', '[]'::jsonb, 'pending', NULL, '{}'::jsonb)`,
      [randomUUID(), sessionId, "haircut:male_wavy_undercut"],
    );
    const jobId = randomUUID();
    await pool.query(
      `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, provider_task_id, submitted_at, created_at, updated_at)
       VALUES ($1, $2, 'hairstyle', 'running', 0, $3, $4::jsonb, 'task-timeout', $5, $5, $5)`,
      [
        jobId,
        sessionId,
        `timeout:${jobId}`,
        JSON.stringify({ candidateKey: "haircut:male_wavy_undercut", templateId: "male_wavy_undercut" }),
        new Date(Date.now() - 60_000),
      ],
    );
    await writeRenderCache({
      cacheDir,
      contentHash: hash,
      candidateKey: "haircut:male_wavy_undercut",
      templateId: "male_wavy_undercut",
      bytes: cachedBytes,
    });
    const youcam = {
      run: async () => ({ kind: "running" }),
      readResult: async () => null,
    } as unknown as YouCamClient;
    await advanceDemoJobs({
      pool,
      storage,
      youcam,
      now: new Date(),
      renderCacheDir: cacheDir,
      renderJobTimeoutMs: 45_000,
    });
    const preview = await pool.query<{ status: string; detail: { source?: string } }>(
      `SELECT status, detail FROM demo_previews WHERE session_id = $1 AND candidate_key = 'haircut:male_wavy_undercut'`,
      [sessionId],
    );
    assert.equal(preview.rows[0]?.status, "ready");
    assert.equal(preview.rows[0]?.detail.source, "cached");

    const failJobId = randomUUID();
    await pool.query(
      `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key, detail)
       VALUES ($1, $2, 'haircut:male_bald', 'Bald', 10, 'match', '[]'::jsonb, 'pending', NULL, '{}'::jsonb)`,
      [randomUUID(), sessionId],
    );
    await pool.query(
      `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, created_at, updated_at)
       VALUES ($1, $2, 'hairstyle', 'queued', 0, $3, $4::jsonb, NOW(), NOW())`,
      [failJobId, sessionId, `fail:${failJobId}`, JSON.stringify({ candidateKey: "haircut:male_bald", templateId: "male_bald" })],
    );
    const failingYoucam = {
      run: async () => ({ kind: "failed", code: "PROVIDER_UNAVAILABLE", providerError: "offline" }),
      readResult: async () => null,
    } as unknown as YouCamClient;
    await advanceDemoJobs({
      pool,
      storage,
      youcam: failingYoucam,
      now: new Date(),
      renderCacheDir: cacheDir,
      renderJobTimeoutMs: 45_000,
    });
    const failedPreview = await pool.query<{ status: string }>(
      `SELECT status FROM demo_previews WHERE session_id = $1 AND candidate_key = 'haircut:male_bald'`,
      [sessionId],
    );
    assert.equal(failedPreview.rows[0]?.status, "failed");
  } finally {
    restore();
    await close(server);
    await pool.end();
  }
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function baseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function cookieOf(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = header.match(/hr_demo=([^;]+)/);
  if (!match) throw new Error("missing_demo_cookie");
  return `hr_demo=${match[1]}`;
}

async function send(base: string, cookie: string, method: string, pathName: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method,
    headers: {
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
