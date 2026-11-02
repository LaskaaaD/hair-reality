import type { Pool, PoolClient } from "pg";
import type { HaircutAlternative, HaircutFinding, HaircutPreviewScreen, HaircutProposal, StoredPreview } from "../../shared/previews.js";
import { withConsultationLock } from "../consultations/records.js";
import { candidateIdFromJobConfiguration } from "./request.js";

const ACTIVE = ["QUEUED", "CLAIMED", "UPLOADING", "SUBMITTING", "RUNNING"];

export class PreviewRejected extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readHaircutPreviews(pool: Pool, userId: string, consultationId: string): Promise<HaircutPreviewScreen | null> {
  const owned = await pool.query<{ version: number }>(
    `SELECT version FROM consultations
     WHERE id = $1 AND deleted_at IS NULL
       AND (
         client_user_id = $2
         OR EXISTS (
           SELECT 1 FROM salon_memberships
           WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
         )
       )`,
    [consultationId, userId],
  );
  const consultation = owned.rows[0];
  if (!consultation) return null;
  const photos = await pool.query<{ id: string; role: string }>(
    `SELECT id, role FROM assets
     WHERE consultation_id = $1 AND role = ANY($2::text[]) AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC`,
    [consultationId, ["current_front", "beard"]],
  );
  const frontId = photos.rows.find((row) => row.role === "current_front")?.id ?? null;
  const beardId = photos.rows.find((row) => row.role === "beard")?.id ?? null;
  const services = await pool.query<{ id: string; kind: "haircut" | "colour" | "beard"; input_version: number }>(
    `SELECT id, kind, input_version FROM consultation_services
     WHERE consultation_id = $1 AND kind = ANY($2::text[]) AND selected = true
     ORDER BY CASE kind WHEN 'haircut' THEN 0 WHEN 'colour' THEN 1 ELSE 2 END, id`,
    [consultationId, ["haircut", "colour", "beard"]],
  );
  const pending = await pool.query<{ configuration_fingerprint: string }>(
    `SELECT configuration_fingerprint FROM provider_jobs
     WHERE consultation_id = $1 AND operation = 'preview' AND state = ANY($2::text[])`,
    [consultationId, ACTIVE],
  );
  const pendingIds = pending.rows.flatMap((row) => {
    const id = candidateIdFromJobConfiguration(row.configuration_fingerprint);
    return id === null ? [] : [id];
  });
  const presented = [];
  for (const service of services.rows) {
    const sourceAssetId = service.kind === "beard" ? beardId ?? frontId : frontId;
    presented.push(await presentService(pool, service.id, service.kind, service.input_version, pendingIds, sourceAssetId));
  }
  return {
    consultationId,
    version: consultation.version,
    sourceAssetId: frontId,
    services: presented,
  };
}

export async function selectPreviewForActor(
  pool: Pool,
  userId: string,
  consultationId: string,
  serviceId: string,
  previewId: string,
  expectedVersion: number,
): Promise<void> {
  const access = await pool.query<{ owner: boolean; member: boolean }>(
    `SELECT consultations.client_user_id = $2 AS owner,
            EXISTS (
              SELECT 1 FROM salon_memberships
              WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
            ) AS member
     FROM consultations
     WHERE id = $1 AND deleted_at IS NULL`,
    [consultationId, userId],
  );
  const row = access.rows[0];
  if (!row) throw new PreviewRejected(404, "not_found", "That consultation is not available.");
  if (row.owner) {
    await selectPreview(pool, userId, consultationId, serviceId, previewId, expectedVersion);
    return;
  }
  if (row.member) {
    await selectReviewPreview(pool, userId, consultationId, serviceId, previewId, expectedVersion);
    return;
  }
  throw new PreviewRejected(404, "not_found", "That consultation is not available.");
}

