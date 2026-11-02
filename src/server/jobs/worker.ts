import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { attachDerivedAsset } from "../assets/records.js";
import { externalProcessingAllowed } from "../assets/consent.js";
import type { PrivateStorage } from "../assets/storage.js";
import { releaseReservation, finishReservation, writeJobEvent } from "./accounting.js";
import { leaseDurationMs, nextPollDelayMs, renewDurationMs } from "./caps.js";
import { advanceOpenAIJob } from "../providers/openai/runner.js";
import type { OpenAIClient } from "../providers/openai/client.js";
import { advanceYouCamJob } from "../providers/youcam/runner.js";
import type { YouCamClient } from "../providers/youcam/client.js";
import { recordOwnedPreview } from "../previews/records.js";
import { fixtureInterpretationValues } from "./interpretation-request.js";
import { parseOpenAIRequest } from "../providers/openai/contract.js";
import { singleYouCamCapability } from "../providers/youcam/contract.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export type FixtureFault = "exit-after-task-id" | "ambiguous-exit" | "poll-fail" | null;

export type ClaimedJob = {
  id: string;
  consultationId: string;
  operation: string;
  state: string;
  fencingToken: number;
  providerTaskId: string | null;
  attempt: number;
  sourceAssetIds: string[];
  consultationServiceId: string | null;
  serviceInputVersion: number | null;
  maxCost: number;
  provider: string;
};

