import type { Pool, PoolClient } from "pg";
import type { ProviderName } from "../../shared/assets.js";

export async function externalProcessingAllowed(
  db: Pool | PoolClient,
  consultationId: string,
  assetIds: readonly string[],
  providers: readonly ProviderName[],
): Promise<boolean> {
  if (assetIds.length === 0 || providers.length === 0) return false;
  const consultation = await db.query<{ deleted_at: Date | null }>(
    "SELECT deleted_at FROM consultations WHERE id = $1",
    [consultationId],
  );
  if (!consultation.rows[0] || consultation.rows[0].deleted_at) return false;
  const assets = await db.query<{ id: string }>(
    `SELECT id FROM assets
     WHERE consultation_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
    [consultationId, assetIds],
  );
  if (assets.rowCount !== assetIds.length) return false;
  const consent = await db.query<{
    accepted: boolean;
    withdrawn_at: Date | null;
    asset_scope: string[];
    providers: string[];
  }>(
    `SELECT accepted, withdrawn_at, asset_scope, providers
     FROM consents
     WHERE consultation_id = $1
     ORDER BY accepted_at DESC, id DESC
     LIMIT 1`,
    [consultationId],
  );
  const latest = consent.rows[0];
  if (!latest || !latest.accepted || latest.withdrawn_at) return false;
  const scope = new Set(latest.asset_scope);
  if (!assetIds.every((id) => scope.has(id))) return false;
  const allowed = new Set(latest.providers);
  return providers.every((provider) => allowed.has(provider));
}
