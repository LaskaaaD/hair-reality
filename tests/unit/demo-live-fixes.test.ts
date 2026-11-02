import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import { demoSessionGetResponseSchema } from "../../src/shared/preview-schema.js";

const { Pool } = pg;

loadLocalEnv();
const HAS_DATABASE = Boolean(process.env.DATABASE_URL && process.env.TEST_DATABASE_URL);

test("sample persona creates no previews; renders are idempotent; GET session without cookie returns null", { skip: !HAS_DATABASE && "DATABASE_URL and TEST_DATABASE_URL are not set" }, async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-089-demo-"));
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-089-journal-")),
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
    const noSession = await send(base, "", "GET", "/api/v1/demo/session");
    assert.equal(noSession.status, 200);
    const noSessionBody: unknown = await noSession.json();
    assert.equal(demoSessionGetResponseSchema.safeParse(noSessionBody).success, true);
    assert.equal((noSessionBody as { data: null }).data, null);

    const sample = await send(base, "", "POST", "/api/v1/demo/personas/sample", {});
    assert.equal(sample.status, 201);
    const cookie = cookieOf(sample);
    const sessionAfterPersona = await send(base, cookie, "GET", "/api/v1/demo/session");
    const sessionPayload = demoSessionGetResponseSchema.parse(await sessionAfterPersona.json());
    assert.equal(sessionPayload.data?.analysisStatus, "ready");
    assert.equal(sessionPayload.data?.looks.length, 0);

    const previewCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM demo_previews WHERE session_id = $1`,
      [sessionPayload.data?.id],
    );
    assert.equal(previewCount.rows[0]?.count, "0");

    const firstRender = await send(base, cookie, "POST", "/api/v1/demo/session/renders", { keys: ["haircut:side-part--classic-side-part"] });
    assert.equal(firstRender.status, 200);
    const firstBody = await firstRender.json() as { data: { looks: { key: string; status: string }[] } };
    assert.equal(firstBody.data.looks.length, 1);
    assert.equal(firstBody.data.looks[0]?.status, "ready");

    const secondRender = await send(base, cookie, "POST", "/api/v1/demo/session/renders", { keys: ["haircut:side-part--classic-side-part"] });
    assert.equal(secondRender.status, 200);
    const secondBody = await secondRender.json() as { data: { looks: { key: string }[] } };
    assert.equal(secondBody.data.looks.length, 1);

    const thirdKey = "haircut:crop--textured-caesar-low-taper";
    const twoKeys = await send(base, cookie, "POST", "/api/v1/demo/session/renders", {
      keys: ["haircut:side-part--classic-side-part", thirdKey],
    });
    assert.equal(twoKeys.status, 200);
    const twoBody = await twoKeys.json() as { data: { looks: unknown[] } };
    assert.equal(twoBody.data.looks.length, 2);

    const authedElsewhere = await send(base, "", "GET", "/api/v1/demo/session/questions");
    assert.equal(authedElsewhere.status, 401);
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
