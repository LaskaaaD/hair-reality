import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Actor } from "../auth/authorization.js";
import type { DeletionAcknowledgement, DeletionJournal } from "./journal.js";
import { JournalUnavailableError } from "./journal.js";
import type { PrivateStorage } from "./storage.js";
import { loadConsultation, salonMember } from "./access.js";

export type DeletionView = {
  operationId: string;
  status: "pending" | "completed";
  scope: "asset" | "consultation";
  retained: "textual_plan" | "accounting_only";
  currentVersion: number;
  message: string;
};

export type DeletionFailure = {
  ok: false;
  status: 403 | 404 | 409;
  code: "forbidden" | "not_found" | "stale_version";
  message: string;
  currentVersion?: number;
};

type Receipt = {
  operation_id: string;
  resource_id: string;
  scope: "asset" | "consultation";
  status: "pending" | "completed";
  journal_sequence: string | null;
  journal_checksum: string | null;
  requested_at: Date;
};

type AssetRow = {
  id: string;
  consultation_id: string;
  deleted_at: Date | null;
  client_user_id: string;
  salon_id: string;
  version: number;
  consultation_deleted_at: Date | null;
};

export async function deleteOwnedAsset(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  actor: Actor;
  assetId: string;
  expectedVersion: number;
  now: Date;
}): Promise<{ ok: true; deletion: DeletionView } | DeletionFailure> {
  const asset = await loadAsset(options.pool, options.assetId);
  if (!asset) return missing();
  const allowed = await ownerGate(options.pool, options.actor, asset);
  if (!allowed.ok) return allowed;
  const existing = await latestReceipt(options.pool, asset.id, "asset");
  if (existing) return finish(options, existing, asset.consultation_id);
  if (asset.deleted_at || asset.consultation_deleted_at) return missing();
  if (asset.version !== options.expectedVersion) return stale(asset.version);
  const created = await tombstoneAsset(options.pool, asset, options.expectedVersion, options.now);
  if (created === "stale" || created === "missing") return recoverAsset(options, asset, created);
  return finish(options, created, asset.consultation_id);
}

export async function deleteExpiredAsset(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  assetId: string;
  now: Date;
}): Promise<{ ok: true; deletion: DeletionView } | DeletionFailure> {
  const asset = await loadAsset(options.pool, options.assetId);
  if (!asset || asset.consultation_deleted_at) return missing();
  const existing = await latestReceipt(options.pool, asset.id, "asset");
  if (existing) return finish(options, existing, asset.consultation_id);
  if (asset.deleted_at) return missing();
  const created = await tombstoneAsset(options.pool, asset, asset.version, options.now);
  if (created === "stale" || created === "missing") return recoverAsset(options, asset, created);
  return finish(options, created, asset.consultation_id);
}

export async function deleteOwnedConsultation(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  actor: Actor;
  consultationId: string;
  expectedVersion: number;
  now: Date;
}): Promise<{ ok: true; deletion: DeletionView } | DeletionFailure> {
  const consultation = await loadConsultation(options.pool, options.consultationId);
  if (!consultation) return missing();
  const owns = consultation.clientUserId === options.actor.userId;
  if (!owns) {
    const member = await salonMember(options.pool, options.actor.userId, consultation.salonId);
    return member
      ? { ok: false, status: 403, code: "forbidden", message: "You cannot delete this consultation." }
      : missing();
  }
  const existing = await latestReceipt(options.pool, consultation.id, "consultation");
  if (existing) return finish(options, existing, consultation.id);
  if (consultation.deletedAt) return missing();
  if (consultation.version !== options.expectedVersion) return stale(consultation.version);
  const created = await tombstoneConsultation(options.pool, consultation.id, options.actor.userId, options.expectedVersion, options.now);
  if (created === "stale") return stale(consultation.version);
  if (created === "missing") return missing();
  return finish(options, created, consultation.id);
}