async function selectReviewPreview(
  pool: Pool,
  userId: string,
  consultationId: string,
  serviceId: string,
  previewId: string,
  expectedVersion: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ version: number; lifecycle: string }>(
      `SELECT version, lifecycle FROM consultations
       WHERE id = $1 AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM salon_memberships
           WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
         )
       FOR UPDATE`,
      [consultationId, userId],
    );
    const row = locked.rows[0];
    if (!row) throw new PreviewRejected(404, "not_found", "That consultation is not available.");
    if (row.lifecycle !== "STYLIST_REVIEWING" && row.lifecycle !== "CONSULTATION_REQUIRED") {
      throw new PreviewRejected(409, "state_conflict", "A stylist selects a preview during review.");
    }
    if (row.version !== expectedVersion) {
      throw new PreviewRejected(409, "stale_version", "Reload this consultation before choosing a preview.");
    }
    const preview = await client.query<{ stale: boolean; freshness: string }>(
      `SELECT previews.stale, previews.freshness
       FROM previews
       JOIN consultation_services ON consultation_services.id = previews.consultation_service_id
       WHERE previews.id = $1
         AND consultation_services.id = $2
         AND consultation_services.consultation_id = $3
         AND consultation_services.selected = true`,
      [previewId, serviceId, consultationId],
    );
    const chosen = preview.rows[0];
    if (!chosen) throw new PreviewRejected(404, "not_found", "That preview is not available.");
    if (chosen.stale || chosen.freshness !== "current") {
      throw new PreviewRejected(409, "stale_preview", "A stale preview cannot be the current selection.");
    }
    await client.query("UPDATE previews SET selected = false WHERE consultation_service_id = $1 AND selected = true", [serviceId]);
    await client.query("UPDATE previews SET selected = true WHERE id = $1", [previewId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function selectPreview(
  pool: Pool,
  userId: string,
  consultationId: string,
  serviceId: string,
  previewId: string,
  expectedVersion: number,
): Promise<void> {
  const result = await withConsultationLock(pool, userId, consultationId, expectedVersion, async (client) => {
    const preview = await client.query<{ stale: boolean; freshness: string }>(
      `SELECT previews.stale, previews.freshness
       FROM previews
       JOIN consultation_services ON consultation_services.id = previews.consultation_service_id
       WHERE previews.id = $1
         AND consultation_services.id = $2
         AND consultation_services.consultation_id = $3
         AND consultation_services.kind = ANY($4::text[])
         AND consultation_services.selected = true`,
      [previewId, serviceId, consultationId, ["haircut", "colour", "beard"]],
    );
    const row = preview.rows[0];
    if (!row) throw new PreviewRejected(404, "not_found", "That preview is not available.");
    if (row.stale || row.freshness !== "current") {
      throw new PreviewRejected(409, "stale_preview", "A stale preview cannot be the current selection.");
    }
    await client.query(
      "UPDATE previews SET selected = false WHERE consultation_service_id = $1 AND selected = true",
      [serviceId],
    );
    await client.query("UPDATE previews SET selected = true WHERE id = $1", [previewId]);
  });
  if (!result.ok) throw new PreviewRejected(result.status, result.code, result.message);
}

async function presentService(
  pool: Pool | PoolClient,
  serviceId: string,
  kind: "haircut" | "colour" | "beard",
  inputVersion: number,
  pendingIds: readonly string[],
  sourceAssetId: string | null,
): Promise<HaircutPreviewScreen["services"][number]> {
  const target = await pool.query<{
    candidate_id: string | null;
    title: string | null;
    interpreted: unknown;
  }>(
    `SELECT targets.candidate_id, candidates.title, targets.interpreted
     FROM targets
     LEFT JOIN candidates ON candidates.id = targets.candidate_id
     WHERE targets.consultation_service_id = $1
     ORDER BY targets.created_at DESC, targets.id DESC
     LIMIT 1`,
    [serviceId],
  );
  const assessment = await pool.query<{ findings: unknown; suggestions: unknown }>(
    `SELECT findings, suggestions FROM reality_assessments
     WHERE consultation_service_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [serviceId],
  );
  const previews = await pool.query<{
    id: string;
    candidate_id: string | null;
    freshness: string;
    stale: boolean;
    selected: boolean;
    result_asset_id: string | null;
    representation_limits: unknown;
    provider_version: string | null;
    service_input_version: number | null;
  }>(
    `SELECT previews.id, previews.candidate_id, previews.freshness, previews.stale, previews.selected,
            previews.result_asset_id, previews.representation_limits, previews.provider_version,
            provider_jobs.service_input_version
     FROM previews
     LEFT JOIN provider_jobs ON provider_jobs.id = previews.job_id
     WHERE previews.consultation_service_id = $1
     ORDER BY previews.created_at DESC, previews.id DESC`,
    [serviceId],
  );
  const dream = dreamOf(target.rows[0]);
  const alternatives = await alternativesOf(pool, assessment.rows[0]?.suggestions, dream?.candidateId ?? null);
  return {
    serviceId,
    kind,
    sourceAssetId,
    inputVersion,
    dream,
    alternatives,
    findings: findingsOf(assessment.rows[0]?.findings, kind),
    previews: previews.rows.map((row) => previewOf(row)),
    pendingCandidateIds: pendingIds.filter((id) => id === dream?.candidateId || alternatives.some((item) => item.candidateId === id)),
  };
}

function dreamOf(row: { candidate_id: string | null; title: string | null; interpreted: unknown } | undefined): HaircutProposal | null {
  if (!row?.candidate_id || !row.title) return null;
  const interpreted = recordOf(row.interpreted);
  const confirmed = recordOf(interpreted.confirmed);
  return {
    candidateId: row.candidate_id,
    title: row.title,
    length: textOrNull(confirmed.length),
    texture: textOrNull(confirmed.texture),
    shade: textOrNull(confirmed.shade),
    referenceFullness: textOrNull(confirmed.referenceFullness),
    unsupported: stringList(interpreted.unsupported),
  };
}

async function alternativesOf(pool: Pool | PoolClient, suggestions: unknown, dreamId: string | null): Promise<HaircutAlternative[]> {
  const alternatives = recordOf(suggestions).alternatives;
  if (!Array.isArray(alternatives)) return [];
  const rows = alternatives.flatMap((item) => {
    const record = recordOf(item);
    const candidateId = textOrNull(record.candidateId);
    if (!candidateId || candidateId === dreamId) return [];
    const colourRole: "dream" | "possible_first_step" | "lower_complexity" | null = record.colourRole === "dream" || record.colourRole === "possible_first_step" || record.colourRole === "lower_complexity" ? record.colourRole : null;
    return [{ candidateId, retained: stringList(record.retained), changed: stringList(record.changed), note: textOrNull(record.note), colourRole }];
  });
  if (rows.length === 0) return [];
  const titles = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM candidates WHERE id = ANY($1::uuid[])",
    [rows.map((row) => row.candidateId)],
  );
  const titleOf = new Map(titles.rows.map((row) => [row.id, row.title]));
  return rows.map((row) => ({
    candidateId: row.candidateId,
    title: titleOf.get(row.candidateId) ?? "Catalogue alternative",
    retained: row.retained,
    changed: row.changed,
    note: row.note,
    colourRole: row.colourRole,
  }));
}

function findingsOf(value: unknown, kind: "haircut" | "colour" | "beard"): HaircutFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    if (record.service !== kind) return [];
    const ruleId = textOrNull(record.ruleId);
    const dimension = textOrNull(record.dimension);
    const outcome = textOrNull(record.outcome);
    const reason = textOrNull(record.reason);
    if (!ruleId || !dimension || !outcome || !reason) return [];
    return [{ ruleId, dimension, outcome, reason }];
  });
}

function previewOf(row: {
  id: string;
  candidate_id: string | null;
  freshness: string;
  stale: boolean;
  selected: boolean;
  result_asset_id: string | null;
  representation_limits: unknown;
  provider_version: string | null;
  service_input_version: number | null;
}): StoredPreview {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    sourceVersion: row.service_input_version,
    freshness: row.freshness,
    stale: row.stale,
    selected: row.selected,
    resultAssetId: row.result_asset_id,
    limits: stringList(row.representation_limits),
    providerVersion: row.provider_version,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function recordOwnedPreview(
  pool: Pool,
  input: {
    jobId: string;
    fencingToken: number;
    owner: string;
    consultationServiceId: string;
    sourceAssetId: string;
    resultAssetId: string;
    serviceInputVersion: number | null;
    freshness: "current" | "stale";
    providerVersion: string;
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owned = await client.query(
      `SELECT 1 FROM provider_jobs
       WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
      [input.jobId, input.fencingToken, input.owner],
    );
    if ((owned.rowCount ?? 0) !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const service = await client.query<{ input_version: number; deleted_at: Date | null }>(
      `SELECT consultation_services.input_version, consultations.deleted_at
       FROM consultation_services
       JOIN consultations ON consultations.id = consultation_services.consultation_id
       WHERE consultation_services.id = $1
       FOR UPDATE OF consultation_services`,
      [input.consultationServiceId],
    );
    const version = service.rows[0]?.input_version;
    const deleted = service.rows[0]?.deleted_at;
    const safeFreshness = deleted || version !== input.serviceInputVersion ? "stale" : input.freshness;
    if (deleted) {
      await client.query("ROLLBACK");
      return false;
    }
    const configured = await client.query<{ configuration_fingerprint: string }>(
      "SELECT configuration_fingerprint FROM provider_jobs WHERE id = $1",
      [input.jobId],
    );
    const configuration = configured.rows[0]?.configuration_fingerprint ?? "";
    const candidateId = candidateIdFromJobConfiguration(configuration);
    const bound = candidateId
      ? await client.query("SELECT 1 FROM candidates WHERE id = $1", [candidateId])
      : { rowCount: 0 };
    const storedCandidate = (bound.rowCount ?? 0) === 1 ? candidateId : null;
    const target = await client.query<{ interpreted: unknown }>(
      `SELECT interpreted FROM targets
       WHERE consultation_service_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.consultationServiceId],
    );
    await client.query(
      `INSERT INTO previews (
         consultation_service_id, job_id, source_asset_id, candidate_id, configuration_fingerprint,
         result_asset_id, provider, provider_version, freshness, stale, representation_limits
       ) VALUES ($1, $2, $3, $4, $5, $6, 'youcam', $7, $8, $9, $10::jsonb)`,
      [
        input.consultationServiceId,
        input.jobId,
        input.sourceAssetId,
        storedCandidate,
        configuration || input.jobId,
        input.resultAssetId,
        input.providerVersion,
        safeFreshness,
        safeFreshness === "stale",
        JSON.stringify(unsupportedLimits(target.rows[0]?.interpreted)),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function unsupportedLimits(interpreted: unknown): string[] {
  if (!interpreted || typeof interpreted !== "object" || Array.isArray(interpreted)) return [];
  const unsupported = (interpreted as { unsupported?: unknown }).unsupported;
  if (!Array.isArray(unsupported)) return [];
  return unsupported.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}
