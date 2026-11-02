import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RemoteDeletionJournal, type DeletionScope } from "../../src/server/assets/journal.js";
import { startJournalReceiver } from "../../src/server/assets/journal-receiver.js";
import { decideRestore, manifestChecksum, type BackupManifest } from "../../src/server/assets/restore.js";

test("an off-host journal replays a post-backup deletion and a broken journal stays closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-receiver-"));
  const receiver = await startJournalReceiver(directory);
  try {
    const journal = new RemoteDeletionJournal(receiver.url);
    const kept = "8c0a9b11-2233-4455-6677-8899aabbccdd";
    const removed = "9c0a9b11-2233-4455-6677-8899aabbccde";
    const first = await journal.append(intent("4f1b5d8e-6c2a-4e7b-9d11-223344556677", kept, "asset"));
    const duplicate = await journal.append(intent("4f1b5d8e-6c2a-4e7b-9d11-223344556677", kept, "asset"));
    assert.equal(duplicate.sequence, first.sequence);
    const manifest: BackupManifest = {
      imageDigest: "sha256:fixture",
      checkpointSequence: first.sequence,
      checkpointChecksum: first.checksum,
    };
    const signed = manifestChecksum(manifest);
    await journal.append(intent("5f1b5d8e-6c2a-4e7b-9d11-223344556678", removed, "consultation"));
    const stored = await fetch(new URL("/journal", receiver.url)).then(async (response) => {
      assert.equal(response.status, 200);
      return await response.json() as { journalText: string | null; checkpoint: { sequence: number; checksum: string } | null };
    });
    const primary = new Map<string, string>([[kept, "photo"], [removed, "consultation"]]);
    const decision = decideRestore({
      manifest,
      manifestChecksum: signed,
      journalText: stored.journalText,
      checkpoint: stored.checkpoint,
    });
    assert.equal(decision.open, true);
    if (decision.open) {
      assert.equal(decision.replay.length, 1);
      for (const item of decision.replay) primary.delete(item.resourceId);
    }
    assert.equal(primary.has(kept), true);
    assert.equal(primary.has(removed), false);
    assert.deepEqual(
      decideRestore({ manifest, manifestChecksum: signed, journalText: null, checkpoint: null }),
      { open: false, reason: "journal_missing" },
    );
    const gapped = decideRestore({
      manifest,
      manifestChecksum: signed,
      journalText: stored.journalText?.replace("\"sequence\":2", "\"sequence\":9") ?? null,
      checkpoint: stored.checkpoint,
    });
    assert.equal(gapped.open, false);
    if (!gapped.open) assert.equal(gapped.reason, "journal_gap");
    const tampered = decideRestore({
      manifest,
      manifestChecksum: "0".repeat(64),
      journalText: stored.journalText,
      checkpoint: stored.checkpoint,
    });
    assert.deepEqual(tampered, { open: false, reason: "manifest_mismatch" });
  } finally {
    await receiver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production package does not publish PostgreSQL or bake a secret", async () => {
  const compose = await readFile(path.resolve("docker-compose.production.yml"), "utf8");
  const dockerfile = await readFile(path.resolve("docker", "Dockerfile"), "utf8");
  assert.equal(compose.includes("5432:5432"), false);
  assert.equal(compose.includes("0.0.0.0:5432"), false);
  assert.match(compose, /YOUCAM_API_KEY: \$\{YOUCAM_API_KEY:-\}/);
  assert.match(compose, /OPENAI_API_KEY: \$\{OPENAI_API_KEY:-\}/);
  assert.match(compose, /PROVIDER_DOWNLOAD_ALLOWLIST: \$\{PROVIDER_DOWNLOAD_ALLOWLIST:-\}/);
  assert.equal(compose.includes("YOUCAM_API_KEY: \""), false);
  assert.equal(compose.includes("sk-"), false);
  assert.equal(dockerfile.includes("SESSION_SECRET"), false);
  assert.equal(dockerfile.includes("YOUCAM_API_KEY"), false);
  assert.equal(dockerfile.includes("OPENAI_API_KEY"), false);
  assert.equal(dockerfile.includes("POSTGRES_PASSWORD="), false);
});

function intent(operationId: string, resourceId: string, scope: DeletionScope) {
  return { operationId, resourceId, scope, timestamp: "2026-10-12T12:00:00.000Z" };
}
