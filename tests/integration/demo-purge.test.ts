import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { purgeExpiredDemo } from "../../src/server/demo/purge.js";
import { insertSession } from "../../src/server/demo/store.js";

const { Pool } = pg;

test("the daily purge removes expired demo sessions and their files, and never an active session", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000 });
  const root = await mkdtemp(path.join(tmpdir(), "hr-purge-"));
  const cacheDir = await mkdtemp(path.join(tmpdir(), "hr-purge-cache-"));
  const storage = createPrivateStorage(root);
  try {
    const now = new Date();
    const old = await seed(pool, storage, cacheDir, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), "a");
    const fresh = await seed(pool, storage, cacheDir, new Date(now.getTime() - 24 * 60 * 60 * 1000), "b");

    const result = await purgeExpiredDemo({ pool, storage, renderCacheDir: cacheDir, now });
    assert.equal(result.sessions, 1);
    assert.equal(result.files, 2);
    assert.equal(result.cachedRenders, 1);

    assert.equal(await storage.exists(old.photoKey), false);
    assert.equal(await storage.exists(old.previewKey), false);
    assert.equal(await storage.exists(fresh.photoKey), true);
    assert.equal(await storage.exists(fresh.previewKey), true);
    assert.deepEqual((await readdir(cacheDir)).sort(), [`${fresh.hash}__style.jpg`]);

    const sessions = await pool.query<{ id: string }>("SELECT id FROM demo_sessions");
    assert.deepEqual(sessions.rows.map((row) => row.id), [fresh.id]);
    const usage = await pool.query("SELECT 1 FROM demo_usage");
    assert.equal(usage.rowCount, 2, "unit accounting survives the purge");
    assert.equal((await pool.query("SELECT 1 FROM demo_photos")).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM demo_previews")).rowCount, 1);
  } finally {
    await pool.end();
  }
});

async function seed(pool: pg.Pool, storage: ReturnType<typeof createPrivateStorage>, cacheDir: string, created: Date, tag: string) {
  const id = await insertSession(pool, { service: "haircut", tokenHash: randomBytes(32).toString("hex"), now: created, personaId: null });
  const photoKey = randomBytes(32).toString("hex");
  const previewKey = randomBytes(32).toString("hex");
  const hash = randomBytes(32).toString("hex");
  await storage.write(photoKey, Buffer.from(`photo-${tag}`));
  await storage.write(previewKey, Buffer.from(`preview-${tag}`));
  await writeFile(path.join(cacheDir, `${hash}__style.jpg`), "cached");
  await pool.query(
    "INSERT INTO demo_photos (id, session_id, role, storage_key, content_hash, mime) VALUES (gen_random_uuid(), $1, 'front', $2, $3, 'image/jpeg')",
    [id, photoKey, hash],
  );
  await pool.query(
    `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key)
     VALUES (gen_random_uuid(), $1, 'haircut:x', 'X', 70, 'ok', '[]'::jsonb, 'ready', $2)`,
    [id, previewKey],
  );
  await pool.query("INSERT INTO demo_usage (id, session_id, capability, units, idempotency_key, created_at) VALUES (gen_random_uuid(), $1, 'analysis', 15, $2, $3)", [id, `analysis:${id}`, created]);
  return { id, photoKey, previewKey, hash };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
