import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { createPrivateStorage, type PrivateStorage } from "../../src/server/assets/storage.js";
import { loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { analysisCapabilities } from "../../src/server/demo/analysis.js";
import { advanceDemoJobs, demoJobsInFlight, enqueueAnalysis } from "../../src/server/demo/jobs.js";
import type { YouCamCapability } from "../../src/server/providers/youcam/contract.js";
import type { YouCamClient, YouCamRunResult } from "../../src/server/providers/youcam/client.js";

const { Pool } = pg;

type Submit = { capability: YouCamCapability; templateId: unknown; reference: boolean };
type RunInput = Parameters<YouCamClient["run"]>[0];

let pool: InstanceType<typeof Pool>;
let storage: PrivateStorage;
let jpeg: Buffer;

before(async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  storage = createPrivateStorage(await mkdtemp(path.join(tmpdir(), "hr-dedupe-")));
  jpeg = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#884422" } }).jpeg().toBuffer();
});

after(async () => {
  await pool?.end();
});

/**
 * A YouCam stand-in that records every submit (a run without a provider task id). A submit waits on `release`, like the real
 * upload + task POST on a slow network. Polling a task reports it finished.
 */
function fakeYouCam(options: { submit?: () => Promise<YouCamRunResult>; release?: Promise<void> } = {}) {
  const submits: Submit[] = [];
  const polls: string[] = [];
  const client = {
    async run(input: RunInput): Promise<YouCamRunResult> {
      if (input.providerTaskId) {
        polls.push(input.providerTaskId);
        return input.capability === "hairstyle"
          ? { kind: "succeeded", evidence: { values: {} } as never, downloadUrl: "https://app-cdn.makeupar.com/result.jpg" }
          : { kind: "succeeded", evidence: { values: {} } as never, downloadUrl: null };
      }
      submits.push({ capability: input.capability, templateId: input.controls.template_id, reference: Boolean(input.referenceBytes) });
      await options.release;
      if (options.submit) return options.submit();
      return { kind: "accepted", taskId: `task-${submits.length}` };
    },
    async readResult(): Promise<Buffer> {
      return jpeg;
    },
  } as unknown as YouCamClient;
  return { client, submits, polls };
}

async function seedSession(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO demo_sessions (id, token_hash, service, expires_at) VALUES ($1, $2, 'haircut', NOW() + INTERVAL '1 day')`,
    [id, randomUUID().replaceAll("-", "").padEnd(64, "0")],
  );
  for (const role of ["front", "left", "right", "crown"]) {
    const key = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await storage.write(key, jpeg);
    await pool.query(
      `INSERT INTO demo_photos (id, session_id, role, storage_key, content_hash, mime) VALUES ($1, $2, $3, $4, $5, 'image/jpeg')`,
      [randomUUID(), id, role, key, randomUUID().replaceAll("-", "").padEnd(64, "0")],
    );
  }
  return id;
}

/** Queues a render job. `style` is a catalogue reference photo stem (colour-safe) unless `template` is true (must be refused). */
async function queueRender(sessionId: string, style: string, template = false): Promise<string> {
  const templateId = style;
  const jobId = randomUUID();
  const candidateKey = `haircut:${templateId}`;
  await pool.query(
    `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, detail)
     VALUES ($1, $2, $3, $4, 70, 'match', '[]'::jsonb, 'pending', '{}'::jsonb)`,
    [randomUUID(), sessionId, candidateKey, templateId],
  );
  await pool.query(
    `INSERT INTO demo_jobs (id, session_id, capability, status, units, idempotency_key, payload, created_at, updated_at)
     VALUES ($1, $2, 'hairstyle', 'queued', 0, $3, $4::jsonb, NOW(), NOW())`,
    [jobId, sessionId, `render:${jobId}`, JSON.stringify(template ? { candidateKey, templateId } : { candidateKey, catalogueRef: `${style}.jpg`, cacheStyle: `ref:${style}` })],
  );
  return jobId;
}

function tick(youcam: YouCamClient): Promise<void> {
  return advanceDemoJobs({ pool, storage, youcam, now: new Date() });
}

async function tickUntilIdle(youcam: YouCamClient, limit = 40): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const open = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM demo_jobs WHERE status IN ('queued', 'running')`);
    if (open.rows[0]?.count === 0) return;
    await tick(youcam);
  }
  throw new Error("jobs_did_not_settle");
}

