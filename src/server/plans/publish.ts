import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { INDEPENDENT_PREVIEW_CAPTION, UNREPRESENTED_ADJUSTMENT, type PlanService, type PlanSnapshot } from "../../shared/plans.js";

export class PlanRejected extends Error {
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

export type PublishedRevision = {
  revisionId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  snapshotHash: string;
  snapshot: PlanSnapshot;
  version: number;
  created: boolean;
};

export async function publishSubmission(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  parentRevisionId: string | null,
  idempotencyKey: string,
): Promise<PublishedRevision> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      version: number;
      lifecycle: string;
      client_user_id: string;
      current_revision_id: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT version, lifecycle, client_user_id, current_revision_id, deleted_at
       FROM consultations WHERE id = $1 FOR UPDATE`,
      [consultationId],
    );
    const row = locked.rows[0];
    if (!row || row.deleted_at || row.client_user_id !== userId) {
      throw new PlanRejected(404, "not_found", "That consultation is not available.");
    }
    const requestHash = createHash("sha256").update(JSON.stringify({ expectedVersion, parentRevisionId })).digest("hex");
    const existing = await client.query<{ request_hash: string; resource_id: string | null }>(
      `SELECT request_hash, resource_id FROM idempotency_keys
       WHERE actor_user_id = $1 AND operation = 'submission' AND idempotency_key = $2`,
      [userId, idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new PlanRejected(409, "idempotency_conflict", "That key was used for a different submission.", row.version);
      if (!prior.resource_id) throw new PlanRejected(409, "idempotency_conflict", "That submission is still being saved.", row.version);
      const stored = await readRevision(client, consultationId, prior.resource_id);
      await client.query("COMMIT");
      return { ...stored, created: false };
    }
    if (row.version !== expectedVersion) {
      throw new PlanRejected(409, "stale_version", "Another edit was saved. Reload this consultation before publishing.", row.version);
    }
    if ((row.current_revision_id ?? null) !== parentRevisionId) {
      throw new PlanRejected(409, "stale_parent", "Publish from the current revision.", row.version);
    }
    if (row.lifecycle !== "READY_FOR_REVIEW") {
      throw new PlanRejected(409, "not_ready", "Check readiness before publishing the plan.", row.version);
    }
    const snapshot = await buildSnapshot(client, consultationId, true);
    const snapshotHash = createHash("sha256").update(stable(snapshot)).digest("hex");
    const reviewConditions = snapshot.services.flatMap((service) => service.findings.filter((finding) => finding.outcome === "stylist_review_required"));
    const number = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM plan_revisions WHERE consultation_id = $1",
      [consultationId],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO plan_revisions (
         consultation_id, revision_number, author_user_id, parent_revision_id, snapshot, snapshot_hash, review_conditions
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       RETURNING id`,
      [consultationId, number.rows[0]?.next ?? 1, userId, parentRevisionId, stable(snapshot), snapshotHash, JSON.stringify(reviewConditions)],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("Revision was not saved");
    await client.query(
      `INSERT INTO approvals (revision_id, actor_user_id, party, snapshot_hash)
       VALUES ($1, $2, 'client', $3)`,
      [revisionId, userId, snapshotHash],
    );
    const written = await client.query(
      `UPDATE consultations
       SET current_revision_id = $2, lifecycle = 'SUBMITTED', version = version + 1
       WHERE id = $1 AND version = $3`,
      [consultationId, revisionId, row.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Another edit was saved. Reload this consultation before publishing.", row.version);
    await client.query(
      `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash, resource_id)
       VALUES ($1, 'submission', $2, $3, $4)`,
      [userId, idempotencyKey, requestHash, revisionId],
    );
    await client.query("COMMIT");
    return {
      revisionId,
      revisionNumber: number.rows[0]?.next ?? 1,
      parentRevisionId,
      snapshotHash,
      snapshot,
      version: row.version + 1,
      created: true,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readCurrentProposal(pool: Pool, userId: string, consultationId: string): Promise<{ version: number; parentRevisionId: string | null; snapshot: PlanSnapshot } | null> {
  const owned = await pool.query<{ version: number; current_revision_id: string | null }>(
    `SELECT version, current_revision_id FROM consultations
     WHERE id = $1 AND client_user_id = $2 AND deleted_at IS NULL`,
    [consultationId, userId],
  );
  const row = owned.rows[0];
  if (!row) return null;
  return {
    version: row.version,
    parentRevisionId: row.current_revision_id,
    snapshot: await buildSnapshot(pool, consultationId, false),
  };
}

export async function readRevisionHistory(pool: Pool, userId: string, consultationId: string): Promise<PublishedRevision[] | null> {
  const owned = await pool.query(
    `SELECT 1 FROM consultations
     WHERE id = $1 AND deleted_at IS NULL
       AND (
         client_user_id = $2
         OR EXISTS (
           SELECT 1 FROM salon_memberships
           WHERE salon_memberships.salon_id = consultations.salon_id
             AND salon_memberships.user_id = $2
         )
       )`,
    [consultationId, userId],
  );
  if ((owned.rowCount ?? 0) === 0) return null;
  const rows = await pool.query<{
    id: string;
    revision_number: number;
    parent_revision_id: string | null;
    snapshot_hash: string;
    snapshot: PlanSnapshot;
  }>(
    `SELECT id, revision_number, parent_revision_id, snapshot_hash, snapshot
     FROM plan_revisions WHERE consultation_id = $1
     ORDER BY revision_number DESC`,
    [consultationId],
  );
  if (rows.rows.length === 0) return [];
  const state = await pool.query<{ version: number; lifecycle: string; current_revision_id: string | null; client_user_id: string }>(
    "SELECT version, lifecycle, current_revision_id, client_user_id FROM consultations WHERE id = $1",
    [consultationId],
  );
  const consultation = state.rows[0];
  if (!consultation) return null;
  const viewerParty: "client" | "stylist" = consultation.client_user_id === userId ? "client" : "stylist";
  const approvals = await pool.query<{
    revision_id: string;
    party: "client" | "stylist";
    snapshot_hash: string;
    approved_at: Date;
    display_name: string;
  }>(
    `SELECT approvals.revision_id, approvals.party, approvals.snapshot_hash, approvals.approved_at, users.display_name
     FROM approvals
     JOIN users ON users.id = approvals.actor_user_id
     WHERE approvals.revision_id = ANY($1::uuid[])
     ORDER BY approvals.party`,
    [rows.rows.map((row) => row.id)],
  );
  return rows.rows.map((row) => ({
    revisionId: row.id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    snapshotHash: row.snapshot_hash,
    snapshot: row.snapshot,
    version: consultation.version,
    created: false,
    consultationVersion: consultation.version,
    lifecycle: consultation.lifecycle,
    current: consultation.current_revision_id === row.id,
    viewerParty,
    approvals: approvals.rows.filter((approval) => approval.revision_id === row.id).map((approval) => ({
      party: approval.party,
      displayName: approval.display_name,
      approvedAt: approval.approved_at.toISOString(),
      snapshotHash: approval.snapshot_hash,
    })),
  }));
}

export type StylistNote = {
  kind: "haircut" | "colour" | "beard";
  text: string;
  represented: boolean;
};

export async function publishStylistRevision(
  pool: Pool,
  userId: string,
  consultationId: string,
  input: {
    expectedVersion: number;
    parentRevisionId: string;
    reason: string;
    outcome: "counterproposal" | "consultation_required" | "resolution";
    addressedChangeRequestIds: string[];
    notes: StylistNote[];
    idempotencyKey: string;
  },
): Promise<PublishedRevision & { lifecycle: string; comparison: { kind: string; previewReused: boolean; representationLimit: string | null }[] }> {
  const reason = input.reason.trim();
  if (reason.length < 1 || reason.length > 4000) throw new PlanRejected(400, "invalid_input", "Write a reason of 1 to 4000 characters.");
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
    const member = row ? await salonMember(client, userId, row.salon_id) : false;
    if (!row || row.deleted_at || !member) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    const requestHash = createHash("sha256").update(stable({
      expectedVersion: input.expectedVersion,
      parentRevisionId: input.parentRevisionId,
      reason,
      outcome: input.outcome,
      addressedChangeRequestIds: [...input.addressedChangeRequestIds].sort(),
      notes: input.notes,
    })).digest("hex");
    const existing = await client.query<{ request_hash: string; resource_id: string | null }>(
      `SELECT request_hash, resource_id FROM idempotency_keys
       WHERE actor_user_id = $1 AND operation = 'stylist-revision' AND idempotency_key = $2`,
      [userId, input.idempotencyKey],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (prior.request_hash !== requestHash) throw new PlanRejected(409, "idempotency_conflict", "That key was used for a different revision.", row.version);
      if (!prior.resource_id) throw new PlanRejected(409, "idempotency_conflict", "That revision is still being saved.", row.version);
      const stored = await readRevision(client, consultationId, prior.resource_id);
      await client.query("COMMIT");
      return { ...stored, lifecycle: row.lifecycle, comparison: [] };
    }
    if (row.version !== input.expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this consultation before publishing.", row.version);
    if (row.current_revision_id !== input.parentRevisionId) throw new PlanRejected(409, "stale_parent", "Publish from the current revision.", row.version);
    const expectedLifecycle = input.outcome === "resolution" ? "CONSULTATION_REQUIRED" : "STYLIST_REVIEWING";
    if (row.lifecycle !== expectedLifecycle) {
      throw new PlanRejected(409, "state_conflict", "This revision cannot be published from the current status.", row.version);
    }
    const parent = await readRevision(client, consultationId, input.parentRevisionId);
    const services = parent.snapshot.services.map((service) => copyService(service));
    for (const note of input.notes) {
      const service = services.find((item) => item.kind === note.kind);
      if (!service) throw new PlanRejected(400, "invalid_input", "That note does not match a service in this plan.");
      const text = note.text.trim();
      if (text.length < 1 || text.length > 400) throw new PlanRejected(400, "invalid_input", "Write a service note of 1 to 400 characters.");
      service.stylistNote = text;
      if (note.represented) {
        const current = await client.query<{ id: string; title: string | null; result_asset_id: string | null }>(
          `SELECT previews.id, candidates.title, previews.result_asset_id
           FROM previews
           JOIN consultation_services ON consultation_services.id = previews.consultation_service_id
           LEFT JOIN candidates ON candidates.id = previews.candidate_id
           WHERE consultation_services.consultation_id = $1
             AND consultation_services.kind = $2
             AND previews.selected = true
             AND previews.stale = false
             AND previews.freshness = 'current'
           LIMIT 1`,
          [consultationId, note.kind],
        );
        const selected = current.rows[0];
        if (selected) {
          service.preview = {
            id: selected.id,
            title: selected.title,
            resultAssetId: selected.result_asset_id,
            caption: INDEPENDENT_PREVIEW_CAPTION,
            unavailableReason: null,
            representationLimit: null,
          };
        }
      } else if (!note.represented) {
        if (!service.unsupported.includes(UNREPRESENTED_ADJUSTMENT)) service.unsupported.push(UNREPRESENTED_ADJUSTMENT);
        service.preview = { ...service.preview, representationLimit: UNREPRESENTED_ADJUSTMENT };
      }
    }
    const snapshot: PlanSnapshot = {
      services,
      history: parent.snapshot.history,
      priorities: parent.snapshot.priorities,
      changeSummary: reason,
    };
    const snapshotHash = createHash("sha256").update(stable(snapshot)).digest("hex");
    const openRequests = await client.query<{ id: string }>(
      "SELECT id FROM change_requests WHERE consultation_id = $1 AND resolving_revision_id IS NULL FOR UPDATE",
      [consultationId],
    );
    const openIds = new Set(openRequests.rows.map((item) => item.id));
    if (input.addressedChangeRequestIds.some((id) => !openIds.has(id))) {
      throw new PlanRejected(409, "unknown_change_request", "Name only open change requests for this consultation.", row.version);
    }
    const reviewConditions = input.outcome === "consultation_required"
      ? [{ outcome: "consultation_required", reason }]
      : services.flatMap((service) => service.findings.filter((finding) => finding.outcome === "stylist_review_required"));
    const number = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM plan_revisions WHERE consultation_id = $1",
      [consultationId],
    );
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO plan_revisions (
         consultation_id, revision_number, author_user_id, parent_revision_id, snapshot, snapshot_hash, review_conditions
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       RETURNING id`,
      [consultationId, number.rows[0]?.next ?? 1, userId, input.parentRevisionId, stable(snapshot), snapshotHash, JSON.stringify(reviewConditions)],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("Revision was not saved");
    const lifecycle = input.outcome === "consultation_required" ? "CONSULTATION_REQUIRED" : "AWAITING_CLIENT";
    if (input.outcome !== "consultation_required") {
      await client.query(
        `INSERT INTO approvals (revision_id, actor_user_id, party, snapshot_hash) VALUES ($1, $2, 'stylist', $3)`,
        [revisionId, userId, snapshotHash],
      );
    }
    if (input.addressedChangeRequestIds.length > 0) {
      await client.query(
        `UPDATE change_requests SET resolving_revision_id = $1
         WHERE consultation_id = $2 AND id = ANY($3::uuid[]) AND resolving_revision_id IS NULL`,
        [revisionId, consultationId, input.addressedChangeRequestIds],
      );
    }
    const written = await client.query(
      `UPDATE consultations SET current_revision_id = $2, lifecycle = $3, version = version + 1
       WHERE id = $1 AND version = $4`,
      [consultationId, revisionId, lifecycle, row.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Reload this consultation before publishing.", row.version);
    await client.query(
      `INSERT INTO idempotency_keys (actor_user_id, operation, idempotency_key, request_hash, resource_id)
       VALUES ($1, 'stylist-revision', $2, $3, $4)`,
      [userId, input.idempotencyKey, requestHash, revisionId],
    );
    await client.query("COMMIT");
    return {
      revisionId,
      revisionNumber: number.rows[0]?.next ?? 1,
      parentRevisionId: input.parentRevisionId,
      snapshotHash,
      snapshot,
      version: row.version + 1,
      created: true,
      lifecycle,
      comparison: services.map((service) => {
        const previous = parent.snapshot.services.find((item) => item.kind === service.kind);
        return {
          kind: service.kind,
          previewReused: (previous?.preview.id ?? null) === service.preview.id,
          representationLimit: service.preview.representationLimit,
        };
      }),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function requestPlanChange(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  revisionId: string,
  message: string,
): Promise<{ id: string; version: number }> {
  const reason = message.trim();
  if (reason.length < 1 || reason.length > 4000) throw new PlanRejected(400, "invalid_input", "Write a change request of 1 to 4000 characters.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      version: number;
      lifecycle: string;
      client_user_id: string;
      current_revision_id: string | null;
      deleted_at: Date | null;
    }>("SELECT version, lifecycle, client_user_id, current_revision_id, deleted_at FROM consultations WHERE id = $1 FOR UPDATE", [consultationId]);
    const row = locked.rows[0];
    if (!row || row.deleted_at || row.client_user_id !== userId) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    if (row.version !== expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this consultation before requesting a change.", row.version);
    if (row.current_revision_id !== revisionId) throw new PlanRejected(409, "stale_revision", "Request a change from the current revision.", row.version);
    if (!["SUBMITTED", "AWAITING_CLIENT", "PLAN_APPROVED"].includes(row.lifecycle)) {
      throw new PlanRejected(409, "state_conflict", "A change request belongs on a submitted plan.", row.version);
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO change_requests (consultation_id, revision_id, requester_user_id, reason)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [consultationId, revisionId, userId, reason],
    );
    const written = await client.query(
      `UPDATE consultations SET lifecycle = 'STYLIST_REVIEWING', version = version + 1 WHERE id = $1 AND version = $2`,
      [consultationId, row.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Reload this consultation before requesting a change.", row.version);
    await client.query("COMMIT");
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Change request was not saved");
    return { id, version: row.version + 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const APPROVAL_LIFECYCLES = ["SUBMITTED", "STYLIST_REVIEWING", "AWAITING_CLIENT", "PLAN_APPROVED"];

export async function approvePlan(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  revisionId: string,
  snapshotHash: string,
): Promise<{ version: number; lifecycle: string; party: "client" | "stylist"; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockConsultation(client, consultationId);
    const party = await partyFor(client, userId, locked);
    if (!party) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    if (locked.version !== expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this plan before approving it.", locked.version);
    if (locked.current_revision_id !== revisionId) throw new PlanRejected(409, "stale_revision", "Approve the current plan version.", locked.version);
    if (!APPROVAL_LIFECYCLES.includes(locked.lifecycle)) throw new PlanRejected(409, "state_conflict", "This plan cannot be approved from its current status.", locked.version);
    await rejectOpenChangeRequest(client, consultationId, locked.version);
    const revision = await client.query<{ snapshot_hash: string; review_conditions: unknown }>(
      "SELECT snapshot_hash, review_conditions FROM plan_revisions WHERE id = $1 AND consultation_id = $2",
      [revisionId, consultationId],
    );
    const stored = revision.rows[0];
    if (!stored) throw new PlanRejected(404, "not_found", "That plan version is not available.", locked.version);
    if (stored.snapshot_hash !== snapshotHash) throw new PlanRejected(409, "hash_mismatch", "Approve the plan text you were shown.", locked.version);
    if (unresolvedReview(stored.review_conditions)) throw new PlanRejected(409, "unresolved_review", "Resolve the professional review before approving this plan.", locked.version);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO approvals (revision_id, actor_user_id, party, snapshot_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (revision_id, party) DO NOTHING
       RETURNING id`,
      [revisionId, userId, party, snapshotHash],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      const existing = await client.query<{ snapshot_hash: string }>(
        "SELECT snapshot_hash FROM approvals WHERE revision_id = $1 AND party = $2",
        [revisionId, party],
      );
      if (existing.rows[0]?.snapshot_hash !== snapshotHash) throw new PlanRejected(409, "hash_mismatch", "This party already approved different plan text.", locked.version);
      await client.query("COMMIT");
      return { version: locked.version, lifecycle: locked.lifecycle, party, created: false };
    }
    const parties = await client.query<{ party: string }>(
      "SELECT party FROM approvals WHERE revision_id = $1",
      [revisionId],
    );
    const both = new Set(parties.rows.map((item) => item.party));
    const lifecycle = both.has("client") && both.has("stylist") ? "PLAN_APPROVED" : locked.lifecycle;
    const written = await client.query(
      `UPDATE consultations SET lifecycle = $2, version = version + 1 WHERE id = $1 AND version = $3`,
      [consultationId, lifecycle, locked.version],
    );
    if ((written.rowCount ?? 0) !== 1) throw new PlanRejected(409, "stale_version", "Reload this plan before approving it.", locked.version);
    await client.query("COMMIT");
    return { version: locked.version + 1, lifecycle, party, created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertBookingAllowed(
  pool: Pool,
  userId: string,
  consultationId: string,
  expectedVersion: number,
  revisionId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockConsultation(client, consultationId);
    const party = await partyFor(client, userId, locked);
    if (!party) throw new PlanRejected(404, "not_found", "That consultation is not available.");
    if (locked.version !== expectedVersion) throw new PlanRejected(409, "stale_version", "Reload this plan before booking.", locked.version);
    if (locked.current_revision_id !== revisionId) throw new PlanRejected(409, "stale_revision", "Book the current plan version.", locked.version);
    await rejectOpenChangeRequest(client, consultationId, locked.version);
    if (locked.lifecycle !== "PLAN_APPROVED") throw new PlanRejected(409, "not_approved", "Booking waits until both parties approve this plan version.", locked.version);
    const revision = await client.query<{ review_conditions: unknown }>(
      "SELECT review_conditions FROM plan_revisions WHERE id = $1 AND consultation_id = $2",
      [revisionId, consultationId],
    );
    if (unresolvedReview(revision.rows[0]?.review_conditions)) throw new PlanRejected(409, "unresolved_review", "Resolve the professional review before booking.", locked.version);
    const parties = await client.query<{ party: string }>("SELECT party FROM approvals WHERE revision_id = $1", [revisionId]);
    const both = new Set(parties.rows.map((item) => item.party));
    if (!both.has("client") || !both.has("stylist")) throw new PlanRejected(409, "not_approved", "Booking waits until both parties approve this plan version.", locked.version);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockConsultation(client: PoolClient, consultationId: string): Promise<{
  version: number;
  lifecycle: string;
  client_user_id: string;
  salon_id: string;
  current_revision_id: string | null;
  deleted_at: Date | null;
}> {
  const locked = await client.query<{
    version: number;
    lifecycle: string;
    client_user_id: string;
    salon_id: string;
    current_revision_id: string | null;
    deleted_at: Date | null;
  }>("SELECT version, lifecycle, client_user_id, salon_id, current_revision_id, deleted_at FROM consultations WHERE id = $1 FOR UPDATE", [consultationId]);
  const row = locked.rows[0];
  if (!row || row.deleted_at) throw new PlanRejected(404, "not_found", "That consultation is not available.");
  return row;
}

export async function partyFor(
  client: PoolClient,
  userId: string,
  row: { client_user_id: string; salon_id: string },
): Promise<"client" | "stylist" | null> {
  if (row.client_user_id === userId) return "client";
  return await salonMember(client, userId, row.salon_id) ? "stylist" : null;
}

export async function rejectOpenChangeRequest(client: PoolClient, consultationId: string, version: number): Promise<void> {
  const open = await client.query(
    "SELECT 1 FROM change_requests WHERE consultation_id = $1 AND resolving_revision_id IS NULL",
    [consultationId],
  );
  if ((open.rowCount ?? 0) > 0) throw new PlanRejected(409, "open_change_request", "An open change request blocks approval and booking.", version);
}

export function unresolvedReview(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const record = recordOf(item);
    return record.outcome === "consultation_required" || record.outcome === "stylist_review_required";
  });
}

async function salonMember(client: PoolClient, userId: string, salonId: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM salon_memberships WHERE salon_id = $1 AND user_id = $2",
    [salonId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

function copyService(service: PlanService): PlanService {
  return {
    kind: service.kind,
    targetTitle: service.targetTitle,
    unsupported: [...service.unsupported],
    findings: service.findings.map((finding) => ({ ...finding })),
    stylistNote: service.stylistNote ?? null,
    preview: {
      id: service.preview.id,
      title: service.preview.title,
      resultAssetId: service.preview.resultAssetId,
      caption: service.preview.caption,
      unavailableReason: service.preview.unavailableReason,
      representationLimit: service.preview.representationLimit ?? null,
    },
  };
}

async function readRevision(client: PoolClient, consultationId: string, revisionId: string): Promise<PublishedRevision> {
  const result = await client.query<{
    id: string;
    revision_number: number;
    parent_revision_id: string | null;
    snapshot_hash: string;
    snapshot: PlanSnapshot;
    version: number;
  }>(
    `SELECT plan_revisions.id, plan_revisions.revision_number, plan_revisions.parent_revision_id,
            plan_revisions.snapshot_hash, plan_revisions.snapshot, consultations.version
     FROM plan_revisions
     JOIN consultations ON consultations.id = plan_revisions.consultation_id
     WHERE plan_revisions.id = $1 AND plan_revisions.consultation_id = $2`,
    [revisionId, consultationId],
  );
  const row = result.rows[0];
  if (!row) throw new PlanRejected(404, "not_found", "That revision is not available.");
  return {
    revisionId: row.id,
    revisionNumber: row.revision_number,
    parentRevisionId: row.parent_revision_id,
    snapshotHash: row.snapshot_hash,
    snapshot: row.snapshot,
    version: row.version,
    created: false,
  };
}

async function buildSnapshot(client: Pool | PoolClient, consultationId: string, strict: boolean): Promise<PlanSnapshot> {
  const services = await client.query<{ kind: "haircut" | "colour" | "beard" }>(
    `SELECT kind FROM consultation_services
     WHERE consultation_id = $1 AND selected = true
     ORDER BY CASE kind WHEN 'haircut' THEN 0 WHEN 'colour' THEN 1 ELSE 2 END, id`,
    [consultationId],
  );
  if (services.rows.length === 0 && strict) throw new PlanRejected(409, "not_ready", "Choose at least one service before publishing.");
  const colour = services.rows.some((service) => service.kind === "colour");
  const history = await client.query<{ answers: unknown }>(
    `SELECT answers FROM hair_histories WHERE consultation_id = $1 ORDER BY version DESC, id DESC LIMIT 1`,
    [consultationId],
  );
  if (strict && colour && !history.rows[0]) throw new PlanRejected(409, "not_ready", "Colour history is required before publishing a colour plan.");
  const preferences = await client.query<{ payload: unknown }>(
    `SELECT payload FROM preferences WHERE consultation_id = $1 ORDER BY version DESC, id DESC LIMIT 1`,
    [consultationId],
  );
  const presented: PlanService[] = [];
  for (const service of services.rows) {
    presented.push(await presentPlanService(client, consultationId, service.kind, strict));
  }
  return {
    services: presented,
    history: colour ? history.rows[0]?.answers ?? null : null,
    priorities: preferences.rows[0]?.payload ?? null,
    changeSummary: "Initial proposal.",
  };
}

async function presentPlanService(client: Pool | PoolClient, consultationId: string, kind: "haircut" | "colour" | "beard", strict: boolean): Promise<PlanService> {
  const service = await client.query<{ id: string; input_version: number }>(
    `SELECT id, input_version FROM consultation_services
     WHERE consultation_id = $1 AND kind = $2 AND selected = true`,
    [consultationId, kind],
  );
  const row = service.rows[0];
  if (!row) {
    if (!strict) return emptyService(kind);
    throw new PlanRejected(409, "not_ready", "A selected service is missing.");
  }
  const target = await client.query<{ title: string | null; description: string | null; interpreted: unknown }>(
    `SELECT candidates.title, targets.description, targets.interpreted
     FROM targets
     LEFT JOIN candidates ON candidates.id = targets.candidate_id
     WHERE targets.consultation_service_id = $1
     ORDER BY targets.created_at DESC, targets.id DESC
     LIMIT 1`,
    [row.id],
  );
  if (!target.rows[0]) {
    if (!strict) return emptyService(kind);
    throw new PlanRejected(409, "not_ready", "Each service needs a target before publishing.");
  }
  const assessment = await client.query<{ findings: unknown }>(
    `SELECT findings FROM reality_assessments
     WHERE consultation_service_id = $1 AND input_fingerprint = $2
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [row.id, `service:${row.id}:v${row.input_version}`],
  );
  if (!assessment.rows[0] && strict) throw new PlanRejected(409, "not_ready", "Each service needs a current assessment before publishing.");
  const preview = await client.query<{ id: string; title: string | null; result_asset_id: string | null }>(
    `SELECT previews.id, candidates.title, previews.result_asset_id
     FROM previews
     LEFT JOIN candidates ON candidates.id = previews.candidate_id
     WHERE previews.consultation_service_id = $1
       AND previews.selected = true
       AND previews.stale = false
       AND previews.freshness = 'current'
     LIMIT 1`,
    [row.id],
  );
  const selected = preview.rows[0];
  if (!selected && strict) throw new PlanRejected(409, "not_ready", "Each service needs a current selected preview before publishing.");
  const interpreted = recordOf(target.rows[0].interpreted);
  return {
    kind,
    targetTitle: target.rows[0].title ?? target.rows[0].description,
    unsupported: stringList(interpreted.unsupported),
    findings: findingsOf(assessment.rows[0]?.findings),
    stylistNote: null,
    preview: selected ? {
      id: selected.id,
      title: selected.title,
      resultAssetId: selected.result_asset_id,
      caption: INDEPENDENT_PREVIEW_CAPTION,
      unavailableReason: null,
      representationLimit: null,
    } : {
      id: null,
      title: null,
      resultAssetId: null,
      caption: INDEPENDENT_PREVIEW_CAPTION,
      unavailableReason: "No current preview is selected.",
      representationLimit: null,
    },
  };
}

function emptyService(kind: "haircut" | "colour" | "beard"): PlanService {
  return {
    kind,
    targetTitle: null,
    unsupported: [],
    findings: [],
    stylistNote: null,
    preview: {
      id: null,
      title: null,
      resultAssetId: null,
      caption: INDEPENDENT_PREVIEW_CAPTION,
      unavailableReason: "No current preview is selected.",
      representationLimit: null,
    },
  };
}

function findingsOf(value: unknown): PlanService["findings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    const ruleId = typeof record.ruleId === "string" ? record.ruleId : null;
    const outcome = typeof record.outcome === "string" ? record.outcome : null;
    const reason = typeof record.reason === "string" ? record.reason : null;
    if (!ruleId || !outcome || !reason) return [];
    return [{ ruleId, outcome, reason }];
  });
}

function stable(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((sorted, key) => {
    sorted[key] = sortValue(record[key]);
    return sorted;
  }, {});
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
