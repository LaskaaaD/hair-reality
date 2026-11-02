import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import type { YouCamClient } from "../../src/server/providers/youcam/client.js";

const { Pool } = pg;

async function portrait(hair: string, hairHeight: number): Promise<Buffer> {
  const rect = (x: number, y: number, w: number, h: number, fill: string) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="512">`
    + rect(0, 0, 384, 512, "#D9D5CC")
    + rect(120, 250 - hairHeight + 100, 144, 230, "#E0B08F")
    + rect(110, 80 + 100 - hairHeight, 164, hairHeight + 60, hair)
    + rect(0, 440, 384, 72, "#151515")
    + `</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

test("a render with drastically wrong hair colour is recoloured; a mild one is shown as is; a failed recolour keeps the render", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-recolour-"));
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-recolour-journal-")),
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
  const server = createServer(createApp(config, storageRoot, { pool, storage, demoIpLimit: new AttemptWindow(10, 60_000) }));
  await listen(server);
  try {
    const sample = await fetch(`${baseUrl(server)}/api/v1/demo/personas/sample`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(sample.status, 201);
    const cookie = /hr_demo=([^;]+)/.exec(sample.headers.get("set-cookie") ?? "")![1]!;
    const session = (await (await fetch(`${baseUrl(server)}/api/v1/demo/session`, { headers: { cookie: `hr_demo=${cookie}`, accept: "application/json" } })).json()) as { data: { id: string } };
    const sessionId = session.data.id;
    await pool.query(`DELETE FROM demo_jobs WHERE session_id = $1`, [sessionId]);

    // The client's own photo: brown hair on a plain wall.
    const own = await portrait("#4F4035", 120);
    const ownKey = randomBytes(32).toString("hex");
    await storage.write(ownKey, own);
    const hadFront = await pool.query(`UPDATE demo_photos SET storage_key = $2 WHERE session_id = $1 AND role = 'front'`, [sessionId, ownKey]);
    if (hadFront.rowCount === 0) {
      await pool.query(`INSERT INTO demo_photos (id, session_id, role, storage_key, content_hash, mime) VALUES ($1, $2, 'front', $3, $4, 'image/jpeg')`, [randomUUID(), sessionId, ownKey, randomBytes(32).toString("hex")]);
    }

    const blackRender = await portrait("#1A1816", 150);
    const mildRender = await portrait("#5A4A3E", 150);
    const recoloured = await portrait("#4F4035", 150);
    const hairColourCalls: Record<string, unknown>[] = [];
    let recolourOutcome: "succeed" | "fail" = "succeed";
    const youcam = {
      run: async (input: { capability: string; providerTaskId: string | null; controls: Record<string, unknown> }) => {
        if (input.capability === "hairstyle") return { kind: "succeeded", evidence: {}, downloadUrl: `https://render.test/${input.providerTaskId}` };
        hairColourCalls.push(input.controls);
        if (recolourOutcome === "fail") return { kind: "failed", code: "PROVIDER_UNAVAILABLE", providerError: "offline" };
        return input.providerTaskId === null ? { kind: "accepted", taskId: "recolour-task" } : { kind: "succeeded", evidence: {}, downloadUrl: "https://render.test/recoloured" };
      },
      readResult: async (url: string) => (url.endsWith("black") ? blackRender : url.endsWith("mild") ? mildRender : url.endsWith("recoloured") ? recoloured : null),
    } as unknown as YouCamClient;
    const tick = () => advanceDemoJobs({ pool, storage, youcam, now: new Date() });

    const queueHairstyle = async (candidateKey: string, task: string) => {
      await pool.query(
        `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key, detail)
         VALUES ($1, $2, $3, 'Style', 50, 'match', '[]'::jsonb, 'pending', NULL, '{}'::jsonb)`,
        [randomUUID(), sessionId, candidateKey],
      );
      const id = randomUUID();
      await pool.query(
        `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, provider_task_id, submitted_at, created_at, updated_at)
         VALUES ($1, $2, 'hairstyle', 'running', 0, $3, $4::jsonb, $5, NOW(), NOW(), NOW())`,
        [id, sessionId, `job:${id}`, JSON.stringify({ candidateKey }), task],
      );
    };
    const preview = async (candidateKey: string) => (await pool.query<{ status: string; storage_key: string | null }>(
      `SELECT status, storage_key FROM demo_previews WHERE session_id = $1 AND candidate_key = $2`, [sessionId, candidateKey])).rows[0]!;
    const recolourJobs = async () => (await pool.query<{ status: string; payload: { hex?: string; recolourSourceKey?: string } }>(
      `SELECT status, payload FROM demo_jobs WHERE session_id = $1 AND capability = 'hair-color' ORDER BY created_at`, [sessionId])).rows;

    // 1. Mild difference: shown right away, no recolour job.
    await queueHairstyle("haircut:mild", "mild");
    await tick();
    assert.equal((await preview("haircut:mild")).status, "ready");
    assert.equal((await recolourJobs()).length, 0);

    // 2. Drastic difference: the preview stays pending while a recolour job runs, then shows the recoloured image.
    await queueHairstyle("haircut:black", "black");
    await tick();
    assert.equal((await preview("haircut:black")).status, "pending");
    const queued = await recolourJobs();
    assert.equal(queued.length, 1);
    assert.match(queued[0]!.payload.hex ?? "", /^#[0-9A-F]{6}$/);
    await tick();
    await tick();
    const done = await preview("haircut:black");
    assert.equal(done.status, "ready");
    assert.notEqual(done.storage_key, queued[0]!.payload.recolourSourceKey);
    assert.deepEqual(hairColourCalls[0]?.pattern, { name: "full" });
    const palettes = (hairColourCalls[0]?.palettes ?? []) as { color: string }[];
    assert.equal(palettes[0]?.color, queued[0]!.payload.hex);
    const chunks: Buffer[] = [];
    for await (const chunk of storage.stream(done.storage_key!)) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), recoloured);

    // 3. The recolour step fails: the client still gets the render as YouCam returned it.
    recolourOutcome = "fail";
    await queueHairstyle("haircut:black-two", "black");
    await tick();
    assert.equal((await preview("haircut:black-two")).status, "pending");
    await tick();
    const kept = await preview("haircut:black-two");
    assert.equal(kept.status, "ready");
    assert.ok(kept.storage_key);
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
