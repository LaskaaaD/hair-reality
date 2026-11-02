import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { PrivateStorage } from "../assets/storage.js";

export type PurgeResult = { sessions: number; files: number; cachedRenders: number };

/**
 * Deletes demo sessions whose 7 days are over, with their photos, previews and references (rows cascade),
 * then the stored files and render-cache copies nothing active still points at. Usage rows stay for the unit caps.
 */
export async function purgeExpiredDemo(options: {
  pool: Pool;
  storage: PrivateStorage;
  renderCacheDir: string;
  now: Date;
}): Promise<PurgeResult> {
  const { pool, storage, renderCacheDir, now } = options;
  const expired = await pool.query<{ id: string }>(`SELECT id FROM demo_sessions WHERE expires_at <= $1`, [now]);
  const ids = expired.rows.map((row) => row.id);
  if (ids.length === 0) return { sessions: 0, files: 0, cachedRenders: 0 };

  const keys = await pool.query<{ key: string }>(
    `SELECT storage_key AS key FROM demo_photos WHERE session_id = ANY($1) AND storage_key IS NOT NULL
     UNION SELECT storage_key FROM demo_previews WHERE session_id = ANY($1) AND storage_key IS NOT NULL
     UNION SELECT storage_key FROM demo_references WHERE session_id = ANY($1) AND storage_key IS NOT NULL
     UNION SELECT storage_key FROM demo_jobs WHERE session_id = ANY($1) AND storage_key IS NOT NULL`,
    [ids],
  );
  const hashes = await pool.query<{ hash: string }>(
    `SELECT DISTINCT content_hash AS hash FROM demo_photos WHERE session_id = ANY($1)`,
    [ids],
  );

  await pool.query(`DELETE FROM demo_sessions WHERE id = ANY($1) AND expires_at <= $2`, [ids, now]);

  let files = 0;
  for (const { key } of keys.rows) {
    const stillUsed = await pool.query(
      `SELECT 1 FROM demo_photos WHERE storage_key = $1
       UNION ALL SELECT 1 FROM demo_previews WHERE storage_key = $1
       UNION ALL SELECT 1 FROM demo_references WHERE storage_key = $1
       UNION ALL SELECT 1 FROM demo_jobs WHERE storage_key = $1 LIMIT 1`,
      [key],
    );
    if (stillUsed.rowCount) continue;
    await storage.remove(key);
    files += 1;
  }

  const stillActiveHashes = new Set(
    (await pool.query<{ hash: string }>(`SELECT DISTINCT content_hash AS hash FROM demo_photos`)).rows.map((row) => row.hash),
  );
  const expiredHashes = new Set(hashes.rows.map((row) => row.hash).filter((hash) => !stillActiveHashes.has(hash)));
  let cachedRenders = 0;
  if (expiredHashes.size > 0) {
    let names: string[] = [];
    try {
      names = await readdir(renderCacheDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const hash = name.split("__")[0];
      if (hash && expiredHashes.has(hash)) {
        await rm(path.join(renderCacheDir, name), { force: true });
        cachedRenders += 1;
      }
    }
  }
  return { sessions: ids.length, files, cachedRenders };
}