export async function expireAssets(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  now: Date;
}): Promise<{ completed: number; pending: number }> {
  const due = await options.pool.query<{ id: string }>(
    `SELECT assets.id
     FROM assets
     JOIN consultations ON consultations.id = assets.consultation_id
     WHERE assets.deleted_at IS NULL
       AND assets.expires_at <= $1
       AND consultations.deleted_at IS NULL`,
    [options.now],
  );
  let completed = 0;
  let pending = 0;
  for (const row of due.rows) {
    const result = await deleteExpiredAsset({ ...options, assetId: row.id });
    if (!result.ok) continue;
    if (result.deletion.status === "completed") completed += 1;
    else pending += 1;
  }
  return { completed, pending };
}

async function finish(
  options: { pool: Pool; storage: PrivateStorage; journal: DeletionJournal; now: Date },
  receipt: Receipt,
  consultationId: string,
): Promise<{ ok: true; deletion: DeletionView }> {
  let current = receipt;
  if (current.status === "pending") {
    const acknowledged = await acknowledge(options.journal, current);
    if (acknowledged) {
      await options.pool.query(
        `UPDATE deletion_receipts
         SET journal_sequence = $2, journal_checksum = $3
         WHERE operation_id = $1 AND status = 'pending'`,
        [current.operation_id, acknowledged.sequence, acknowledged.checksum],
      );
      const purged = await purge(options.pool, options.storage, current, consultationId, options.now);
      if (purged) {
        await options.pool.query(
          `UPDATE deletion_receipts
           SET status = 'completed', completed_at = $2
           WHERE operation_id = $1 AND status = 'pending' AND journal_sequence IS NOT NULL`,
          [current.operation_id, options.now],
        );
      }
    } else {
      console.error("deletion_journal_pending");
    }
    const reloaded = await latestReceipt(options.pool, current.resource_id, current.scope);
    if (reloaded) current = reloaded;
  }
  const version = await options.pool.query<{ version: number }>(
    "SELECT version FROM consultations WHERE id = $1",
    [consultationId],
  );
  return { ok: true, deletion: view(current, Number(version.rows[0]?.version ?? 1)) };
}

async function acknowledge(journal: DeletionJournal, receipt: Receipt): Promise<DeletionAcknowledgement | null> {
  try {
    return await journal.append({
      operationId: receipt.operation_id,
      resourceId: receipt.resource_id,
      scope: receipt.scope,
      timestamp: new Date(receipt.requested_at).toISOString(),
    });
  } catch (error) {
    if (error instanceof JournalUnavailableError) return null;
    console.error("deletion_journal_pending");
    return null;
  }
}

async function purge(pool: Pool, storage: PrivateStorage, receipt: Receipt, consultationId: string, now: Date): Promise<boolean> {
  try {
    const keys = receipt.scope === "asset"
      ? await purgeAssetRecords(pool, consultationId, receipt.resource_id)
      : await purgeConsultationRecords(pool, consultationId, now);
    for (const key of keys) await storage.remove(key);
    return true;
  } catch {
    console.error("asset_cleanup_failed");
    return false;
  }
}

export async function replayDeletionIntent(
  pool: Pool,
  storage: PrivateStorage,
  intent: { resourceId: string; scope: "asset" | "consultation" },
  now: Date,
): Promise<void> {
  if (intent.scope === "consultation") {
    await pool.query(
      "UPDATE consultations SET deleted_at = COALESCE(deleted_at, $2) WHERE id = $1",
      [intent.resourceId, now],
    );
    const keys = await purgeConsultationRecords(pool, intent.resourceId, now);
    for (const key of keys) await storage.remove(key);
    return;
  }
  const found = await pool.query<{ consultation_id: string }>(
    "SELECT consultation_id FROM assets WHERE id = $1",
    [intent.resourceId],
  );
  const consultationId = found.rows[0]?.consultation_id;
  if (!consultationId) return;
  await pool.query(
    "UPDATE assets SET deleted_at = COALESCE(deleted_at, $2) WHERE id = $1",
    [intent.resourceId, now],
  );
  const keys = await purgeAssetRecords(pool, consultationId, intent.resourceId);
  for (const key of keys) await storage.remove(key);
}

