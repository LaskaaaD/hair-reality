import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export type DeletionScope = "asset" | "consultation";

export type DeletionJournalEntry = {
  operationId: string;
  resourceId: string;
  scope: DeletionScope;
  timestamp: string;
};

export type DeletionAcknowledgement = {
  sequence: number;
  operationId: string;
  checksum: string;
};

export type DeletionJournal = {
  append(entry: DeletionJournalEntry): Promise<DeletionAcknowledgement>;
};

export class JournalUnavailableError extends Error {
  constructor() {
    super("deletion_journal_unavailable");
    this.name = "JournalUnavailableError";
  }
}

export type StoredIntent = DeletionJournalEntry & DeletionAcknowledgement;

export function journalChecksum(entry: DeletionJournalEntry): string {
  return createHash("sha256")
    .update(`${entry.operationId}|${entry.resourceId}|${entry.scope}|${entry.timestamp}`)
    .digest("hex");
}

export function createDeletionJournal(config: AppConfig): DeletionJournal {
  // "none": the legacy consultation deletion is not configured (the hackathon demo never uses it), so it fails closed.
  if (config.deletionJournalMode === "none") return new UnavailableDeletionJournal();
  if (config.deletionJournalMode === "remote") {
    if (!config.backupHost) return new UnavailableDeletionJournal();
    return new RemoteDeletionJournal(`https://${config.backupHost}`);
  }
  return new LocalDeletionJournal(config.deletionJournalDir);
}

export class RemoteDeletionJournal implements DeletionJournal {
  constructor(private readonly baseUrl: string) {}

  async append(entry: DeletionJournalEntry): Promise<DeletionAcknowledgement> {
    let response: Response;
    try {
      response = await fetch(new URL("/intents", this.baseUrl), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
    } catch {
      throw new JournalUnavailableError();
    }
    if (!response.ok) throw new JournalUnavailableError();
    const body = await response.json() as Partial<DeletionAcknowledgement>;
    if (body.operationId !== entry.operationId || body.checksum !== journalChecksum(entry) || typeof body.sequence !== "number") {
      throw new JournalUnavailableError();
    }
    return { sequence: body.sequence, operationId: entry.operationId, checksum: body.checksum };
  }
}

export class UnavailableDeletionJournal implements DeletionJournal {
  async append(): Promise<DeletionAcknowledgement> {
    throw new JournalUnavailableError();
  }
}

export class LocalDeletionJournal implements DeletionJournal {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly directory: string) {}

  append(entry: DeletionJournalEntry): Promise<DeletionAcknowledgement> {
    const result = this.tail.then(() => this.write(entry));
    this.tail = result.then(() => undefined, () => undefined);
    return result;
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
        return { sequence: previous.sequence, operationId: previous.operationId, checksum: previous.checksum };
      }
      const sequence = (existing.at(-1)?.sequence ?? 0) + 1;
      if (existing.some((intent) => intent.sequence === sequence)) throw new JournalUnavailableError();
      const stored: StoredIntent = { ...entry, sequence, checksum };
      await handle.write(`${JSON.stringify(stored)}\n`);
      await handle.sync();
      return { sequence, operationId: entry.operationId, checksum };
    } finally {
      await handle.close();
    }
  }
}

export function parseJournal(contents: string): StoredIntent[] {
  if (contents.trim() === "") return [];
  const intents: StoredIntent[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: Partial<StoredIntent>;
    try {
      parsed = JSON.parse(line) as Partial<StoredIntent>;
    } catch {
      throw new JournalUnavailableError();
    }
    if (!parsed.operationId || !parsed.resourceId || !parsed.scope || !parsed.timestamp || !parsed.checksum) {
      throw new JournalUnavailableError();
    }
    if (parsed.sequence !== intents.length + 1) throw new JournalUnavailableError();
    const entry = {
      operationId: parsed.operationId,
      resourceId: parsed.resourceId,
      scope: parsed.scope,
      timestamp: parsed.timestamp,
    };
    if (parsed.checksum !== journalChecksum(entry)) throw new JournalUnavailableError();
    intents.push({ ...entry, sequence: parsed.sequence, checksum: parsed.checksum });
  }
  return intents;
}
