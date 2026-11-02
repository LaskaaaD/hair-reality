import type { Pool, PoolClient } from "pg";
import type { SessionUser } from "../../shared/auth.js";
import {
  affectedServiceKinds,
  readStoredHistory,
  readStoredPreferences,
  sameBriefValue,
  type ColourHistory,
  type PreferencesInput,
} from "../../shared/client-brief.js";
import { supportedCandidate } from "../catalogue/records.js";
import type { StoredTarget, TargetInput } from "../../shared/catalogue.js";
import {
  consultationSchema,
  missingRequirements,
  serviceInputFingerprint,
  sortServiceKinds,
  type Consultation,
  type ReadinessFact,
  type ServiceKind,
} from "../../shared/consultations.js";

const editableLifecycles = new Set(["DRAFT", "READY_FOR_REVIEW"]);

type Failure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
  currentVersion: number | null;
};

type Success = { ok: true; consultation: Consultation };
type ListSuccess = { ok: true; consultations: Consultation[]; nextCursor: string | null };
export type ConsultationResult = Success | Failure;
export type ConsultationListResult = ListSuccess | Failure;

type ConsultationRow = {
  id: string;
  salon_id: string;
  salon_slug: string;
  client_user_id: string;
  lifecycle: string;
  version: number;
  current_revision_id: string | null;
  deleted_at: Date | null;
  created_at: Date;
};

type ServiceRow = {
  id: string;
  kind: ServiceKind;
  input_version: number;
  has_target: boolean;
  has_assessment: boolean;
  has_preview: boolean;
};

