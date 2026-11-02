import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { loadConfig } from "../../src/server/config.js";
import { workerPlan } from "../../src/worker/plan.js";

test("the worker idles in fixture mode and does not print credentials", async () => {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/worker/index.ts"], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      HAIR_REALITY_SKIP_ENV_FILE: "1",
      NODE_ENV: "development",
      PROVIDER_MODE: "fixture",
      PORT: "3000",
      APP_ORIGIN: "http://localhost:3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const started = await waitFor(child, () => output.includes("No provider jobs are scheduled"));
  assert.equal(started, true);
  assert.match(output, /Provider mode: fixture/);
  assert.equal(/postgres:|api[_-]?key|secret/i.test(output), false);
  stop(child);
  await once(child, "exit");
});

test("live mode without the operator probe does not submit", async () => {
  const secret = "synthetic-live-key";
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/worker/index.ts"], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PATHEXT: process.env.PATHEXT,
      HAIR_REALITY_SKIP_ENV_FILE: "1",
      NODE_ENV: "development",
      PROVIDER_MODE: "live",
      PORT: "3000",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: "postgres://probe:probe-secret@127.0.0.1:1/none",
      YOUCAM_API_KEY: secret,
      OPENAI_API_KEY: secret,
      YOUCAM_API_BASE_URL: "https://api.synthetic.youcam.invalid",
      PROVIDER_DOWNLOAD_ALLOWLIST: "synthetic.youcam.invalid",
      YOUCAM_LIVE_SUBMISSION: "1",
      OPENAI_LIVE_SUBMISSION: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  const started = await waitFor(child, () => output.includes("is not submitting"));
  assert.equal(started, true);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("probe-secret"), false);
  stop(child);
  await once(child, "exit");
});

test("the worker plan stays idle until the operator probe is explicit", () => {
  const live = loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "live",
    APP_ORIGIN: "http://127.0.0.1:4173",
    DATABASE_URL: "postgres://probe:probe-secret@127.0.0.1:1/none",
    YOUCAM_API_KEY: "synthetic-live-key",
    OPENAI_API_KEY: "synthetic-live-key",
    YOUCAM_API_BASE_URL: "https://api.synthetic.youcam.invalid",
    PROVIDER_DOWNLOAD_ALLOWLIST: "synthetic.youcam.invalid",
    YOUCAM_LIVE_SUBMISSION: "1",
    OPENAI_LIVE_SUBMISSION: "1",
  });
  assert.equal(workerPlan(live), "idle");
  assert.equal(workerPlan({ ...live, operatorProbe: true }), "probe");
  assert.equal(workerPlan({ ...live, operatorProbe: true, databaseUrl: undefined }), "idle");
});

function stop(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function waitFor(child: ReturnType<typeof spawn>, ready: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 15000;
  while (!ready() && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return ready();
}
