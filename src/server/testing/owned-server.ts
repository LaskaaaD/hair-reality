import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLocalEnv } from "../config.js";
import { assertTestDatabase } from "../db/database-identity.js";
import { ensureDemonstrationSalon } from "../db/ensure-demo-salon.js";

export type OwnedServer = {
  baseUrl: string;
  exited: Promise<never>;
  stop: () => Promise<void>;
};

export function assertProductionBuild(root = process.cwd()): void {
  const server = path.join(root, "dist", "server", "index.js");
  const shell = path.join(root, "dist", "client", "index.html");
  if (!existsSync(server) || !existsSync(shell)) {
    throw new Error("Production build is missing. Run npm run build before this check.");
  }
}

export function fixtureChildEnv(source: NodeJS.ProcessEnv, options: {
  port: number;
  privateDir: string;
  journalDir: string;
  name: string;
}): NodeJS.ProcessEnv {
  const applicationUrl = required(source, "DATABASE_URL");
  const testUrl = required(source, "TEST_DATABASE_URL");
  assertTestDatabase(applicationUrl, testUrl);
  const env: NodeJS.ProcessEnv = { ...source };
  delete env.YOUCAM_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.YOUCAM_API_BASE_URL;
  delete env.SEED_CLIENT_PASSWORD;
  delete env.SEED_STYLIST_PASSWORD;
  delete env.SEED_ADMIN_PASSWORD;
  delete env.SEED_ISOLATION_PASSWORD;
  delete env.POSTGRES_PASSWORD;
  env.DATABASE_URL = testUrl;
  delete env.TEST_DATABASE_URL;
  env.HAIR_REALITY_SKIP_ENV_FILE = "1";
  env.PORT = String(options.port);
  env.APP_ORIGIN = `http://127.0.0.1:${options.port}`;
  env.PROVIDER_MODE = "fixture";
  env.NODE_ENV = "development";
  env.PRIVATE_STORAGE_DIR = options.privateDir;
  env.DELETION_JOURNAL_DIR = options.journalDir;
  env.DELETION_JOURNAL_MODE = "local";
  env.HAIR_REALITY_PROCESS = options.name;
  if (options.name === "fixture-e2e") env.HAIR_REALITY_FIXTURE_AUTH_PARTITION = "1";
  return env;
}

export async function assertPortAvailable(port: number): Promise<void> {
  await assertHostPortAvailable(port, "127.0.0.1");
  await assertHostPortAvailable(port, "::1");
}

export async function startOwnedServer(port: number, name: string): Promise<OwnedServer> {
  assertProductionBuild();
  loadLocalEnv();
  await assertPortAvailable(port);
  const privateDir = await mkdtemp(path.join(tmpdir(), "hair-reality-private-"));
  const journalDir = await mkdtemp(path.join(tmpdir(), "hair-reality-journal-"));
  let env: NodeJS.ProcessEnv;
  try {
    env = fixtureChildEnv(process.env, { port, privateDir, journalDir, name });
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error("TEST_DATABASE_URL is required");
    await ensureDemonstrationSalon(testUrl);
  } catch (error) {
    await Promise.all([
      rm(privateDir, { recursive: true, force: true }),
      rm(journalDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
  const child = spawn(process.execPath, [path.join("dist", "server", "index.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  const collect = (chunk: Buffer) => {
    logs = `${logs}${chunk.toString("utf8")}`.slice(-8000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  if (child.pid !== undefined) await trackOwnedDirectories(child.pid, privateDir, journalDir);
  let stopped = false;
  let rejectExit: (error: Error) => void = () => undefined;
  const exited = new Promise<never>((_resolve, reject) => {
    rejectExit = reject;
  });
  void exited.catch(() => undefined);
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    killOwnedProcess(child);
    await Promise.all([
      rm(privateDir, { recursive: true, force: true }),
      rm(journalDir, { recursive: true, force: true }),
    ]);
    if (child.pid !== undefined) await forgetOwnedDirectories(child.pid);
  };
  child.once("exit", (code) => {
    if (stopped) return;
    rejectExit(new Error(redact(`Owned server exited with code ${code ?? "unknown"}.\n${logs}`)));
  });
  return { baseUrl: `http://127.0.0.1:${port}`, exited, stop };
}

export function killOwnedProcess(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

export function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]");
}

const ownedRegistryPrefix = "hair-reality-owned-";

export async function trackOwnedDirectories(pid: number, privateDir: string, journalDir: string): Promise<void> {
  await writeFile(registryPath(pid), JSON.stringify({ privateDir, journalDir }), "utf8");
}

export async function releaseAbandonedOwnedDirectories(): Promise<void> {
  const entries = await readdir(tmpdir());
  await Promise.all(entries.map(async (name) => {
    if (!name.startsWith(ownedRegistryPrefix) || !name.endsWith(".json")) return;
    const pid = Number(name.slice(ownedRegistryPrefix.length, -".json".length));
    if (!Number.isInteger(pid) || pid <= 0 || processAlive(pid)) return;
    const file = path.join(tmpdir(), name);
    let record: { privateDir?: unknown; journalDir?: unknown };
    try {
      record = JSON.parse(await readFile(file, "utf8")) as { privateDir?: unknown; journalDir?: unknown };
    } catch {
      return;
    }
    const dirs = [record.privateDir, record.journalDir].filter((value): value is string => (
      typeof value === "string" && isInsideTmp(value)
    ));
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await rm(file, { force: true });
  }));
}

function registryPath(pid: number): string {
  return path.join(tmpdir(), `${ownedRegistryPrefix}${pid}.json`);
}

async function forgetOwnedDirectories(pid: number): Promise<void> {
  await rm(registryPath(pid), { force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isInsideTmp(dir: string): boolean {
  const root = path.resolve(tmpdir()).toLowerCase();
  const target = path.resolve(dir).toLowerCase();
  return target.startsWith(`${root}${path.sep}`);
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example to .env, then run docker compose up -d db and npm run db:migrate.`);
  }
  return value;
}

function assertHostPortAvailable(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} on ${host} is already in use. Refusing to attach to an existing process.`));
        return;
      }
      if (host === "::1") {
        resolve();
        return;
      }
      reject(error);
    });
    server.listen(port, host, () => {
      server.close(() => resolve());
    });
  });
}