export async function invalidateServiceInputs(pool: Pool, serviceId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ id: string }>(
      `UPDATE consultation_services
       SET input_version = input_version + 1
       WHERE id = $1 AND selected = true
       RETURNING id`,
      [serviceId],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return false;
    }
    await markPreviewsStale(client, [row.id]);
    await client.query(
      `UPDATE consultations
       SET lifecycle = 'DRAFT', version = version + 1
       WHERE id = (SELECT consultation_id FROM consultation_services WHERE id = $1)
         AND lifecycle = 'READY_FOR_REVIEW'
         AND deleted_at IS NULL`,
      [row.id],
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

export async function createConsultation(
  pool: Pool,
  userId: string,
  salonId: string,
  services: readonly ServiceKind[],
): Promise<ConsultationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO consultations (client_user_id, salon_id, lifecycle, version)
       SELECT $1, salons.id, 'DRAFT', 1
       FROM salons
       WHERE salons.id = $2 AND salons.branding->>'kind' = 'demonstration'
       RETURNING id`,
      [userId, salonId],
    );
    const created = inserted.rows[0];
    if (!created) {
      await client.query("ROLLBACK");
      return fail(404, "not_found", "That salon is not available.");
    }
    await insertServices(client, created.id, services);
    const consultation = await loadOwned(client, created.id, userId);
    await client.query("COMMIT");
    if (!consultation) return fail(404, "not_found", "That consultation is not available.");
    return { ok: true, consultation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateDraft(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  services: readonly ServiceKind[],
  brief: { history?: ColourHistory; preferences?: PreferencesInput } = {},
): Promise<ConsultationResult> {
  return mutate(pool, userId, consultationId, expectedVersion, async (client, row) => {
    const previous = await loadBriefRows(client, row.id);
    await replaceSelection(client, row.id, services);
    const affected = affectedServiceKinds(services, previous, brief);
    await bumpSelectedInputs(client, row.id, affected);
    const nextVersion = row.version + 1;
    if (brief.history && !sameBriefValue(previous.history, brief.history)) {
      await client.query(
        `INSERT INTO hair_histories (consultation_id, version, answers)
         VALUES ($1, $2, $3::jsonb)`,
        [row.id, nextVersion, JSON.stringify(brief.history)],
      );
    }
    if (brief.preferences && !sameBriefValue(previous.preferences, brief.preferences)) {
      await client.query(
        `INSERT INTO preferences (consultation_id, version, payload)
         VALUES ($1, $2, $3::jsonb)`,
        [row.id, nextVersion, JSON.stringify(brief.preferences)],
      );
    }
    const written = await client.query(
      `UPDATE consultations
       SET lifecycle = 'DRAFT', version = version + 1
       WHERE id = $1 AND version = $2 AND client_user_id = $3 AND deleted_at IS NULL`,
      [row.id, row.version, userId],
    );
    if ((written.rowCount ?? 0) !== 1) throw new Error("Draft version was not saved");
  });
}

export async function saveTarget(
  pool: Pool,
  userId: string,
  consultationId: string,
  input: TargetInput,
): Promise<ConsultationResult> {
  return mutate(pool, userId, consultationId, input.expectedVersion, async (client, row) => {
    const service = await client.query<{ id: string }>(
      `SELECT id FROM consultation_services
       WHERE consultation_id = $1 AND kind = $2 AND selected = true`,
      [row.id, input.serviceKind],
    );
    const serviceId = service.rows[0]?.id;
    if (!serviceId) throw new TargetRejected("serviceKind", "Choose a selected service.");
    if (input.candidateId) {
      const candidate = await supportedCandidate(client, row.salon_id, input.candidateId, input.serviceKind);
      if (!candidate) throw new TargetRejected("candidateId", "That catalogue entry is not available for this service.");
    }
    if (input.inspirationAssetId) {
      const asset = await client.query(
        `SELECT 1 FROM assets
         WHERE id = $1 AND consultation_id = $2 AND role = 'inspiration' AND deleted_at IS NULL`,
        [input.inspirationAssetId, row.id],
      );
      if ((asset.rowCount ?? 0) !== 1) throw new TargetRejected("inspirationAssetId", "That inspiration photograph is not available.");
    }
    const interpreted = {
      confirmed: input.confirmed,
      unsupported: input.unsupported,
      proposals: input.proposals,
    };
    await client.query(
      `INSERT INTO targets (
         consultation_service_id, source_kind, inspiration_asset_id, candidate_id, description, interpreted, uncertainty
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        serviceId,
        input.sourceKind,
        input.inspirationAssetId ?? null,
        input.candidateId ?? null,
        input.description ?? null,
        JSON.stringify(interpreted),
        input.proposals.length > 0 || input.unsupported.length > 0 ? "review" : null,
      ],
    );
    await bumpSelectedInputs(client, row.id, [input.serviceKind]);
    const written = await client.query(
      `UPDATE consultations
       SET lifecycle = 'DRAFT', version = version + 1
       WHERE id = $1 AND version = $2 AND client_user_id = $3 AND deleted_at IS NULL`,
      [row.id, row.version, userId],
    );
    if ((written.rowCount ?? 0) !== 1) throw new Error("Target version was not saved");
  });
}

export class TargetRejected extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

export async function readTargets(pool: Pool, consultationId: string): Promise<StoredTarget[]> {
  const result = await pool.query<{
    kind: ServiceKind;
    source_kind: StoredTarget["sourceKind"];
    candidate_id: string | null;
    title: string | null;
    description: string | null;
    inspiration_asset_id: string | null;
    interpreted: unknown;
  }>(
    `SELECT DISTINCT ON (s.kind)
            s.kind, t.source_kind, t.candidate_id, c.title, t.description, t.inspiration_asset_id, t.interpreted
     FROM consultation_services s
     JOIN targets t ON t.consultation_service_id = s.id
     LEFT JOIN candidates c ON c.id = t.candidate_id
     WHERE s.consultation_id = $1 AND s.selected = true
     ORDER BY s.kind, t.created_at DESC, t.id DESC`,
    [consultationId],
  );
  return result.rows.flatMap((row) => {
    const interpreted = interpretedOf(row.interpreted);
    if (!interpreted) return [];
    return [{
      serviceKind: row.kind,
      sourceKind: row.source_kind,
      candidateId: row.candidate_id,
      title: row.title,
      description: row.description,
      inspirationAssetId: row.inspiration_asset_id,
      confirmed: interpreted.confirmed,
      unsupported: interpreted.unsupported,
      proposals: interpreted.proposals,
    }];
  });
}

