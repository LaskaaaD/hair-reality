import pg from "pg";
import { ConfigError, assertSupportedNode, loadConfig, loadLocalEnv } from "../server/config.js";
import { createPrivateStorage } from "../server/assets/storage.js";
import { ensureBudgetAccounts } from "../server/jobs/accounting.js";
import { runWorker } from "../server/jobs/worker.js";
import { databaseHost, installFixtureNetworkGuard } from "../server/providers/network-guard.js";
import { createProbeClients } from "../server/providers/probe-clients.js";
import { workerPlan } from "./plan.js";

async function main(): Promise<void> {
  assertSupportedNode();
  loadLocalEnv();
  const config = loadConfig();
  if (!config.databaseUrl) {
    if (config.providerMode === "fixture" || config.providerMode === "recorded_demo") installFixtureNetworkGuard();
    console.log(`Hair Reality worker idle. Provider mode: ${config.providerMode}. No provider jobs are scheduled.`);
    await idle();
    return;
  }
  const plan = workerPlan(config);
  if (plan === "idle") {
    if (config.providerMode === "recorded_demo") installFixtureNetworkGuard();
    console.log(`Hair Reality worker is not submitting. Provider mode: ${config.providerMode}.`);
    await idle();
    return;
  }
  if (plan === "fixture") installFixtureNetworkGuard(databaseHost(config.databaseUrl));
  const clients = plan === "probe" ? createProbeClients(config) : null;
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  try {
    await ensureBudgetAccounts(pool, config.providerMode);
    await runWorker({
      pool,
      storage: createPrivateStorage(config.privateStorageDir),
      config,
      ...(clients?.youcam ? { youcam: clients.youcam } : {}),
      ...(clients?.openai ? { openai: clients.openai } : {}),
    });
  } finally {
    await pool.end();
  }
}

function idle(): Promise<void> {
  const keepAlive = setInterval(() => undefined, 60_000);
  return new Promise((resolve) => {
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    const name = error instanceof Error ? error.name : "unknown";
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    console.error(`Worker failed to start. ${name} ${code}`.trim());
  }
  process.exit(1);
});
