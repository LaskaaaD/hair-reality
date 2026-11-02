import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { externalProcessingAllowed } from "../../src/server/assets/consent.js";
import { importOwnedPhotograph } from "../../src/server/assets/import-photo.js";
import { importRoles } from "../../src/shared/assets.js";
import { LocalDeletionJournal } from "../../src/server/assets/journal.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { hashPassword } from "../../src/server/db/passwords.js";

const { Pool } = pg;

test("operator import stores a private photograph and records consent only after acceptance", { timeout: 120_000 }, async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000 });
  const storage = createPrivateStorage(await mkdtemp(path.join(tmpdir(), "hr-import-")));
  const journal = new LocalDeletionJournal(await mkdtemp(path.join(tmpdir(), "hr-import-journal-")));
  const password = "owner-import-password";
  const now = new Date("2026-10-11T12:00:00.000Z");
  try {
    const salon = await insertId(pool, "INSERT INTO salons (slug, name, timezone, branding) VALUES ('import-salon', 'Import', 'Europe/Warsaw', '{\"kind\":\"demonstration\"}') RETURNING id");
    const owner = await insertId(pool, "INSERT INTO users (email, display_name, password_hash) VALUES ('owner.import@example.com', 'Owner', $1) RETURNING id", [await hashPassword(password)]);
    const other = await insertId(pool, "INSERT INTO users (email, display_name, password_hash) VALUES ('other.import@example.com', 'Other', $1) RETURNING id", [await hashPassword("other-import-password")]);
    const consultation = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [owner, salon]);
    const foreign = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [other, salon]);
    const file = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#888888" } }).jpeg().toBuffer();
    const common = {
      pool,
      storage,
      journal,
      now,
      retentionDays: 30,
      email: "owner.import@example.com",
      password,
      role: "current_front",
      file,
      providers: ["youcam", "openai"] as const,
    };
    const stored = await importOwnedPhotograph({ ...common, accept: false });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    assert.equal(stored.consentRecorded, false);
    assert.match(stored.statement, /is not permission to send it/);
    assert.equal(JSON.stringify(stored).includes(password), false);
    const consents = await pool.query("SELECT count(*)::int AS count FROM consents");
    assert.equal(consents.rows[0]?.count, 0);
    assert.equal(await externalProcessingAllowed(pool, consultation, [stored.assetId ?? ""], ["youcam"]), false);
    const assetIds = stored.assetId ? [stored.assetId] : [];
    for (const role of importRoles) {
      if (role === "current_front") continue;
      const saved = await importOwnedPhotograph({ ...common, role, accept: false });
      assert.equal(saved.ok, true);
      if (saved.ok && saved.assetId) assetIds.push(saved.assetId);
    }
    const legacy = await importOwnedPhotograph({ ...common, role: "current_side", accept: false });
    assert.equal(legacy.ok, false);
    const densityAsBack = await importOwnedPhotograph({ ...common, role: "current_back", accept: false });
    assert.equal(densityAsBack.ok, false);
    const roles = await pool.query<{ role: string }>("SELECT role FROM assets WHERE consultation_id = $1 AND deleted_at IS NULL ORDER BY role", [consultation]);
    assert.deepEqual(roles.rows.map((row) => row.role), [...importRoles].sort());

    const accepted = await importOwnedPhotograph({
      pool,
      storage,
      journal,
      now,
      retentionDays: 30,
      email: "owner.import@example.com",
      password,
      accept: true,
      providers: ["youcam", "openai"],
      assetIds,
    });
    assert.equal(accepted.ok, true);
    if (!accepted.ok) return;
    assert.equal(accepted.consentRecorded, true);
    assert.equal(await externalProcessingAllowed(pool, consultation, assetIds, ["youcam", "openai"]), true);

    const rejected = await importOwnedPhotograph({ ...common, password: "wrong-password-12", accept: false });
    assert.equal(rejected.ok, false);
    const foreignImport = await importOwnedPhotograph({
      ...common,
      consultationId: foreign,
      accept: false,
    });
    assert.equal(foreignImport.ok, false);
  } finally {
    await pool.end();
  }
});

async function insertId(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const result = await pool.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("missing id");
  return id;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
