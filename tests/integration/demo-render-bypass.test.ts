import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { personForRanking } from "../../src/domain/profile-overrides.js";
import { PALETTE_LIMIT, canRender, selectLooks } from "../../src/domain/scoring.js";
import { createApp } from "../../src/server/app.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { advanceDemoJobs } from "../../src/server/demo/jobs.js";
import { catalogueReferenceFile, referenceCacheStyle } from "../../src/server/demo/reference-photo.js";
import { referenceIdentity } from "../../src/server/demo/render-pick.js";
import { sampleFrontPhotoHash, writeRenderCache } from "../../src/server/demo/render-cache.js";
import { hashToken, sessionByToken } from "../../src/server/demo/store.js";
import type { YouCamClient } from "../../src/server/providers/youcam/client.js";

const { Pool } = pg;

test("RENDER_CACHE_BYPASS=1 sends exactly one hair-transfer submit per chosen style even when all are cached; off sends none", async () => {
  loadLocalEnv();
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(required("DATABASE_URL"), testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-bypass-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "hr-bypass-disk-"));
  const storage = createPrivateStorage(storageRoot);
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "live",
    APP_ORIGIN: "http://127.0.0.1:3000",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    RENDER_CACHE_DIR: cacheDir,
    YOUCAM_API_KEY: "integration-youcam-key-01234567890123456789012",
    OPENAI_API_KEY: "integration-openai-key-012345678901234567890",
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-bypass-journal-")),
    DELETION_JOURNAL_MODE: "local",
    BUDGET_PHASE: "development",
    YOUCAM_DEV_CAP: "500",
    YOUCAM_DEMO_CAP: "300",
    YOUCAM_TOTAL_CAP: "800",
    YOUCAM_RESERVE: "200",
    OPENAI_BUDGET_USD: "5",
    TRUST_PROXY: "0",
  });
  const server = createServer(createApp(config, storageRoot, { pool, storage }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_address");
  const base = `http://127.0.0.1:${address.port}`;
  const previousBypass = process.env.RENDER_CACHE_BYPASS;
  try {
    const frontHash = await sampleFrontPhotoHash();
    const jpeg = await sharp({ create: { width: 240, height: 300, channels: 3, background: "#667744" } }).jpeg().toBuffer();

    const run = async (bypass: boolean): Promise<{ submits: number; keys: string[] }> => {
      if (bypass) process.env.RENDER_CACHE_BYPASS = "1";
      else delete process.env.RENDER_CACHE_BYPASS;
      const created = await fetch(`${base}/api/v1/demo/personas/sample`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(created.status, 201);
      const token = (created.headers.get("set-cookie") ?? "").match(/hr_demo=([^;]+)/)?.[1];
      assert.ok(token);
      const session = await sessionByToken(pool, hashToken(token), new Date());
      assert.ok(session?.analysis);
      await pool.query(`UPDATE demo_sessions SET recommendation = '{"rankPath":"llm"}'::jsonb WHERE id = $1`, [session.id]);
      const ranked = selectLooks({
        service: session.service,
        person: personForRanking(session.analysis, session.profileOverrides),
        answers: session.answers,
        likes: session.likes,
        referenceIds: [],
        limit: PALETTE_LIMIT,
      }).ranked.filter(canRender);
      const seen = new Set<string>();
      const chosen = ranked.filter((look) => {
        const file = catalogueReferenceFile(look.variant);
        const ref = referenceIdentity(look.variant);
        if (!file || !ref || seen.has(ref)) return false;
        seen.add(ref);
        return true;
      }).slice(0, 3);
      assert.equal(chosen.length, 3);
      for (const look of chosen) {
        const file = catalogueReferenceFile(look.variant);
        assert.ok(file);
        await writeRenderCache({ cacheDir, contentHash: frontHash, candidateKey: look.variant.key, templateId: referenceCacheStyle(file), bytes: jpeg });
      }
      const keys = chosen.map((look) => look.variant.key);
      const rendered = await fetch(`${base}/api/v1/demo/session/renders`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `hr_demo=${token}` },
        body: JSON.stringify({ keys }),
      });
      assert.equal(rendered.status, 200, await rendered.clone().text());
      let submits = 0;
      const youcam = {
        run: async (input: { capability: string; providerTaskId: string | null }) => {
          if (input.capability === "hairstyle" && input.providerTaskId === null) submits += 1;
          return { kind: "failed", code: "PROVIDER_UNAVAILABLE" };
        },
        readResult: async () => null,
      } as unknown as YouCamClient;
      for (let tick = 0; tick < 4; tick += 1) {
        await advanceDemoJobs({ pool, storage, youcam, now: new Date(), renderCacheDir: cacheDir, renderJobTimeoutMs: 45_000 });
      }
      return { submits, keys };
    };

    const on = await run(true);
    assert.equal(on.keys.length, 3);
    assert.equal(on.submits, 3, "bypass on: every warmed style is rendered fresh");
    const off = await run(false);
    assert.equal(off.submits, 0, "bypass off: warmed styles are served from the cache");
  } finally {
    if (previousBypass === undefined) delete process.env.RENDER_CACHE_BYPASS;
    else process.env.RENDER_CACHE_BYPASS = previousBypass;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