function interpretedOf(value: unknown): { confirmed: StoredTarget["confirmed"]; unsupported: string[]; proposals: StoredTarget["proposals"] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { confirmed?: unknown; unsupported?: unknown; proposals?: unknown };
  if (!record.confirmed || typeof record.confirmed !== "object" || Array.isArray(record.confirmed)) return null;
  if (!Array.isArray(record.unsupported) || !record.unsupported.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(record.proposals)) return null;
  const proposals: StoredTarget["proposals"] = [];
  for (const item of record.proposals) {
    if (!item || typeof item !== "object") return null;
    const proposal = item as { statement?: unknown; support?: unknown; confirmed?: unknown };
    if (typeof proposal.statement !== "string" || proposal.support !== "unknown" || proposal.confirmed !== false) return null;
    proposals.push({ statement: proposal.statement, support: "unknown", confirmed: false });
  }
  return { confirmed: record.confirmed as StoredTarget["confirmed"], unsupported: record.unsupported, proposals };
}

export async function checkReadiness(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
): Promise<ConsultationResult> {
  return mutate(pool, userId, consultationId, expectedVersion, async (client, row) => {
    const facts = await readinessFacts(client, row.id);
    const ready = missingRequirements(facts).length === 0;
    const next = ready ? "READY_FOR_REVIEW" : "DRAFT";
    if (next === row.lifecycle) return;
    const written = await client.query(
      `UPDATE consultations
       SET lifecycle = $4, version = version + 1
       WHERE id = $1 AND version = $2 AND client_user_id = $3 AND deleted_at IS NULL`,
      [row.id, row.version, userId, next],
    );
    if ((written.rowCount ?? 0) !== 1) throw new Error("Readiness version was not saved");
  });
}

export async function readConsultation(pool: Pool, actor: SessionUser, consultationId: string): Promise<ConsultationResult> {
  const result = await pool.query<ConsultationRow>(
    `${visibleSql()} AND c.id = $1`,
    [consultationId, actor.id],
  );
  const row = result.rows[0];
  if (!row || row.deleted_at) return fail(404, "not_found", "That consultation is not available.");
  const consultation = await present(pool, row, actor.id);
  return { ok: true, consultation };
}

export async function listConsultations(
  pool: Pool,
  userId: string,
  cursor: { createdAt: string; id: string } | null,
  limit: number,
): Promise<ConsultationListResult> {
  const result = await pool.query<ConsultationRow>(
    `SELECT ${columns()}
     FROM consultations c
     JOIN salons s ON s.id = c.salon_id
     WHERE c.client_user_id = $1 AND c.deleted_at IS NULL
       AND ($2::timestamptz IS NULL OR (c.created_at, c.id) < ($2::timestamptz, $3::uuid))
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $4`,
    [userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
  );
  const page = result.rows.slice(0, limit);
  const extra = result.rows[limit];
  const consultations = await Promise.all(page.map((row) => present(pool, row, userId)));
  return {
    ok: true,
    consultations,
    nextCursor: extra ? encodeCursor(extra.created_at, extra.id) : null,
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(value: string): { createdAt: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) return null;
    if (typeof record.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)) {
      return null;
    }
    return { createdAt: new Date(record.createdAt).toISOString(), id: record.id };
  } catch {
    return null;
  }
}

export async function withConsultationLock(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  change: (client: PoolClient, row: ConsultationRow) => Promise<void>,
): Promise<ConsultationResult> {
  return mutate(pool, userId, consultationId, expectedVersion, change);
}

