import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

export type MigrationResult = {
  applied: string[];
};

export async function migrate(connectionString: string, migrationsDirectory: string): Promise<MigrationResult> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    const applied: string[] = [];
    for (const filename of files) {
      const sqlText = await readFile(path.join(migrationsDirectory, filename), "utf8");
      const checksum = createHash("sha256").update(sqlText).digest("hex");
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      const recorded = existing.rows[0];
      if (recorded) {
        if (recorded.checksum !== checksum) {
          throw new Error(`Migration checksum changed: ${filename}`);
        }
        continue;
      }
      await client.query(sqlText);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [filename, checksum],
      );
      applied.push(filename);
    }
    await client.query("COMMIT");
    return { applied };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

/** Migration files on disk that the database has not recorded as applied. */
export async function pendingMigrations(pool: pg.Pool, migrationsDirectory: string): Promise<string[]> {
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const table = await pool.query<{ present: string | null }>("SELECT to_regclass('schema_migrations') AS present");
  if (!table.rows[0]?.present) return files;
  const done = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(done.rows.map((row) => row.filename));
  return files.filter((name) => !applied.has(name));
}
