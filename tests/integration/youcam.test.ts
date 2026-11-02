import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pg from "pg";
import sharp from "sharp";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { loadConfig, loadLocalEnv } from "../../src/server/config.js";
import { resetTestDatabase } from "../../src/server/db/migrate-cli.js";
import { migrate } from "../../src/server/db/migrate.js";
import { hashPassword } from "../../src/server/db/passwords.js";
import { admitJob, ensureBudgetAccounts, reconcileAssumedSettlement } from "../../src/server/jobs/accounting.js";
import { claimNext, processClaimedJob } from "../../src/server/jobs/worker.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import { FACE_ANGLE_ERROR, YouCamClient } from "../../src/server/providers/youcam/client.js";
import { advanceYouCamJob, syntheticStorageKey } from "../../src/server/providers/youcam/runner.js";

const { Pool } = pg;

test("YouCam jobs block unpaid admission and do not resubmit a known or uncertain task", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 4, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-youcam-job-"));
  const now = new Date("2026-10-11T12:00:00.000Z");
  const config = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "live",
    APP_ORIGIN: "http://127.0.0.1:4173",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: testUrl,
    PRIVATE_STORAGE_DIR: storageRoot,
    DELETION_JOURNAL_DIR: await mkdtemp(path.join(tmpdir(), "hr-youcam-journal-")),
    DELETION_JOURNAL_MODE: "local",
    BUDGET_PHASE: "development",
    YOUCAM_DEV_CAP: "100",
    YOUCAM_DEMO_CAP: "300",
    YOUCAM_TOTAL_CAP: "800",
    YOUCAM_RESERVE: "200",
    OPENAI_BUDGET_USD: "5",
    TRUST_PROXY: "0",
    YOUCAM_API_KEY: "synthetic-test-key",
    OPENAI_API_KEY: "synthetic-openai-key",
    YOUCAM_API_BASE_URL: "https://api.synthetic.youcam.invalid",
    PROVIDER_DOWNLOAD_ALLOWLIST: "synthetic.youcam.invalid",
    YOUCAM_LIVE_SUBMISSION: "1",
    HAIR_REALITY_OPERATOR_PROBE: "1",
  });
  const restore = installFixtureNetworkGuard();
  try {
    await assert.rejects(fetch("https://yce-api-01.makeupar.com"), /Blocked outbound provider traffic/);
    await ensureBudgetAccounts(pool, "live");
    await pool.query(
      `UPDATE provider_budget_accounts
       SET balance_units = 100000, balance_observed_at = $1
       WHERE provider = 'youcam' AND mode = 'live'`,
      [now],
    );
    const salon = await insertId(pool, "INSERT INTO salons (slug, name, timezone, branding) VALUES ('youcam-adapter', 'YouCam Adapter', 'Europe/Warsaw', '{\"kind\":\"demonstration\"}') RETURNING id");
    const user = await insertId(pool, "INSERT INTO users (email, display_name, password_hash) VALUES ('youcam.adapter@example.com', 'Adapter', $1) RETURNING id", [await hashPassword("adapter-password-12")]);
    const consultation = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [user, salon]);
    const missingPrice = await admitJob({
      pool, config, actorId: user, consultationId: consultation, operation: "analysis", provider: "youcam",
      idempotencyKey: "missing-price", body: { capabilities: ["hair-type"] }, expectedVersion: 1, assetIds: [],
      serviceId: null, configuration: JSON.stringify(["hair-type"]), now,
    });
    assert.equal(missingPrice.ok, false);
    if (!missingPrice.ok) assert.equal(missingPrice.code, "price_unavailable");

    await pool.query(
      `INSERT INTO provider_price_observations (provider, mode, operation, units, observed_at)
       VALUES ('youcam', 'live', 'hair-type', 2, $1)`,
      [new Date("2026-10-09T12:00:00.000Z")],
    );
    const stale = await admitJob({
      pool, config, actorId: user, consultationId: consultation, operation: "analysis", provider: "youcam",
      idempotencyKey: "stale-price", body: { capabilities: ["hair-type"] }, expectedVersion: 1, assetIds: [],
      serviceId: null, configuration: JSON.stringify(["hair-type"]), now,
    });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.code, "price_stale");

    await pool.query(
      `INSERT INTO provider_price_observations (provider, mode, operation, units, observed_at)
       VALUES ('youcam', 'live', 'hair-type', 2, $1)`,
      [now],
    );
    const jobs = await pool.query("SELECT count(*)::text AS count FROM provider_jobs");
    assert.equal(jobs.rows[0]?.count, "0");

    const storage = createPrivateStorage(storageRoot);
    const key = syntheticStorageKey("density-photo");
    const image = await sharp({ create: { width: 120, height: 120, channels: 3, background: "#888888" } }).jpeg().toBuffer();
    await storage.write(key, image);
    const asset = await insertId(
      pool,
      `INSERT INTO assets (owner_user_id, consultation_id, role, storage_key, content_hash, width, height, mime_type)
       VALUES ($1, $2, 'current_density', $3, $4, 120, 120, 'image/jpeg') RETURNING id`,
      [user, consultation, key, key],
    );
    const jobId = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids
       ) VALUES ($1, 'youcam', 'analysis', 'fingerprint', 'development', 'QUEUED', 'live',
         'youcam-s2s-2026-10-11', $2, 1, ARRAY[$3]::uuid[]) RETURNING id`,
      [consultation, JSON.stringify(["hair-density"]), asset],
    );
    const calls: string[] = [];
    const client = new YouCamClient({
      baseUrl: "https://api.synthetic.youcam.invalid",
      apiKey: "synthetic-test-key",
      allowlist: ["synthetic.youcam.invalid"],
      callMode: "synthetic",
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: {
        async request(input) {
          calls.push(`${input.method} ${new URL(input.url).pathname}`);
          if (input.url.includes("/task/")) throw new Error("ambiguous submission");
          if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({
              status: 200,
              data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }] },
            })),
          };
        },
      },
    });
    const claimed = await claimNext(pool, "youcam-test-owner", "live", now);
    assert.equal(claimed?.id, jobId);
    if (!claimed) return;
    await processClaimedJob({
      pool, storage, config, job: claimed, owner: "youcam-test-owner", fault: null, now, youcam: client,
    });
    const uncertain = await pool.query<{ state: string; provider_task_id: string | null }>(
      "SELECT state, provider_task_id FROM provider_jobs WHERE id = $1",
      [jobId],
    );
    assert.equal(uncertain.rows[0]?.state, "SUBMISSION_UNCERTAIN");
    assert.equal(uncertain.rows[0]?.provider_task_id, null);
    assert.equal(calls.filter((call) => call.includes("/task/")).length, 1);
    const again = await claimNext(pool, "youcam-test-owner", "live", now);
    assert.equal(again, null);
    assert.equal(calls.filter((call) => call.includes("/task/")).length, 1);

    await pool.query(
      `UPDATE provider_jobs
       SET state = 'RUNNING', provider_task_id = 'known-task', lease_owner = NULL, lease_expires_at = $2
       WHERE id = $1`,
      [jobId, now],
    );
    const resumed = await claimNext(pool, "youcam-test-owner-2", "live", new Date(now.getTime() + 60_000));
    assert.equal(resumed?.providerTaskId, "known-task");
    const before = calls.length;
    if (resumed) {
      await processClaimedJob({
        pool, storage, config, job: resumed, owner: "youcam-test-owner-2", fault: null, now, youcam: client,
      });
    }
    assert.equal(calls.slice(before).some((call) => call.startsWith("POST")), false);

    await pool.query(
      "UPDATE provider_jobs SET lease_expires_at = '2099-01-01T00:00:00Z' WHERE id = $1 AND state = 'RUNNING'",
      [jobId],
    );
    const lengthJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id
       ) VALUES ($1, 'youcam', 'analysis', 'length-fingerprint', 'development', 'QUEUED', 'live',
         'youcam-s2s-2026-10-11', $2, 1, ARRAY[$3]::uuid[], 'known-length') RETURNING id`,
      [consultation, JSON.stringify(["hair-length"]), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 1, 'reserved', 'live', 'development', '{}')`,
      [lengthJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET reserved_units = reserved_units + 1
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const success = new YouCamClient({
      baseUrl: "https://api.synthetic.youcam.invalid",
      apiKey: "synthetic-test-key",
      allowlist: ["synthetic.youcam.invalid"],
      callMode: "synthetic",
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: {
        async request() {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({
              status: 200,
              data: { task_status: "success", results: { hair_length: { term: "long hair" } } },
            })),
          };
        },
      },
    });
    const lengthClaim = await claimNext(pool, "youcam-length", "live", new Date(now.getTime() + 180_000));
    assert.equal(lengthClaim?.id, lengthJob);
    if (lengthClaim) {
      await processClaimedJob({
        pool, storage, config, job: lengthClaim, owner: "youcam-length", fault: null, now, youcam: success,
      });
    }
    const saved = await pool.query<{ state: string; values: { term: string } }>(
      `SELECT provider_jobs.state, analysis_results.values
       FROM provider_jobs JOIN analysis_results ON analysis_results.consultation_id = provider_jobs.consultation_id
       WHERE provider_jobs.id = $1`,
      [lengthJob],
    );
    assert.equal(saved.rows[0]?.state, "SUCCEEDED");
    assert.equal(JSON.stringify(saved.rows[0]?.values).includes("http"), false);
    assert.equal(saved.rows[0]?.values.term, "long hair");

    const colorJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id
       ) VALUES ($1, 'youcam', 'preview', 'color-fingerprint', 'development', 'QUEUED', 'live',
         'youcam-s2s-2026-10-11', $2, 1, ARRAY[$3]::uuid[], 'known-color') RETURNING id`,
      [consultation, JSON.stringify({ capability: "hair-color" }), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 1, 'reserved', 'live', 'development', '{}')`,
      [colorJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET reserved_units = reserved_units + 1
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const noDownload = new YouCamClient({
      baseUrl: "https://api.synthetic.youcam.invalid",
      apiKey: "synthetic-test-key",
      allowlist: ["synthetic.youcam.invalid"],
      callMode: "synthetic",
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: {
        async request(input) {
          if (input.method !== "GET") throw new Error("image poll must not submit");
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({
              status: 200,
              data: { task_status: "success", results: { url: "https://synthetic.youcam.invalid/result" } },
            })),
          };
        },
      },
    });
    const colorClaim = await claimNext(pool, "youcam-color", "live", new Date(now.getTime() + 240_000));
    assert.equal(colorClaim?.id, colorJob);
    if (colorClaim) {
      await processClaimedJob({
        pool, storage, config, job: colorClaim, owner: "youcam-color", fault: null, now, youcam: noDownload,
      });
    }
    const undownloaded = await pool.query<{ state: string; error_code: string; settlement_state: string; actual_units: string }>(
      `SELECT provider_jobs.state, provider_jobs.error_code, usage_ledger.settlement_state, usage_ledger.actual_units
       FROM provider_jobs JOIN usage_ledger ON usage_ledger.job_id = provider_jobs.id
       WHERE provider_jobs.id = $1`,
      [colorJob],
    );
    assert.equal(undownloaded.rows[0]?.state, "FAILED");
    assert.equal(undownloaded.rows[0]?.error_code, "PROVIDER_UNAVAILABLE");
    assert.equal(undownloaded.rows[0]?.settlement_state, "settled");
    assert.equal(undownloaded.rows[0]?.actual_units, "1");

    const angleJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id
       ) VALUES ($1, 'youcam', 'analysis', 'angle-fingerprint', 'development', 'QUEUED', 'live',
         'youcam-s2s-2026-10-11', $2, 2, ARRAY[$3]::uuid[], 'known-angle') RETURNING id`,
      [consultation, JSON.stringify(["hair-type"]), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 2, 'reserved', 'live', 'development', '{}')`,
      [angleJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET reserved_units = reserved_units + 2
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const angleClient = new YouCamClient({
      baseUrl: "https://api.synthetic.youcam.invalid",
      apiKey: "synthetic-test-key",
      allowlist: ["synthetic.youcam.invalid"],
      callMode: "synthetic",
      resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: {
        async request() {
          return {
            status: 200,
            headers: {},
            body: Buffer.from(JSON.stringify({ status: 200, data: { task_status: "error", error: FACE_ANGLE_ERROR } })),
          };
        },
      },
    });
    const settledBefore = await pool.query<{ settled_units: string }>(
      `SELECT settled_units FROM provider_budget_accounts
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const angleClaim = await claimNext(pool, "youcam-angle", "live", new Date(now.getTime() + 300_000));
    assert.equal(angleClaim?.id, angleJob);
    if (angleClaim) {
      await processClaimedJob({
        pool, storage, config, job: angleClaim, owner: "youcam-angle", fault: null, now, youcam: angleClient,
      });
    }
    const angleRow = await pool.query<{ error_code: string; settlement_state: string; actual_units: string | null; instruction: string }>(
      `SELECT provider_jobs.error_code, usage_ledger.settlement_state, usage_ledger.actual_units,
              audit_events.metadata->>'instruction' AS instruction
       FROM provider_jobs
       JOIN usage_ledger ON usage_ledger.job_id = provider_jobs.id
       LEFT JOIN audit_events ON audit_events.entity_id = provider_jobs.id AND audit_events.event_name = 'provider.retake'
       WHERE provider_jobs.id = $1`,
      [angleJob],
    );
    assert.equal(angleRow.rows[0]?.error_code, "RETAKE_REQUIRED");
    assert.equal(angleRow.rows[0]?.settlement_state, "uncertain");
    assert.equal(angleRow.rows[0]?.actual_units, null);
    assert.match(angleRow.rows[0]?.instruction ?? "", /current_front, current_right, current_left/);
    const settledAfterError = await pool.query<{ settled_units: string }>(
      `SELECT settled_units FROM provider_budget_accounts
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    assert.equal(settledAfterError.rows[0]?.settled_units, settledBefore.rows[0]?.settled_units);

    const assumedJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id, error_code
       ) VALUES ($1, 'youcam', 'analysis', 'assumed-fingerprint', 'development', 'FAILED', 'live',
         'youcam-s2s-2026-10-11', $2, 2, ARRAY[$3]::uuid[], 'assumed-task', 'PROVIDER_UNAVAILABLE') RETURNING id`,
      [consultation, JSON.stringify(["hair-frizziness"]), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, actual_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 2, 2, 'settled', 'live', 'development', '{}')`,
      [assumedJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET settled_units = settled_units + 2
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const reason = "Credit history shows a charge and an exact _failed reversal with a zero net.";
    const first = await reconcileAssumedSettlement(pool, {
      jobId: assumedJob,
      now,
      reason,
      outcome: "not_billed",
      errorCode: "RETAKE_REQUIRED",
      instruction: "Retake current_front, current_right, current_left.",
    });
    const second = await reconcileAssumedSettlement(pool, {
      jobId: assumedJob,
      now,
      reason,
      outcome: "not_billed",
      errorCode: "RETAKE_REQUIRED",
      instruction: "Retake current_front, current_right, current_left.",
    });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    const corrected = await pool.query<{ id: string; error_code: string; settlement_state: string; actual_units: string; audits: string }>(
      `SELECT provider_jobs.id, provider_jobs.error_code, usage_ledger.settlement_state, usage_ledger.actual_units,
              (SELECT count(*) FROM audit_events WHERE entity_id = provider_jobs.id AND event_name = 'usage.reconciled')::text AS audits
       FROM provider_jobs JOIN usage_ledger ON usage_ledger.job_id = provider_jobs.id
       WHERE provider_jobs.id = $1`,
      [assumedJob],
    );
    assert.equal(corrected.rows[0]?.id, assumedJob);
    assert.equal(corrected.rows[0]?.error_code, "RETAKE_REQUIRED");
    assert.equal(corrected.rows[0]?.settlement_state, "released");
    assert.equal(corrected.rows[0]?.actual_units, "0");
    assert.equal(corrected.rows[0]?.audits, "1");
    const settledAfterRelease = await pool.query<{ settled_units: string }>(
      `SELECT settled_units FROM provider_budget_accounts
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    assert.equal(settledAfterRelease.rows[0]?.settled_units, settledAfterError.rows[0]?.settled_units);

    const openJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id, error_code
       ) VALUES ($1, 'youcam', 'analysis', 'open-fingerprint', 'development', 'FAILED', 'live',
         'youcam-s2s-2026-10-11', $2, 1, ARRAY[$3]::uuid[], 'open-task', 'PROVIDER_UNAVAILABLE') RETURNING id`,
      [consultation, JSON.stringify(["hair-density"]), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, actual_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 1, 1, 'settled', 'live', 'development', '{}')`,
      [openJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET settled_units = settled_units + 1
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const unresolvedReason = "Credit history is incomplete, so the failed task stays unresolved exposure.";
    const unresolved = await reconcileAssumedSettlement(pool, {
      jobId: openJob, now, reason: unresolvedReason, outcome: "unresolved", errorCode: "INVALID_PHOTO",
    });
    const unresolvedAgain = await reconcileAssumedSettlement(pool, {
      jobId: openJob, now, reason: unresolvedReason, outcome: "unresolved", errorCode: "INVALID_PHOTO",
    });
    assert.equal(unresolved.applied, true);
    assert.equal(unresolvedAgain.applied, false);
    const openRow = await pool.query<{ settlement_state: string; actual_units: string | null; estimated_units: string; reserved_units: string; settled_units: string }>(
      `SELECT usage_ledger.settlement_state, usage_ledger.actual_units, usage_ledger.estimated_units,
              provider_budget_accounts.reserved_units, provider_budget_accounts.settled_units
       FROM usage_ledger
       JOIN provider_budget_accounts ON provider_budget_accounts.provider = usage_ledger.provider
         AND provider_budget_accounts.phase = usage_ledger.phase AND provider_budget_accounts.mode = usage_ledger.mode
       WHERE usage_ledger.job_id = $1`,
      [openJob],
    );
    assert.equal(openRow.rows[0]?.settlement_state, "uncertain");
    assert.equal(openRow.rows[0]?.actual_units, null);
    assert.equal(openRow.rows[0]?.estimated_units, "1");
    assert.equal(openRow.rows[0]?.settled_units, settledAfterError.rows[0]?.settled_units);

    const heldJob = await insertId(
      pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         provider_version, configuration_fingerprint, max_cost, source_asset_ids, provider_task_id, error_code
       ) VALUES ($1, 'youcam', 'analysis', 'held-fingerprint', 'development', 'FAILED', 'live',
         'youcam-s2s-2026-10-11', $2, 2, ARRAY[$3]::uuid[], 'held-task', 'RETAKE_REQUIRED') RETURNING id`,
      [consultation, JSON.stringify(["hair-type"]), asset],
    );
    await pool.query(
      `INSERT INTO usage_ledger (job_id, provider, budget_bucket, unit, estimated_units, actual_units, settlement_state, mode, phase, price_snapshot)
       VALUES ($1, 'youcam', 'development', 'youcam_unit', 2, NULL, 'uncertain', 'live', 'development', '{}')`,
      [heldJob],
    );
    await pool.query(
      `UPDATE provider_budget_accounts SET reserved_units = reserved_units + 2
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const heldBefore = await pool.query<{ reserved_units: string }>(
      `SELECT reserved_units FROM provider_budget_accounts
       WHERE provider = 'youcam' AND mode = 'live' AND phase = 'development'`,
    );
    const heldReason = "Credit history pairs the charge with an exact _failed reversal. Net charge is 0.";
    const released = await reconcileAssumedSettlement(pool, { jobId: heldJob, now, reason: heldReason, outcome: "not_billed" });
    const releasedAgain = await reconcileAssumedSettlement(pool, { jobId: heldJob, now, reason: heldReason, outcome: "not_billed" });
    assert.equal(released.applied, true);
    assert.equal(releasedAgain.applied, false);
    const heldRow = await pool.query<{ settlement_state: string; actual_units: string; reserved_units: string }>(
      `SELECT usage_ledger.settlement_state, usage_ledger.actual_units, provider_budget_accounts.reserved_units
       FROM usage_ledger
       JOIN provider_budget_accounts ON provider_budget_accounts.provider = usage_ledger.provider
         AND provider_budget_accounts.phase = usage_ledger.phase AND provider_budget_accounts.mode = usage_ledger.mode
       WHERE usage_ledger.job_id = $1`,
      [heldJob],
    );
    assert.equal(heldRow.rows[0]?.settlement_state, "released");
    assert.equal(heldRow.rows[0]?.actual_units, "0");
    assert.equal(Number(heldRow.rows[0]?.reserved_units), Number(heldBefore.rows[0]?.reserved_units) - 2);
  } finally {
    restore();
    await pool.end();
  }
});

