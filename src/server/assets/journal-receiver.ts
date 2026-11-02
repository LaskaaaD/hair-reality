import { createServer, type Server } from "node:http";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import {
  JournalUnavailableError,
  journalChecksum,
  parseJournal,
  type DeletionAcknowledgement,
  type DeletionJournalEntry,
  type DeletionScope,
} from "./journal.js";

type Checkpoint = { sequence: number; checksum: string };

export class DurableJournalDirectory {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  append(entry: DeletionJournalEntry): Promise<DeletionAcknowledgement> {
    const result = this.tail.then(() => this.write(entry));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async readText(): Promise<string | null> {
    return readOptional(path.join(this.directory, "intents.jsonl"));
  }

  async checkpoint(): Promise<Checkpoint | null> {
    const text = await readOptional(path.join(this.directory, "checkpoint.json"));
    if (text === null) return null;
    return parseCheckpoint(text);
  }

  private async write(entry: DeletionJournalEntry): Promise<DeletionAcknowledgement> {
    await mkdir(this.directory, { recursive: true });
    const file = path.join(this.directory, "intents.jsonl");
    const handle = await open(file, "a+");
    try {
      const info = await handle.stat();
      const contents = Buffer.alloc(info.size);
      if (info.size > 0) await handle.read(contents, 0, info.size, 0);
      const existing = parseJournal(contents.toString("utf8"));
      const checksum = journalChecksum(entry);
      const previous = existing.find((intent) => intent.operationId === entry.operationId);
      if (previous) {
        if (previous.checksum !== checksum || previous.resourceId !== entry.resourceId || previous.scope !== entry.scope) {
          throw new JournalUnavailableError();
        }
        const acknowledgement = { sequence: previous.sequence, operationId: previous.operationId, checksum: previous.checksum };
        await writeCheckpoint(this.directory, acknowledgement);
        return acknowledgement;
      }
      const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
      const stored = { ...entry, sequence, checksum };
      await handle.write(`${JSON.stringify(stored)}\n`);
      await handle.sync();
      const acknowledgement = { sequence, operationId: entry.operationId, checksum };
      await writeCheckpoint(this.directory, acknowledgement);
      return acknowledgement;
    } finally {
      await handle.close();
    }
  }
}

export function startJournalReceiver(directory: string): Promise<{ url: string; close: () => Promise<void> }> {
  const store = new DurableJournalDirectory(directory);
  const server = createServer((request, response) => {
    void handle(store, request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server),
      });
    });
  });
}

async function handle(
  store: DurableJournalDirectory,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  try {
    if (request.method === "GET" && request.url === "/journal") {
      send(response, 200, { journalText: await store.readText(), checkpoint: await store.checkpoint() });
      return;
    }
    if (request.method !== "POST" || request.url !== "/intents") {
      send(response, 404, { error: "not_found" });
      return;
    }
    const entry = parseEntry(await readBody(request));
    if (!entry) {
      send(response, 400, { error: "invalid_intent" });
      return;
    }
    send(response, 200, await store.append(entry));
  } catch {
    send(response, 503, { error: "deletion_journal_unavailable" });
  }
}

function parseEntry(raw: string): DeletionJournalEntry | null {
  let parsed: Partial<DeletionJournalEntry>;
  try {
    parsed = JSON.parse(raw) as Partial<DeletionJournalEntry>;
  } catch {
    return null;
  }
  if (!isUuid(parsed.operationId) || !isUuid(parsed.resourceId)) return null;
  if (parsed.scope !== "asset" && parsed.scope !== "consultation") return null;
  if (!isTimestamp(parsed.timestamp)) return null;
  const entry: DeletionJournalEntry = {
    operationId: parsed.operationId,
    resourceId: parsed.resourceId,
    scope: parsed.scope as DeletionScope,
    timestamp: parsed.timestamp,
  };
  return entry;
}

function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function writeCheckpoint(directory: string, acknowledgement: DeletionAcknowledgement): Promise<void> {
  const temporary = path.join(directory, "checkpoint.json.tmp");
  const target = path.join(directory, "checkpoint.json");
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify({ sequence: acknowledgement.sequence, checksum: acknowledgement.checksum }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function parseCheckpoint(text: string): Checkpoint {
  const parsed = JSON.parse(text) as Partial<Checkpoint>;
  if (typeof parsed.sequence !== "number" || typeof parsed.checksum !== "string") throw new JournalUnavailableError();
  return { sequence: parsed.sequence, checksum: parsed.checksum };
}