async function clearJobs(): Promise<void> {
  await pool.query(`DELETE FROM demo_jobs`);
  await pool.query(`DELETE FROM demo_previews`);
}

test("a job whose upload and submit is still in flight is never submitted again by later ticks", { timeout: 30_000 }, async () => {
  await clearJobs();
  const sessionId = await seedSession();
  const jobId = await queueRender(sessionId, "style-curly-top-fade");
  let finish!: () => void;
  const release = new Promise<void>((resolve) => { finish = resolve; });
  const youcam = fakeYouCam({ release });

  const first = tick(youcam.client);
  try {
    await waitFor(() => youcam.submits.length === 1);
    assert.deepEqual(demoJobsInFlight(), [jobId]);
    // The 2 s worker timer keeps firing while the slow submit runs. A tick that wrongly re-claims the job would block on
    // `release`, so each tick is raced against a short deadline and the assertion below fails instead of deadlocking.
    for (let index = 0; index < 6; index += 1) await Promise.race([tick(youcam.client), pause(200)]);
    assert.equal(youcam.submits.length, 1);
  } finally {
    // Always let the held submit finish: a failed assertion must not leave a job in flight behind it.
    finish();
  }
  await first;
  assert.deepEqual(demoJobsInFlight(), []);
  const accepted = await pool.query<{ status: string; provider_task_id: string | null }>(`SELECT status, provider_task_id FROM demo_jobs WHERE id = $1`, [jobId]);
  assert.equal(accepted.rows[0]?.provider_task_id, "task-1");

  // Later ticks only poll the accepted task.
  await tickUntilIdle(youcam.client);
  assert.equal(youcam.submits.length, 1);
  assert.deepEqual(youcam.polls, ["task-1"]);
  const done = await pool.query<{ status: string }>(`SELECT status FROM demo_jobs WHERE id = $1`, [jobId]);
  assert.equal(done.rows[0]?.status, "succeeded");
});

test("two ticks that start together claim a queued job once", async () => {
  await clearJobs();
  const sessionId = await seedSession();
  await queueRender(sessionId, "style-textured-crop");
  const youcam = fakeYouCam({ release: new Promise((resolve) => setTimeout(resolve, 150)) });
  await Promise.all([tick(youcam.client), tick(youcam.client), tick(youcam.client)]);
  assert.equal(youcam.submits.length, 1);
  await tickUntilIdle(youcam.client);
  assert.equal(youcam.submits.length, 1);
});

test("one analysis submits face attributes, hair type, hair density and frizziness exactly once each", async () => {
  await clearJobs();
  const sessionId = await seedSession();
  const capabilities = analysisCapabilities("haircut", "hackathon", false);
  assert.deepEqual([...capabilities].sort(), ["face-attributes", "hair-density", "hair-frizziness", "hair-type"]);
  const fingerprint = "a".repeat(64);
  const youcam = fakeYouCam({ release: new Promise((resolve) => setTimeout(resolve, 20)) });
  // A double click on Analyse enqueues the same capture twice; the idempotency key keeps it to one set of jobs.
  await enqueueAnalysis(pool, { sessionId, capabilities, fingerprint, now: new Date() });
  await enqueueAnalysis(pool, { sessionId, capabilities, fingerprint, now: new Date() });
  await Promise.all([tick(youcam.client), tick(youcam.client)]);
  await tickUntilIdle(youcam.client);
  assert.deepEqual(youcam.submits.map((submit) => submit.capability).sort(), ["face-attributes", "hair-density", "hair-frizziness", "hair-type"]);
  const jobs = await pool.query<{ status: string }>(`SELECT status FROM demo_jobs WHERE session_id = $1`, [sessionId]);
  assert.equal(jobs.rows.length, 4);
  assert.equal(jobs.rows.every((row) => row.status === "succeeded"), true);
});

