import type { Pool } from "pg";
import sharp from "sharp";
import { externalProcessingAllowed } from "../../assets/consent.js";
import type { PrivateStorage } from "../../assets/storage.js";
import { finishReservation, holdUnresolvedUsage, releaseReservation, writeJobEvent } from "../../jobs/accounting.js";
import { OpenAIClient, type OpenAICall, type OpenAIUsage } from "./client.js";
import {
  deterministicExplanation,
  parseOpenAIRequest,
  storedInterpretation,
  validateOutput,
  type OpenAIRequest,
  type SuppliedFinding,
} from "./contract.js";
import { OPENAI_PRICING_VERSION, usageMicro, type ImageSize } from "./pricing.js";

type Snapshot = {
  images?: ImageSize[];
  inputTokenCeiling?: number;
};

export async function advanceOpenAIJob(options: {
  pool: Pool;
  storage: PrivateStorage;
  client: OpenAIClient;
  jobId: string;
  fencingToken: number;
  owner: string;
  now: Date;
}): Promise<void> {
  const job = await options.pool.query<{
    state: string;
    provider: string;
    consultation_id: string;
    configuration_fingerprint: string;
    max_cost: string;
    source_asset_ids: string[];
    consultation_service_id: string | null;
    service_input_version: number | null;
    price_snapshot: Snapshot;
  }>(
    `SELECT state, provider, consultation_id, configuration_fingerprint, max_cost, source_asset_ids,
            consultation_service_id, service_input_version, price_snapshot
     FROM provider_jobs WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
    [options.jobId, options.fencingToken, options.owner],
  );
  const row = job.rows[0];
  if (!row || row.state === "SUBMISSION_UNCERTAIN" || row.provider !== "openai") return;
  const request = parseOpenAIRequest(row.configuration_fingerprint);
  if (!request) {
    await failBeforeSubmit(options, "UNSUPPORTED_CONFIGURATION");
    return;
  }
  const eligible = await eligibleForSubmit(options.pool, row);
  if (!eligible) {
    await cancelBeforeSubmit(options, row.consultation_id);
    return;
  }
  const images = await loadImages(options.pool, options.storage, request, row.price_snapshot.images ?? []);
  if (request.imageAssetIds.length > 0 && !images) {
    await failBeforeSubmit(options, "INVALID_PHOTO");
    return;
  }
  const submitting = await options.pool.query(
    `UPDATE provider_jobs SET state = 'SUBMITTING', updated_at = now()
     WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL
       AND state IN ('CLAIMED', 'UPLOADING', 'QUEUED')`,
    [options.jobId, options.fencingToken, options.owner],
  );
  if ((submitting.rowCount ?? 0) !== 1) return;
  const result = await options.client.respond(request, images ?? []);
  if (result.kind === "uncertain") {
    await markUncertain(options);
    return;
  }
  if (result.kind === "failed") {
    await failBeforeSubmit(options, result.code);
    return;
  }
  const measured = measuredUnits(result.usage);
  if (measured === null) {
    await storeUnmeasured(options, row.consultation_id, request, result);
    return;
  }
  const actual = measured;
  if (request.operation === "finding_explanation" && (result.kind !== "completed" || !validateOutput(request.operation, result.text, request).ok)) {
    await storeExplanation(options, row.consultation_id, request.findings, deterministicExplanation(request.findings), "deterministic_fallback", actual);
    return;
  }
  if (result.kind !== "completed") {
    await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, actual, "FAILED", "PROVIDER_RESPONSE_INVALID");
    return;
  }
  const validated = validateOutput(request.operation, result.text, request);
  if (!validated.ok) {
    await finishReservation(options.pool, options.jobId, options.fencingToken, options.owner, actual, "FAILED", "PROVIDER_RESPONSE_INVALID");
    return;
  }
  const value = request.operation === "target_interpretation" && validated.value
    ? storedInterpretation(validated.value as Parameters<typeof storedInterpretation>[0])
    : validated.value;
  const stored = request.operation === "finding_explanation"
    ? { explanation: (validated.value as { explanation: string }).explanation, findings: request.findings, provenance: "model_text" }
    : value;
  await storeResult(options, row.consultation_id, request.operation, stored, null, actual);
}

async function eligibleForSubmit(pool: Pool, job: {
  consultation_id: string;
  source_asset_ids: string[];
  consultation_service_id: string | null;
  service_input_version: number | null;
}): Promise<boolean> {
  const consultation = await pool.query<{ deleted_at: Date | null }>(
    "SELECT deleted_at FROM consultations WHERE id = $1",
    [job.consultation_id],
  );
  if (!consultation.rows[0] || consultation.rows[0].deleted_at) return false;
  if (job.consultation_service_id !== null) {
    const service = await pool.query<{ input_version: number }>(
      "SELECT input_version FROM consultation_services WHERE id = $1 AND selected = true",
      [job.consultation_service_id],
    );
    const version = service.rows[0]?.input_version;
    if (version === undefined) return false;
    if (job.service_input_version !== null && version !== job.service_input_version) return false;
  }
  if (job.source_asset_ids.length === 0) return true;
  return externalProcessingAllowed(pool, job.consultation_id, job.source_asset_ids, ["openai"]);
}

async function loadImages(
  pool: Pool,
  storage: PrivateStorage,
  request: OpenAIRequest,
  reserved: readonly ImageSize[],
): Promise<{ mimeType: string; base64: string }[] | null> {
  if (request.imageAssetIds.length === 0) return [];
  if (reserved.length !== request.imageAssetIds.length) return null;
  const rows = await pool.query<{ id: string; storage_key: string; mime_type: string }>(
    `SELECT id, storage_key, mime_type FROM assets
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [request.imageAssetIds],
  );
  const byId = new Map(rows.rows.map((row) => [row.id, row]));
  const images: { mimeType: string; base64: string }[] = [];
  for (let index = 0; index < request.imageAssetIds.length; index += 1) {
    const assetId = request.imageAssetIds[index];
    const expected = reserved[index];
    if (!assetId || !expected) return null;
    const asset = byId.get(assetId);
    if (!asset || (asset.mime_type !== "image/jpeg" && asset.mime_type !== "image/png")) return null;
    let bytes: Buffer;
    let metadata: { width?: number; height?: number };
    try {
      bytes = await readKey(storage, asset.storage_key);
      metadata = await sharp(bytes).metadata();
    } catch {
      return null;
    }
    if (metadata.width !== expected.width || metadata.height !== expected.height) return null;
    images.push({ mimeType: asset.mime_type, base64: bytes.toString("base64") });
  }
  return images;
}

