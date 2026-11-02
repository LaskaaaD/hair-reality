import type { Pool } from "pg";
import type { SessionUser } from "../../shared/auth.js";

export type Actor = {
  userId: string;
  memberships: readonly { salonId: string; role: "stylist" | "admin" }[];
};

export type ConsultationAction = "read" | "client_update" | "salon_review";

export type ConsultationRecord = {
  id: string;
  clientUserId: string;
  salonId: string;
  assignedStylistUserId: string | null;
  version: number;
};

type ConsultationRow = {
  id: string;
  client_user_id: string;
  salon_id: string;
  assigned_stylist_user_id: string | null;
  version: number;
  deleted_at: Date | null;
};

export function actorFromSession(user: SessionUser): Actor {
  return {
    userId: user.id,
    memberships: user.memberships.map((membership) => ({
      salonId: membership.salonId,
      role: membership.role,
    })),
  };
}

export async function accessConsultation(
  pool: Pool,
  actor: Actor,
  consultationId: string,
  action: ConsultationAction,
): Promise<{ ok: true; consultation: ConsultationRecord } | { ok: false; reason: "not_found" | "forbidden" }> {
  const existing = await pool.query<ConsultationRow>(
    `SELECT id, client_user_id, salon_id, assigned_stylist_user_id, version, deleted_at
     FROM consultations
     WHERE id = $1`,
    [consultationId],
  );
  const row = existing.rows[0];
  if (!row || row.deleted_at) return { ok: false, reason: "not_found" };
  const owns = row.client_user_id === actor.userId;
  const member = await isSalonMember(pool, actor.userId, row.salon_id);
  if (!owns && !member) return { ok: false, reason: "not_found" };
  if (action === "read") return { ok: true, consultation: mapRow(row) };
  if (action === "client_update") {
    if (!owns) return { ok: false, reason: "forbidden" };
    const updated = await pool.query<ConsultationRow>(
      `UPDATE consultations
       SET version = version + 1
       WHERE id = $1 AND client_user_id = $2 AND deleted_at IS NULL
       RETURNING id, client_user_id, salon_id, assigned_stylist_user_id, version, deleted_at`,
      [consultationId, actor.userId],
    );
    const next = updated.rows[0];
    if (!next) return { ok: false, reason: "not_found" };
    return { ok: true, consultation: mapRow(next) };
  }
  if (action !== "salon_review" || !member) return { ok: false, reason: "forbidden" };
  const updated = await pool.query<ConsultationRow>(
    `UPDATE consultations
     SET assigned_stylist_user_id = $2
     WHERE id = $1
       AND salon_id = $3
       AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM salon_memberships
         WHERE salon_memberships.salon_id = consultations.salon_id
           AND salon_memberships.user_id = $2
       )
     RETURNING id, client_user_id, salon_id, assigned_stylist_user_id, version, deleted_at`,
      [consultationId, actor.userId, row.salon_id],
  );
  const next = updated.rows[0];
  if (!next) return { ok: false, reason: "not_found" };
  return { ok: true, consultation: mapRow(next) };
}

async function isSalonMember(pool: Pool, userId: string, salonId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM salon_memberships WHERE user_id = $1 AND salon_id = $2",
    [userId, salonId],
  );
  return (result.rowCount ?? 0) > 0;
}

function mapRow(row: ConsultationRow): ConsultationRecord {
  return {
    id: row.id,
    clientUserId: row.client_user_id,
    salonId: row.salon_id,
    assignedStylistUserId: row.assigned_stylist_user_id,
    version: row.version,
  };
}