async function purgeAssetRecords(pool: Pool, consultationId: string, assetId: string): Promise<string[]> {
  return transaction(pool, async (client) => {
    const ids = await relatedAssetIds(client, consultationId, [assetId]);
    await client.query(
      `DELETE FROM analysis_results
       WHERE consultation_id = $1
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(input_assets) = 'array' THEN input_assets ELSE '[]'::jsonb END
           ) AS element
           WHERE element->>'id' = ANY($2::text[])
         )`,
      [consultationId, ids],
    );
    await client.query(
      `DELETE FROM previews
       WHERE source_asset_id = ANY($1::uuid[]) OR result_asset_id = ANY($1::uuid[])`,
      [ids],
    );
    const keys = await client.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return keys.rows.map((row) => row.storage_key);
  });
}

async function purgeConsultationRecords(pool: Pool, consultationId: string, now: Date): Promise<string[]> {
  return transaction(pool, async (client) => {
    await client.query("UPDATE consultations SET current_revision_id = NULL WHERE id = $1", [consultationId]);
    await client.query(
      `DELETE FROM approvals
       WHERE revision_id IN (SELECT id FROM plan_revisions WHERE consultation_id = $1)`,
      [consultationId],
    );
    await client.query("DELETE FROM change_requests WHERE consultation_id = $1", [consultationId]);
    await client.query("DELETE FROM bookings WHERE consultation_id = $1", [consultationId]);
    await client.query("DELETE FROM discussion_messages WHERE consultation_id = $1", [consultationId]);
    await client.query("DELETE FROM hair_histories WHERE consultation_id = $1", [consultationId]);
    await client.query("DELETE FROM preferences WHERE consultation_id = $1", [consultationId]);
    await client.query(
      `DELETE FROM reality_assessments
       WHERE consultation_service_id IN (SELECT id FROM consultation_services WHERE consultation_id = $1)`,
      [consultationId],
    );
    await client.query(
      `DELETE FROM previews
       WHERE consultation_service_id IN (SELECT id FROM consultation_services WHERE consultation_id = $1)`,
      [consultationId],
    );
    await client.query(
      `DELETE FROM targets
       WHERE consultation_service_id IN (SELECT id FROM consultation_services WHERE consultation_id = $1)`,
      [consultationId],
    );
    await client.query("DELETE FROM analysis_results WHERE consultation_id = $1", [consultationId]);
    await client.query(
      `DELETE FROM demo_asset_retentions
       WHERE asset_id IN (SELECT id FROM assets WHERE consultation_id = $1)`,
      [consultationId],
    );
    await client.query("UPDATE assets SET consent_id = NULL, deleted_at = COALESCE(deleted_at, $2) WHERE consultation_id = $1", [consultationId, now]);
    await client.query("DELETE FROM consents WHERE consultation_id = $1", [consultationId]);
    await deletePlanRevisions(client, consultationId);
    const keys = await client.query<{ storage_key: string }>(
      "SELECT storage_key FROM assets WHERE consultation_id = $1",
      [consultationId],
    );
    return keys.rows.map((row) => row.storage_key);
  });
}

