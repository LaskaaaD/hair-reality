import type { Pool, PoolClient } from "pg";
import type { Actor } from "../auth/authorization.js";

export type ConsultationAccess = {
  id: string;
  clientUserId: string;
  salonId: string;
  version: number;
  deletedAt: Date | null;
};

type ConsultationRow = {
  id: string;
  client_user_id: string;
  salon_id: string;
  version: number;
  deleted_at: Date | null;
};

export async function loadConsultation(
  db: Pool | PoolClient,
  consultationId: string,
): Promise<ConsultationAccess | null> {
  const result = await db.query<ConsultationRow>(
    `SELECT id, client_user_id, salon_id, version, deleted_at
     FROM consultations
     WHERE id = $1`,
    [consultationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientUserId: row.client_user_id,
    salonId: row.salon_id,
    version: row.version,
    deletedAt: row.deleted_at,
  };
}

export async function salonMember(db: Pool | PoolClient, userId: string, salonId: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM salon_memberships WHERE salon_id = $1 AND user_id = $2`,
    [salonId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function authorizeConsultation(
  db: Pool | PoolClient,
  actor: Actor,
  consultationId: string,
  action: "read" | "owner",
): Promise<{ ok: true; consultation: ConsultationAccess } | { ok: false; status: 403 | 404 }> {
  const consultation = await loadConsultation(db, consultationId);
  if (!consultation || consultation.deletedAt) return { ok: false, status: 404 };
  const owns = consultation.clientUserId === actor.userId;
  const member = owns ? false : await salonMember(db, actor.userId, consultation.salonId);
  if (!owns && !member) return { ok: false, status: 404 };
  if (action === "owner" && !owns) return { ok: false, status: 403 };
  return { ok: true, consultation };
}
