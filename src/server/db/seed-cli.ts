import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadLocalEnv } from "../config.js";
import { seed } from "./seed.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  const result = await seed({
    connectionString: config.databaseUrl,
    nodeEnv: config.nodeEnv,
    passwords: {
      SEED_CLIENT_PASSWORD: process.env.SEED_CLIENT_PASSWORD,
      SEED_STYLIST_PASSWORD: process.env.SEED_STYLIST_PASSWORD,
      SEED_ADMIN_PASSWORD: process.env.SEED_ADMIN_PASSWORD,
    },
    includeIsolation: false,
    credentialsFile: path.resolve("var/seed-credentials.txt"),
  });
  console.log(`Seed complete. New users: ${result.createdUsers}. No catalogue template IDs were inserted.`);
  if (result.wroteCredentials) {
    console.log("Generated passwords were written to var/seed-credentials.txt");
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "seed failed";
    console.error(message);
    process.exitCode = 1;
  });
}
