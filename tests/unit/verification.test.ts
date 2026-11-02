import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installFixtureNetworkGuard, ProviderTrafficError } from "../../src/server/providers/network-guard.js";
import { readinessFailure } from "../../src/server/testing/smoke.js";
import { assertPortAvailable, assertProductionBuild, fixtureChildEnv, releaseAbandonedOwnedDirectories, trackOwnedDirectories } from "../../src/server/testing/owned-server.js";
import { runSteps } from "../../src/server/testing/verify-runner.js";

const applicationUrl = "postgres://hair_reality:local-test@127.0.0.1:5434/hair_reality";
const testUrl = "postgres://hair_reality:local-test@127.0.0.1:5434/hair_reality_test";

test("the verify runner fails a controlled check and a missing command", () => {
  const failed = runSteps([{ name: "controlled failure", command: 'node -e "process.exit(3)"' }]);
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.failedStep, "controlled failure");

  const missing = runSteps([{ name: "missing tool", command: "hair-reality-missing-command" }]);
  assert.equal(missing.ok, false);
  assert.notEqual(missing.exitCode, 0);
  assert.equal(missing.failedStep, "missing tool");

  const passed = runSteps([{ name: "controlled pass", command: 'node -e "process.exit(0)"' }]);
  assert.deepEqual(passed, { ok: true, exitCode: 0, failedStep: null });
});

test("fixture servers refuse a missing build, a busy port, and the application database", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "hair-reality-empty-"));
  assert.throws(() => assertProductionBuild(empty), /npm run build/);

  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(() => assertPortAvailable(address.port), /Refusing to attach/);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  assert.throws(() => fixtureChildEnv({}, {
    port: 4173,
    privateDir: empty,
    journalDir: empty,
    name: "fixture-test",
  }), /DATABASE_URL is required/);
  assert.throws(() => fixtureChildEnv({
    DATABASE_URL: applicationUrl,
    TEST_DATABASE_URL: "postgresql://other:different@localhost/Hair_Reality?port=5434",
  }, {
    port: 4173,
    privateDir: empty,
    journalDir: empty,
    name: "fixture-test",
  }), /Refusing to reset the application database/);

  const env = fixtureChildEnv({
    DATABASE_URL: applicationUrl,
    TEST_DATABASE_URL: testUrl,
    YOUCAM_API_KEY: "do-not-copy",
    OPENAI_API_KEY: "do-not-copy",
    SEED_CLIENT_PASSWORD: "do-not-copy",
  }, {
    port: 4173,
    privateDir: empty,
    journalDir: empty,
    name: "fixture-test",
  });
  assert.equal(env.DATABASE_URL, testUrl);
  assert.equal(env.TEST_DATABASE_URL, undefined);
  assert.equal(env.HAIR_REALITY_SKIP_ENV_FILE, "1");
  assert.equal(env.PROVIDER_MODE, "fixture");
  assert.equal(env.YOUCAM_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.SEED_CLIENT_PASSWORD, undefined);
  assert.equal(env.APP_ORIGIN, "http://127.0.0.1:4173");
});

test("abandoned fixture directories are removed and a live owner is kept", async () => {
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    dead.once("exit", () => resolve());
    dead.once("error", reject);
  });
  assert.ok(dead.pid);
  const abandonedPrivate = await mkdtemp(path.join(tmpdir(), "hair-reality-private-"));
  const abandonedJournal = await mkdtemp(path.join(tmpdir(), "hair-reality-journal-"));
  const livePrivate = await mkdtemp(path.join(tmpdir(), "hair-reality-private-"));
  const liveJournal = await mkdtemp(path.join(tmpdir(), "hair-reality-journal-"));
  await trackOwnedDirectories(dead.pid, abandonedPrivate, abandonedJournal);
  await trackOwnedDirectories(process.pid, livePrivate, liveJournal);
  try {
    await releaseAbandonedOwnedDirectories();
    assert.equal(existsSync(abandonedPrivate), false);
    assert.equal(existsSync(abandonedJournal), false);
    assert.equal(existsSync(livePrivate), true);
    assert.equal(existsSync(liveJournal), true);
  } finally {
    await rm(livePrivate, { recursive: true, force: true });
    await rm(liveJournal, { recursive: true, force: true });
    await rm(path.join(tmpdir(), `hair-reality-owned-${process.pid}.json`), { force: true });
    await rm(path.join(tmpdir(), `hair-reality-owned-${dead.pid}.json`), { force: true });
  }
});

test("readiness failures stay free of connection strings", () => {
  const message = readinessFailure(503, '{"error":{"message":"Database is not accessible"}} postgres://user:secret@127.0.0.1:5434/hair_reality');
  assert.match(message, /docker compose up -d db/);
  assert.equal(message.includes("postgres://"), false);
  assert.equal(message.includes("secret"), false);
  assert.equal(message.includes("5434"), false);
});

test("fixture mode blocks provider connections and still allows loopback", async () => {
  const restore = installFixtureNetworkGuard();
  const hits: string[] = [];
  const local = net.createServer((socket) => {
    hits.push("local");
    socket.end();
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", () => resolve()));
  const address = local.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.throws(() => {
      const socket = new net.Socket();
      socket.connect(443, "api.openai.com");
    }, (error: unknown) => error instanceof ProviderTrafficError && error.host === "api.openai.com");
    assert.throws(() => {
      const socket = new net.Socket();
      socket.connect(443, "docs.perfectcorp.com");
    }, (error: unknown) => error instanceof ProviderTrafficError);
    await assert.rejects(() => fetch("https://api.openai.com/v1/models"), ProviderTrafficError);
    await new Promise<void>((resolve, reject) => {
      local.once("connection", () => resolve());
      const socket = net.connect(address.port, "127.0.0.1");
      socket.once("error", reject);
    });
    assert.deepEqual(hits, ["local"]);
    restore();
    const database = installFixtureNetworkGuard("db");
    try {
      assert.throws(() => {
        const socket = new net.Socket();
        socket.connect(5432, "api.openai.com");
      }, (error: unknown) => error instanceof ProviderTrafficError);
      const opened = net.connect(1, "db");
      opened.once("error", () => undefined);
      opened.destroy();
    } finally {
      database();
    }
  } finally {
    restore();
    await new Promise<void>((resolve, reject) => local.close((error) => error ? reject(error) : resolve()));
  }
});
