import type { Pool } from "pg";
import { accessConsultation, actorFromSession } from "../auth/authorization.js";
import type { SessionUser } from "../../shared/auth.js";
import {
  clientBriefSchema,
  prioritiesForService,
  readStoredHistory,
  readStoredPreferences,
  type ClientBrief,
} from "../../shared/client-brief.js";
import type { ServiceKind } from "../../shared/consultations.js";

type Failure = { ok: false; status: 403 | 404; code: "forbidden" | "not_found"; message: string };
type Success = { ok: true; brief: ClientBrief };

export async function readClientBrief(pool: Pool, actor: SessionUser, consultationId: string): Promise<Success | Failure> {
  const access = await accessConsultation(pool, actorFromSession(actor), consultationId, "read");
  if (!access.ok) {
    return access.reason === "forbidden"
      ? { ok: false, status: 403, code: "forbidden", message: "You cannot view this consultation." }
      : { ok: false, status: 404, code: "not_found", message: "That consultation is not available." };
  }
  const consultation = await pool.query<{ version: number }>(
    "SELECT version FROM consultations WHERE id = $1 AND deleted_at IS NULL",
    [consultationId],
  );
  const version = consultation.rows[0]?.version;
  if (!version) return { ok: false, status: 404, code: "not_found", message: "That consultation is not available." };
  const services = await pool.query<{ kind: ServiceKind }>(
    `SELECT kind FROM consultation_services
     WHERE consultation_id = $1 AND selected = true
     ORDER BY CASE kind WHEN 'haircut' THEN 1 WHEN 'colour' THEN 2 ELSE 3 END`,
    [consultationId],
  );
  const history = await pool.query<{ answers: unknown }>(
    `SELECT answers FROM hair_histories
     WHERE consultation_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [consultationId],
  );
  const preferences = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM preferences
     WHERE consultation_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [consultationId],
  );
  const selected = services.rows.map((row) => row.kind);
  const storedPreferences = readStoredPreferences(preferences.rows[0]?.payload);
  const colourSelected = selected.includes("colour");
  return {
    ok: true,
    brief: clientBriefSchema.parse({
      data: {
        version,
        historyRequired: colourSelected,
        history: colourSelected ? readStoredHistory(history.rows[0]?.answers) : null,
        preferences: storedPreferences,
        services: selected.map((kind) => ({
          kind,
          priorities: prioritiesForService(kind, storedPreferences),
        })),
      },
    }).data,
  };
}