test("N requested renders make exactly N hair-transfer submits", async () => {
  await clearJobs();
  const sessionId = await seedSession();
  const styles = ["style-curly-top-fade", "style-textured-crop", "style-ivy-league"];
  for (const style of styles) await queueRender(sessionId, style);
  const youcam = fakeYouCam({ release: new Promise((resolve) => setTimeout(resolve, 20)) });
  await Promise.all([tick(youcam.client), tick(youcam.client), tick(youcam.client)]);
  await tickUntilIdle(youcam.client);
  assert.equal(youcam.submits.length, styles.length);
  assert.equal(youcam.submits.every((submit) => submit.reference && submit.templateId === undefined), true);
  assert.equal(youcam.submits.every((submit) => submit.capability === "hairstyle"), true);
  const ready = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM demo_previews WHERE status = 'ready'`);
  assert.equal(ready.rows[0]?.count, styles.length);
});

test("a failed submit is not retried by later ticks and keeps a specific reason", async () => {
  await clearJobs();
  const sessionId = await seedSession();
  const jobId = await queueRender(sessionId, "style-low-taper");
  const youcam = fakeYouCam({
    submit: async () => ({ kind: "failed", code: "PROVIDER_UNAVAILABLE", detail: "file_put_transport_TypeError role=source bytes=86970" }),
  });
  await tick(youcam.client);
  for (let index = 0; index < 5; index += 1) await tick(youcam.client);
  assert.equal(youcam.submits.length, 1);
  const job = await pool.query<{ status: string; error_code: string; result: { reason?: string } }>(`SELECT status, error_code, result FROM demo_jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0]?.status, "failed");
  assert.equal(job.rows[0]?.error_code, "PROVIDER_UNAVAILABLE");
  assert.match(job.rows[0]?.result.reason ?? "", /network error/);
  const preview = await pool.query<{ status: string }>(`SELECT status FROM demo_previews WHERE candidate_key = 'haircut:style-low-taper'`);
  assert.equal(preview.rows[0]?.status, "failed");
});

test("an unconfirmed submit (uncertain) or a thrown error fails the job instead of submitting again", async () => {
  for (const submit of [
    async (): Promise<YouCamRunResult> => ({ kind: "uncertain" }),
    async (): Promise<YouCamRunResult> => { throw new TypeError("fetch failed"); },
  ]) {
    await clearJobs();
    const sessionId = await seedSession();
    const jobId = await queueRender(sessionId, "style-french-crop");
    const youcam = fakeYouCam({ submit });
    for (let index = 0; index < 4; index += 1) await tick(youcam.client);
    assert.equal(youcam.submits.length, 1);
    const job = await pool.query<{ status: string }>(`SELECT status FROM demo_jobs WHERE id = $1`, [jobId]);
    assert.equal(job.rows[0]?.status, "failed");
  }
});

test("a template-only hair transfer is refused before YouCam is called", async () => {
  await clearJobs();
  const sessionId = await seedSession();
  const jobId = await queueRender(sessionId, "male_tousled_cut", true);
  const youcam = fakeYouCam();
  for (let index = 0; index < 3; index += 1) await tick(youcam.client);
  assert.equal(youcam.submits.length, 0);
  const job = await pool.query<{ status: string; error_code: string }>(`SELECT status, error_code FROM demo_jobs WHERE id = $1`, [jobId]);
  assert.equal(job.rows[0]?.status, "failed");
  assert.equal(job.rows[0]?.error_code, "UNSUPPORTED_CONFIGURATION");
  const preview = await pool.query<{ status: string }>(`SELECT status FROM demo_previews WHERE candidate_key = 'haircut:male_tousled_cut'`);
  assert.equal(preview.rows[0]?.status, "failed");
});

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition_not_met");
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
