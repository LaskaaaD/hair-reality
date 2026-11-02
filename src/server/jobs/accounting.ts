import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { JobOperation, JobView } from "../../shared/jobs.js";
import { jobSchema } from "../../shared/jobs.js";
import type { AppConfig } from "../config.js";
import { externalProcessingAllowed } from "../assets/consent.js";
import { parseOpenAIRequest, priceDocumentedOpenAIRequest } from "../providers/openai/contract.js";
import { OPENAI_PRICING_VERSION } from "../providers/openai/pricing.js";
import { catalogueBindingError, type CatalogueSeed } from "../catalogue/inventory.js";
import { previewProviderConfiguration } from "../previews/request.js";
import { singleYouCamCapability, YOUCAM_CONTRACT_VERSION, youcamLiveBlocker } from "../providers/youcam/contract.js";
import {
  ACTIVE_STATES,
  BALANCE_MAX_AGE_MS,
  PRICE_MAX_AGE_MS,
  PROBE_DEVELOPMENT_CAP,
  QUOTAS,
  exposureOf,
  fresh,
  jobFingerprint,
  phaseCap,
  requestHash,
  totalCap,
  type Exposure,
} from "./caps.js";

const PROVIDER_VERSION = "fixture-1";

export type AdmitFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  currentVersion: number | null;
};

export type AdmitSuccess = { ok: true; job: JobView; created: boolean };
export type AdmitResult = AdmitSuccess | AdmitFailure;

type Outcome = { commit: boolean; result: AdmitResult };

