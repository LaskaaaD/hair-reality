import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { createApp } from "../../src/server/app.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { isSameDatabase, TestDatabaseGuardError } from "../../src/server/db/database-identity.js";
import { dropScratchDatabase, ensureDatabase, resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { verifyPassword } from "../../src/server/db/passwords.js";
import { seed } from "../../src/server/db/seed.js";

const { Client } = pg;
const migrationsDirectory = path.resolve("migrations");
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const PASSWORD_HASH = "$argon2id$constraint-fixture";

test("PostgreSQL migrations, seeds, constraints and readiness", { timeout: 180_000 }, async () => {
  loadLocalEnv();
  const applicationUrl = requiredEnv("DATABASE_URL");
  const testUrl = requiredEnv("TEST_DATABASE_URL");
  const scratchUrl = withDatabase(applicationUrl, "hair_reality_migration_scratch");

  await dropScratchDatabase(applicationUrl, scratchUrl);
  await ensureDatabase(scratchUrl);
  const first = await migrate(scratchUrl, migrationsDirectory);
  const second = await migrate(scratchUrl, migrationsDirectory);
    assert.deepEqual(first.applied, [
      "0001_initial.sql",
      "0002_session_expiry.sql",
      "0003_private_assets.sql",
      "0004_consultation_selection.sql",
      "0005_jobs_accounting.sql",
      "0006_asset_roles.sql",
      "0007_preview_selection.sql",
      "0008_demo_sessions.sql",
      "0009_demo_v3.sql",
      "0010_preview_score_decimal.sql",
    ]);
  assert.deepEqual(second.applied, []);
  await dropScratchDatabase(applicationUrl, scratchUrl);

  const app = new Client({ connectionString: applicationUrl, connectionTimeoutMillis: 5000 });
  await app.connect();
  try {
    const beforeUsers = await count(app, "SELECT count(*)::text AS value FROM users");
    const beforeCandidates = await count(app, "SELECT count(*)::text AS value FROM candidates");
    const beforeHash = await text(app, "SELECT password_hash AS value FROM users WHERE email = $1", ["client.demo@example.com"]);
    assert.ok(beforeUsers >= 3);
    assert.equal(beforeHash.startsWith("$argon2id$"), true);
    const alternateApplicationUrl = equivalentApplicationUrl(applicationUrl);
    const portOverrideUrl = authorityPortOverride(applicationUrl);
    const emptyHostOverrideUrl = emptyQueryOverride(applicationUrl, "host", "203.0.113.10");
    const emptyPortOverrideUrl = emptyQueryOverride(applicationUrl, "port", "1");
    assert.equal(isSameDatabase(applicationUrl, alternateApplicationUrl), true);
    assert.equal(isSameDatabase(applicationUrl, portOverrideUrl), true);
    assert.equal(isSameDatabase(applicationUrl, emptyHostOverrideUrl), true);
    assert.equal(isSameDatabase(applicationUrl, emptyPortOverrideUrl), true);
    await assert.rejects(
      () => resetTestDatabase(applicationUrl, alternateApplicationUrl),
      (error: unknown) => error instanceof TestDatabaseGuardError,
    );
    await assert.rejects(
      () => resetTestDatabase(applicationUrl, portOverrideUrl),
      (error: unknown) => error instanceof TestDatabaseGuardError,
    );
    await assert.rejects(
      () => resetTestDatabase(applicationUrl, emptyHostOverrideUrl),
      (error: unknown) => error instanceof TestDatabaseGuardError,
    );
    await assert.rejects(
      () => resetTestDatabase(applicationUrl, emptyPortOverrideUrl),
      (error: unknown) => error instanceof TestDatabaseGuardError,
    );
    assert.equal(await count(app, "SELECT count(*)::text AS value FROM users"), beforeUsers);
    assert.equal(await text(app, "SELECT password_hash AS value FROM users WHERE email = $1", ["client.demo@example.com"]), beforeHash);
    assert.equal(await count(app, "SELECT count(*)::text AS value FROM users WHERE email = 'client.isolation@example.com'"), 0);
    assert.equal(await count(app, "SELECT count(*)::text AS value FROM candidates"), beforeCandidates);
    await seed({
      connectionString: applicationUrl,
      nodeEnv: "test",
      passwords: { SEED_CLIENT_PASSWORD: "different-integration-password" },
      credentialsFile: null,
    });
    const afterHash = await text(app, "SELECT password_hash AS value FROM users WHERE email = $1", ["client.demo@example.com"]);
    assert.equal(afterHash, beforeHash);
    assert.equal(await verifyPassword("different-integration-password", afterHash), false);
  } finally {
    await app.end();
  }

  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, migrationsDirectory);
  const credentialsDir = await mkdtemp(path.join(tmpdir(), "hair-reality-seed-"));
  const credentialsFile = path.join(credentialsDir, "seed-credentials.txt");
  const generated = await seed({
    connectionString: testUrl,
    nodeEnv: "test",
    includeIsolation: true,
    credentialsFile,
  });
  assert.equal(generated.createdUsers, 4);
  assert.equal(generated.wroteCredentials, true);
  const credentialText = await readFile(credentialsFile, "utf8");
  const lines = credentialText.trim().split(/\n/);
  assert.equal(lines.length, 4);
  const clientPassword = passwordFrom(lines, "client.demo@example.com");
  assert.equal(lines.some((line) => line.startsWith("client.isolation@example.com ")), true);
  const credentialSize = (await stat(credentialsFile)).size;

  const testDb = new Client({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
  await testDb.connect();
  try {
    const stored = await text(testDb, "SELECT password_hash AS value FROM users WHERE email = $1", ["client.demo@example.com"]);
    assert.equal(await verifyPassword(clientPassword, stored), true);
    const repeated = await seed({
      connectionString: testUrl,
      nodeEnv: "test",
      includeIsolation: true,
      passwords: { SEED_CLIENT_PASSWORD: "different-integration-password" },
      credentialsFile,
    });
    assert.equal(repeated.createdUsers, 0);
    assert.equal(repeated.wroteCredentials, false);
    assert.equal((await stat(credentialsFile)).size, credentialSize);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM users"), 4);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM salons"), 2);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM salon_memberships"), 2);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM demo_slots"), 3);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM provider_budget_accounts"), 4);
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM candidates"), 0);
    assert.equal(await text(testDb, "SELECT password_hash AS value FROM users WHERE email = $1", ["client.demo@example.com"]), stored);
    assert.equal(await verifyPassword("different-integration-password", stored), false);
    await testDb.query("UPDATE provider_budget_accounts SET reserved_units = 9 WHERE provider = 'youcam' AND phase = 'development'");
    await seed({ connectionString: testUrl, nodeEnv: "test", includeIsolation: true, credentialsFile: null });
    assert.equal(await text(
      testDb,
      "SELECT reserved_units::text AS value FROM provider_budget_accounts WHERE provider = 'youcam' AND phase = 'development'",
    ), "9");
    assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM users"), 4);

    await expectSqlState(testDb, "23505", async () => {
      const ids = await baseGraph(testDb, "dup-revision");
      await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
    });
    await expectSqlState(testDb, "23505", async () => {
      const ids = await baseGraph(testDb, "dup-approval");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      await insertApproval(testDb, revisionId, ids.authorId, "client", HASH);
      await insertApproval(testDb, revisionId, ids.authorId, "client", HASH);
    });
    await expectSqlState(testDb, "P0001", async () => {
      const ids = await baseGraph(testDb, "bad-hash");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      await insertApproval(testDb, revisionId, ids.authorId, "client", OTHER_HASH);
    });
    await expectSqlState(testDb, "P0001", async () => {
      const firstIds = await baseGraph(testDb, "parent-a");
      const secondIds = await baseGraph(testDb, "parent-b");
      const parentId = await insertRevision(testDb, firstIds.consultationId, firstIds.authorId, 1, null);
      await insertRevision(testDb, secondIds.consultationId, secondIds.authorId, 1, parentId);
    });
    await expectSqlState(testDb, "P0001", async () => {
      const ids = await baseGraph(testDb, "immutable");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      await testDb.query("UPDATE plan_revisions SET snapshot = snapshot WHERE id = $1", [revisionId]);
    });
    await expectSqlState(testDb, "P0001", async () => {
      const ids = await baseGraph(testDb, "other-salon");
      const otherSalon = await insertSalon(testDb, "other-salon-slot");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      const foreignSlot = await insertSlot(testDb, otherSalon);
      await insertBooking(testDb, ids.consultationId, revisionId, foreignSlot, "book-other-salon", "confirmed");
    });
    await expectSqlState(testDb, "23505", async () => {
      const firstIds = await baseGraph(testDb, "slot-a");
      const secondIds = await baseGraph(testDb, "slot-b");
      const slotId = await insertSlot(testDb, firstIds.salonId);
      const firstRevision = await insertRevision(testDb, firstIds.consultationId, firstIds.authorId, 1, null);
      const secondRevision = await insertRevision(testDb, secondIds.consultationId, secondIds.authorId, 1, null);
      await testDb.query("UPDATE consultations SET salon_id = $2 WHERE id = $1", [secondIds.consultationId, firstIds.salonId]);
      await insertBooking(testDb, firstIds.consultationId, firstRevision, slotId, "book-slot-1", "confirmed");
      await insertBooking(testDb, secondIds.consultationId, secondRevision, slotId, "book-slot-2", "confirmed");
    });
    await expectSqlState(testDb, "23505", async () => {
      const ids = await baseGraph(testDb, "one-consultation");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      const firstSlot = await insertSlot(testDb, ids.salonId, "2026-12-02T09:00:00.000Z");
      const secondSlot = await insertSlot(testDb, ids.salonId, "2026-12-02T10:00:00.000Z");
      await insertBooking(testDb, ids.consultationId, revisionId, firstSlot, "consult-1", "confirmed");
      await insertBooking(testDb, ids.consultationId, revisionId, secondSlot, "consult-2", "confirmed");
    });
    await expectSqlState(testDb, "23505", async () => {
      const ids = await baseGraph(testDb, "idem");
      const revisionId = await insertRevision(testDb, ids.consultationId, ids.authorId, 1, null);
      const firstSlot = await insertSlot(testDb, ids.salonId, "2026-12-01T09:00:00.000Z");
      const secondSlot = await insertSlot(testDb, ids.salonId, "2026-12-01T10:00:00.000Z");
      await insertBooking(testDb, ids.consultationId, revisionId, firstSlot, "same-key", "cancelled");
      await insertBooking(testDb, ids.consultationId, revisionId, secondSlot, "same-key", "cancelled");
    });
    await expectSqlState(testDb, "23503", async () => {
      await testDb.query(
        `INSERT INTO assets (owner_user_id, consultation_id, role, storage_key, content_hash, width, height, mime_type)
         VALUES (gen_random_uuid(), gen_random_uuid(), 'current_front', 'missing', 'hash', 1, 1, 'image/jpeg')`,
      );
    });
    await expectSqlState(testDb, "23503", async () => {
      const ids = await baseGraph(testDb, "stylist-fk");
      const outsider = await insertUser(testDb, "outsider-stylist-fk@example.com");
      await testDb.query("UPDATE consultations SET assigned_stylist_user_id = $2 WHERE id = $1", [ids.consultationId, outsider]);
    });
    await expectSqlState(testDb, "P0001", async () => {
      const ids = await baseGraph(testDb, "deleted-job");
      await testDb.query("UPDATE consultations SET deleted_at = now() WHERE id = $1", [ids.consultationId]);
      await testDb.query(
        `INSERT INTO provider_jobs (consultation_id, provider, operation, input_fingerprint, cost_phase, state)
         VALUES ($1, 'youcam', 'preview', 'fingerprint', 'development', 'QUEUED')`,
        [ids.consultationId],
      );
    });
    await expectSqlState(testDb, "23514", async () => {
      const salonId = await insertSalon(testDb, "catalogue-check");
      await testDb.query(
        `INSERT INTO candidates (salon_id, service_kind, title, provenance, provider_reference)
         VALUES ($1, 'haircut', 'Invented', 'fixture', 'template-not-verified')`,
        [salonId],
      );
    });
    await expectSqlState(testDb, "23505", async () => {
      const ids = await baseGraph(testDb, "actor-idem");
      await testDb.query(
        `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash)
         VALUES ($1, 'book', 'key-1', 'hash')`,
        [ids.authorId],
      );
      await testDb.query(
        `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash)
         VALUES ($1, 'book', 'key-1', 'hash')`,
        [ids.authorId],
      );
    });
    await withRollback(testDb, async () => {
      const ids = await baseGraph(testDb, "ledger");
      const job = await testDb.query<{ id: string }>(
        `INSERT INTO provider_jobs (consultation_id, provider, operation, input_fingerprint, cost_phase, state)
         VALUES ($1, 'openai', 'interpret', 'fingerprint', 'development', 'QUEUED') RETURNING id`,
        [ids.consultationId],
      );
      const jobId = job.rows[0]?.id;
      assert.ok(jobId);
      await testDb.query(
        `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, settlement_state)
         VALUES ($1, 'openai', 'development', 'usd_micro', 1000, 'reserved')`,
        [jobId],
      );
      await testDb.query("DELETE FROM provider_jobs WHERE id = $1", [jobId]);
      assert.equal(await count(testDb, "SELECT count(*)::text AS value FROM usage_ledger"), 1);
      assert.equal(await text(testDb, "SELECT coalesce(job_id::text, 'null') AS value FROM usage_ledger"), "null");
    });
  } finally {
    await testDb.end();
  }

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    const readyConfig = loadConfig({
      ...process.env,
      NODE_ENV: "development",
      PROVIDER_MODE: "fixture",
      DATABASE_URL: applicationUrl,
    });
    const readyServer = await listen(createApp(readyConfig));
    try {
      const health = await fetch(`${readyServer.base}/api/v1/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { data: { status: "ok" } });
      const ready = await fetch(`${readyServer.base}/api/v1/ready`);
      assert.equal(ready.status, 200);
      assert.deepEqual(await ready.json(), { data: { status: "ready" } });
    } finally {
      await readyServer.close();
    }

    const downConfig = loadConfig({
      ...process.env,
      NODE_ENV: "development",
      PROVIDER_MODE: "fixture",
      DATABASE_URL: "postgres://hair_reality:invalid@127.0.0.1:1/hair_reality",
    });
    const downServer = await listen(createApp(downConfig));
    try {
      const downHealth = await fetch(`${downServer.base}/api/v1/health`);
      assert.equal(downHealth.status, 200);
      const downReady = await fetch(`${downServer.base}/api/v1/ready`);
      const body = await downReady.json() as { error: { code: string } };
      assert.equal(downReady.status, 503);
      assert.equal(body.error.code, "dependency_unavailable");
      assert.equal(JSON.stringify(body).includes("postgres://"), false);
    } finally {
      await downServer.close();
    }
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.some((line) => line.includes("postgres://") || line.includes("replace-with-local-password")), false);
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for database integration checks`);
  return value;
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

function emptyQueryOverride(connectionString: string, name: string, decoy: string): string {
  const url = new URL(connectionString);
  url.searchParams.append(name, decoy);
  url.searchParams.append(name, "");
  return url.toString();
}

function authorityPortOverride(connectionString: string): string {
  const url = new URL(connectionString);
  const port = url.port || "5432";
  url.port = "1";
  url.searchParams.set("port", port);
  return url.toString();
}

function equivalentApplicationUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  url.protocol = "postgresql:";
  url.username = "other-user";
  url.password = "different-password";
  url.hostname = url.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1";
  url.pathname = `/${database.toUpperCase()}`;
  url.search = "sslmode=disable";
  return url.toString();
}