export async function claimNext(
  pool: Pool,
  owner: string,
  mode: AppConfig["providerMode"],
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaimedJob | null> {
  const leaseMs = leaseDurationMs(mode, env);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<{
      id: string;
      consultation_id: string;
      operation: string;
      state: string;
      fencing_token: string;
      provider_task_id: string | null;
      attempt: number;
      source_asset_ids: string[];
      consultation_service_id: string | null;
      service_input_version: number | null;
      max_cost: string;
      provider: string;
    }>(
      `UPDATE provider_jobs
       SET state = CASE
             WHEN state = 'SUBMITTING' AND provider_task_id IS NULL THEN 'SUBMISSION_UNCERTAIN'
             WHEN state = 'QUEUED' THEN 'CLAIMED'
             WHEN state IN ('CLAIMED', 'UPLOADING') THEN 'CLAIMED'
             ELSE 'RUNNING'
           END,
           lease_owner = CASE
             WHEN state = 'SUBMITTING' AND provider_task_id IS NULL THEN NULL
             ELSE $2
           END,
           lease_expires_at = CASE
             WHEN state = 'SUBMITTING' AND provider_task_id IS NULL THEN NULL
             ELSE $3::timestamptz
           END,
           fencing_token = fencing_token + 1,
           updated_at = $4::timestamptz
       WHERE id = (
         SELECT id FROM provider_jobs
         WHERE mode = $1
           AND (
             state = 'QUEUED'
             OR (
               state IN ('CLAIMED', 'UPLOADING', 'RUNNING', 'SUBMITTING')
               AND lease_expires_at <= $4::timestamptz
               AND (next_poll_at IS NULL OR next_poll_at <= $4::timestamptz)
             )
           )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, consultation_id, operation, state, fencing_token, provider_task_id, attempt,
                 source_asset_ids, consultation_service_id, service_input_version, max_cost, provider`,
      [mode, owner, new Date(now.getTime() + leaseMs), now],
    );
    const row = claimed.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    if (row.state === "SUBMISSION_UNCERTAIN") {
      await client.query(
        `UPDATE usage_ledger SET settlement_state = 'uncertain'
         WHERE job_id = $1 AND settlement_state = 'reserved'`,
        [row.id],
      );
      await writeJobEvent(client, null, row.consultation_id, null, row.id, now);
    }
    await client.query("COMMIT");
    return {
      id: row.id,
      consultationId: row.consultation_id,
      operation: row.operation,
      state: row.state,
      fencingToken: Number(row.fencing_token),
      providerTaskId: row.provider_task_id,
      attempt: row.attempt,
      sourceAssetIds: row.source_asset_ids ?? [],
      consultationServiceId: row.consultation_service_id,
      serviceInputVersion: row.service_input_version,
      maxCost: Number(row.max_cost),
      provider: row.provider,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function processClaimedJob(options: {
  pool: Pool;
  storage: PrivateStorage;
  config: AppConfig;
  job: ClaimedJob;
  owner: string;
  fault: FixtureFault;
  now: Date;
  youcam?: YouCamClient;
  openai?: OpenAIClient;
}): Promise<void> {
  if (options.job.state === "SUBMISSION_UNCERTAIN") return;
  if (
    options.config.providerMode === "live"
    && options.job.provider === "openai"
    && options.config.openaiLiveSubmission
    && options.openai
  ) {
    await advanceOpenAIJob({
      pool: options.pool,
      storage: options.storage,
      client: options.openai,
      jobId: options.job.id,
      fencingToken: options.job.fencingToken,
      owner: options.owner,
      now: options.now,
    });
    return;
  }
  if (options.config.providerMode === "live" && options.config.youcamLiveSubmission && options.youcam && options.job.provider !== "openai") {
    await advanceYouCamJob({
      pool: options.pool,
      storage: options.storage,
      client: options.youcam,
      jobId: options.job.id,
      fencingToken: options.job.fencingToken,
      owner: options.owner,
      now: options.now,
      retentionDays: options.config.assetRetentionDays,
    });
    return;
  }
  if (options.config.providerMode !== "fixture") return;
  if (options.job.providerTaskId) {
    await pollFixture(options);
    return;
  }
  const eligible = await stillEligible(options.pool, options.job);
  if (!eligible) {
    await cancelUnsent(options.pool, options.job, options.owner);
    return;
  }
  const submitting = await fenced(
    options.pool,
    `UPDATE provider_jobs SET state = 'SUBMITTING', updated_at = now()
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL
       AND state IN ('CLAIMED', 'UPLOADING', 'QUEUED')`,
    [options.job.id, options.job.fencingToken, options.owner],
  );
  if (!submitting) return;
  const taskId = `fixture-${randomUUID()}`;
  if (options.fault === "ambiguous-exit") {
    const inserted = await options.pool.query(
      `INSERT INTO fixture_provider_tasks (task_id, job_id, status)
       SELECT $1, id, 'running'
       FROM provider_jobs
       WHERE id = $2 AND fencing_token = $3 AND lease_owner = $4
         AND state = 'SUBMITTING' AND provider_task_id IS NULL
       RETURNING task_id`,
      [taskId, options.job.id, options.job.fencingToken, options.owner],
    );
    if ((inserted.rowCount ?? 0) === 1) process.exit(43);
    return;
  }
  const saved = await options.pool.query(
    `WITH owned AS (
       SELECT id FROM provider_jobs
       WHERE id = $2 AND fencing_token = $3 AND lease_owner = $4
         AND state = 'SUBMITTING' AND provider_task_id IS NULL
       FOR UPDATE
     ),
     task AS (
       INSERT INTO fixture_provider_tasks (task_id, job_id, status)
       SELECT $1, id, 'running' FROM owned
       RETURNING task_id, job_id
     )
     UPDATE provider_jobs
     SET provider_task_id = task.task_id, state = 'RUNNING', updated_at = now()
     FROM task
     WHERE provider_jobs.id = task.job_id
     RETURNING provider_jobs.provider_task_id`,
    [taskId, options.job.id, options.job.fencingToken, options.owner],
  );
  if ((saved.rowCount ?? 0) !== 1) return;
  if (options.fault === "exit-after-task-id") process.exit(42);
  options.job.providerTaskId = taskId;
  options.job.state = "RUNNING";
  await pollFixture(options);
}

async function pollFixture(options: {
  pool: Pool;
  storage: PrivateStorage;
  config: AppConfig;
  job: ClaimedJob;
  owner: string;
  fault: FixtureFault;
  now: Date;
}): Promise<void> {
  const taskId = options.job.providerTaskId;
  if (!taskId) return;
  if (options.fault === "poll-fail") {
    const delay = nextPollDelayMs(options.job.attempt, options.config.providerMode);
    await fenced(
      options.pool,
      `UPDATE provider_jobs
       SET state = 'RUNNING', attempt = attempt + 1, next_poll_at = $4::timestamptz, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NOT NULL`,
      [options.job.id, options.job.fencingToken, options.owner, new Date(options.now.getTime() + delay)],
    );
    return;
  }
  await options.pool.query(
    `UPDATE fixture_provider_tasks SET status = 'succeeded'
     WHERE task_id = $1 AND job_id = $2 AND status = 'running'`,
    [taskId, options.job.id],
  );
  await finalizeFixture(options);
}

async function finalizeFixture(options: {
  pool: Pool;
  storage: PrivateStorage;
  config: AppConfig;
  job: ClaimedJob;
  owner: string;
  now: Date;
}): Promise<void> {
  const temp = path.join(tmpdir(), `hair-reality-${options.job.id}.png`);
  let attached: { assetId: string } | null = null;
  try {
    const gate = await currentEligibility(options.pool, options.job);
    if (gate.kind === "deleted") {
      await finishReservation(options.pool, options.job.id, options.job.fencingToken, options.owner, options.job.maxCost, "FAILED", "result_discarded");
      return;
    }
    await recordFixtureEvidence(options);
    if (options.job.operation === "preview" && options.job.sourceAssetIds[0] && options.job.consultationServiceId) {
      await writeFile(temp, TINY_PNG);
      const result = await attachDerivedAsset({
        pool: options.pool,
        storage: options.storage,
        consultationId: options.job.consultationId,
        sourceAssetId: options.job.sourceAssetIds[0],
        file: TINY_PNG,
        retentionDays: options.config.assetRetentionDays,
      });
      if (!result.ok) {
        await finishReservation(options.pool, options.job.id, options.job.fencingToken, options.owner, options.job.maxCost, "FAILED", "result_discarded");
        return;
      }
      attached = { assetId: result.assetId };
      const freshness = gate.kind === "stale" ? "stale" : "current";
      const recorded = await recordPreview(options, result.assetId, freshness);
      if (!recorded) {
        await discardAsset(options.pool, options.storage, result.assetId);
        await finishReservation(options.pool, options.job.id, options.job.fencingToken, options.owner, options.job.maxCost, "FAILED", "result_discarded");
        return;
      }
    }
    const finished = await finishReservation(
      options.pool,
      options.job.id,
      options.job.fencingToken,
      options.owner,
      options.job.maxCost,
      "SUCCEEDED",
      null,
    );
    if (!finished && attached) await discardAsset(options.pool, options.storage, attached.assetId);
  } finally {
    await rm(temp, { force: true });
  }
}

async function recordFixtureEvidence(options: {
  pool: Pool;
  job: ClaimedJob;
  now: Date;
}): Promise<void> {
  const stored = await options.pool.query<{ configuration_fingerprint: string }>(
    "SELECT configuration_fingerprint FROM provider_jobs WHERE id = $1",
    [options.job.id],
  );
  const configuration = stored.rows[0]?.configuration_fingerprint;
  if (!configuration) return;
  if (options.job.operation === "analysis") {
    const capability = singleYouCamCapability(configuration);
    if (!capability) return;
    await options.pool.query(
      `INSERT INTO analysis_results (
         consultation_id, capability, input_assets, provider, provider_version, source, values, uncertainty, freshness, observed_at
       ) VALUES ($1, $2, $3::jsonb, 'youcam', 'fixture-1', 'fixture', $4::jsonb, 'fixture_not_a_measurement', 'current', $5)`,
      [
        options.job.consultationId,
        capability,
        JSON.stringify(options.job.sourceAssetIds),
        JSON.stringify({ provenance: "fixture_not_a_measurement" }),
        options.now,
      ],
    );
    return;
  }
  if (options.job.operation !== "interpretation") return;
  const request = parseOpenAIRequest(configuration);
  if (!request) return;
  const evidence = fixtureInterpretationValues(request);
  await options.pool.query(
    `INSERT INTO analysis_results (
       consultation_id, consultation_service_id, capability, input_assets, provider, provider_version, source, values, uncertainty, freshness, observed_at
     ) VALUES ($1, $2, $3, $4::jsonb, 'openai', 'fixture-1', 'fixture', $5::jsonb, $6, 'current', $7)`,
    [
      options.job.consultationId,
      options.job.consultationServiceId,
      `openai-${request.operation}`,
      JSON.stringify(request.imageAssetIds),
      JSON.stringify(evidence.values),
      evidence.uncertainty,
      options.now,
    ],
  );
}

async function recordPreview(
  options: { pool: Pool; job: ClaimedJob; owner: string },
  assetId: string,
  freshness: "current" | "stale",
): Promise<boolean> {
  const serviceId = options.job.consultationServiceId;
  const sourceAssetId = options.job.sourceAssetIds[0];
  if (!serviceId || !sourceAssetId) return false;
  return recordOwnedPreview(options.pool, {
    jobId: options.job.id,
    fencingToken: options.job.fencingToken,
    owner: options.owner,
    consultationServiceId: serviceId,
    sourceAssetId,
    resultAssetId: assetId,
    serviceInputVersion: options.job.serviceInputVersion,
    freshness,
    providerVersion: "fixture-1",
  });
}

async function discardAsset(pool: Pool, storage: PrivateStorage, assetId: string): Promise<void> {
  const removed = await pool.query<{ storage_key: string }>(
    `UPDATE assets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING storage_key`,
    [assetId],
  );
  const key = removed.rows[0]?.storage_key;
  if (key) await storage.remove(key).catch(() => undefined);
}

async function currentEligibility(pool: Pool, job: ClaimedJob): Promise<{ kind: "current" | "stale" | "deleted" }> {
  const consultation = await pool.query<{ deleted_at: Date | null }>(
    "SELECT deleted_at FROM consultations WHERE id = $1",
    [job.consultationId],
  );
  if (!consultation.rows[0] || consultation.rows[0].deleted_at) return { kind: "deleted" };
  if (job.consultationServiceId !== null) {
    const service = await pool.query<{ input_version: number }>(
      "SELECT input_version FROM consultation_services WHERE id = $1 AND selected = true",
      [job.consultationServiceId],
    );
    const version = service.rows[0]?.input_version;
    if (version === undefined) return { kind: "deleted" };
    if (job.serviceInputVersion !== null && version !== job.serviceInputVersion) return { kind: "stale" };
  }
  if (job.sourceAssetIds.length > 0) {
    const allowed = await externalProcessingAllowed(pool, job.consultationId, job.sourceAssetIds, ["youcam"]);
    if (!allowed) return { kind: "deleted" };
  }
  return { kind: "current" };
}

async function stillEligible(pool: Pool, job: ClaimedJob): Promise<boolean> {
  const gate = await currentEligibility(pool, job);
  return gate.kind === "current";
}

async function cancelUnsent(pool: Pool, job: ClaimedJob, owner: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cancelled = await client.query(
      `UPDATE provider_jobs
       SET state = 'CANCELLED', error_code = 'eligibility_withdrawn', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
         AND state IN ('QUEUED', 'CLAIMED', 'UPLOADING') AND provider_task_id IS NULL`,
      [job.id, job.fencingToken, owner],
    );
    if ((cancelled.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await releaseReservation(client, job.id);
    await writeJobEvent(client, null, job.consultationId, null, job.id, new Date());
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function fenced(pool: Pool, sql: string, params: unknown[]): Promise<boolean> {
  const result = await pool.query(sql, params);
  return (result.rowCount ?? 0) === 1;
}

export async function renewLease(pool: Pool, job: ClaimedJob, owner: string, mode: AppConfig["providerMode"], now: Date): Promise<boolean> {
  return fenced(
    pool,
    `UPDATE provider_jobs SET lease_expires_at = $4::timestamptz, updated_at = now()
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
    [job.id, job.fencingToken, owner, new Date(now.getTime() + leaseDurationMs(mode))],
  );
}

export function workerFault(mode: AppConfig["providerMode"], env: NodeJS.ProcessEnv = process.env): FixtureFault {
  if (mode !== "fixture") return null;
  const value = env.HAIR_REALITY_FIXTURE_FAULT;
  if (value === "exit-after-task-id" || value === "ambiguous-exit" || value === "poll-fail") return value;
  return null;
}

export function workerTickLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.HAIR_REALITY_WORKER_MAX_TICKS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return null;
  return Number(raw);
}

export async function runWorker(options: {
  pool: Pool;
  storage: PrivateStorage;
  config: AppConfig;
  owner?: string;
  now?: () => Date;
  ticks?: number;
  youcam?: YouCamClient;
  openai?: OpenAIClient;
}): Promise<void> {
  const owner = options.owner ?? `worker-${process.pid}`;
  const now = options.now ?? (() => new Date());
  const limit = options.ticks ?? workerTickLimit();
  const fault = workerFault(options.config.providerMode);
  for (let tick = 0; limit === null || tick < limit; tick += 1) {
    const job = await claimNext(options.pool, owner, options.config.providerMode, now());
    if (!job) {
      if (limit !== null) continue;
      await delay(renewDurationMs(options.config.providerMode));
      continue;
    }
    await renewLease(options.pool, job, owner, options.config.providerMode, now());
    await processClaimedJob({
      pool: options.pool,
      storage: options.storage,
      config: options.config,
      job,
      owner,
      fault,
      now: now(),
      ...(options.youcam ? { youcam: options.youcam } : {}),
      ...(options.openai ? { openai: options.openai } : {}),
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