async function storeExplanation(
  options: { pool: Pool; jobId: string; fencingToken: number; owner: string; now: Date },
  consultationId: string,
  findings: readonly SuppliedFinding[],
  explanation: string,
  uncertainty: string,
  actual: number,
): Promise<void> {
  await storeResult(options, consultationId, "finding_explanation", {
    explanation,
    findings,
    provenance: uncertainty === "deterministic_fallback" ? "deterministic_findings" : "model_text",
  }, uncertainty, actual);
}

async function storeUnmeasured(
  options: { pool: Pool; jobId: string; fencingToken: number; owner: string; now: Date },
  consultationId: string,
  request: OpenAIRequest,
  result: Extract<OpenAICall, { kind: "completed" | "refused" | "incomplete" | "malformed" }>,
): Promise<void> {
  const explanationFallback = request.operation === "finding_explanation"
    && (result.kind !== "completed" || !validateOutput(request.operation, result.text, request).ok);
  if (explanationFallback) {
    await insertAnalysis(options, consultationId, "finding_explanation", {
      explanation: deterministicExplanation(request.findings),
      findings: request.findings,
      provenance: "deterministic_findings",
    }, "deterministic_fallback");
    await holdUnresolvedUsage(options.pool, options.jobId, options.fencingToken, options.owner, "SUCCEEDED", "usage_unverified");
    return;
  }
  if (result.kind === "completed") {
    const validated = validateOutput(request.operation, result.text, request);
    if (validated.ok) {
      const value = request.operation === "target_interpretation" && validated.value
        ? storedInterpretation(validated.value as Parameters<typeof storedInterpretation>[0])
        : validated.value;
      const stored = request.operation === "finding_explanation"
        ? { explanation: (validated.value as { explanation: string }).explanation, findings: request.findings, provenance: "model_text" }
        : value;
      await insertAnalysis(options, consultationId, request.operation, stored, "usage_unverified");
      await holdUnresolvedUsage(options.pool, options.jobId, options.fencingToken, options.owner, "SUCCEEDED", "usage_unverified");
      return;
    }
  }
  await holdUnresolvedUsage(options.pool, options.jobId, options.fencingToken, options.owner, "FAILED", "usage_unverified");
}

async function insertAnalysis(
  options: { pool: Pool; now: Date },
  consultationId: string,
  operation: string,
  values: unknown,
  uncertainty: string | null,
): Promise<void> {
  await options.pool.query(
    `INSERT INTO analysis_results (
       consultation_id, capability, input_assets, provider, provider_version, source, values, uncertainty, freshness, observed_at
     ) VALUES ($1, $2, '[]'::jsonb, 'openai', $3, 'llm_observation', $4::jsonb, $5, 'current', $6)`,
    [consultationId, `openai-${operation}`, OPENAI_PRICING_VERSION, JSON.stringify(values), uncertainty, options.now],
  );
}

async function storeResult(
  options: { pool: Pool; jobId: string; fencingToken: number; owner: string; now: Date },
  consultationId: string,
  operation: string,
  values: unknown,
  uncertainty: string | null,
  actual: number,
): Promise<void> {
  await insertAnalysis(options, consultationId, operation, values, uncertainty);
  const assumption = actual > await reservedUnits(options.pool, options.jobId) ? "reservation_exceeded" : null;
  await finishReservation(
    options.pool,
    options.jobId,
    options.fencingToken,
    options.owner,
    actual,
    "SUCCEEDED",
    assumption,
  );
}

function measuredUnits(usage: OpenAIUsage | null): number | null {
  if (!usage) return null;
  return usageMicro(usage.inputTokens, usage.outputTokens);
}

async function reservedUnits(pool: Pool, jobId: string): Promise<number> {
  const result = await pool.query<{ estimated_units: string }>(
    "SELECT estimated_units FROM usage_ledger WHERE job_id = $1",
    [jobId],
  );
  return Number(result.rows[0]?.estimated_units ?? 0);
}

async function markUncertain(options: { pool: Pool; jobId: string; fencingToken: number; owner: string }): Promise<void> {
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
}

async function cancelBeforeSubmit(
  options: { pool: Pool; jobId: string; fencingToken: number; owner: string; now: Date },
  consultationId: string,
): Promise<void> {
  const client = await options.pool.connect();
  try {
    await client.query("BEGIN");
    const cancelled = await client.query(
      `UPDATE provider_jobs
       SET state = 'CANCELLED', error_code = 'eligibility_withdrawn', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND provider_task_id IS NULL
         AND state IN ('QUEUED', 'CLAIMED', 'UPLOADING')`,
      [options.jobId, options.fencingToken, options.owner],
    );
    if ((cancelled.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return;
    }
    await releaseReservation(client, options.jobId);
    await writeJobEvent(client, null, consultationId, null, options.jobId, options.now);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function failBeforeSubmit(
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

async function readKey(storage: PrivateStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.stream(key)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
