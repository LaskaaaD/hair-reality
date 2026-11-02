import { randomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { importRoles, type AssetDto, type ConsentRequest, type ProviderName } from "../../shared/assets.js";
import type { Actor } from "../auth/authorization.js";
import { authorizeConsultation, loadConsultation, salonMember } from "./access.js";
import { deleteExpiredAsset, type DeletionView } from "./deletion.js";
import { ImageRejected, normalizeImage } from "./images.js";
import type { PrivateStorage } from "./storage.js";

const ROLES = new Set<string>(importRoles);

export type AssetFailure = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 413 | 422;
  code: "invalid_input" | "forbidden" | "not_found" | "stale_version" | "too_large" | "unsupported_image";
  message: string;
  currentVersion?: number;
};

export async function uploadAsset(options: {
  pool: Pool;
  storage: PrivateStorage;
  actor: Actor;
  consultationId: string;
  role: string;
  expectedVersion: number;
  file: Buffer;
  retentionDays: number;
  now: Date;
}): Promise<{ ok: true; asset: AssetDto } | AssetFailure> {
  if (!ROLES.has(options.role)) {
    return { ok: false, status: 400, code: "invalid_input", message: "Choose a supported photograph role." };
  }
  const access = await authorizeConsultation(options.pool, options.actor, options.consultationId, "owner");
  if (!access.ok) return denied(access.status);
  if (access.consultation.version !== options.expectedVersion) return stale(access.consultation.version);
  let image;
  try {
    image = await normalizeImage(options.file);
  } catch (error) {
    if (error instanceof ImageRejected && error.reason === "too_large") {
      return { ok: false, status: 413, code: "too_large", message: "The photograph is larger than 9 MB." };
    }
    if (error instanceof ImageRejected && error.reason === "too_many_pixels") {
      return { ok: false, status: 422, code: "unsupported_image", message: "The photograph has too many pixels." };
    }
    return { ok: false, status: 422, code: "unsupported_image", message: "Upload a JPEG, PNG or WebP photograph." };
  }
  const key = randomBytes(32).toString("hex");
  await options.storage.write(key, image.bytes);
  try {
    const asset = await transaction(options.pool, async (client) => {
      const updated = await client.query<{ version: number }>(
        `UPDATE consultations
         SET version = version + 1
         WHERE id = $1 AND client_user_id = $2 AND version = $3 AND deleted_at IS NULL
         RETURNING version`,
        [options.consultationId, options.actor.userId, options.expectedVersion],
      );
      const version = updated.rows[0];
      if (!version) throw new Conflict();
      const inserted = await client.query<{
        id: string;
        consultation_id: string;
        role: AssetDto["role"];
        mime_type: AssetDto["mimeType"];
        width: number;
        height: number;
        provenance: AssetDto["provenance"];
        expires_at: Date;
        created_at: Date;
      }>(
        `INSERT INTO assets (
           owner_user_id, consultation_id, role, storage_key, content_hash,
           width, height, mime_type, expires_at, provenance
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9), 'client_upload'
         )
         RETURNING id, consultation_id, role, mime_type, width, height, provenance, expires_at, created_at`,
        [
          options.actor.userId,
          options.consultationId,
          options.role,
          key,
          image.contentHash,
          image.width,
          image.height,
          image.mimeType,
          options.retentionDays,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("asset_insert_failed");
      return row;
    });
    return { ok: true, asset: toDto(asset) };
  } catch (error) {
    await options.storage.remove(key).catch(() => {
      console.error("asset_cleanup_failed");
    });
    if (error instanceof Conflict) {
      const current = await loadConsultation(options.pool, options.consultationId);
      return stale(current?.version ?? options.expectedVersion);
    }
    throw error;
  }
}

export async function listOwnedAssets(options: {
  pool: Pool;
  actor: Actor;
  consultationId: string;
}): Promise<{ ok: true; assets: AssetDto[] } | AssetFailure> {
  const access = await authorizeConsultation(options.pool, options.actor, options.consultationId, "read");
  if (!access.ok) return denied(access.status);
  const listed = await options.pool.query<{
    id: string;
    consultation_id: string;
    role: AssetDto["role"];
    mime_type: AssetDto["mimeType"];
    width: number;
    height: number;
    provenance: AssetDto["provenance"];
    expires_at: Date;
    created_at: Date;
  }>(
    `SELECT id, consultation_id, role, mime_type, width, height, provenance, expires_at, created_at
     FROM assets
     WHERE consultation_id = $1 AND deleted_at IS NULL AND provenance = 'client_upload'
     ORDER BY created_at DESC, id DESC
     LIMIT 100`,
    [options.consultationId],
  );
  return { ok: true, assets: listed.rows.map(toDto) };
}

export async function openAssetContent(options: {
  pool: Pool;
  storage: PrivateStorage;
  actor: Actor;
  assetId: string;
}): Promise<{ ok: true; mimeType: string; size: number; stream: ReadStream } | AssetFailure> {
  const found = await options.pool.query<{
    consultation_id: string;
    mime_type: string;
    storage_key: string;
    deleted_at: Date | null;
    consultation_deleted_at: Date | null;
  }>(
    `SELECT assets.consultation_id, assets.mime_type, assets.storage_key, assets.deleted_at,
            consultations.deleted_at AS consultation_deleted_at
     FROM assets
     JOIN consultations ON consultations.id = assets.consultation_id
     WHERE assets.id = $1`,
    [options.assetId],
  );
  const asset = found.rows[0];
  if (!asset || asset.deleted_at || asset.consultation_deleted_at) return denied(404);
  const access = await authorizeConsultation(options.pool, options.actor, asset.consultation_id, "read");
  if (!access.ok) return denied(404);
  try {
    const size = await options.storage.size(asset.storage_key);
    return { ok: true, mimeType: asset.mime_type, size, stream: options.storage.stream(asset.storage_key) };
  } catch {
    console.error("asset_stream_failed");
    return denied(404);
  }
}

export async function recordConsent(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: Parameters<typeof deleteExpiredAsset>[0]["journal"];
  actor: Actor;
  consultationId: string;
  request: ConsentRequest;
  now: Date;
}): Promise<{ ok: true; consent: ConsentDto; deletions: DeletionView[] } | AssetFailure> {
  const access = await authorizeConsultation(options.pool, options.actor, options.consultationId, "owner");
  if (!access.ok) return denied(access.status);
  const uniqueAssets = [...new Set(options.request.assetIds)];
  if (uniqueAssets.length > 0) {
    const owned = await options.pool.query(
      `SELECT id FROM assets
       WHERE consultation_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
      [options.consultationId, uniqueAssets],
    );
    if ((owned.rowCount ?? 0) !== uniqueAssets.length) return denied(404);
  }
  const prior = await options.pool.query<{ accepted: boolean }>(
    `SELECT accepted FROM consents
     WHERE consultation_id = $1 AND accepted = true AND withdrawn_at IS NULL
     LIMIT 1`,
    [options.consultationId],
  );
  const withdrawal = !options.request.accepted && (prior.rowCount ?? 0) > 0;
  const inserted = await options.pool.query<{ id: string; accepted_at: Date }>(
    `INSERT INTO consents (
       consultation_id, actor_user_id, consent_version, providers, accepted, withdrawn_at, asset_scope, statement
     ) VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END, $7::uuid[], $8)
     RETURNING id, accepted_at`,
    [
      options.consultationId,
      options.actor.userId,
      options.request.consentVersion,
      options.request.providers,
      options.request.accepted,
      withdrawal,
      uniqueAssets,
      options.request.statement,
    ],
  );
  const row = inserted.rows[0];
  if (!row) return denied(404);
  const deletions: DeletionView[] = [];
  if (withdrawal && options.request.deleteAssets) {
    for (const assetId of uniqueAssets) {
      const deleted = await deleteExpiredAsset({
        pool: options.pool,
        storage: options.storage,
        journal: options.journal,
        assetId,
        now: options.now,
      });
      if (deleted.ok) deletions.push(deleted.deletion);
    }
  }
  return {
    ok: true,
    deletions,
    consent: {
      id: row.id,
      consultationId: options.consultationId,
      consentVersion: options.request.consentVersion,
      providers: options.request.providers,
      assetIds: uniqueAssets,
      accepted: options.request.accepted,
      withdrawn: withdrawal,
      recordedAt: row.accepted_at.toISOString(),
    },
  };
}

export async function recordDemoRetention(options: {
  pool: Pool;
  actor: Actor;
  assetId: string;
  consentId: string;
  retainedUntil: Date;
}): Promise<{ ok: true; expiresAt: string } | AssetFailure> {
  const asset = await options.pool.query<{
    consultation_id: string;
    client_user_id: string;
    salon_id: string;
    created_at: Date;
    deleted_at: Date | null;
  }>(
    `SELECT assets.consultation_id, consultations.client_user_id, consultations.salon_id,
            assets.created_at, assets.deleted_at
     FROM assets
     JOIN consultations ON consultations.id = assets.consultation_id
     WHERE assets.id = $1`,
    [options.assetId],
  );
  const row = asset.rows[0];
  if (!row || row.deleted_at) return denied(404);
  if (row.client_user_id !== options.actor.userId) {
    const member = await salonMember(options.pool, options.actor.userId, row.salon_id);
    return denied(member ? 403 : 404);
  }
  const minimum = row.created_at.getTime() + 30 * 24 * 60 * 60 * 1000;
  if (options.retainedUntil.getTime() <= minimum) {
    return { ok: false, status: 422, code: "unsupported_image", message: "Demo retention must be longer than 30 days and recorded separately." };
  }
  const consent = await options.pool.query(
    `SELECT 1 FROM consents
     WHERE id = $1 AND consultation_id = $2 AND accepted = true AND withdrawn_at IS NULL`,
    [options.consentId, row.consultation_id],
  );
  if ((consent.rowCount ?? 0) !== 1) return denied(404);
  try {
    await transaction(options.pool, async (client) => {
      await client.query(
        `INSERT INTO demo_asset_retentions (asset_id, actor_user_id, consent_id, retained_until)
         VALUES ($1, $2, $3, $4)`,
        [options.assetId, options.actor.userId, options.consentId, options.retainedUntil],
      );
      const updated = await client.query(
        `UPDATE assets SET expires_at = $2
         WHERE id = $1 AND deleted_at IS NULL`,
        [options.assetId, options.retainedUntil],
      );
      if (updated.rowCount !== 1) throw new Conflict();
    });
  } catch (error) {
    if (error instanceof Conflict) return denied(409);
    throw error;
  }
  return { ok: true, expiresAt: options.retainedUntil.toISOString() };
}

export async function attachDerivedAsset(options: {
  pool: Pool;
  storage: PrivateStorage;
  consultationId: string;
  sourceAssetId: string;
  file: Buffer;
  retentionDays: number;
}): Promise<{ ok: true; assetId: string } | { ok: false; reason: "deleted" | "invalid_image" }> {
  let image;
  try {
    image = await normalizeImage(options.file);
  } catch {
    return { ok: false, reason: "invalid_image" };
  }
  const key = randomBytes(32).toString("hex");
  await options.storage.write(key, image.bytes);
  try {
    const inserted = await options.pool.query<{ id: string }>(
      `INSERT INTO assets (
         owner_user_id, consultation_id, role, storage_key, content_hash,
         width, height, mime_type, expires_at, provenance, source_asset_id
       )
       SELECT assets.owner_user_id, assets.consultation_id, 'preview', $3, $4, $5, $6, $7,
              now() + make_interval(days => $8), 'provider_derivative', assets.id
       FROM assets
       JOIN consultations ON consultations.id = assets.consultation_id
       WHERE assets.id = $1
         AND assets.consultation_id = $2
         AND assets.deleted_at IS NULL
         AND consultations.deleted_at IS NULL
       RETURNING id`,
      [
        options.sourceAssetId,
        options.consultationId,
        key,
        image.contentHash,
        image.width,
        image.height,
        image.mimeType,
        options.retentionDays,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      await options.storage.remove(key);
      return { ok: false, reason: "deleted" };
    }
    return { ok: true, assetId: id };
  } catch (error) {
    await options.storage.remove(key).catch(() => {
      console.error("asset_cleanup_failed");
    });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("deleted")) return { ok: false, reason: "deleted" };
    throw error;
  }
}

export type ConsentDto = {
  id: string;
  consultationId: string;
  consentVersion: string;
  providers: ProviderName[];
  assetIds: string[];
  accepted: boolean;
  withdrawn: boolean;
  recordedAt: string;
};

function toDto(row: {
  id: string;
  consultation_id: string;
  role: AssetDto["role"];
  mime_type: AssetDto["mimeType"];
  width: number;
  height: number;
  provenance: AssetDto["provenance"];
  expires_at: Date;
  created_at: Date;
}): AssetDto {
  return {
    id: row.id,
    consultationId: row.consultation_id,
    role: row.role,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    provenance: row.provenance,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

class Conflict extends Error {
  constructor() {
    super("conflict");
    this.name = "Conflict";
  }
}

async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function denied(status: 403 | 404 | 409): AssetFailure {
  if (status === 403) return { ok: false, status, code: "forbidden", message: "You cannot change this consultation." };
  if (status === 409) return { ok: false, status, code: "stale_version", message: "The consultation changed. Reload and try again." };
  return { ok: false, status: 404, code: "not_found", message: "That photograph or consultation is not available." };
}

function stale(currentVersion: number): AssetFailure {
  return {
    ok: false,
    status: 409,
    code: "stale_version",
    message: "The consultation changed. Reload and try again.",
    currentVersion,
  };
}