function passwordFrom(lines: string[], email: string): string {
  const line = lines.find((candidate) => candidate.startsWith(`${email} `));
  if (!line) throw new Error(`Missing generated credential for ${email}`);
  return line.slice(email.length + 1);
}

async function count(client: pg.Client, sqlText: string): Promise<number> {
  return Number(await text(client, sqlText));
}

async function text(client: pg.Client, sqlText: string, params: unknown[] = []): Promise<string> {
  const result = await client.query<{ value: string }>(sqlText, params);
  const value = result.rows[0]?.value;
  if (value === undefined) throw new Error("Expected a database value");
  return value;
}

async function withRollback(client: pg.Client, body: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await body();
  } finally {
    await client.query("ROLLBACK");
  }
}

async function expectSqlState(client: pg.Client, expected: string, body: () => Promise<void>): Promise<void> {
  await withRollback(client, async () => {
    try {
      await body();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      assert.equal(code, expected);
      return;
    }
    assert.fail(`Expected SQLSTATE ${expected}`);
  });
}

async function baseGraph(client: pg.Client, suffix: string): Promise<{ consultationId: string; authorId: string; salonId: string }> {
  const authorId = await insertUser(client, `author-${suffix}@example.com`);
  const salonId = await insertSalon(client, `salon-${suffix}`);
  const consultation = await client.query<{ id: string }>(
    "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id",
    [authorId, salonId],
  );
  const consultationId = consultation.rows[0]?.id;
  if (!consultationId) throw new Error("Consultation insert failed");
  return { consultationId, authorId, salonId };
}