async function mutate(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  change: (client: PoolClient, row: ConsultationRow) => Promise<void>,
): Promise<ConsultationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<ConsultationRow & { member: boolean }>(
      `SELECT ${columns()},
              EXISTS (
                SELECT 1 FROM salon_memberships m
                WHERE m.salon_id = c.salon_id AND m.user_id = $2 AND m.role IN ('stylist', 'admin')
              ) AS member
       FROM consultations c
       JOIN salons s ON s.id = c.salon_id
       WHERE c.id = $1
       FOR UPDATE OF c`,
      [consultationId, userId],
    );
    const row = locked.rows[0];
    if (!row || row.deleted_at) {
      await client.query("ROLLBACK");
      return fail(404, "not_found", "That consultation is not available.");
    }
    if (row.client_user_id !== userId) {
      await client.query("ROLLBACK");
      return row.member
        ? fail(403, "forbidden", "You cannot change this consultation.")
        : fail(404, "not_found", "That consultation is not available.");
    }
    if (!editableLifecycles.has(row.lifecycle)) {
      await client.query("ROLLBACK");
      return fail(409, "state_conflict", "This consultation can no longer be edited.", row.version);
    }
    if (row.version !== expectedVersion) {
      await client.query("ROLLBACK");
      return fail(409, "stale_version", "Another edit was saved. Reload this consultation before saving again.", row.version);
    }
    await change(client, row);
    const consultation = await loadOwned(client, consultationId, userId);
    await client.query("COMMIT");
    if (!consultation) return fail(404, "not_found", "That consultation is not available.");
    return { ok: true, consultation };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replaceSelection(client: PoolClient, consultationId: string, services: readonly ServiceKind[]): Promise<void> {
  const retired = await client.query<{ id: string }>(
    `UPDATE consultation_services
     SET selected = false
     WHERE consultation_id = $1 AND selected = true AND NOT (kind = ANY($2::text[]))
     RETURNING id`,
    [consultationId, services],
  );
  await markPreviewsStale(client, retired.rows.map((row) => row.id));
  await client.query(
    `INSERT INTO consultation_services (consultation_id, kind)
     SELECT $1, desired.kind
     FROM unnest($2::text[]) AS desired(kind)
     WHERE NOT EXISTS (
       SELECT 1 FROM consultation_services existing
       WHERE existing.consultation_id = $1 AND existing.kind = desired.kind AND existing.selected = true
     )`,
    [consultationId, services],
  );
}

async function insertServices(client: PoolClient, consultationId: string, services: readonly ServiceKind[]): Promise<void> {
  await client.query(
    `INSERT INTO consultation_services (consultation_id, kind)
     SELECT $1, desired.kind FROM unnest($2::text[]) AS desired(kind)`,
    [consultationId, sortServiceKinds(services)],
  );
}

async function loadBriefRows(
  client: PoolClient,
  consultationId: string,
): Promise<{ history: ColourHistory | null; preferences: PreferencesInput | null }> {
  const history = await client.query<{ answers: unknown }>(
    `SELECT answers FROM hair_histories
     WHERE consultation_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [consultationId],
  );
  const preferences = await client.query<{ payload: unknown }>(
    `SELECT payload FROM preferences
     WHERE consultation_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [consultationId],
  );
  return {
    history: readStoredHistory(history.rows[0]?.answers),
    preferences: readStoredPreferences(preferences.rows[0]?.payload),
  };
}

async function bumpSelectedInputs(client: PoolClient, consultationId: string, kinds: readonly ServiceKind[]): Promise<void> {
  if (kinds.length === 0) return;
  const updated = await client.query<{ id: string }>(
    `UPDATE consultation_services
     SET input_version = input_version + 1
     WHERE consultation_id = $1 AND selected = true AND kind = ANY($2::text[])
     RETURNING id`,
    [consultationId, kinds],
  );
  await markPreviewsStale(client, updated.rows.map((row) => row.id));
}

async function markPreviewsStale(client: PoolClient, serviceIds: readonly string[]): Promise<void> {
  if (serviceIds.length === 0) return;
  await client.query(
    `UPDATE previews
     SET stale = true, freshness = 'stale', selected = false
     WHERE consultation_service_id = ANY($1::uuid[])`,
    [serviceIds],
  );
}

