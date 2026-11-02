import type { Pool } from "pg";
import type { SessionUser } from "../../shared/auth.js";
import { accessConsultation, actorFromSession } from "../auth/authorization.js";
import type { NotificationHub } from "../notifications/hub.js";

const STATUSES = ["DRAFT", "READY_FOR_REVIEW", "SUBMITTED", "STYLIST_REVIEWING", "AWAITING_CLIENT", "PLAN_APPROVED", "BOOKED", "CANCELLED"] as const;

export class SalonRejected extends Error {
  readonly status: number;
  readonly code: string;
  readonly currentVersion: number | null;

  constructor(status: number, code: string, message: string, currentVersion: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.currentVersion = currentVersion;
  }
}

export async function listInbox(pool: Pool, actor: SessionUser, status: string | null): Promise<{ id: string; lifecycle: string; version: number; clientName: string; services: string[] }[]> {
  if (actor.memberships.length === 0) throw new SalonRejected(403, "forbidden", "A salon membership is required.");
  if (status && !STATUSES.includes(status as (typeof STATUSES)[number])) {
    throw new SalonRejected(400, "invalid_input", "That status is not a consultation status.");
  }
  const salonIds = actor.memberships.map((membership) => membership.salonId);
  const rows = await pool.query<{ id: string; lifecycle: string; version: number; client_name: string }>(
    `SELECT consultations.id, consultations.lifecycle, consultations.version, users.display_name AS client_name
     FROM consultations
     JOIN users ON users.id = consultations.client_user_id
     WHERE consultations.deleted_at IS NULL
       AND consultations.salon_id = ANY($1::uuid[])
       AND ($2::text IS NULL OR consultations.lifecycle = $2)
     ORDER BY consultations.created_at DESC, consultations.id DESC
     LIMIT 50`,
    [salonIds, status],
  );
  const listed = [];
  for (const row of rows.rows) {
    const services = await pool.query<{ kind: string }>(
      "SELECT kind FROM consultation_services WHERE consultation_id = $1 AND selected = true ORDER BY kind",
      [row.id],
    );
    listed.push({
      id: row.id,
      lifecycle: row.lifecycle,
      version: row.version,
      clientName: row.client_name,
      services: services.rows.map((service) => service.kind),
    });
  }
  return listed;
}

