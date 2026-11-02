import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { PrivateStorage } from "../../assets/storage.js";
import { attachDerivedAsset } from "../../assets/records.js";
import { releaseReservation, finishReservation, holdUnresolvedUsage } from "../../jobs/accounting.js";
import { CAPABILITY_CONTRACTS, isYouCamCapability, singleYouCamCapability, storageRolesFor, storedRoleForProviderSlot, YOUCAM_CONTRACT_VERSION, type YouCamCapability } from "./contract.js";
import { recordOwnedPreview } from "../../previews/records.js";
import { YouCamClient, retakeInstruction, settlementFromHistory, type PublicEvidence } from "./client.js";

export async function advanceYouCamJob(options: {
  pool: Pool;
  storage: PrivateStorage;
  client: YouCamClient;
  jobId: string;
  fencingToken: number;
  owner: string;
  now: Date;
  retentionDays: number;
}): Promise<void> {
  const current = await options.pool.query<{
    state: string;
    provider_task_id: string | null;
    configuration_fingerprint: string;
    created_at: Date;
    source_asset_ids: string[];
    max_cost: string;
  }>(
    `SELECT state, provider_task_id, configuration_fingerprint, created_at, source_asset_ids, max_cost
     FROM provider_jobs
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
    [options.jobId, options.fencingToken, options.owner],
  );
  const job = current.rows[0];
  if (!job || job.state === "SUBMISSION_UNCERTAIN") return;
  const capability = singleYouCamCapability(job.configuration_fingerprint);
  if (!capability || !isYouCamCapability(capability)) {
    await failClosed(options, "UNSUPPORTED_CONFIGURATION");
    return;
  }
    if (job.provider_task_id) {
    const polled = await options.client.run({
      capability,
      photos: [],
      controls: {},
      providerTaskId: job.provider_task_id,
      now: options.now,
      submittedAt: job.created_at,
    });
    if (polled.kind === "succeeded") await persistResult(options, job, capability, polled);
    else if (polled.kind === "failed") {
      const held = await holdUnresolvedUsage(options.pool, options.jobId, options.fencingToken, options.owner, "FAILED", polled.code);
      const instruction = polled.providerError ? retakeInstruction(polled.providerError, storageRolesFor(capability)) : null;
      if (held && instruction) await recordRetake(options.pool, options.jobId, instruction, options.now);
    }
    return;
  }
  const photos = await loadPhotos(options.pool, options.storage, capability, job.configuration_fingerprint, job.source_asset_ids);
  if (!photos) {
    await failClosed(options, "INVALID_PHOTO");
    return;
  }
  const submitting = await options.pool.query(
    `UPDATE provider_jobs SET state = 'SUBMITTING', updated_at = now()
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL
       AND state IN ('CLAIMED', 'UPLOADING', 'QUEUED')`,
    [options.jobId, options.fencingToken, options.owner],
  );
  if ((submitting.rowCount ?? 0) !== 1) return;
  const submitted = await options.client.run({
    capability,
    photos,
    controls: controlsFrom(job.configuration_fingerprint),
    providerTaskId: null,
    now: options.now,
    submittedAt: null,
  });
  if (submitted.kind === "uncertain") {
    await options.pool.query(
      `UPDATE provider_jobs
       SET state = 'SUBMISSION_UNCERTAIN', lease_owner = NULL, lease_expires_at = NULL, error_code = 'SUBMISSION_UNCERTAIN', updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND provider_task_id IS NULL`,
      [options.jobId, options.fencingToken],
    );
    await options.pool.query(
      `UPDATE usage_ledger SET settlement_state = 'uncertain'
       WHERE job_id = $1 AND settlement_state = 'reserved'`,
      [options.jobId],
    );
    return;
  }
  if (submitted.kind === "accepted") {
    await options.pool.query(
      `UPDATE provider_jobs SET provider_task_id = $4, state = 'RUNNING', updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL`,
      [options.jobId, options.fencingToken, options.owner, submitted.taskId],
    );
    return;
  }
  if (submitted.kind === "failed") await failClosed(options, submitted.code);
}

async function persistResult(
  options: {
    pool: Pool;
    storage: PrivateStorage;
    client: YouCamClient;
    jobId: string;
    fencingToken: number;
    owner: string;
    retentionDays: number;
  },
  job: { source_asset_ids: string[]; max_cost: string; provider_task_id: string | null },
  capability: YouCamCapability,
  polled: { evidence: PublicEvidence; downloadUrl: string | null },
): Promise<void> {
  let values = polled.evidence.values;
  if (polled.downloadUrl) {
    const image = await options.client.readResult(polled.downloadUrl);
    const source = job.source_asset_ids[0];
    if (!image || !source) {
      await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, Number(job.max_cost), "FAILED", "PROVIDER_UNAVAILABLE");
      return;
    }
    const consultation = await options.pool.query<{ consultation_id: string }>(
      "SELECT consultation_id FROM provider_jobs WHERE id = $1",
      [options.jobId],
    );
    const consultationId = consultation.rows[0]?.consultation_id;
    if (!consultationId) return;
    const attached = await attachDerivedAsset({
      pool: options.pool,
      storage: options.storage,
      consultationId,
      sourceAssetId: source,
      file: image,
      retentionDays: options.retentionDays,
    });
    if (!attached.ok) {
      await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, Number(job.max_cost), "FAILED", "result_discarded");
      return;
    }
    const preview = await options.pool.query<{
      operation: string;
      consultation_service_id: string | null;
      service_input_version: number | null;
    }>(
      `SELECT operation, consultation_service_id, service_input_version
       FROM provider_jobs WHERE id = $1`,
      [options.jobId],
    );
    const previewJob = preview.rows[0];
    if (previewJob?.operation === "preview" && previewJob.consultation_service_id) {
      const recorded = await recordOwnedPreview(options.pool, {
        jobId: options.jobId,
        fencingToken: options.fencingToken,
        owner: options.owner,
        consultationServiceId: previewJob.consultation_service_id,
        sourceAssetId: source,
        resultAssetId: attached.assetId,
        serviceInputVersion: previewJob.service_input_version,
        freshness: "current",
        providerVersion: YOUCAM_CONTRACT_VERSION,
      });
      if (!recorded) {
        await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, Number(job.max_cost), "FAILED", "result_discarded");
        return;
      }
    }
    values = { stored: true };
  }
  await options.pool.query(
    `INSERT INTO analysis_results (
       consultation_id, capability, input_assets, provider, provider_version, source, values, uncertainty, freshness, observed_at
     )
     SELECT consultation_id, $2, to_jsonb($3::uuid[]), 'youcam', $4, 'youcam', $5::jsonb, $6, 'current', now()
     FROM provider_jobs WHERE id = $1`,
    [
      options.jobId,
      capability,
      job.source_asset_ids,
      YOUCAM_CONTRACT_VERSION,
      JSON.stringify(values),
      polled.evidence.unknown.length > 0 ? polled.evidence.unknown.join(",") : null,
    ],
  );
  await settleYouCamSuccess(options, job);
}

async function settleYouCamSuccess(
  options: {
    pool: Pool;
    client: YouCamClient;
    jobId: string;
    fencingToken: number;
    owner: string;
  },
  job: { max_cost: string; provider_task_id: string | null },
): Promise<void> {
  const history = await options.client.listUsage();
  const decision = settlementFromHistory(job.provider_task_id, history);
  if (decision.kind === "billed") {
    await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, decision.units, "SUCCEEDED", null);
    return;
  }
  if (decision.kind === "not_billed") {
    await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, 0, "SUCCEEDED", null);
    return;
  }
  if (decision.kind === "unresolved") {
    await holdUnresolvedUsage(options.pool, options.jobId, options.fencingToken, options.owner, "SUCCEEDED", "reconciliation_unresolved");
    return;
  }
  await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, Number(job.max_cost), "SUCCEEDED", null);
}

async function recordRetake(pool: Pool, jobId: string, instruction: string, now: Date): Promise<void> {
  const consultation = await pool.query<{ consultation_id: string }>(
    "SELECT consultation_id FROM provider_jobs WHERE id = $1",
    [jobId],
  );
  const consultationId = consultation.rows[0]?.consultation_id;
  if (!consultationId) return;
  await pool.query(
    `INSERT INTO audit_events (id, actor_user_id, entity_type, entity_id, event_name, metadata, occurred_at)
     VALUES ($1, NULL, 'provider_job', $2, 'provider.retake', $3, $4)`,
    [randomUUID(), jobId, JSON.stringify({
      jobId,
      consultationId,
      instruction,
    }), now],
  );
}

async function failClosed(
  options: { pool: Pool; jobId: string; fencingToken: number; owner: string },
  code: string,
): Promise<void> {
  const client = await options.pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT 1 FROM provider_jobs
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL
         AND state IN ('CLAIMED', 'UPLOADING', 'SUBMITTING', 'QUEUED')`,
      [options.jobId, options.fencingToken, options.owner],
    );
    if ((owned.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await releaseReservation(client, options.jobId);
    await client.query(
      `UPDATE provider_jobs SET state = 'FAILED', error_code = $4, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
      [options.jobId, options.fencingToken, options.owner, code],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function loadPhotos(
  pool: Pool,
  storage: PrivateStorage,
  capability: YouCamCapability,
  configuration: string,
  sourceAssetIds: readonly string[],
): Promise<{ role: string; bytes: Buffer }[] | null> {
  const expected = CAPABILITY_CONTRACTS[capability].photos;
  const views = explicitViews(configuration);
  const rows = await pool.query<{ id: string; role: string; storage_key: string }>(
    `SELECT id, role, storage_key FROM assets
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [sourceAssetIds],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const photos: { role: string; bytes: Buffer }[] = [];
  for (const role of expected) {
    const stored = storedRoleForProviderSlot(capability, role);
    const assetId = views?.[role] ?? rows.rows.find((row) => row.role === stored)?.id;
    if (!assetId || !stored) return null;
    const asset = byId.get(assetId);
    if (!asset || asset.role !== stored) return null;
    const bytes = await readKey(storage, asset.storage_key);
    photos.push({ role, bytes });
  }
  return photos;
}

function explicitViews(configuration: string): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(configuration);
    if (typeof parsed !== "object" || parsed === null || !("views" in parsed)) return null;
    const views = parsed.views;
    if (typeof views !== "object" || views === null) return null;
    const result: Record<string, string> = {};
    for (const [role, id] of Object.entries(views)) {
      if (typeof id === "string") result[role] = id;
    }
    return result;
  } catch {
    return null;
  }
}

function controlsFrom(configuration: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(configuration);
    if (typeof parsed !== "object" || parsed === null || !("controls" in parsed)) return {};
    const controls: unknown = parsed.controls;
    if (typeof controls !== "object" || controls === null || Array.isArray(controls)) return {};
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(controls)) result[key] = value;
    return result;
  } catch {
    return {};
  }
}

async function readKey(storage: PrivateStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.stream(key)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function syntheticStorageKey(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}
