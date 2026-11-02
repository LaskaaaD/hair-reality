import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig, loadLocalEnv } from "../config.js";
import { createPrivateStorage } from "../assets/storage.js";
import { purgeExpiredDemo } from "./purge.js";
import { renderCacheDir } from "./render-cache.js";

const { Pool } = pg;

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  try {
    const result = await purgeExpiredDemo({
      pool,
      storage: createPrivateStorage(config.privateStorageDir),
      renderCacheDir: renderCacheDir(config.renderCacheDir),
      now: new Date(),
    });
    console.log(`Expired demo purge: sessions ${result.sessions}, files ${result.files}, cached renders ${result.cachedRenders}`);
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "demo_purge_failed");
    process.exitCode = 1;
  });
}