export async function readReview(pool: Pool, actor: SessionUser, consultationId: string): Promise<Record<string, unknown> | null> {
  const access = await accessConsultation(pool, actorFromSession(actor), consultationId, "read");
  if (!access.ok) return null;
  const consultation = await pool.query<{ lifecycle: string; version: number; current_revision_id: string | null; salon_id: string }>(
    "SELECT lifecycle, version, current_revision_id, salon_id FROM consultations WHERE id = $1",
    [consultationId],
  );
  const row = consultation.rows[0];
  if (!row) return null;
  const revision = row.current_revision_id
    ? await pool.query<{ revision_number: number; snapshot_hash: string }>(
      "SELECT revision_number, snapshot_hash FROM plan_revisions WHERE id = $1",
      [row.current_revision_id],
    )
    : { rows: [] };
  const services = await pool.query<{ id: string; kind: string; input_version: number }>(
    `SELECT id, kind, input_version FROM consultation_services
     WHERE consultation_id = $1 AND selected = true
     ORDER BY CASE kind WHEN 'haircut' THEN 0 WHEN 'colour' THEN 1 ELSE 2 END`,
    [consultationId],
  );
  const presented = [];
  for (const service of services.rows) {
    const target = await pool.query<{ title: string | null; description: string | null; interpreted: unknown }>(
      `SELECT candidates.title, targets.description, targets.interpreted
       FROM targets LEFT JOIN candidates ON candidates.id = targets.candidate_id
       WHERE targets.consultation_service_id = $1
       ORDER BY targets.created_at DESC LIMIT 1`,
      [service.id],
    );
    const assessment = await pool.query<{ findings: unknown }>(
      `SELECT findings FROM reality_assessments
       WHERE consultation_service_id = $1 AND input_fingerprint = $2
       ORDER BY created_at DESC LIMIT 1`,
      [service.id, `service:${service.id}:v${service.input_version}`],
    );
    const sourceRole = service.kind === "beard" ? "beard" : "current_front";
    const source = await pool.query<{ id: string }>(
      `SELECT id FROM assets
       WHERE consultation_id = $1 AND role = $2 AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [consultationId, sourceRole],
    );
    const candidates = await pool.query<{ id: string; title: string }>(
      `SELECT id, title FROM candidates
       WHERE salon_id = $1 AND service_kind = $2 AND enabled = true
       ORDER BY title ASC
       LIMIT 12`,
      [row.salon_id, service.kind],
    );
    const previews = await pool.query<{
      id: string;
      candidate_id: string | null;
      title: string | null;
      result_asset_id: string | null;
      selected: boolean;
    }>(
      `SELECT previews.id, previews.candidate_id, candidates.title, previews.result_asset_id, previews.selected
       FROM previews
       LEFT JOIN candidates ON candidates.id = previews.candidate_id
       WHERE previews.consultation_service_id = $1 AND previews.stale = false AND previews.freshness = 'current'
       ORDER BY previews.created_at DESC
       LIMIT 8`,
      [service.id],
    );
    presented.push({
      serviceId: service.id,
      kind: service.kind,
      sourceAssetId: source.rows[0]?.id ?? null,
      targetTitle: target.rows[0]?.title ?? target.rows[0]?.description ?? null,
      unsupported: stringList(recordOf(target.rows[0]?.interpreted).unsupported),
      findings: findingsOf(assessment.rows[0]?.findings),
      candidates: candidates.rows,
      previews: previews.rows.map((preview) => ({
        id: preview.id,
        candidateId: preview.candidate_id,
        title: preview.title,
        resultAssetId: preview.result_asset_id,
        selected: preview.selected,
      })),
    });
  }
  const preferences = await pool.query<{ payload: unknown }>(
    "SELECT payload FROM preferences WHERE consultation_id = $1 ORDER BY version DESC LIMIT 1",
    [consultationId],
  );
  const history = await pool.query<{ answers: unknown }>(
    "SELECT answers FROM hair_histories WHERE consultation_id = $1 ORDER BY version DESC LIMIT 1",
    [consultationId],
  );
  const assets = await pool.query<{ id: string; role: string }>(
    `SELECT DISTINCT ON (role) id, role FROM assets
     WHERE consultation_id = $1 AND deleted_at IS NULL
     ORDER BY role, created_at DESC, id DESC`,
    [consultationId],
  );
  return {
    consultationId,
    lifecycle: row.lifecycle,
    version: row.version,
    revisionId: row.current_revision_id,
    revisionNumber: revision.rows[0]?.revision_number ?? null,
    snapshotHash: revision.rows[0]?.snapshot_hash ?? null,
    services: presented,
    priorities: preferences.rows[0]?.payload ?? null,
    history: history.rows[0]?.answers ?? null,
    evidenceRoles: assets.rows.map((asset) => asset.role),
    evidence: assets.rows.map((asset) => ({ id: asset.id, role: asset.role })),
    openChangeRequests: (await pool.query<{ id: string; reason: string }>(
      `SELECT id, reason FROM change_requests
       WHERE consultation_id = $1 AND resolving_revision_id IS NULL
       ORDER BY created_at, id`,
      [consultationId],
    )).rows,
  };
}

export async function listMessages(pool: Pool, actor: SessionUser, consultationId: string): Promise<{ id: string; body: string; authorName: string; createdAt: string }[] | null> {
  const access = await accessConsultation(pool, actorFromSession(actor), consultationId, "read");
  if (!access.ok) return null;
  const rows = await pool.query<{ id: string; body: string; author_name: string; created_at: Date }>(
    `SELECT discussion_messages.id, discussion_messages.body, users.display_name AS author_name, discussion_messages.created_at
     FROM discussion_messages
     JOIN users ON users.id = discussion_messages.author_user_id
     WHERE discussion_messages.consultation_id = $1
     ORDER BY discussion_messages.created_at ASC, discussion_messages.id ASC`,
    [consultationId],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    body: row.body,
    authorName: row.author_name,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function addMessage(
  pool: Pool,
  actor: SessionUser,
  consultationId: string,
  text: string,
  hub: NotificationHub | null,
): Promise<{ id: string; body: string; authorName: string; createdAt: string }> {
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 4000) throw new SalonRejected(400, "invalid_input", "Write a message of 1 to 4000 characters.");
  const access = await accessConsultation(pool, actorFromSession(actor), consultationId, "read");
  if (!access.ok) throw new SalonRejected(404, "not_found", "That consultation is not available.");
  const inserted = await pool.query<{ id: string; created_at: Date; version: number }>(
    `WITH inserted AS (
       INSERT INTO discussion_messages (consultation_id, author_user_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, created_at
     )
     SELECT inserted.id, inserted.created_at, consultations.version
     FROM inserted
     JOIN consultations ON consultations.id = $1`,
    [consultationId, actor.id, trimmed],
  );
  const row = inserted.rows[0];
  if (!row) throw new SalonRejected(404, "not_found", "That consultation is not available.");
  if (hub) {
    await hub.publish({ event: "message.created", consultationId, version: row.version, resourceId: row.id });
  }
  return { id: row.id, body: trimmed, authorName: actor.displayName, createdAt: row.created_at.toISOString() };
}

export async function startReview(
  pool: Pool,
  actor: SessionUser,
  consultationId: string,
  expectedVersion: number,
  revisionId: string,
  hub: NotificationHub | null = null,
): Promise<{ version: number; lifecycle: string }> {
  if (actor.memberships.length === 0) throw new SalonRejected(403, "forbidden", "A salon membership is required.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      version: number;
      lifecycle: string;
      salon_id: string;
      current_revision_id: string | null;
      deleted_at: Date | null;
    }>("SELECT version, lifecycle, salon_id, current_revision_id, deleted_at FROM consultations WHERE id = $1 FOR UPDATE", [consultationId]);
    const row = locked.rows[0];
    const member = row ? actor.memberships.some((membership) => membership.salonId === row.salon_id) : false;
    if (!row || row.deleted_at || !member) throw new SalonRejected(404, "not_found", "That consultation is not available.");
    if (row.version !== expectedVersion) throw new SalonRejected(409, "stale_version", "Reload this consultation before starting review.", row.version);
    if (row.current_revision_id !== revisionId) throw new SalonRejected(409, "stale_revision", "Start review from the current revision.", row.version);
    if (row.lifecycle !== "SUBMITTED" && row.lifecycle !== "AWAITING_CLIENT") {
      throw new SalonRejected(409, "state_conflict", "Review can start from a submitted or awaiting-client plan.", row.version);
    }
    const written = await client.query<{ version: number }>(
      `UPDATE consultations
       SET lifecycle = 'STYLIST_REVIEWING', assigned_stylist_user_id = $2, version = version + 1
       WHERE id = $1
       RETURNING version`,
      [consultationId, actor.id],
    );
    await client.query("COMMIT");
    const version = written.rows[0]?.version ?? row.version + 1;
    if (hub) await hub.publish({ event: "consultation.updated", consultationId, version });
    return { version, lifecycle: "STYLIST_REVIEWING" };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function findingsOf(value: unknown): { ruleId: string; outcome: string; reason: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    if (typeof record.ruleId !== "string" || typeof record.outcome !== "string" || typeof record.reason !== "string") return [];
    return [{ ruleId: record.ruleId, outcome: record.outcome, reason: record.reason }];
  });
}