test("an old anatomical hair-type view map fails closed before upload", async () => {
  loadLocalEnv();
  const applicationUrl = required("DATABASE_URL");
  const testUrl = required("TEST_DATABASE_URL");
  await resetTestDatabase(applicationUrl, testUrl);
  await migrate(testUrl, path.resolve("migrations"));
  const pool = new Pool({ connectionString: testUrl, max: 2, connectionTimeoutMillis: 5000 });
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-youcam-map-"));
  const storage = createPrivateStorage(storageRoot);
  const now = new Date("2026-10-12T18:00:00.000Z");
  let uploads = 0;
  const client = new YouCamClient({
    baseUrl: "https://api.synthetic.youcam.invalid",
    apiKey: "synthetic-test-key",
    allowlist: ["synthetic.youcam.invalid"],
    callMode: "synthetic",
    transport: {
      async request() {
        uploads += 1;
        return { status: 500, headers: {}, body: Buffer.alloc(0) };
      },
    },
  });
  try {
    const salon = await insertId(pool, "INSERT INTO salons (slug, name, timezone) VALUES ('youcam-map', 'YouCam Map', 'Europe/Warsaw') RETURNING id");
    const user = await insertId(pool, "INSERT INTO users (email, display_name, password_hash) VALUES ('youcam.map@example.com', 'Map', $1) RETURNING id", [await hashPassword("adapter-password-12")]);
    const consultation = await insertId(pool, "INSERT INTO consultations (client_user_id, salon_id) VALUES ($1, $2) RETURNING id", [user, salon]);
    const front = await storeRole(pool, storage, user, consultation, "current_front", "front");
    const anatomicalRight = await storeRole(pool, storage, user, consultation, "current_right", "anatomical-right");
    const anatomicalLeft = await storeRole(pool, storage, user, consultation, "current_left", "anatomical-left");
    const jobId = await insertId(pool,
      `INSERT INTO provider_jobs (
         consultation_id, provider, operation, input_fingerprint, cost_phase, state, mode,
         lease_owner, fencing_token, configuration_fingerprint, source_asset_ids, max_cost
       ) VALUES (
         $1, 'youcam', 'analysis', 'old-map', 'development', 'CLAIMED', 'live',
         'map-owner', 1, $2, ARRAY[$3, $4, $5]::uuid[], 2
       ) RETURNING id`,
      [consultation, JSON.stringify({
        capability: "hair-type",
        views: { front, right: anatomicalRight, left: anatomicalLeft },
      }), front, anatomicalRight, anatomicalLeft],
    );
    await advanceYouCamJob({
      pool, storage, client, jobId, fencingToken: 1, owner: "map-owner", now, retentionDays: 30,
    });
    const failed = await pool.query<{ state: string; error_code: string | null }>(
      "SELECT state, error_code FROM provider_jobs WHERE id = $1",
      [jobId],
    );
    assert.equal(failed.rows[0]?.state, "FAILED");
    assert.equal(failed.rows[0]?.error_code, "INVALID_PHOTO");
    assert.equal(uploads, 0);
  } finally {
    await pool.end();
  }
});

async function storeRole(pool: pg.Pool, storage: ReturnType<typeof createPrivateStorage>, ownerId: string, consultationId: string, role: string, label: string): Promise<string> {
  const key = syntheticStorageKey(label);
  await storage.write(key, Buffer.from(label));
  return insertId(
    pool,
    `INSERT INTO assets (owner_user_id, consultation_id, role, storage_key, content_hash, width, height, mime_type)
     VALUES ($1, $2, $3, $4, $4, 8, 8, 'image/png') RETURNING id`,
    [ownerId, consultationId, role, key],
  );
}

async function insertId(pool: pg.Pool, sql: string, values: readonly unknown[] = []): Promise<string> {
  const result = await pool.query<{ id: string }>(sql, values as unknown[]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error("missing id");
  return id;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