async function tombstoneAsset(
  pool: Pool,
  asset: AssetRow,
  expectedVersion: number,
  now: Date,
): Promise<Receipt | "stale" | "missing"> {
  return transaction(pool, async (client) => {
    const locked = await client.query<{ version: number; deleted_at: Date | null }>(
      `SELECT version, deleted_at FROM consultations WHERE id = $1 AND client_user_id = $2 FOR UPDATE`,
      [asset.consultation_id, asset.client_user_id],
    );
    const row = locked.rows[0];
    if (!row || row.deleted_at) return "missing";
    if (row.version !== expectedVersion) return "stale";
    const updated = await client.query(
      `UPDATE consultations SET version = version + 1
       WHERE id = $1 AND version = $2 AND deleted_at IS NULL`,
      [asset.consultation_id, expectedVersion],
    );
    if (updated.rowCount !== 1) return "stale";
    const related = await relatedAssetIds(client, asset.consultation_id, [asset.id]);
    await client.query(
      `UPDATE assets SET deleted_at = $2
       WHERE deleted_at IS NULL AND id = ANY($1::uuid[])`,
      [related, now],
    );
    return insertReceipt(client, asset.id, "asset", now);
  });
}

async function tombstoneConsultation(
  pool: Pool,
  consultationId: string,
  actorId: string,
  expectedVersion: number,
  now: Date,
): Promise<Receipt | "stale" | "missing"> {
  return transaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE consultations
       SET deleted_at = $4, version = version + 1
       WHERE id = $1 AND client_user_id = $2 AND version = $3 AND deleted_at IS NULL`,
      [consultationId, actorId, expectedVersion, now],
    );
    if (updated.rowCount !== 1) {
      const current = await client.query<{ version: number; deleted_at: Date | null }>(
        "SELECT version, deleted_at FROM consultations WHERE id = $1 AND client_user_id = $2",
        [consultationId, actorId],
      );
      return current.rows[0]?.deleted_at ? "missing" : "stale";
    }
    await client.query(
      "UPDATE assets SET deleted_at = $2 WHERE consultation_id = $1 AND deleted_at IS NULL",
      [consultationId, now],
    );
    await client.query(
      `WITH cancelled AS (
         UPDATE provider_jobs
         SET state = 'CANCELLED', updated_at = $2
         WHERE consultation_id = $1
           AND provider_task_id IS NULL
           AND state IN ('QUEUED', 'CLAIMED', 'UPLOADING', 'SUBMITTING')
           AND NOT EXISTS (
             SELECT 1 FROM fixture_provider_tasks WHERE fixture_provider_tasks.job_id = provider_jobs.id
           )
         RETURNING id
       ),
       released AS (
         UPDATE usage_ledger
         SET settlement_state = 'released', actual_units = 0
         WHERE job_id IN (SELECT id FROM cancelled) AND settlement_state = 'reserved'
         RETURNING estimated_units, provider, phase, mode
       )
       UPDATE provider_budget_accounts AS accounts
       SET reserved_units = accounts.reserved_units - released_totals.units
       FROM (
         SELECT provider, phase, mode, SUM(estimated_units) AS units
         FROM released
         GROUP BY provider, phase, mode
       ) AS released_totals
       WHERE accounts.provider = released_totals.provider
         AND accounts.phase = released_totals.phase
         AND accounts.mode = released_totals.mode`,
      [consultationId, now],
    );
    return insertReceipt(client, consultationId, "consultation", now);
  });
}

async function insertReceipt(client: PoolClient, resourceId: string, scope: Receipt["scope"], now: Date): Promise<Receipt> {
  const inserted = await client.query<Receipt>(
    `INSERT INTO deletion_receipts (operation_id, resource_id, scope, status, requested_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING operation_id, resource_id, scope, status, journal_sequence, journal_checksum, requested_at`,
    [randomUUID(), resourceId, scope, now],
  );
  const receipt = inserted.rows[0];
  if (!receipt) throw new Error("deletion_receipt_missing");
  return receipt;
}

async function latestReceipt(pool: Pool, resourceId: string, scope: Receipt["scope"]): Promise<Receipt | null> {
  const result = await pool.query<Receipt>(
    `SELECT operation_id, resource_id, scope, status, journal_sequence, journal_checksum, requested_at
     FROM deletion_receipts
     WHERE resource_id = $1 AND scope = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [resourceId, scope],
  );
  return result.rows[0] ?? null;
}

