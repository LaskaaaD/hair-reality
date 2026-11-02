import type { Pool } from "pg";
import { accessConsultation, actorFromSession } from "../auth/authorization.js";
import type { SessionUser } from "../../shared/auth.js";
import type { ServiceKind } from "../../shared/consultations.js";
import { hairProfileCapabilities, type HairProfile, type HairProfileCapability } from "../../shared/hair-profile.js";
import { singleYouCamCapability } from "../providers/youcam/contract.js";
import { assembleHairProfile, type ProfileAsset, type ProfileJob, type ProfileObservation } from "./hair-profile.js";

type Failure = { ok: false; status: 403 | 404; code: "forbidden" | "not_found"; message: string };
type Success = { ok: true; profile: HairProfile };

export async function readHairProfile(
  pool: Pool,
  actor: SessionUser,
  consultationId: string,
  presentation: HairProfile["presentation"],
): Promise<Success | Failure> {
  const access = await accessConsultation(pool, actorFromSession(actor), consultationId, "read");
  if (!access.ok) {
    return access.reason === "forbidden"
      ? { ok: false, status: 403, code: "forbidden", message: "You cannot view this consultation." }
      : { ok: false, status: 404, code: "not_found", message: "That consultation is not available." };
  }
  const services = await pool.query<{ kind: ServiceKind }>(
    "SELECT kind FROM consultation_services WHERE consultation_id = $1 AND selected = true",
    [consultationId],
  );
  const assets = await pool.query<{ id: string; role: string; deleted_at: Date | null; created_at: Date }>(
    `SELECT id, role, deleted_at, created_at FROM assets
     WHERE consultation_id = $1 AND role = ANY($2::text[])
     ORDER BY created_at ASC, id ASC`,
    [consultationId, ["current_front", "current_right", "current_left", "current_density", "current_length"]],
  );
  const observations = await pool.query<{
    capability: string;
    source: string;
    values: Record<string, unknown>;
    uncertainty: string | null;
    observed_at: Date;
    input_assets: unknown;
  }>(
    `SELECT capability, source, values, uncertainty, observed_at, input_assets
     FROM analysis_results
     WHERE consultation_id = $1 AND capability = ANY($2::text[])`,
    [consultationId, hairProfileCapabilities],
  );
  const jobs = await pool.query<{
    configuration_fingerprint: string;
    state: string;
    error_code: string | null;
    mode: ProfileJob["mode"];
    source_asset_ids: string[] | null;
    created_at: Date;
  }>(
    `SELECT configuration_fingerprint, state, error_code, mode, source_asset_ids, created_at
     FROM provider_jobs
     WHERE consultation_id = $1 AND provider = 'youcam' AND operation IN ('analysis', 'probe')`,
    [consultationId],
  );
  return {
    ok: true,
    profile: assembleHairProfile({
      presentation,
      services: services.rows.map((row) => row.kind),
      assets: assets.rows.map((row): ProfileAsset => ({
        id: row.id,
        role: row.role,
        deleted: row.deleted_at !== null,
        createdAt: row.created_at.toISOString(),
      })),
      observations: observations.rows.flatMap((row): ProfileObservation[] => {
        const inputAssetIds = assetIdList(row.input_assets);
        if (!inputAssetIds) return [];
        return [{
          capability: row.capability,
          source: row.source,
          values: row.values,
          uncertainty: row.uncertainty,
          observedAt: row.observed_at.toISOString(),
          inputAssetIds,
        }];
      }),
      jobs: jobs.rows.flatMap((row): ProfileJob[] => {
        const capability = singleYouCamCapability(row.configuration_fingerprint);
        if (!capability || !isHairCapability(capability)) return [];
        return [{
          capability,
          state: row.state,
          errorCode: row.error_code,
          mode: row.mode,
          sourceAssetIds: row.source_asset_ids ?? [],
          createdAt: row.created_at.toISOString(),
        }];
      }),
    }),
  };
}

function isHairCapability(value: string): value is HairProfileCapability {
  return (hairProfileCapabilities as readonly string[]).includes(value);
}

function assetIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") ids.push(item);
    else if (item && typeof item === "object" && "id" in item && typeof item.id === "string") ids.push(item.id);
    else return null;
  }
  return ids;
}
