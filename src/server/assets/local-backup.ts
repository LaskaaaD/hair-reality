import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import pg from "pg";
import { databaseIdentity } from "../db/database-identity.js";
import { replayDeletionIntent } from "./deletion.js";
import { decideRestore, type BackupManifest, type RestoreDecision } from "./restore.js";
import { createPrivateStorage } from "./storage.js";

const { Client, Pool } = pg;
export const RESTORE_DATABASE_NAME = "hair_reality_restore_scratch";

export async function dumpPostgresDatabase(connectionString: string, destination: string): Promise<void> {
  const identity = databaseIdentity(connectionString);
  assertIdentifier(identity.database);
  await mkdir(path.dirname(destination), { recursive: true });
  await runDocker([
    "pg_dump",
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "-U",
    "hair_reality",
    "-d",
    identity.database,
  ], destination);
}

export async function openIsolatedRestore(options: {
  applicationUrl: string;
  sourceUrl: string;
  dumpFile: string;
  manifest: BackupManifest;
  manifestChecksum: string;
  journalText: string | null;
  checkpoint: { sequence: number; checksum: string } | null;
  assetBackupDir: string;
  assetRestoreDir: string;
  beforeOpen?: (pool: pg.Pool) => Promise<void>;
}): Promise<RestoreDecision> {
  const source = databaseIdentity(options.sourceUrl);
  const application = databaseIdentity(options.applicationUrl);
  if (source.database === application.database || source.database === RESTORE_DATABASE_NAME) {
    throw new Error("restore_source_refused");
  }
  const decision = decideRestore({
    manifest: options.manifest,
    manifestChecksum: options.manifestChecksum,
    journalText: options.journalText,
    checkpoint: options.checkpoint,
  });
  await rm(options.assetRestoreDir, { recursive: true, force: true });
  if (!decision.open) {
    await dropRestoreDatabase(options.sourceUrl);
    return decision;
  }
  const restoreUrl = await recreateRestoreDatabase(options.sourceUrl);
  await runDocker([
    "pg_restore",
    "--no-owner",
    "--no-acl",
    "--exit-on-error",
    "-U",
    "hair_reality",
    "-d",
    RESTORE_DATABASE_NAME,
  ], undefined, options.dumpFile);
  await cp(options.assetBackupDir, options.assetRestoreDir, { recursive: true });
  const pool = new Pool({ connectionString: restoreUrl, max: 2, connectionTimeoutMillis: 5000 });
  try {
    const storage = createPrivateStorage(options.assetRestoreDir);
    for (const intent of decision.replay) {
      await replayDeletionIntent(pool, storage, intent, new Date(intent.timestamp));
    }
    if (await restoredAccessOpen(options.assetRestoreDir)) throw new Error("restore_opened_before_replay");
    await options.beforeOpen?.(pool);
    await writeFile(path.join(options.assetRestoreDir, "access-open.json"), JSON.stringify({
      openedAt: new Date().toISOString(),
      replayed: decision.replay.length,
    }));
  } finally {
    await pool.end();
  }
  return decision;
}

export async function restoredAccessOpen(directory: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(directory, "access-open.json"), "utf8");
    const parsed = JSON.parse(text) as { openedAt?: string };
    return typeof parsed.openedAt === "string";
  } catch {
    return false;
  }
}

export async function dropRestoreDatabase(connectionString: string): Promise<void> {
  const client = await maintenanceClient(connectionString);
  try {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [RESTORE_DATABASE_NAME],
    );
    await client.query(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE_NAME}`);
  } finally {
    await client.end();
  }
}

async function recreateRestoreDatabase(connectionString: string): Promise<string> {
  await dropRestoreDatabase(connectionString);
  const client = await maintenanceClient(connectionString);
  try {
    await client.query(`CREATE DATABASE ${RESTORE_DATABASE_NAME}`);
  } finally {
    await client.end();
  }
  const url = new URL(connectionString);
  url.pathname = `/${RESTORE_DATABASE_NAME}`;
  return url.toString();
}

async function maintenanceClient(connectionString: string): Promise<pg.Client> {
  const maintenance = new URL(connectionString);
  maintenance.pathname = "/postgres";
  const client = new Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  return client;
}

function assertIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("restore_database_name_refused");
}

function runDocker(command: string[], outputFile?: string, inputFile?: string): Promise<void> {
  const label = command[0] ?? "postgres";
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", "exec", "-T", "db", ...command], {
      cwd: path.resolve("."),
      stdio: [inputFile ? "pipe" : "ignore", outputFile ? "pipe" : "ignore", "pipe"],
      windowsHide: true,
    });
    child.on("error", () => reject(new Error("docker_compose_unavailable")));
    child.stderr?.on("data", () => undefined);
    if (outputFile && child.stdout) {
      const output = createWriteStream(outputFile);
      child.stdout.pipe(output);
      child.on("close", (code) => {
        if (code !== 0) {
          output.destroy();
          reject(new Error(`${label}_failed`));
          return;
        }
        void finished(output).then(() => resolve(), () => reject(new Error(`${label}_failed`)));
      });
      return;
    }
    if (inputFile && child.stdin) {
      const input = createReadStream(inputFile);
      input.pipe(child.stdin);
      input.on("error", () => {
        child.kill();
        reject(new Error(`${label}_failed`));
      });
    }
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label}_failed`));
    });
  });
}
