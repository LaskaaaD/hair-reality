import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig, loadLocalEnv } from "../config.js";
import { assertTestDatabase, databaseIdentity, isSameDatabase } from "./database-identity.js";
import { migrate } from "./migrate.js";

const { Client } = pg;
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../migrations");

export async function ensureDatabase(connectionString: string): Promise<void> {
  const identity = databaseIdentity(connectionString);
  if (!/^[a-z][a-z0-9_]*$/.test(identity.database)) {
    throw new Error("Database name is not a safe identifier");
  }
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [identity.database]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${identity.database}`);
    }
  } finally {
    await client.end();
  }
}

export async function resetTestDatabase(applicationUrl: string, testUrl: string): Promise<void> {
  assertTestDatabase(applicationUrl, testUrl);
  const client = new Client({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  } finally {
    await client.end();
  }
}

export async function dropScratchDatabase(applicationUrl: string, scratchUrl: string): Promise<void> {
  assertTestDatabase(applicationUrl, scratchUrl);
  const identity = databaseIdentity(scratchUrl);
  if (identity.database !== "hair_reality_migration_scratch") {
    throw new Error("Refusing to drop a database outside the migration scratch name");
  }
  const maintenance = new URL(scratchUrl);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [identity.database],
    );
    await client.query(`DROP DATABASE IF EXISTS ${identity.database}`);
  } finally {
    await client.end();
  }
}

export async function migrateConfigured(connectionString: string): Promise<void> {
  const result = await migrate(connectionString, migrationsDirectory);
  const identity = databaseIdentity(connectionString);
  console.log(`Migrated ${identity.database}: ${result.applied.length === 0 ? "already current" : result.applied.join(", ")}`);
}

export async function runMigrations(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
  await ensureDatabase(config.databaseUrl);
  await migrateConfigured(config.databaseUrl);
  if (config.testDatabaseUrl && !isSameDatabase(config.databaseUrl, config.testDatabaseUrl)) {
    await ensureDatabase(config.testDatabaseUrl);
    await migrateConfigured(config.testDatabaseUrl);
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  runMigrations().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "migration failed";
    console.error(message);
    process.exitCode = 1;
  });
}