export async function admitJob(options: {
  pool: Pool;
  config: AppConfig;
  actorId: string;
  consultationId: string;
  operation: JobOperation;
  provider: "youcam" | "openai";
  idempotencyKey: string;
  body: unknown;
  expectedVersion: number;
  assetIds: readonly string[];
  serviceId: string | null;
  configuration: string;
  officialInputTokens?: number;
  now: Date;
}): Promise<AdmitResult> {
  const hash = requestHash(options.consultationId, options.body);
  return transaction(options.pool, async (client) => {
    const consultation = await client.query<{
      version: number;
      deleted_at: Date | null;
      client_user_id: string;
      salon_id: string;
      lifecycle: string;
    }>(
      `SELECT version, deleted_at, client_user_id, salon_id, lifecycle
       FROM consultations WHERE id = $1 FOR UPDATE`,
      [options.consultationId],
    );
    const row = consultation.rows[0];
    if (!row || row.deleted_at) return stop(404, "not_found", "That consultation is not available.");
    const stylistBrief = options.operation === "interpretation" && openAIOperation(options.configuration) === "stylist_brief";
    if (row.client_user_id !== options.actorId || stylistBrief) {
      const member = await client.query(
        `SELECT 1 FROM salon_memberships
         WHERE salon_id = $1 AND user_id = $2 AND role IN ('stylist', 'admin')`,
        [row.salon_id, options.actorId],
      );
      const reviewing = row.lifecycle === "STYLIST_REVIEWING" || row.lifecycle === "CONSULTATION_REQUIRED";
      const reviewPreview = options.operation === "preview" && (member.rowCount ?? 0) > 0 && reviewing;
      const reviewBrief = options.operation === "interpretation"
        && openAIOperation(options.configuration) === "stylist_brief"
        && (member.rowCount ?? 0) > 0
        && reviewing;
      if (!reviewPreview && !reviewBrief) {
        return stop(
          (member.rowCount ?? 0) > 0 ? 403 : 404,
          (member.rowCount ?? 0) > 0 ? "forbidden" : "not_found",
          (member.rowCount ?? 0) > 0 ? "You cannot start this work." : "That consultation is not available.",
        );
      }
    }
    if (row.version !== options.expectedVersion) {
      return stop(409, "stale_version", "Another edit was saved. Reload this consultation before trying again.", row.version);
    }

    const phase = options.config.budgetPhase;
    const mode = options.config.providerMode;
    const accounts = await client.query<{
      id: string;
      phase: string;
      external_units: string;
      balance_units: string | null;
      balance_observed_at: Date | null;
    }>(
      `SELECT id, phase, external_units, balance_units, balance_observed_at
       FROM provider_budget_accounts
       WHERE provider = $1 AND mode = $2
       ORDER BY phase
       FOR UPDATE`,
      [options.provider, mode],
    );
    const budget = accounts.rows.find((item) => item.phase === phase);
    if (!budget) return stop(422, "reconciliation_unavailable", "Account reconciliation is not available. Existing jobs can still be polled.");

    const insertedKey = await client.query<{ id: string }>(
      `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (actor_user_id, operation, idempotency_key) DO NOTHING
       RETURNING id`,
      [options.actorId, options.operation, options.idempotencyKey, hash],
    );
    if ((insertedKey.rowCount ?? 0) === 0) {
      const existing = await client.query<{ request_hash: string; resource_id: string | null }>(
        `SELECT request_hash, resource_id FROM idempotency_keys
         WHERE actor_user_id = $1 AND operation = $2 AND idempotency_key = $3`,
        [options.actorId, options.operation, options.idempotencyKey],
      );
      const key = existing.rows[0];
      if (!key) return stop(409, "idempotency_conflict", "This request conflicts with an earlier one.");
      if (key.request_hash !== hash) {
        return stop(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
      }
      if (!key.resource_id) return stop(409, "idempotency_conflict", "This request is already being processed.");
      const job = await readJob(client, key.resource_id, options.actorId);
      if (!job) return stop(404, "not_found", "That job is not available.");
      return { commit: true, result: { ok: true, job, created: false } };
    }

    let configuration = options.configuration;
    if (options.operation === "preview") {
      const bound = await bindPreviewCandidate(client, options.consultationId, options.serviceId, options.body, configuration);
      if (bound.kind === "stop") return bound.outcome;
      configuration = bound.configuration;
    }

    if (mode === "recorded_demo") {
      return stop(422, "recorded_historical", "Recorded results are historical. New provider work is not started in this mode.");
    }

    const liveYouCam = mode === "live"
      && options.provider === "youcam"
      && options.config.youcamLiveSubmission === true
      && options.config.operatorProbe === true
      && typeof options.config.youcamApiKey === "string"
      && options.config.youcamApiKey.length > 0;
    const youcamCapability = liveYouCam ? singleYouCamCapability(configuration) : null;
    if (liveYouCam && !youcamCapability) {
      return stop(422, "unsupported_configuration", "The YouCam request does not name one documented capability.");
    }
    const openAIPrice = await openAIAdmission(client, options, mode);
    if (openAIPrice && !openAIPrice.ok) return { commit: false, result: openAIPrice };
    const priceOperation = youcamCapability ?? options.operation;
    const price = openAIPrice
      ? null
      : await client.query<{ units: string; observed_at: Date }>(
        `SELECT units, observed_at FROM provider_price_observations
         WHERE provider = $1 AND mode = $2 AND operation = $3
         ORDER BY observed_at DESC LIMIT 1`,
        [options.provider, mode, priceOperation],
      );
    const priceRow = price?.rows[0];
    if (!openAIPrice && !priceRow) return stop(422, "price_unavailable", "The price for this operation is not known. Existing jobs can still be polled.");
    if (!openAIPrice && priceRow && !fresh(priceRow.observed_at, options.now, PRICE_MAX_AGE_MS)) {
      return stop(422, "price_stale", "The price for this operation is stale. Existing jobs can still be polled.");
    }
    const cost = openAIPrice ? openAIPrice.microUnits : money(priceRow?.units ?? 0);
    if (budget.balance_units === null || budget.balance_observed_at === null) {
      return stop(422, "reconciliation_unavailable", "Account reconciliation is not available. Existing jobs can still be polled.");
    }
    // The 60-second clock is the YouCam account balance. OpenAI stores a ledger ceiling, not a provider balance.
    if (options.provider === "youcam" && mode !== "fixture" && !fresh(budget.balance_observed_at, options.now, BALANCE_MAX_AGE_MS)) {
      return stop(422, "reconciliation_unavailable", "Account reconciliation is not available. Existing jobs can still be polled.");
    }

    const phaseExposure = await exposure(client, options.provider, mode, phase);
    const totalExposure = await exposure(client, options.provider, mode, null);
    const external = accounts.rows.reduce((sum, item) => sum + money(item.external_units), 0);
    if (exposureOf(phaseExposure) + cost > phaseCap(options.provider, phase, options.config)) {
      return stop(429, "budget_exceeded", "This phase budget cannot reserve that cost.");
    }
    if (exposureOf(totalExposure) + external + cost > totalCap(options.provider, options.config)) {
      return stop(429, "budget_exceeded", "The application budget cannot reserve that cost.");
    }
    if (options.operation === "probe" && phase === "development") {
      const probe = await probeExposure(client, mode);
      if (probe + cost > PROBE_DEVELOPMENT_CAP) {
        return stop(429, "budget_exceeded", "The initial probe batch cannot reserve that cost.");
      }
    }
    const pending = totalExposure.reserved + totalExposure.uncertain;
    const settledSinceBalance = await settledSince(client, options.provider, mode, budget.balance_observed_at);
    const balance = money(budget.balance_units);
    if (options.provider === "youcam") {
      if (balance - external - pending - settledSinceBalance - cost < options.config.youcamReserve) {
        return stop(429, "budget_exceeded", "The provider balance would fall below the protected reserve.");
      }
    } else if (balance - external - pending - settledSinceBalance - cost < 0) {
      return stop(429, "budget_exceeded", "The provider balance cannot cover this reservation.");
    }
    const service = await loadService(client, options.consultationId, options.serviceId);
    if (options.serviceId && !service) return stop(404, "not_found", "That service is not available.");
    const assetHashes = await assetHashesFor(client, options.consultationId, options.assetIds);
    if (options.assetIds.length > 0 && !assetHashes) return stop(404, "not_found", "That photograph is not available.");
    const allowed = await externalProcessingAllowed(client, options.consultationId, options.assetIds, [options.provider]);
    if (options.assetIds.length > 0 && !allowed) {
      return stop(422, "consent_required", "External processing is not allowed for these photographs.");
    }

    const providerVersion = openAIPrice ? OPENAI_PRICING_VERSION : youcamCapability ? YOUCAM_CONTRACT_VERSION : PROVIDER_VERSION;
    const fingerprint = jobFingerprint({
      ownerId: row.client_user_id,
      assetHashes: assetHashes ?? [],
      operation: options.operation,
      provider: options.provider,
      providerVersion,
      configuration,
      inputVersion: service?.input_version ?? null,
    });
    if (liveYouCam && youcamCapability) {
      const blocker = youcamLiveBlocker(youcamCapability, options.config.providerDownloadHosts);
      if (blocker) return stop(422, "unsupported_configuration", "The YouCam capability is not ready for a paid submission.");
    } else if (mode !== "fixture" && !openAIPrice) {
      return stop(422, "provider_unavailable", "The live provider adapter is not available. Existing jobs can still be polled.");
    }
    const cached = await reusableJob(client, fingerprint, row.client_user_id, options, service?.input_version ?? null, mode);
    if (cached) {
      await client.query("UPDATE idempotency_keys SET resource_id = $2 WHERE actor_user_id = $1 AND operation = $3 AND idempotency_key = $4", [
        options.actorId,
        cached.id,
        options.operation,
        options.idempotencyKey,
      ]);
      return { commit: true, result: { ok: true, job: cached, created: false } };
    }
    const quota = await quotaFailure(client, options, options.now);
    if (quota) return { commit: false, result: quota };

    const snapshot = openAIPrice
      ? openAIPrice.snapshot
      : {
        operation: options.operation,
        units: cost,
        unit: options.provider === "openai" ? "usd_micro" : "youcam_unit",
        observedAt: priceRow?.observed_at.toISOString() ?? options.now.toISOString(),
      };
    const jobId = randomUUID();
    await client.query(
      `INSERT INTO provider_jobs (
        id, consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
        actor_user_id, request_hash, provider_version, configuration_fingerprint, price_snapshot,
        max_cost, consultation_service_id, source_asset_ids, service_input_version
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 'QUEUED', $7,
        $8, $9, $10, $11, $12,
        $13, $14, $15::uuid[], $16
      )`,
      [
        jobId,
        options.consultationId,
        options.provider,
        options.operation,
        fingerprint,
        phase,
        mode,
        options.actorId,
        hash,
        providerVersion,
        configuration,
        JSON.stringify(snapshot),
        cost,
        service?.id ?? null,
        options.assetIds,
        service?.input_version ?? null,
      ],
    );
    await client.query(
      `INSERT INTO usage_ledger (
        job_id, provider, budget_bucket, unit, estimated_units, settlement_state, mode, phase, price_snapshot
      ) VALUES ($1, $2, $3, $4, $5, 'reserved', $6, $7, $8)`,
      [
        jobId,
        options.provider,
        options.operation === "probe" ? "probe" : phase,
        options.provider === "openai" ? "usd_micro" : "youcam_unit",
        cost,
        mode,
        phase,
        JSON.stringify(snapshot),
      ],
    );
    await client.query(
      `UPDATE provider_budget_accounts
       SET reserved_units = reserved_units + $2
       WHERE id = $1`,
      [budget.id, cost],
    );
    await client.query(
      "UPDATE idempotency_keys SET resource_id = $2 WHERE actor_user_id = $1 AND operation = $3 AND idempotency_key = $4",
      [options.actorId, jobId, options.operation, options.idempotencyKey],
    );
    await writeJobEvent(client, options.actorId, options.consultationId, row.version, jobId, options.now);
    const job = await readJob(client, jobId, options.actorId);
    if (!job) return stop(404, "not_found", "That job is not available.");
    return { commit: true, result: { ok: true, job, created: true } };
  });
}

export async function finishReservation(
  pool: Pool,
  jobId: string,
  fencingToken: number,
  leaseOwner: string,
  actualUnits: number,
  state: "SUCCEEDED" | "FAILED",
  errorCode: string | null,
): Promise<boolean> {
  return transaction(pool, async (client) => {
    const fenced = await client.query(
      `UPDATE provider_jobs
       SET state = $3, error_code = $4, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $5
         AND state IN ('RUNNING', 'SUBMITTING', 'CLAIMED', 'UPLOADING')`,
      [jobId, fencingToken, state, errorCode, leaseOwner],
    );
    if ((fenced.rowCount ?? 0) !== 1) return { commit: false, result: false };
    const moved = await moveLedger(client, jobId, ["reserved"], "settled", actualUnits);
    if (!moved) return { commit: false, result: false };
    await client.query(
      `UPDATE provider_budget_accounts
       SET reserved_units = reserved_units - $4, settled_units = settled_units + $5
       WHERE provider = $1 AND phase = $2 AND mode = $3`,
      [moved.provider, moved.phase, moved.mode, moved.estimated, actualUnits],
    );
    const consultation = await client.query<{ consultation_id: string }>(
      "SELECT consultation_id FROM provider_jobs WHERE id = $1",
      [jobId],
    );
    const consultationId = consultation.rows[0]?.consultation_id;
    if (consultationId) await writeJobEvent(client, null, consultationId, null, jobId, new Date());
    return { commit: true, result: true };
  });
}

export async function holdUnresolvedUsage(
  pool: Pool,
  jobId: string,
  fencingToken: number,
  leaseOwner: string,
  state: "SUCCEEDED" | "FAILED",
  errorCode: string,
): Promise<boolean> {
  return transaction(pool, async (client) => {
    const fenced = await client.query(
      `UPDATE provider_jobs
       SET state = $3, error_code = $4, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $5
         AND state IN ('RUNNING', 'SUBMITTING', 'CLAIMED', 'UPLOADING')`,
      [jobId, fencingToken, state, errorCode, leaseOwner],
    );
    if ((fenced.rowCount ?? 0) !== 1) return { commit: false, result: false };
    const held = await client.query(
      `UPDATE usage_ledger
       SET settlement_state = 'uncertain'
       WHERE job_id = $1 AND settlement_state = 'reserved' AND actual_units IS NULL`,
      [jobId],
    );
    if ((held.rowCount ?? 0) !== 1) return { commit: false, result: false };
    return { commit: true, result: true };
  });
}

export async function ensureBudgetAccounts(pool: Pool, mode: AppConfig["providerMode"]): Promise<void> {
  for (const provider of ["youcam", "openai"]) {
    for (const phase of ["development", "demo"]) {
      await pool.query(
        `INSERT INTO provider_budget_accounts (provider, phase, mode)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, phase, mode) DO NOTHING`,
        [provider, phase, mode],
      );
    }
  }
  if (mode === "live") return;
  await pool.query(
    `UPDATE provider_budget_accounts
     SET balance_units = COALESCE(balance_units, 100000),
         balance_observed_at = now()
     WHERE mode = $1`,
    [mode],
  );
}

export async function reconcileAssumedSettlement(
  pool: Pool,
  input: {
    jobId: string;
    now: Date;
    reason: string;
    outcome: "not_billed" | "unresolved" | "billed";
    units?: number;
    errorCode?: string;
    instruction?: string;
  },
): Promise<{ applied: boolean }> {
  if (input.reason.length < 1 || input.reason.length > 500) return { applied: false };
  if (input.outcome === "billed" && (input.units === undefined || !Number.isInteger(input.units) || input.units < 0)) return { applied: false };
  return transaction(pool, async (client): Promise<{ commit: boolean; result: { applied: boolean } }> => {
    const prior = await client.query(
      `SELECT 1 FROM audit_events
       WHERE entity_type = 'provider_job' AND entity_id = $1 AND event_name = 'usage.reconciled'
         AND metadata->>'reason' = $2 AND metadata->>'outcome' = $3
       LIMIT 1`,
      [input.jobId, input.reason, input.outcome],
    );
    if ((prior.rowCount ?? 0) > 0) return { commit: true, result: { applied: false } };
    const ledger = await client.query<{
      provider: string;
      phase: string;
      mode: string;
      settlement_state: string;
      estimated_units: string;
      actual_units: string | null;
    }>(
      `SELECT provider, phase, mode, settlement_state, estimated_units, actual_units
       FROM usage_ledger WHERE job_id = $1 FOR UPDATE`,
      [input.jobId],
    );
    const row = ledger.rows[0];
    if (!row || row.provider !== "youcam") return { commit: true, result: { applied: false } };
    const estimated = money(row.estimated_units);
    const actual = row.actual_units === null ? null : money(row.actual_units);
    const targetActual = input.outcome === "not_billed" ? 0 : input.outcome === "unresolved" ? null : input.units ?? null;
    const targetState = input.outcome === "not_billed" ? "released" : input.outcome === "unresolved" ? "uncertain" : "settled";
    const already = row.settlement_state === targetState && actual === targetActual;
    if (!already) {
      if (input.outcome === "not_billed" && row.settlement_state === "uncertain" && actual === null) {
        await client.query(
          `UPDATE usage_ledger SET settlement_state = 'released', actual_units = 0
           WHERE job_id = $1 AND settlement_state = 'uncertain' AND actual_units IS NULL`,
          [input.jobId],
        );
        await client.query(
          `UPDATE provider_budget_accounts SET reserved_units = reserved_units - $4
           WHERE provider = $1 AND phase = $2 AND mode = $3`,
          [row.provider, row.phase, row.mode, estimated],
        );
      } else if (row.settlement_state !== "settled" || actual === null || actual !== estimated) {
        return { commit: true, result: { applied: false } };
      } else if (input.outcome === "not_billed") {
        await client.query(
          `UPDATE usage_ledger SET settlement_state = 'released', actual_units = 0
           WHERE job_id = $1 AND settlement_state = 'settled'`,
          [input.jobId],
        );
        await client.query(
          `UPDATE provider_budget_accounts SET settled_units = settled_units - $4
           WHERE provider = $1 AND phase = $2 AND mode = $3`,
          [row.provider, row.phase, row.mode, actual],
        );
      } else if (input.outcome === "unresolved") {
        await client.query(
          `UPDATE usage_ledger SET settlement_state = 'uncertain', actual_units = NULL
           WHERE job_id = $1 AND settlement_state = 'settled'`,
          [input.jobId],
        );
        await client.query(
          `UPDATE provider_budget_accounts
           SET settled_units = settled_units - $4, reserved_units = reserved_units + $5
           WHERE provider = $1 AND phase = $2 AND mode = $3`,
          [row.provider, row.phase, row.mode, actual, estimated],
        );
      } else {
        await client.query(
          `UPDATE usage_ledger SET settlement_state = 'settled', actual_units = $2
           WHERE job_id = $1 AND settlement_state = 'settled'`,
          [input.jobId, targetActual],
        );
        await client.query(
          `UPDATE provider_budget_accounts SET settled_units = settled_units + $4
           WHERE provider = $1 AND phase = $2 AND mode = $3`,
          [row.provider, row.phase, row.mode, (targetActual ?? 0) - actual],
        );
      }
    }
    await client.query(
      `INSERT INTO audit_events (id, actor_user_id, entity_type, entity_id, event_name, metadata, occurred_at)
       VALUES ($1, NULL, 'provider_job', $2, 'usage.reconciled', $3, $4)`,
      [randomUUID(), input.jobId, JSON.stringify({
        jobId: input.jobId,
        reason: input.reason,
        outcome: input.outcome,
        previousSettlement: row.settlement_state,
        previousActual: actual,
        instruction: input.instruction ?? null,
      }), input.now],
    );
    if (input.errorCode) {
      await client.query(
        `UPDATE provider_jobs SET error_code = $2, updated_at = now()
         WHERE id = $1 AND state = 'FAILED' AND (error_code = 'PROVIDER_UNAVAILABLE' OR error_code = $2)`,
        [input.jobId, input.errorCode],
      );
    }
    return { commit: true, result: { applied: true } };
  });
}

export async function releaseReservation(client: PoolClient, jobId: string): Promise<boolean> {
  const moved = await moveLedger(client, jobId, ["reserved"], "released", 0);
  if (!moved) return false;
  await client.query(
    `UPDATE provider_budget_accounts
     SET reserved_units = reserved_units - $4
     WHERE provider = $1 AND phase = $2 AND mode = $3`,
    [moved.provider, moved.phase, moved.mode, moved.estimated],
  );
  return true;
}

export async function resolveUncertain(pool: Pool, actorId: string, jobId: string, outcome: "not_billed" | "billed", actualUnits: number | null, mode: AppConfig["providerMode"]): Promise<AdmitResult> {
  return transaction(pool, async (client) => {
    const admin = await client.query(
      "SELECT 1 FROM salon_memberships WHERE user_id = $1 AND role = 'admin' LIMIT 1",
      [actorId],
    );
    if ((admin.rowCount ?? 0) === 0) return stop(403, "forbidden", "Operator reconciliation is not available for this account.");
    const job = await client.query<{ state: string; mode: string; fencing_token: string; consultation_id: string }>(
      "SELECT state, mode, fencing_token, consultation_id FROM provider_jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    const row = job.rows[0];
    if (!row || row.mode !== mode) return stop(404, "not_found", "That job is not available.");
    if (row.state !== "SUBMISSION_UNCERTAIN") {
      return stop(409, "state_conflict", "Only an uncertain submission can be reconciled, and it is not retried.");
    }
    if (outcome === "not_billed") {
      const moved = await moveLedger(client, jobId, ["uncertain"], "released", 0);
      if (moved) {
        await client.query(
          `UPDATE provider_budget_accounts SET reserved_units = reserved_units - $4
           WHERE provider = $1 AND phase = $2 AND mode = $3`,
          [moved.provider, moved.phase, moved.mode, moved.estimated],
        );
      }
      await client.query(
        `UPDATE provider_jobs SET state = 'FAILED', error_code = 'reconciled_not_billed', updated_at = now()
         WHERE id = $1 AND state = 'SUBMISSION_UNCERTAIN'`,
        [jobId],
      );
    } else {
      if (actualUnits === null) return stop(400, "invalid_input", "A billed reconciliation needs the actual units.");
      const moved = await moveLedger(client, jobId, ["uncertain"], "settled", actualUnits);
      if (!moved) return stop(409, "state_conflict", "This reservation was already settled.");
      await client.query(
        `UPDATE provider_budget_accounts
         SET reserved_units = reserved_units - $4, settled_units = settled_units + $5
         WHERE provider = $1 AND phase = $2 AND mode = $3`,
        [moved.provider, moved.phase, moved.mode, moved.estimated, actualUnits],
      );
      await client.query(
        `UPDATE provider_jobs SET state = 'FAILED', error_code = 'reconciled_billed', updated_at = now()
         WHERE id = $1 AND state = 'SUBMISSION_UNCERTAIN'`,
        [jobId],
      );
    }
    await writeJobEvent(client, actorId, row.consultation_id, null, jobId, new Date());
    const view = await readJob(client, jobId, actorId);
    if (!view) return stop(404, "not_found", "That job is not available.");
    return { commit: true, result: { ok: true, job: view, created: false } };
  });
}

export async function readAuthorizedJob(pool: Pool, actorId: string, jobId: string): Promise<JobView | null> {
  return readJob(pool, jobId, actorId);
}

export async function usageReport(pool: Pool, actorId: string, config: AppConfig): Promise<AdmitFailure | { ok: true; body: unknown }> {
  const admin = await pool.query(
    "SELECT 1 FROM salon_memberships WHERE user_id = $1 AND role = 'admin' LIMIT 1",
    [actorId],
  );
  if ((admin.rowCount ?? 0) === 0) {
    return { ok: false, status: 403, code: "forbidden", message: "Operator usage is not available for this account.", currentVersion: null };
  }
  const accounts = [];
  for (const provider of ["youcam", "openai"] as const) {
    for (const phase of ["development", "demo"] as const) {
      const held = await exposure(pool, provider, config.providerMode, phase);
      const external = await pool.query<{ external_units: string }>(
        `SELECT external_units FROM provider_budget_accounts
         WHERE provider = $1 AND phase = $2 AND mode = $3`,
        [provider, phase, config.providerMode],
      );
      accounts.push({
        provider,
        phase,
        mode: config.providerMode,
        unit: provider === "openai" ? "usd_micro" : "youcam_unit",
        settledUnits: held.settled,
        reservedUnits: held.reserved,
        uncertainUnits: held.uncertain,
        externalUnits: money(external.rows[0]?.external_units ?? 0),
        phaseCap: phaseCap(provider, phase, config),
        totalCap: totalCap(provider, config),
        reserveUnits: provider === "youcam" ? config.youcamReserve : 0,
      });
    }
  }
  return { ok: true, body: { mode: config.providerMode, phase: config.budgetPhase, accounts } };
}

export async function writeJobEvent(
  client: Pool | PoolClient,
  actorId: string | null,
  consultationId: string,
  version: number | null,
  jobId: string,
  now: Date,
): Promise<void> {
  const eventId = randomUUID();
  await client.query(
    `INSERT INTO audit_events (id, actor_user_id, entity_type, entity_id, event_name, metadata, occurred_at)
     VALUES ($1, $2, 'consultation', $3, 'job.updated', $4, $5)`,
    [eventId, actorId, consultationId, JSON.stringify({
      eventId,
      consultationId,
      version,
      resourceId: jobId,
      occurredAt: now.toISOString(),
    }), now],
  );
}

export async function deliverPendingEvents(
  pool: Pool,
  deliver: (event: { id: string; metadata: unknown }) => Promise<boolean>,
): Promise<number> {
  const pending = await pool.query<{ id: string; metadata: unknown }>(
    `SELECT id, metadata FROM audit_events
     WHERE event_name = 'job.updated' AND notified_at IS NULL
     ORDER BY occurred_at, id
     LIMIT 50`,
  );
  let delivered = 0;
  for (const event of pending.rows) {
    const ok = await deliver(event);
    if (!ok) continue;
    const updated = await pool.query(
      "UPDATE audit_events SET notified_at = now() WHERE id = $1 AND notified_at IS NULL",
      [event.id],
    );
    delivered += updated.rowCount ?? 0;
  }
  return delivered;
}

async function reusableJob(
  client: PoolClient,
  fingerprint: string,
  ownerId: string,
  options: { provider: string; consultationId: string; assetIds: readonly string[]; operation: string },
  inputVersion: number | null,
  mode: string,
): Promise<JobView | null> {
  if (options.operation !== "preview") return null;
  const found = await client.query<{ id: string }>(
    `SELECT provider_jobs.id
     FROM provider_jobs
     JOIN consultations ON consultations.id = provider_jobs.consultation_id
     WHERE provider_jobs.input_fingerprint = $1
       AND provider_jobs.operation = 'preview'
       AND provider_jobs.state = 'SUCCEEDED'
       AND provider_jobs.provider = $2
       AND provider_jobs.mode = $5
       AND consultations.client_user_id = $3
       AND consultations.deleted_at IS NULL
       AND ($4::integer IS NULL OR provider_jobs.service_input_version = $4)
     ORDER BY provider_jobs.created_at DESC
     LIMIT 1`,
    [fingerprint, options.provider, ownerId, inputVersion, mode],
  );
  const id = found.rows[0]?.id;
  if (!id) return null;
  if (options.assetIds.length > 0) {
    const allowed = await externalProcessingAllowed(client, options.consultationId, options.assetIds, [options.provider as "youcam" | "openai"]);
    if (!allowed) return null;
  }
  return readJob(client, id, ownerId);
}

async function quotaFailure(
  client: PoolClient,
  options: { actorId: string; consultationId: string; operation: string; provider: string; config: AppConfig },
  now: Date,
): Promise<AdmitFailure | null> {
  const mode = options.config.providerMode;
  const active = await count(client,
    `SELECT count(*)::int AS value FROM provider_jobs
     WHERE consultation_id = $1 AND mode = $2 AND state = ANY($3::text[])`,
    [options.consultationId, mode, ACTIVE_STATES],
  );
  if (active >= QUOTAS.activePerConsultation) {
    return fail(429, "quota_exceeded", "This consultation already has active paid work.");
  }
  if (options.provider === "youcam") {
    const global = await count(client,
      `SELECT count(*)::int AS value FROM provider_jobs
       WHERE provider = 'youcam' AND mode = $1 AND state = ANY($2::text[])`,
      [mode, ACTIVE_STATES],
    );
    if (global >= QUOTAS.youcamGlobal) return fail(429, "quota_exceeded", "The YouCam work queue is full.");
  }
  if (options.provider === "openai") {
    const global = await count(client,
      `SELECT count(*)::int AS value FROM provider_jobs
       WHERE provider = 'openai' AND mode = $1 AND state = ANY($2::text[])`,
      [mode, ACTIVE_STATES],
    );
    if (global >= QUOTAS.openaiGlobal) return fail(429, "quota_exceeded", "The OpenAI work queue is full.");
  }
  if (options.operation === "preview") {
    const consultationPreviews = await count(client,
      `SELECT count(*)::int AS value FROM provider_jobs
       WHERE consultation_id = $1 AND operation = 'preview' AND mode = $2`,
      [options.consultationId, mode],
    );
    if (consultationPreviews >= QUOTAS.previewsPerConsultation) {
      return fail(429, "quota_exceeded", "This consultation has reached its preview limit.");
    }
    const daily = await count(client,
      `SELECT count(*)::int AS value FROM provider_jobs
       WHERE actor_user_id = $1 AND operation = 'preview' AND mode = $2
         AND created_at >= date_trunc('day', $3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [options.actorId, mode, now.toISOString()],
    );
    if (daily >= QUOTAS.previewsPerAccountPerDay) {
      return fail(429, "quota_exceeded", "This account has reached today's preview limit.");
    }
  }
  return null;
}

async function bindPreviewCandidate(
  client: PoolClient,
  consultationId: string,
  serviceId: string | null,
  body: unknown,
  configuration: string,
): Promise<{ kind: "ready"; configuration: string } | { kind: "stop"; outcome: Outcome }> {
  const candidateId = candidateIdFrom(body);
  const sourceAssetId = sourceAssetIdFrom(body);
  if (!serviceId || !candidateId || !sourceAssetId || configuration !== `preview:${candidateId}`) {
    return { kind: "stop", outcome: stop(422, "unsupported_configuration", "Choose one supported catalogue entry.") };
  }
  const service = await client.query<{ kind: string }>(
    `SELECT kind FROM consultation_services
     WHERE id = $1 AND consultation_id = $2 AND selected = true`,
    [serviceId, consultationId],
  );
  const kind = service.rows[0]?.kind;
  if (kind !== "haircut" && kind !== "colour" && kind !== "beard") {
    return { kind: "stop", outcome: stop(404, "not_found", "That service is not available.") };
  }
  const candidate = await client.query<{
    salon_id: string;
    consultation_salon: string;
    service_kind: string;
    title: string;
    enabled: boolean;
    provenance: string;
    provider_reference: string | null;
    provider_configuration: unknown;
    metadata: unknown;
  }>(
    `SELECT candidates.salon_id, consultations.salon_id AS consultation_salon, candidates.service_kind,
            candidates.title, candidates.enabled, candidates.provenance, candidates.provider_reference,
            candidates.provider_configuration, candidates.metadata
     FROM candidates
     JOIN consultations ON consultations.id = $2
     WHERE candidates.id = $1`,
    [candidateId, consultationId],
  );
  const row = candidate.rows[0];
  if (!row || !row.enabled || row.service_kind !== kind || row.salon_id !== row.consultation_salon) {
    return { kind: "stop", outcome: stop(422, "unsupported_configuration", "That catalogue entry is not supported.") };
  }
  const entry = seedFromCandidate(row, kind);
  if (!entry || catalogueBindingError(entry)) {
    return { kind: "stop", outcome: stop(422, "unsupported_configuration", "That catalogue entry is not supported.") };
  }
  const asset = await client.query<{ role: string }>(
    `SELECT role FROM assets
     WHERE id = $1 AND consultation_id = $2 AND deleted_at IS NULL`,
    [sourceAssetId, consultationId],
  );
  const expectedRole = kind === "beard" ? "beard" : "current_front";
  if (asset.rows[0]?.role !== expectedRole) {
    return { kind: "stop", outcome: stop(422, "unsupported_configuration", "That photograph cannot source this preview.") };
  }
  return {
    kind: "ready",
    configuration: previewProviderConfiguration({
      serviceKind: kind,
      candidateId,
      sourceAssetId,
      controls: entry.configuration,
    }),
  };
}

function candidateIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as { candidateId?: unknown }).candidateId;
  return typeof value === "string" ? value : null;
}

function sourceAssetIdFrom(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as { sourceAssetId?: unknown }).sourceAssetId;
  return typeof value === "string" ? value : null;
}

function seedFromCandidate(row: {
  title: string;
  provenance: string;
  provider_reference: string | null;
  provider_configuration: unknown;
  metadata: unknown;
}, serviceKind: "haircut" | "colour" | "beard"): CatalogueSeed | null {
  const metadata = recordOf(row.metadata);
  const configuration = recordOf(row.provider_configuration);
  const provenance = row.provenance === "youcam" || row.provenance === "fixture" ? row.provenance : null;
  if (!provenance) return null;
  if (serviceKind === "colour") {
    const preset = typeof configuration.preset === "string" ? configuration.preset : null;
    if (!preset || Object.keys(configuration).some((key) => key !== "preset")) return null;
    return {
      key: "bound",
      serviceKind: "colour",
      title: row.title,
      provenance,
      providerReference: row.provider_reference,
      length: "unknown",
      texture: "unknown",
      configuration: { preset },
    };
  }
  const length = enumValue(metadata.length, ["short", "medium", "long", "unknown"] as const);
  const texture = enumValue(metadata.texture, ["straight", "wavy", "curly", "unknown"] as const);
  if (!length || !texture) return null;
  const templateId = typeof configuration.template_id === "string" ? configuration.template_id : null;
  return {
    key: "bound",
    serviceKind,
    title: row.title,
    provenance,
    providerReference: row.provider_reference,
    length,
    texture,
    configuration: templateId ? { template_id: templateId } : {},
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}

async function loadService(client: PoolClient, consultationId: string, serviceId: string | null): Promise<{ id: string; input_version: number } | null> {
  if (!serviceId) return null;
  const result = await client.query<{ id: string; input_version: number }>(
    `SELECT id, input_version FROM consultation_services
     WHERE id = $1 AND consultation_id = $2 AND selected = true`,
    [serviceId, consultationId],
  );
  return result.rows[0] ?? null;
}

async function assetHashesFor(client: PoolClient, consultationId: string, assetIds: readonly string[]): Promise<string[] | null> {
  if (assetIds.length === 0) return [];
  const result = await client.query<{ content_hash: string }>(
    `SELECT content_hash FROM assets
     WHERE consultation_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
    [consultationId, assetIds],
  );
  if ((result.rowCount ?? 0) !== assetIds.length) return null;
  return result.rows.map((row) => row.content_hash);
}

async function exposure(client: Pool | PoolClient, provider: string, mode: string, phase: string | null): Promise<Exposure> {
  const result = await client.query<{ settlement_state: string; units: string }>(
    `SELECT settlement_state,
            COALESCE(SUM(CASE WHEN settlement_state = 'settled' THEN actual_units ELSE estimated_units END), 0)::text AS units
     FROM usage_ledger
     WHERE provider = $1 AND mode = $2 AND ($3::text IS NULL OR phase = $3)
       AND settlement_state IN ('settled', 'reserved', 'uncertain')
     GROUP BY settlement_state`,
    [provider, mode, phase],
  );
  const exposure: Exposure = { settled: 0, reserved: 0, uncertain: 0 };
  for (const row of result.rows) {
    if (row.settlement_state === "settled") exposure.settled = money(row.units);
    if (row.settlement_state === "reserved") exposure.reserved = money(row.units);
    if (row.settlement_state === "uncertain") exposure.uncertain = money(row.units);
  }
  return exposure;
}

async function settledSince(client: PoolClient, provider: string, mode: string, observedAt: Date | null): Promise<number> {
  if (!observedAt) return 0;
  const result = await client.query<{ units: string }>(
    `SELECT COALESCE(SUM(actual_units), 0)::text AS units
     FROM usage_ledger
     WHERE provider = $1 AND mode = $2 AND settlement_state = 'settled' AND recorded_at > $3`,
    [provider, mode, observedAt],
  );
  return money(result.rows[0]?.units ?? 0);
}

async function probeExposure(client: PoolClient, mode: string): Promise<number> {
  const result = await client.query<{ units: string }>(
    `SELECT COALESCE(SUM(CASE WHEN usage_ledger.settlement_state = 'settled' THEN usage_ledger.actual_units ELSE usage_ledger.estimated_units END), 0)::text AS units
     FROM usage_ledger
     JOIN provider_jobs ON provider_jobs.id = usage_ledger.job_id
     WHERE provider_jobs.operation = 'probe' AND provider_jobs.cost_phase = 'development' AND provider_jobs.mode = $1
       AND usage_ledger.settlement_state IN ('settled', 'reserved', 'uncertain')`,
    [mode],
  );
  return money(result.rows[0]?.units ?? 0);
}

async function moveLedger(
  client: PoolClient,
  jobId: string,
  from: readonly string[],
  to: string,
  actual: number,
): Promise<{ provider: string; phase: string; mode: string; estimated: number } | null> {
  const updated = await client.query<{ provider: string; phase: string; mode: string; estimated_units: string }>(
    `UPDATE usage_ledger
     SET settlement_state = $3,
         actual_units = $4,
         recorded_at = CASE WHEN $3 = 'settled' THEN now() ELSE recorded_at END
     WHERE job_id = $1 AND settlement_state = ANY($2::text[])
     RETURNING provider, phase, mode, estimated_units`,
    [jobId, from, to, actual],
  );
  const row = updated.rows[0];
  if (!row) return null;
  return { provider: row.provider, phase: row.phase, mode: row.mode, estimated: money(row.estimated_units) };
}

export async function readJob(client: Pool | PoolClient, jobId: string, actorId: string): Promise<JobView | null> {
  const result = await client.query<{
    id: string;
    consultation_id: string;
    operation: string;
    state: string;
    mode: "fixture" | "recorded_demo" | "live";
    error_code: string | null;
    result_asset_id: string | null;
  }>(
    `SELECT provider_jobs.id, provider_jobs.consultation_id, provider_jobs.operation, provider_jobs.state,
            provider_jobs.mode, provider_jobs.error_code, previews.result_asset_id
     FROM provider_jobs
     JOIN consultations ON consultations.id = provider_jobs.consultation_id
     LEFT JOIN previews ON previews.job_id = provider_jobs.id AND previews.stale = false AND previews.freshness = 'current'
     WHERE provider_jobs.id = $1
       AND (
         consultations.client_user_id = $2
         OR EXISTS (
           SELECT 1 FROM salon_memberships
           WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
         )
       )`,
    [jobId, actorId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return jobSchema.parse({
    id: row.id,
    consultationId: row.consultation_id,
    operation: row.operation,
    state: row.state,
    mode: row.mode,
    historical: row.mode === "recorded_demo",
    errorCode: row.error_code,
    resultAssetId: row.result_asset_id,
  });
}

async function count(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  const result = await client.query<{ value: number }>(sql, params);
  return Number(result.rows[0]?.value ?? 0);
}

async function openAIAdmission(
  client: PoolClient,
  options: {
    config: AppConfig;
    provider: string;
    configuration: string;
    assetIds: readonly string[];
    consultationId: string;
    officialInputTokens?: number;
  },
  mode: AppConfig["providerMode"],
): Promise<null | AdmitFailure | Extract<ReturnType<typeof priceDocumentedOpenAIRequest>, { ok: true }>> {
  if (mode !== "live" || options.provider !== "openai") return null;
  if (!options.config.openaiLiveSubmission || !options.config.operatorProbe) {
    return fail(422, "openai_cost_unverified", "OpenAI admission is closed until its cost calculation is verified.");
  }
  const request = parseOpenAIRequest(options.configuration);
  if (!request) {
    return fail(422, "openai_cost_unverified", "OpenAI admission is closed until its cost calculation is verified.");
  }
  const requested = [...request.imageAssetIds].sort().join(",");
  const supplied = [...options.assetIds].sort().join(",");
  if (requested !== supplied) {
    return fail(422, "unsupported_configuration", "The image settings do not match the request.");
  }
  const images = await client.query<{ id: string; width: number; height: number }>(
    `SELECT id, width, height FROM assets
     WHERE consultation_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
    [options.consultationId, request.imageAssetIds],
  );
  if (request.imageAssetIds.length > 0 && images.rowCount !== request.imageAssetIds.length) {
    return fail(404, "not_found", "That photograph is not available.");
  }
  const byId = new Map(images.rows.map((row) => [row.id, row]));
  const sizes: { width: number; height: number }[] = [];
  for (const id of request.imageAssetIds) {
    const asset = byId.get(id);
    if (!asset) return fail(404, "not_found", "That photograph is not available.");
    sizes.push({ width: asset.width, height: asset.height });
  }
  const priced = priceDocumentedOpenAIRequest(options.config.openaiModel, request, sizes);
  if (!priced.ok) return fail(priced.status, priced.code, priced.message);
  const violated = await client.query(
    `SELECT 1 FROM usage_ledger
     WHERE provider = 'openai' AND mode = 'live' AND settlement_state = 'settled'
       AND actual_units > estimated_units
       AND price_snapshot->>'pricingVersion' = $1
     LIMIT 1`,
    [OPENAI_PRICING_VERSION],
  );
  if ((violated.rowCount ?? 0) > 0) {
    return fail(422, "openai_cost_unverified", "A previous OpenAI response exceeded its reservation.");
  }
  return priced;
}

function openAIOperation(configuration: string): string | null {
  return parseOpenAIRequest(configuration)?.operation ?? null;
}

function money(value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("unsafe money");
  return parsed;
}

function fail(status: number, code: string, message: string, currentVersion: number | null = null): AdmitFailure {
  return { ok: false, status, code, message, currentVersion };
}

function stop(status: number, code: string, message: string, currentVersion: number | null = null): Outcome {
  return { commit: false, result: fail(status, code, message, currentVersion) };
}

async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<{ commit: boolean; result: T }>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const outcome = await fn(client);
    await client.query(outcome.commit ? "COMMIT" : "ROLLBACK");
    return outcome.result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