async function insertUser(client: pg.Client, email: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'Constraint User', $2) RETURNING id",
    [email, PASSWORD_HASH],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("User insert failed");
  return id;
}

async function insertSalon(client: pg.Client, slug: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO salons (slug, name, timezone) VALUES ($1, 'Constraint Salon', 'Europe/Warsaw') RETURNING id",
    [slug],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Salon insert failed");
  return id;
}

async function insertRevision(
  client: pg.Client,
  consultationId: string,
  authorId: string,
  revisionNumber: number,
  parentId: string | null,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO plan_revisions (consultation_id, revision_number, author_user_id, parent_revision_id, snapshot, snapshot_hash)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5) RETURNING id`,
    [consultationId, revisionNumber, authorId, parentId, HASH],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Revision insert failed");
  return id;
}

async function insertApproval(client: pg.Client, revisionId: string, actorId: string, party: string, snapshotHash: string): Promise<void> {
  await client.query(
    "INSERT INTO approvals (revision_id, actor_user_id, party, snapshot_hash) VALUES ($1, $2, $3, $4)",
    [revisionId, actorId, party, snapshotHash],
  );
}

async function insertSlot(client: pg.Client, salonId: string, startsAt = "2026-12-01T09:00:00.000Z"): Promise<string> {
  const result = await client.query<{ id: string }>(
    "INSERT INTO demo_slots (salon_id, starts_at, ends_at) VALUES ($1, $2, $2::timestamptz + interval '45 minutes') RETURNING id",
    [salonId, startsAt],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Slot insert failed");
  return id;
}

async function insertBooking(
  client: pg.Client,
  consultationId: string,
  revisionId: string,
  slotId: string,
  idempotencyKey: string,
  status: string,
): Promise<void> {
  await client.query(
    `INSERT INTO bookings (consultation_id, revision_id, demo_slot_id, idempotency_key, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [consultationId, revisionId, slotId, idempotencyKey, status],
  );
}

function listen(app: ReturnType<typeof createApp>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP port"));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
        }),
      });
    });
  });
}