async function loadAsset(pool: Pool, assetId: string): Promise<AssetRow | null> {
  const result = await pool.query<AssetRow>(
    `SELECT assets.id, assets.consultation_id, assets.deleted_at,
            consultations.client_user_id, consultations.salon_id, consultations.version,
            consultations.deleted_at AS consultation_deleted_at
     FROM assets
     JOIN consultations ON consultations.id = assets.consultation_id
     WHERE assets.id = $1`,
    [assetId],
  );
  return result.rows[0] ?? null;
}

async function recoverAsset(
  options: { pool: Pool; storage: PrivateStorage; journal: DeletionJournal; now: Date },
  asset: AssetRow,
  outcome: "stale" | "missing",
): Promise<{ ok: true; deletion: DeletionView } | DeletionFailure> {
  const existing = await latestReceipt(options.pool, asset.id, "asset");
  if (existing) return finish(options, existing, asset.consultation_id);
  if (outcome === "missing") return missing();
  const current = await loadConsultation(options.pool, asset.consultation_id);
  return stale(current?.version ?? asset.version);
}

async function ownerGate(pool: Pool, actor: Actor, asset: AssetRow): Promise<{ ok: true } | DeletionFailure> {
  if (asset.client_user_id === actor.userId) return { ok: true };
  if (asset.deleted_at || asset.consultation_deleted_at) return missing();
  const member = await salonMember(pool, actor.userId, asset.salon_id);
  if (!member) return missing();
  return { ok: false, status: 403, code: "forbidden", message: "You cannot delete this photograph." };
}

async function relatedAssetIds(client: PoolClient, consultationId: string, roots: string[]): Promise<string[]> {
  const seen = new Set(roots);
  let frontier = [...roots];
  while (frontier.length > 0) {
    const result = await client.query<{ id: string | null }>(
      `SELECT id FROM assets
       WHERE consultation_id = $1 AND source_asset_id = ANY($2::uuid[])
       UNION
       SELECT assets.id FROM assets
       JOIN previews ON previews.result_asset_id = assets.id
       WHERE assets.consultation_id = $1
         AND previews.source_asset_id = ANY($2::uuid[])`,
      [consultationId, frontier],
    );
    frontier = [];
    for (const row of result.rows) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      frontier.push(row.id);
    }
  }
  return [...seen];
}

async function deletePlanRevisions(client: PoolClient, consultationId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const deleted = await client.query(
      `DELETE FROM plan_revisions
       WHERE consultation_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM plan_revisions AS child
           WHERE child.parent_revision_id = plan_revisions.id
         )`,
      [consultationId],
    );
    if ((deleted.rowCount ?? 0) === 0) return;
  }
  throw new Error("plan_revision_purge_incomplete");
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function view(receipt: Receipt, currentVersion: number): DeletionView {
  const retained = receipt.scope === "asset" ? "textual_plan" : "accounting_only";
  const message = receipt.status === "pending"
    ? receipt.scope === "asset"
      ? "Deletion is pending. Access to the photograph is already revoked. The written plan, history and messages remain."
      : "Deletion is pending. Access is already revoked."
    : receipt.scope === "asset"
      ? "The photograph and its derivatives were removed. The written plan, history and messages remain."
      : "The consultation's personal photographs, history, messages and plan text were removed. Accounting totals remain.";
  return {
    operationId: receipt.operation_id,
    status: receipt.status,
    scope: receipt.scope,
    retained,
    currentVersion,
    message,
  };
}

function missing(): DeletionFailure {
  return { ok: false, status: 404, code: "not_found", message: "That photograph or consultation is not available." };
}

function stale(currentVersion: number): DeletionFailure {
  return {
    ok: false,
    status: 409,
    code: "stale_version",
    message: "The consultation changed. Reload and try again.",
    currentVersion,
  };
}
