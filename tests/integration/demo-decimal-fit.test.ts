import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate, pendingMigrations } from "../../src/server/db/migrate.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";

const { Pool } = pg;

type Card = { key: string; score: number; renderable?: boolean };

test("a decimal Fit survives recommend, render, preview row and results", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  assert.deepEqual(await pendingMigrations(pool, path.resolve("migrations")), []);
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-fit-"));
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    RENDER_CACHE_DIR: await mkdtemp(path.join(tmpdir(), "hr-fit-disk-")),
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-fit-journal-")),
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
  const app = createApp(config, storageRoot, { pool, storage: createPrivateStorage(storageRoot), demoIpLimit: new AttemptWindow(10, 60_000) });
  const server = createServer(app);
  await listen(server);
  const base = baseUrl(server);
  try {
    const sample = await send(base, "", "POST", "/api/v1/demo/personas/sample", {});
    assert.equal(sample.status, 201);
    const cookie = cookieOf(sample);

    const recommended = await send(base, cookie, "POST", "/api/v1/demo/session/recommend", {});
    assert.equal(recommended.status, 200);
    const body = await recommended.json() as { data: { recommendations: Card[] } };
    const card = body.data.recommendations.find((item) => item.renderable !== false);
    assert.ok(card);
    assert.equal(Number.isInteger(card.score), false, "fixture Fit should carry one decimal");

    const rendered = await send(base, cookie, "POST", "/api/v1/demo/session/renders", { keys: [card.key] });
    assert.equal(rendered.status, 200);

    const row = await pool.query<{ score: number }>(`SELECT score FROM demo_previews WHERE candidate_key = $1`, [card.key]);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0]?.score, card.score);
    process.stdout.write(`FIT ${card.score}\n`);
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
  const match = (response.headers.get("set-cookie") ?? "").match(/hr_demo=([^;]+)/);
  if (!match) throw new Error("missing_demo_cookie");
  return `hr_demo=${match[1]}`;
}

async function send(base: string, cookie: string, method: string, pathName: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathName}`, {
    method,
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
