import { createHash } from "node:crypto";
import { parseJournal, type StoredIntent } from "./journal.js";

export type BackupManifest = {
  imageDigest: string;
  checkpointSequence: number;
  checkpointChecksum: string;
};

export type RestoreDecision = {
  open: false;
  reason: "journal_missing" | "journal_gap" | "checkpoint_mismatch" | "manifest_mismatch";
} | {
  open: true;
  replay: StoredIntent[];
};

export function manifestChecksum(manifest: BackupManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function decideRestore(input: {
  manifest: BackupManifest;
  manifestChecksum: string;
  journalText: string | null;
  checkpoint: { sequence: number; checksum: string } | null;
}): RestoreDecision {
  if (input.manifestChecksum !== manifestChecksum(input.manifest)) return { open: false, reason: "manifest_mismatch" };
  if (input.journalText === null || input.checkpoint === null) return { open: false, reason: "journal_missing" };
  let intents: StoredIntent[];
  try {
    intents = parseJournal(input.journalText);
  } catch {
    return { open: false, reason: "journal_gap" };
  }
  const last = intents.at(-1);
  if (!last || last.sequence !== input.checkpoint.sequence || last.checksum !== input.checkpoint.checksum) {
    return { open: false, reason: "checkpoint_mismatch" };
  }
  if (input.manifest.checkpointSequence > last.sequence || input.manifest.checkpointChecksum !== intents[input.manifest.checkpointSequence - 1]?.checksum) {
    return { open: false, reason: "journal_gap" };
  }
  return { open: true, replay: intents.filter((intent) => intent.sequence > input.manifest.checkpointSequence) };
}
