import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expireAssets } from "./deletion.js";
import { createDeletionJournal } from "./journal.js";
import { createPrivateStorage } from "./storage.js";
import { loadConfig, loadLocalEnv } from "../config.js";

const { Pool } = pg;

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const result = await expireAssets({
      pool,
      storage: createPrivateStorage(config.privateStorageDir),
      journal: createDeletionJournal(config),
      now: new Date(),
    });
    console.log(`Expired assets completed: ${result.completed}; pending: ${result.pending}`);
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "asset_expiry_failed");
    process.exitCode = 1;
  });
}
