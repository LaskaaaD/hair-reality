import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { parsePerson } from "../../domain/person.js";
import { applyEvidence, unknownAnalysis } from "../../domain/profile.js";
import type { PrivateStorage } from "../assets/storage.js";
import type { OpenAIClient } from "../providers/openai/client.js";
import type { YouCamClient } from "../providers/youcam/client.js";
import { compareHairColour, needsRecolour } from "./hair-colour-check.js";
import { isCatalogueReferenceFile, TEMPLATE_RENDER_REFUSAL } from "./reference-photo.js";
import { RENDER_TIMEOUT_REASON, renderFailureReason } from "./render-failure.js";
import { attachVisionIfReady, restoreVisionFields, trackVision } from "./llm.js";
import { HACKATHON_FACE_FEATURES, isYouCamCapability, type YouCamCapability } from "../providers/youcam/contract.js";
import {
  demoMediaRoot,
  detailWithSource,
  readRenderCache,
  sampleFrontPhotoHash,
  writeRenderCache,
  type PreviewImageSource,
} from "./render-cache.js";

type JobRow = {
  id: string;
  session_id: string;
  capability: string;
  provider_task_id: string | null;
  payload: unknown;
  storage_key: string | null;
  submitted_at: Date | null;
};

const OPTIONAL_ANALYSIS = new Set(["hair-density"]);

export function analysisOutcome(jobs: readonly { capability: string; status: string }[]): "running" | "ready" | "failed" {
  if (jobs.length === 0) return "running";
  if (jobs.some((job) => job.status === "queued" || job.status === "running")) return "running";
  const blocking = jobs.filter((job) => !OPTIONAL_ANALYSIS.has(job.capability));
  if (blocking.some((job) => job.status === "failed")) return "failed";
  if (blocking.length === 0 && jobs.some((job) => job.status === "failed")) return "failed";
  return "ready";
}

export function crownReadingNotice(jobs: readonly { capability: string; status: string }[]): string | null {
  const densityFailed = jobs.some((job) => job.capability === "hair-density" && job.status === "failed");
  const frontAccepted = jobs.some((job) => job.capability === "face-attributes" && job.status === "succeeded");
  if (!densityFailed || !frontAccepted) return null;
  return "The crown photo needs the top of the head, with part of the face still in frame. Density was skipped. The front photo was accepted.";
}

export function retakeSlotFor(jobs: readonly { capability: string; status: string; error_code?: string | null }[]): "front" | "sides" | null {
  if (analysisOutcome(jobs) !== "failed") return null;
  if (providerSideFailure(jobs)) return null;
  const faceOk = jobs.some((job) => job.capability === "face-attributes" && job.status === "succeeded");
  const faceFailed = jobs.some((job) => job.capability === "face-attributes" && job.status === "failed");
  return faceOk && !faceFailed ? "sides" : "front";
}

export function retakeReadingNotice(jobs: readonly { capability: string; status: string; error_code?: string | null }[]): string {
  if (providerSideFailure(jobs)) return "The photo analysis service could not be reached. Your photos look fine. Try again in a moment.";
  if (retakeSlotFor(jobs) === "sides") return "A side photo could not be read. Retake the left and right views. The front photo was accepted.";
  return "The front photo could not be read. Retake it and try again.";
}

/** One secret-free log line per failed YouCam task, so a failure can be explained afterwards. */
export function failureLogLine(capability: string, result: { code: string; providerError?: string | null; detail?: string }): string {
  const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "-";
  return `demo_analysis_task_failed capability=${capability} code=${result.code} detail=${clean(result.detail)} providerError=${clean(result.providerError)}`;
}

const PROVIDER_SIDE_CODES = new Set(["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMIT", "PROVIDER_AUTH", "PROVIDER_QUOTA", "PROVIDER_RESPONSE_INVALID", "SUBMISSION_UNCERTAIN"]);

