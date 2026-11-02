import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { providerNames, type ProviderName } from "../../shared/assets.js";
import { loadConfig, loadLocalEnv } from "../config.js";
import { createPrivateStorage } from "./storage.js";
import { createDeletionJournal } from "./journal.js";
import { importOwnedPhotograph } from "./import-photo.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_URL is required.");
  const args = readArgs(process.argv.slice(2));
  if (!args.email || (!args.file && args.assetIds.length === 0)) {
    throw new Error("Usage: npm run operator:import-photo -- --email you@example.com --role current_front --file C:\\path\\photo.jpg [--consultation id] [--providers youcam,openai]. The command asks for the account password without showing it. After reading the printed statement, record consent with --asset STORED_ID --accept and no --file.");
  }
  const password = await readPassword();
  const file = args.file ? await readFile(args.file) : undefined;
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = await importOwnedPhotograph({
      pool,
      storage: createPrivateStorage(config.privateStorageDir),
      journal: createDeletionJournal(config),
      now: new Date(),
      retentionDays: config.assetRetentionDays,
      email: args.email,
      password,
      ...(args.role ? { role: args.role } : {}),
      ...(file ? { file } : {}),
      ...(args.consultation ? { consultationId: args.consultation } : {}),
      accept: args.accept,
      providers: args.providers,
      ...(args.assetIds.length > 0 ? { assetIds: args.assetIds } : {}),
    });
    console.log(result.statement);
    if (!result.ok) {
      console.error(result.message);
      if (result.consultationIds) console.error(result.consultationIds.join("\n"));
      process.exitCode = 1;
      return;
    }
    if (result.assetId) console.log(`Stored photograph ${result.assetId} on consultation ${result.consultationId}.`);
    if (result.consentRecorded) {
      console.log("Consent was recorded. These photographs may be sent only to the named providers.");
      return;
    }
    console.log("The photograph is stored privately. Consent was not recorded, so it will not be sent to YouCam or OpenAI.");
    if (result.assetId) {
      console.log(`Run again with --asset ${result.assetId} --accept, and without --file, only after you agree with the statement above. The password prompt appears again and stays hidden.`);
    }
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

async function readPassword(): Promise<string> {
  const supplied = process.env.HAIR_REALITY_OWNER_PASSWORD;
  if (supplied) return supplied;
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Run this command in a terminal so the account password can be entered without being shown.");
  }
  process.stdout.write("Account password: ");
  const password = await new Promise<string>((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Photograph import cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char < " ") continue;
        value += char;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
  });
  if (!password) throw new Error("The account password is required.");
  return password;
}

function readArgs(argv: readonly string[]): {
  email?: string;
  role?: string;
  file?: string;
  consultation?: string;
  accept: boolean;
  providers: ProviderName[];
  assetIds: string[];
} {
  let email: string | undefined;
  let role: string | undefined;
  let file: string | undefined;
  let consultation: string | undefined;
  let accept = false;
  let providers: ProviderName[] = ["youcam", "openai"];
  const assetIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--accept") accept = true;
    else if (arg === "--email" && next) { email = next; index += 1; }
    else if (arg === "--role" && next) { role = next; index += 1; }
    else if (arg === "--file" && next) { file = path.resolve(next); index += 1; }
    else if (arg === "--consultation" && next) { consultation = next; index += 1; }
    else if (arg === "--asset" && next) { assetIds.push(next); index += 1; }
    else if (arg === "--providers" && next) {
      providers = next.split(",").filter((provider): provider is ProviderName => providerNames.includes(provider as ProviderName));
      index += 1;
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return {
    accept,
    providers,
    assetIds,
    ...(email ? { email } : {}),
    ...(role ? { role } : {}),
    ...(file ? { file } : {}),
    ...(consultation ? { consultation } : {}),
  };
}

const isDirect = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Photograph import failed.");
    process.exitCode = 1;
  });
}
