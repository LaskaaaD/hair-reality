import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import pg from "pg";
import { RemoteDeletionJournal } from "../../src/server/assets/journal.js";
import { startJournalReceiver } from "../../src/server/assets/journal-receiver.js";
import {
  RESTORE_DATABASE_NAME,
  dropRestoreDatabase,
  dumpPostgresDatabase,
  openIsolatedRestore,
  restoredAccessOpen,
} from "../../src/server/assets/local-backup.js";
import { manifestChecksum, type BackupManifest } from "../../src/server/assets/restore.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { hashPassword } from "../../src/server/db/passwords.js";

const { Pool, Client } = pg;

test("an isolated PostgreSQL and asset restore replays deletion before access", { timeout: 180_000 }, async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000 });
  const sourceDir = await mkdtemp(path.join(tmpdir(), "hr-backup-source-"));
  const backupDir = await mkdtemp(path.join(tmpdir(), "hr-backup-copy-"));
  const restoreDir = path.join(tmpdir(), `hr-backup-restore-${Date.now()}`);
  const dumpDir = await mkdtemp(path.join(tmpdir(), "hr-backup-dump-"));
  const journalDir = await mkdtemp(path.join(tmpdir(), "hr-backup-journal-"));
  const receiver = await startJournalReceiver(journalDir);
  const dumpFile = path.join(dumpDir, "database.dump");
  try {
    const passwordHash = await hashPassword("restore-password-12");
    const salon = await insertId(pool, "INSERT INTO salons (slug, name, timezone) VALUES ('restore-salon', 'Restore Salon', 'Europe/Warsaw') RETURNING id");
    const clientId = await insertId(pool, "INSERT INTO users (email, display_name, password_hash) VALUES ('restore.client@example.com', 'Restore Client', $1) RETURNING id", [passwordHash]);
    const keptConsultation = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [clientId, salon]);
    const removedConsultation = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [clientId, salon]);
    const storage = createPrivateStorage(sourceDir);
    const keptKey = hash("kept-photo");
    const removedKey = hash("removed-photo");
    await storage.write(keptKey, Buffer.from("kept-photo-bytes"));
    await storage.write(removedKey, Buffer.from("removed-photo-bytes"));
    const keptAsset = await insertAsset(pool, clientId, keptConsultation, keptKey);
    const removedAsset = await insertAsset(pool, clientId, removedConsultation, removedKey);
    const keptSnapshot = { note: "kept length" };
    const removedSnapshot = { note: "remove this personal plan" };
    const keptRevision = await insertRevision(pool, keptConsultation, clientId, keptSnapshot);
    const removedRevision = await insertRevision(pool, removedConsultation, clientId, removedSnapshot);
    await pool.query(
      "INSERT INTO approvals (revision_id, actor_user_id, party, snapshot_hash) VALUES ($1, $2, 'client', $3), ($4, $2, 'client', $5)",
      [keptRevision, clientId, hash(JSON.stringify(keptSnapshot)), removedRevision, hash(JSON.stringify(removedSnapshot))],
    );
    await pool.query(
      "INSERT INTO discussion_messages (consultation_id, author_user_id, body) VALUES ($1, $2, 'Keep this note.'), ($3, $2, 'Delete this personal message.')",
      [keptConsultation, clientId, removedConsultation],
    );

    const journal = new RemoteDeletionJournal(receiver.url);
    const checkpoint = await journal.append({
      operationId: "11111111-1111-4111-8111-111111111111",
      resourceId: "22222222-2222-4222-8222-222222222222",
      scope: "asset",
      timestamp: "2026-10-12T12:00:00.000Z",
    });
    const manifest: BackupManifest = {
      imageDigest: "sha256:local-restore",
      checkpointSequence: checkpoint.sequence,
      checkpointChecksum: checkpoint.checksum,
    };
    const signed = manifestChecksum(manifest);
    await dumpPostgresDatabase(testUrl, dumpFile);
    await cp(sourceDir, backupDir, { recursive: true, force: true });
    await journal.append({
      operationId: "33333333-3333-4333-8333-333333333333",
      resourceId: removedConsultation,
      scope: "consultation",
      timestamp: "2026-10-12T13:00:00.000Z",
    });
    await storage.remove(removedKey);
    const stored = await fetch(new URL("/journal", receiver.url)).then(async (response) => {
      assert.equal(response.status, 200);
      return await response.json() as { journalText: string | null; checkpoint: { sequence: number; checksum: string } | null };
    });

    let replayedWhileClosed = false;
    const opened = await openIsolatedRestore({
      applicationUrl,
      sourceUrl: testUrl,
      dumpFile,
      manifest,
      manifestChecksum: signed,
      journalText: stored.journalText,
      checkpoint: stored.checkpoint,
      assetBackupDir: backupDir,
      assetRestoreDir: restoreDir,
      beforeOpen: async (restored) => {
        assert.equal(await restoredAccessOpen(restoreDir), false);
        const restoredStorage = createPrivateStorage(restoreDir);
        assert.equal(await restoredStorage.exists(removedKey), false);
        assert.equal(await restoredStorage.exists(keptKey), true);
        const removedPlans = await restored.query("SELECT COUNT(*)::int AS count FROM plan_revisions WHERE consultation_id = $1", [removedConsultation]);
        const keptPlans = await restored.query<{ snapshot: { note: string } }>("SELECT snapshot FROM plan_revisions WHERE consultation_id = $1", [keptConsultation]);
        const removedMessages = await restored.query("SELECT COUNT(*)::int AS count FROM discussion_messages WHERE consultation_id = $1", [removedConsultation]);
        const keptMessages = await restored.query<{ body: string }>("SELECT body FROM discussion_messages WHERE consultation_id = $1", [keptConsultation]);
        const removedApprovals = await restored.query("SELECT COUNT(*)::int AS count FROM approvals WHERE revision_id = $1", [removedRevision]);
        const keptApprovals = await restored.query("SELECT COUNT(*)::int AS count FROM approvals WHERE revision_id = $1", [keptRevision]);
        const keptAssetRow = await restored.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM assets WHERE id = $1", [keptAsset]);
        const removedAssetRow = await restored.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM assets WHERE id = $1", [removedAsset]);
        assert.equal(removedPlans.rows[0]?.count, 0);
        assert.equal(keptPlans.rows[0]?.snapshot.note, "kept length");
        assert.equal(removedMessages.rows[0]?.count, 0);
        assert.equal(keptMessages.rows[0]?.body, "Keep this note.");
        assert.equal(removedApprovals.rows[0]?.count, 0);
        assert.equal(keptApprovals.rows[0]?.count, 1);
        assert.equal(keptAssetRow.rows[0]?.deleted_at, null);
        assert.ok(removedAssetRow.rows[0]?.deleted_at);
        replayedWhileClosed = true;
      },
    });
    assert.equal(opened.open, true);
    assert.equal(replayedWhileClosed, true);
    assert.equal(await restoredAccessOpen(restoreDir), true);

    const closed = await openIsolatedRestore({
      applicationUrl,
      sourceUrl: testUrl,
      dumpFile,
      manifest,
      manifestChecksum: signed,
      journalText: null,
      checkpoint: null,
      assetBackupDir: backupDir,
      assetRestoreDir: restoreDir,
    });
    assert.deepEqual(closed, { open: false, reason: "journal_missing" });
    assert.equal(await restoredAccessOpen(restoreDir), false);
    assert.equal(await databaseExists(testUrl), false);
  } finally {
    await receiver.close();
    await dropRestoreDatabase(testUrl).catch(() => undefined);
    await pool.end();
    await rm(sourceDir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
    await rm(restoreDir, { recursive: true, force: true });
    await rm(dumpDir, { recursive: true, force: true });
    await rm(journalDir, { recursive: true, force: true });
  }
});

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function insertId(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<string> {
  const result = await pool.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Expected an id");
  return id;
}

async function insertAsset(pool: pg.Pool, ownerId: string, consultationId: string, key: string): Promise<string> {
  return insertId(
    pool,
    `INSERT INTO assets (owner_user_id, consultation_id, role, storage_key, content_hash, width, height, mime_type)
     VALUES ($1, $2, 'current_front', $3, $3, 8, 8, 'image/png') RETURNING id`,
    [ownerId, consultationId, key],
  );
}

async function insertRevision(pool: pg.Pool, consultationId: string, authorId: string, snapshot: { note: string }): Promise<string> {
  return insertId(
    pool,
    `INSERT INTO plan_revisions (consultation_id, revision_number, author_user_id, snapshot, snapshot_hash)
     VALUES ($1, 1, $2, $3::jsonb, $4) RETURNING id`,
    [consultationId, authorId, JSON.stringify(snapshot), hash(JSON.stringify(snapshot))],
  );
}

async function databaseExists(connectionString: string): Promise<boolean> {
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [RESTORE_DATABASE_NAME]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await client.end();
  }
}