/** True when every blocking failure is a provider/transport problem, not something wrong with a photo. */
export function providerSideFailure(jobs: readonly { capability: string; status: string; error_code?: string | null }[]): boolean {
  const failed = jobs.filter((job) => job.status === "failed" && !OPTIONAL_ANALYSIS.has(job.capability));
  return failed.length > 0 && failed.every((job) => typeof job.error_code === "string" && PROVIDER_SIDE_CODES.has(job.error_code));
}

export function captureStamp(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  const stamp = fingerprint.endsWith(":vision") ? fingerprint.slice(0, -":vision".length) : fingerprint;
  return /^[a-f0-9]{64}$/.test(stamp) ? stamp : null;
}

export function clipProviderReason(value: string | null | undefined): string | null {
  if (!value) return null;
  const reason = value.replace(/\s+/g, " ").trim().slice(0, 180);
  return reason.length > 0 ? reason : null;
}

export async function enqueueAnalysis(
  pool: Pool,
  input: { sessionId: string; capabilities: readonly YouCamCapability[]; fingerprint: string; now: Date },
): Promise<void> {
  for (const capability of input.capabilities) {
    await pool.query(
      `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, created_at, updated_at)
       VALUES ($1, $2, $3, 'queued', $4, $5, '{}'::jsonb, $6, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), input.sessionId, capability, 0, `analysis:${input.sessionId}:${input.fingerprint}:${capability}`, input.now],
    );
  }
  const current = await pool.query<{ analysis_fingerprint: string | null }>(
    `SELECT analysis_fingerprint FROM demo_sessions WHERE id = $1`,
    [input.sessionId],
  );
  if (captureStamp(current.rows[0]?.analysis_fingerprint ?? null) !== input.fingerprint) {
    await pool.query(
      `UPDATE demo_sessions SET analysis_fingerprint = $2, analysis = $3::jsonb WHERE id = $1`,
      [input.sessionId, input.fingerprint, JSON.stringify(unknownAnalysis("youcam"))],
    );
  }
  await refreshAnalysis(pool, input.sessionId);
}

/**
 * Jobs this process is uploading, submitting or polling right now. The 2 s ticker used to re-claim a job whose
 * upload+submit was still in flight (status 'running', no task id yet) and submit it again, which created
 * duplicate paid YouCam tasks on a slow network (27 Oct 2026: 14 hair-transfer tasks for 3 previews).
 */
const inFlight = new Set<string>();

export function demoJobsInFlight(): readonly string[] {
  return [...inFlight];
}

type AdvanceInput = {
  pool: Pool;
  storage: PrivateStorage;
  youcam: YouCamClient;
  openai?: OpenAIClient | null;
  budgetUsd?: number;
  now: Date;
  renderCacheDir?: string;
  renderJobTimeoutMs?: number;
};

export async function advanceDemoJobs(input: {
  pool: Pool;
  storage: PrivateStorage;
  youcam: YouCamClient;
  openai?: OpenAIClient | null;
  budgetUsd?: number;
  now: Date;
  renderCacheDir?: string;
  renderJobTimeoutMs?: number;
}): Promise<void> {
  const client = await input.pool.connect();
  let job: JobRow | null = null;
  try {
    await client.query("BEGIN");
    const claimed = await client.query<JobRow>(
      `UPDATE demo_jobs SET status = 'running', updated_at = $1
       WHERE id = (
         SELECT id FROM demo_jobs WHERE status IN ('queued', 'running') AND NOT (id::text = ANY($2::text[])) ORDER BY updated_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING id, session_id, capability, provider_task_id, payload, storage_key, submitted_at`,
      [input.now, [...inFlight]],
    );
    job = claimed.rows[0] ?? null;
    // Marked in flight in the same synchronous step as the claim, so a tick that raced this one can never process it too.
    if (job && inFlight.has(job.id)) job = null;
    if (job) inFlight.add(job.id);
    await client.query("COMMIT");
  } catch (error) {
    if (job) inFlight.delete(job.id);
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (!job) return;
  try {
    if (isYouCamCapability(job.capability)) await processDemoJob(input, job);
  } finally {
    inFlight.delete(job.id);
  }
}

async function processDemoJob(input: AdvanceInput, job: JobRow): Promise<void> {
  if (!isYouCamCapability(job.capability)) return;
  const recolour = recolourPayload(job);
  // A colour correction runs on the hairstyle render, not on the client's own photo.
  const photos = recolour
    ? new Map([["front", await readKey(input.storage, recolour.sourceKey)]])
    : await loadPhotos(input.pool, input.storage, job.session_id);
  const mapped = mapPhotos(job.capability, photos);
  if (!mapped) {
    console.error(`demo_analysis_task_failed capability=${job.capability} code=INVALID_PHOTO detail=missing_photo_roles have=${[...photos.keys()].join(",")}`);
    await failJob(input.pool, job.id, "INVALID_PHOTO", input.now, null);
    await markPreviewFailed(input.pool, job);
    await settleAnalysis(input, job.session_id);
    return;
  }
  const renderJob = job.capability === "hairstyle" || job.capability === "hair-color" || job.capability === "beard";
  const timeoutMs = input.renderJobTimeoutMs ?? 45_000;
  if (
    renderJob
    && job.submitted_at
    && input.now.getTime() - job.submitted_at.getTime() > timeoutMs
  ) {
    if (recolour) {
      await keepUncorrected(input, job, recolour, "PROVIDER_UNAVAILABLE", RENDER_TIMEOUT_REASON);
      return;
    }
    const served = await serveCachedPreview(input, job, photos);
    if (served) return;
    await failJob(input.pool, job.id, "PROVIDER_UNAVAILABLE", input.now, null, RENDER_TIMEOUT_REASON);
    await markPreviewFailed(input.pool, job);
    return;
  }
  const reference = await referenceBytes(input.pool, input.storage, job);
  // A template hair transfer changes the client's hair colour: only a reference photo (hair_color "src") may be submitted.
  if (job.capability === "hairstyle" && job.provider_task_id === null && !reference) {
    console.error(`demo_task_refused capability=hairstyle code=TEMPLATE_RENDER_REFUSED candidate=${previewKey(job)}`);
    await failJob(input.pool, job.id, "UNSUPPORTED_CONFIGURATION", input.now, null, TEMPLATE_RENDER_REFUSAL);
    await markPreviewFailed(input.pool, job);
    return;
  }
  const submitting = job.provider_task_id === null;
  let result: Awaited<ReturnType<YouCamClient["run"]>>;
  try {
    result = await input.youcam.run({
      capability: job.capability,
      photos: mapped,
      controls: reference ? {} : controlsFor(job),
      providerTaskId: job.provider_task_id,
      now: input.now,
      submittedAt: job.submitted_at,
      ...(reference ? { referenceBytes: reference } : {}),
    });
  } catch (error: unknown) {
    if (!submitting) throw error;
    console.error(`demo_task_submit_error capability=${job.capability} ${error instanceof Error ? error.name : "error"}`);
    result = { kind: "failed", code: "PROVIDER_UNAVAILABLE" };
  }
  if (result.kind === "accepted") {
    await input.pool.query(
      `UPDATE demo_jobs SET provider_task_id = $2, submitted_at = $3, status = 'running', updated_at = $3 WHERE id = $1`,
      [job.id, result.taskId, input.now],
    );
    return;
  }
  if (result.kind === "running") return;
  // An unconfirmed submit may already have created a paid task, so it is never sent again on a later tick: it fails and the user retries.
  if (result.kind === "uncertain") result = submitting ? { kind: "failed", code: "SUBMISSION_UNCERTAIN" } : { kind: "running" };
  if (result.kind === "running") return;
  if (result.kind === "failed") {
    console.error(failureLogLine(job.capability, result));
    if (recolour) {
      await keepUncorrected(input, job, recolour, result.code, renderFailureReason(result));
      return;
    }
    if (renderJob && await serveCachedPreview(input, job, photos)) return;
    await failJob(input.pool, job.id, result.code, input.now, result.providerError ?? null, renderFailureReason(result));
    await markPreviewFailed(input.pool, job);
    await settleAnalysis(input, job.session_id);
    return;
  }
  if (result.downloadUrl) {
    const bytes = await input.youcam.readResult(result.downloadUrl);
    if (!bytes) {
      if (recolour) {
        await keepUncorrected(input, job, recolour, "RESULT_EXPIRED", null);
        return;
      }
      if (renderJob && await serveCachedPreview(input, job, photos)) return;
      await failJob(input.pool, job.id, "RESULT_EXPIRED", input.now, null);
      await markPreviewFailed(input.pool, job);
      return;
    }
    const key = job.storage_key ?? randomBytesKey();
    await input.storage.write(key, bytes);
    if (job.capability === "hairstyle" && await queueRecolour(input, job, photos, bytes, key)) return;
    if (renderJob) {
      await persistRenderCache(input, job, photos, bytes);
    }
    await input.pool.query(
      `UPDATE demo_jobs SET status = 'succeeded', storage_key = $2, updated_at = $3 WHERE id = $1`,
      [job.id, key, input.now],
    );
    await markPreviewReady(input.pool, job.session_id, previewKey(job), key, "youcam");
    return;
  }
  await input.pool.query(
    `UPDATE demo_jobs SET status = 'succeeded', result = $2::jsonb, updated_at = $3 WHERE id = $1`,
    [job.id, JSON.stringify(result.evidence.values), input.now],
  );
  await settleAnalysis(input, job.session_id);
}

export async function settleDemoAnalysis(input: { pool: Pool; storage: PrivateStorage; openai?: OpenAIClient | null; sessionId: string; budgetUsd?: number }): Promise<void> {
  await refreshAnalysis(input.pool, input.sessionId);
  if (!input.openai) return;
  try {
    await trackVision(input.sessionId, attachVisionIfReady({ pool: input.pool, storage: input.storage, openai: input.openai, sessionId: input.sessionId, ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}) }));
  } catch (error: unknown) {
    console.error(`demo_vision_failed ${error instanceof Error ? error.name : "error"}`);
  }
}

async function settleAnalysis(input: { pool: Pool; storage: PrivateStorage; openai?: OpenAIClient | null; budgetUsd?: number }, sessionId: string): Promise<void> {
  await settleDemoAnalysis({ ...input, sessionId });
}

export async function loadAnalysisJobs(pool: Pool, sessionId: string): Promise<{ capability: string; status: string; error_code: string | null }[]> {
  const stamp = await sessionStamp(pool, sessionId);
  const result = await pool.query<{ capability: string; status: string; error_code: string | null }>(
    `SELECT capability, status, error_code FROM demo_jobs
     WHERE session_id = $1
       AND capability NOT IN ('hairstyle', 'hair-color', 'beard')
       AND ($2::text IS NULL OR idempotency_key LIKE $2)`,
    [sessionId, stamp ? `analysis:${sessionId}:${stamp}:%` : null],
  );
  return result.rows;
}

async function refreshAnalysis(pool: Pool, sessionId: string): Promise<void> {
  const jobs = await pool.query<{ capability: string; status: string; result: unknown }>(
    `SELECT capability, status, result FROM demo_jobs
     WHERE session_id = $1
       AND capability NOT IN ('hairstyle', 'hair-color', 'beard')
       AND ($2::text IS NULL OR idempotency_key LIKE $2)`,
    [sessionId, await jobKeyPrefix(pool, sessionId)],
  );
  if (jobs.rows.length === 0) return;
  const stored = await pool.query<{ analysis: unknown }>(`SELECT analysis FROM demo_sessions WHERE id = $1`, [sessionId]);
  const previous = parsePerson(stored.rows[0]?.analysis);
  let analysis = unknownAnalysis("youcam");
  for (const row of jobs.rows) {
    if (row.status === "succeeded" && isRecord(row.result) && typeof row.result.providerError !== "string") {
      analysis = applyEvidence(analysis, row.capability, row.result);
    }
  }
  if (previous) analysis = restoreVisionFields(previous, analysis);
  const status = analysisOutcome(jobs.rows);
  await pool.query(
    `UPDATE demo_sessions SET analysis = $2::jsonb, analysis_status = $3 WHERE id = $1`,
    [sessionId, JSON.stringify(analysis), status],
  );
}

async function sessionStamp(pool: Pool, sessionId: string): Promise<string | null> {
  const stored = await pool.query<{ analysis_fingerprint: string | null }>(
    `SELECT analysis_fingerprint FROM demo_sessions WHERE id = $1`,
    [sessionId],
  );
  return captureStamp(stored.rows[0]?.analysis_fingerprint ?? null);
}

async function jobKeyPrefix(pool: Pool, sessionId: string): Promise<string | null> {
  const stamp = await sessionStamp(pool, sessionId);
  return stamp ? `analysis:${sessionId}:${stamp}:%` : null;
}

type RecolourPayload = { sourceKey: string; hex: string };

/** A hair-color job queued by queueRecolour: it recolours the stored hairstyle render to the client's own hair colour. */
function recolourPayload(job: JobRow): RecolourPayload | null {
  if (job.capability !== "hair-color") return null;
  const payload = isRecord(job.payload) ? job.payload : {};
  const { recolourSourceKey: sourceKey, hex } = payload;
  if (typeof sourceKey !== "string" || !/^[a-f0-9]{64}$/.test(sourceKey)) return null;
  if (typeof hex !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
  return { sourceKey, hex };
}

/**
 * YouCam can carry the reference photo's hair colour into the render even with hair_color "src". When the render's hair colour is
 * drastically off the client's own, the preview stays pending and a one-unit hair-color job recolours it; anything milder is shown as is.
 */
async function queueRecolour(input: AdvanceInput, job: JobRow, photos: Map<string, Buffer>, render: Buffer, renderKey: string): Promise<boolean> {
  if (process.env.HAIR_RECOLOUR === "0") return false;
  const front = photos.get("front");
  if (!front) return false;
  let comparison: Awaited<ReturnType<typeof compareHairColour>>;
  try {
    comparison = await compareHairColour(front, render);
  } catch {
    return false;
  }
  const recolour = needsRecolour(comparison);
  console.warn(`demo_recolour candidate=${previewKey(job)} decision=${recolour ? "recolour" : "keep"}${comparison ? ` dE=${comparison.dE.toFixed(1)} dL=${comparison.dL.toFixed(1)} user=${comparison.user.hex} render=${comparison.render.hex}` : " measured=no"}`);
  if (!recolour || !comparison) return false;
  const payload = isRecord(job.payload) ? job.payload : {};
  await input.pool.query(
    `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, created_at, updated_at)
     VALUES ($1, $2, 'hair-color', 'queued', 0, $3, $4::jsonb, $5, $5) ON CONFLICT DO NOTHING`,
    [randomUUID(), job.session_id, `recolour:${job.id}`, JSON.stringify({
      candidateKey: previewKey(job),
      recolourSourceKey: renderKey,
      hex: comparison.user.hex,
      ...(typeof payload.cacheStyle === "string" ? { cacheStyle: payload.cacheStyle } : {}),
    }), input.now],
  );
  await input.pool.query(
    `UPDATE demo_jobs SET status = 'succeeded', storage_key = $2, updated_at = $3 WHERE id = $1`,
    [job.id, renderKey, input.now],
  );
  return true;
}

/** The recolour step failed or timed out: the client still gets the hairstyle render as it came back. */
async function keepUncorrected(input: AdvanceInput, job: JobRow, recolour: RecolourPayload, code: string, reason: string | null): Promise<void> {
  await failJob(input.pool, job.id, code, input.now, null, reason);
  await markPreviewReady(input.pool, job.session_id, previewKey(job), recolour.sourceKey, "youcam");
}

async function failJob(pool: Pool, id: string, code: string, now: Date, providerError: string | null, reason: string | null = null): Promise<void> {
  const clipped = clipProviderReason(providerError);
  const result = { ...(clipped ? { providerError: clipped } : {}), ...(reason ? { reason } : {}) };
  await pool.query(
    `UPDATE demo_jobs SET status = 'failed', error_code = $2, result = $4::jsonb, updated_at = $3 WHERE id = $1`,
    [id, code, now, Object.keys(result).length > 0 ? JSON.stringify(result) : null],
  );
}

async function markPreviewFailed(pool: Pool, job: JobRow): Promise<void> {
  if (job.capability !== "hairstyle" && job.capability !== "hair-color" && job.capability !== "beard") return;
  const key = previewKey(job);
  if (!key) return;
  await pool.query(
    `UPDATE demo_previews SET status = 'failed', detail = '{}'::jsonb WHERE session_id = $1 AND candidate_key = $2 AND status = 'pending'`,
    [job.session_id, key],
  );
}

async function markPreviewReady(
  pool: Pool,
  sessionId: string,
  candidateKey: string,
  storageKeyValue: string,
  source: PreviewImageSource,
): Promise<void> {
  await pool.query(
    `UPDATE demo_previews SET status = 'ready', storage_key = $3, detail = $4::jsonb
     WHERE session_id = $1 AND candidate_key = $2 AND status IN ('pending', 'failed')`,
    [sessionId, candidateKey, storageKeyValue, JSON.stringify(detailWithSource(source))],
  );
}

async function persistRenderCache(
  input: { pool: Pool; renderCacheDir?: string },
  job: JobRow,
  photos: Map<string, Buffer>,
  bytes: Buffer,
): Promise<void> {
  const cacheDir = input.renderCacheDir;
  const frontHash = await frontPhotoHash(input.pool, job.session_id, photos);
  const candidate = previewKey(job);
  if (!cacheDir || !frontHash || !candidate) return;
  const payload = isRecord(job.payload) ? job.payload : {};
  const templateId = typeof payload.cacheStyle === "string" ? payload.cacheStyle : typeof payload.templateId === "string" ? payload.templateId : null;
  await writeRenderCache({ cacheDir, contentHash: frontHash, candidateKey: candidate, templateId, bytes });
}

async function serveCachedPreview(
  input: { pool: Pool; storage: PrivateStorage; renderCacheDir?: string; now: Date },
  job: JobRow,
  photos: Map<string, Buffer>,
): Promise<boolean> {
  if (job.capability !== "hairstyle" && job.capability !== "hair-color" && job.capability !== "beard") return false;
  const cacheDir = input.renderCacheDir;
  const candidate = previewKey(job);
  const frontHash = await frontPhotoHash(input.pool, job.session_id, photos);
  if (!cacheDir || !candidate || !frontHash) return false;
  const payload = isRecord(job.payload) ? job.payload : {};
  const templateId = typeof payload.cacheStyle === "string" ? payload.cacheStyle : typeof payload.templateId === "string" ? payload.templateId : null;
  let sampleHash: string | null = null;
  try {
    sampleHash = await sampleFrontPhotoHash();
  } catch {
    sampleHash = null;
  }
  const cached = await readRenderCache({
    cacheDir,
    contentHash: frontHash,
    candidateKey: candidate,
    templateId,
    samplePhotoHash: sampleHash,
  });
  if (!cached) return false;
  const key = job.storage_key ?? randomBytesKey();
  await input.storage.write(key, cached);
  await input.pool.query(
    `UPDATE demo_jobs SET status = 'succeeded', storage_key = $2, error_code = NULL, updated_at = $3 WHERE id = $1`,
    [job.id, key, input.now],
  );
  await markPreviewReady(input.pool, job.session_id, candidate, key, "cached");
  return true;
}

async function frontPhotoHash(pool: Pool, sessionId: string, loaded: Map<string, Buffer>): Promise<string | null> {
  const fromDb = await pool.query<{ content_hash: string }>(
    `SELECT content_hash FROM demo_photos WHERE session_id = $1 AND role = 'front' LIMIT 1`,
    [sessionId],
  );
  const hash = fromDb.rows[0]?.content_hash;
  if (hash) return hash;
  if (!loaded.has("front")) return null;
  return null;
}

function controlsFor(job: JobRow): Record<string, unknown> {
  const payload = isRecord(job.payload) ? job.payload : {};
  if (job.capability === "face-attributes") {
    return {
      features: [...HACKATHON_FACE_FEATURES],
      face_angle_strictness_level: "medium",
    };
  }
  if (job.capability === "facial-color-tones") return { face_angle_strictness_level: "medium" };
  if (job.capability === "hairstyle" || job.capability === "beard") {
    return typeof payload.templateId === "string" ? { template_id: payload.templateId } : {};
  }
  if (job.capability === "hair-color" && recolourPayload(job)) {
    return { pattern: { name: "full" }, palettes: [{ color: recolourPayload(job)!.hex }] };
  }
  if (job.capability === "hair-color") return typeof payload.preset === "string" ? { preset: payload.preset } : {};
  return {};
}

function previewKey(job: JobRow): string {
  const payload = isRecord(job.payload) ? job.payload : {};
  return typeof payload.candidateKey === "string" ? payload.candidateKey : "";
}

async function referenceBytes(pool: Pool, storage: PrivateStorage, job: JobRow): Promise<Buffer | null> {
  const payload = isRecord(job.payload) ? job.payload : {};
  if (typeof payload.assetFile === "string" && /^[a-z0-9-]+\.jpg$/.test(payload.assetFile)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      return await readFile(join(process.cwd(), "assets", "references", payload.assetFile));
    } catch {
      return null;
    }
  }
  if (isCatalogueReferenceFile(payload.catalogueRef)) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      return await readFile(join(demoMediaRoot(), payload.catalogueRef));
    } catch {
      return null;
    }
  }
  if (typeof payload.referenceId !== "string") return null;
  const found = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM demo_references WHERE session_id = $1 AND id = $2`,
    [job.session_id, payload.referenceId],
  );
  const key = found.rows[0]?.storage_key;
  if (!key) return null;
  return readKey(storage, key);
}

function mapPhotos(capability: YouCamCapability, photos: Map<string, Buffer>): { role: string; bytes: Buffer }[] | null {
  const front = photos.get("front");
  if (!front) return null;
  if (capability === "hair-type" || capability === "hair-frizziness") {
    const left = photos.get("left");
    const right = photos.get("right");
    if (!left || !right) return null;
    return [
      { role: "front", bytes: front },
      { role: "right", bytes: left },
      { role: "left", bytes: right },
    ];
  }
  if (capability === "hair-length") return [{ role: "length", bytes: front }];
  if (capability === "hair-density") {
    const crown = photos.get("crown");
    return crown ? [{ role: "density", bytes: crown }] : null;
  }
  if (capability === "face-attributes" || capability === "facial-color-tones") return [{ role: "face", bytes: front }];
  return [{ role: "source", bytes: front }];
}

async function loadPhotos(pool: Pool, storage: PrivateStorage, sessionId: string): Promise<Map<string, Buffer>> {
  const result = await pool.query<{ role: string; storage_key: string }>(
    `SELECT role, storage_key FROM demo_photos WHERE session_id = $1`,
    [sessionId],
  );
  const photos = new Map<string, Buffer>();
  for (const row of result.rows) photos.set(row.role, await readKey(storage, row.storage_key));
  return photos;
}

async function readKey(storage: PrivateStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.stream(key)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function randomBytesKey(): string {
  return randomBytes(32).toString("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