async function loadOwned(client: Pool | PoolClient, consultationId: string, userId: string): Promise<Consultation | null> {
  const result = await client.query<ConsultationRow>(
    `SELECT ${columns()}
     FROM consultations c
     JOIN salons s ON s.id = c.salon_id
     WHERE c.id = $1 AND c.client_user_id = $2 AND c.deleted_at IS NULL`,
    [consultationId, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return present(client, row, userId);
}

async function present(client: Pool | PoolClient, row: ConsultationRow, actorId: string): Promise<Consultation> {
  const facts = await readinessFacts(client, row.id);
  const services = await client.query<{ id: string; kind: ServiceKind; input_version: number }>(
    `SELECT id, kind, input_version
     FROM consultation_services
     WHERE consultation_id = $1 AND selected = true
     ORDER BY CASE kind WHEN 'haircut' THEN 1 WHEN 'colour' THEN 2 ELSE 3 END`,
    [row.id],
  );
  const jobs = await client.query<{
    id: string;
    operation: string;
    state: string;
    error_code: string | null;
    mode: "fixture" | "recorded_demo" | "live";
  }>(
    `SELECT id, operation, state, error_code, mode
     FROM provider_jobs
     WHERE consultation_id = $1
     ORDER BY created_at, id`,
    [row.id],
  );
  const missing = missingRequirements(facts);
  const owner = row.client_user_id === actorId;
  return consultationSchema.parse({
    id: row.id,
    salonId: row.salon_id,
    salonSlug: row.salon_slug,
    lifecycle: row.lifecycle,
    version: row.version,
    currentRevisionId: row.current_revision_id,
    services: services.rows.map((service) => ({
      id: service.id,
      kind: service.kind,
      inputVersion: service.input_version,
    })),
    readiness: { ready: missing.length === 0, missing },
    actions: owner && editableLifecycles.has(row.lifecycle) ? ["save", "check_readiness"] : [],
    jobs: jobs.rows.map((job) => ({
      id: job.id,
      operation: job.operation,
      state: job.state,
      errorCode: job.error_code,
      mode: job.mode,
      historical: job.mode === "recorded_demo",
    })),
  });
}

async function readinessFacts(client: Pool | PoolClient, consultationId: string): Promise<ReadinessFact[]> {
  const priorities = await client.query(
    `SELECT 1 FROM preferences
     WHERE consultation_id = $1
       AND jsonb_typeof(payload) = 'object'
       AND payload <> '{}'::jsonb
     LIMIT 1`,
    [consultationId],
  );
  const services = await client.query<ServiceRow>(
    `SELECT s.id, s.kind, s.input_version,
            EXISTS (SELECT 1 FROM targets t WHERE t.consultation_service_id = s.id) AS has_target,
            EXISTS (
              SELECT 1 FROM reality_assessments a
              WHERE a.consultation_service_id = s.id
                AND a.input_fingerprint = 'service:' || s.id::text || ':v' || s.input_version::text
            ) AS has_assessment,
            EXISTS (
              SELECT 1 FROM previews p
              WHERE p.consultation_service_id = s.id
                AND p.stale = false
                AND p.freshness = 'current'
                AND p.selected = true
            ) AS has_preview
     FROM consultation_services s
     WHERE s.consultation_id = $1 AND s.selected = true
     ORDER BY CASE s.kind WHEN 'haircut' THEN 1 WHEN 'colour' THEN 2 ELSE 3 END`,
    [consultationId],
  );
  return services.rows.map((service) => ({
    kind: service.kind,
    hasTarget: service.has_target,
    hasPriorities: (priorities.rowCount ?? 0) > 0,
    hasCurrentAssessment: service.has_assessment,
    hasCurrentPreview: service.has_preview,
  }));
}

function columns(): string {
  return `c.id, c.salon_id, s.slug AS salon_slug, c.client_user_id, c.lifecycle, c.version,
          c.current_revision_id, c.deleted_at, c.created_at`;
}

function visibleSql(): string {
  return `SELECT ${columns()}
          FROM consultations c
          JOIN salons s ON s.id = c.salon_id
          WHERE c.deleted_at IS NULL
            AND (
              c.client_user_id = $2
              OR EXISTS (
                SELECT 1 FROM salon_memberships m
                WHERE m.salon_id = c.salon_id AND m.user_id = $2 AND m.role IN ('stylist', 'admin')
              )
            )`;
}

function fail(status: number, code: string, message: string, currentVersion: number | null = null): Failure {
  return { ok: false, status, code, message, currentVersion };
}

export { serviceInputFingerprint };
