import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ConfigError, assertSupportedNode, loadConfig, loadLocalEnv } from "./config.js";
import { createApp } from "./app.js";
import { migrate, pendingMigrations } from "./db/migrate.js";
import { createPrivateStorage } from "./assets/storage.js";
import { ensureBudgetAccounts } from "./jobs/accounting.js";
import { ensureFixturePrices } from "./jobs/fixture-prices.js";
import { advanceDemoJobs } from "./demo/jobs.js";
import { databaseHost, installFixtureNetworkGuard } from "./providers/network-guard.js";
import { AttemptWindow } from "./auth/rate-limit.js";
import { createProbeClients } from "./providers/probe-clients.js";
import { createFixtureOpenAIClient } from "./providers/openai/fixture.js";

async function main(): Promise<void> {
  assertSupportedNode();
  loadLocalEnv();
  const config = loadConfig();
  if (config.providerMode === "fixture" || config.providerMode === "recorded_demo") {
    installFixtureNetworkGuard(databaseHost(config.databaseUrl));
    console.log("Fixture network guard enabled.");
  }
  if (config.nodeEnv === "production" && config.databaseUrl) {
    const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
    await migrate(config.databaseUrl, migrationsDirectory);
  }
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000 })
    : undefined;
  if (pool) {
    const pending = await pendingMigrations(pool, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations"));
    if (pending.length > 0) {
      console.error(`Database has unapplied migrations (${pending.join(", ")}); run npm run db:migrate and restart.`);
      await pool.end();
      process.exit(1);
    }
    await ensureBudgetAccounts(pool, config.providerMode);
    if (config.providerMode === "fixture") await ensureFixturePrices(pool, new Date());
  }
  const clients = config.providerMode === "live" ? createProbeClients(config) : { youcam: null, openai: createFixtureOpenAIClient() };
  const youcam = clients.youcam;
  const openai = clients.openai;
  const storage = createPrivateStorage(config.privateStorageDir);
  const relaxedDemoLimit =
    config.providerMode === "fixture" && process.env.HAIR_REALITY_FIXTURE_AUTH_PARTITION === "1"
      ? new AttemptWindow(500, 60_000)
      : undefined;
  const app = createApp(
    config,
    undefined,
    pool
      ? {
          pool,
          storage,
          ...(openai ? { openai } : {}),
          ...(relaxedDemoLimit ? { demoIpLimit: relaxedDemoLimit } : {}),
        }
      : {},
  );
  const livePool = pool;
  const stopJobs = livePool && youcam
    ? setInterval(() => {
      void advanceDemoJobs({
        pool: livePool,
        storage,
        youcam,
        ...(openai ? { openai } : {}),
        budgetUsd: config.openaiBudgetUsd,
        now: new Date(),
        renderCacheDir: config.renderCacheDir,
        renderJobTimeoutMs: config.renderJobTimeoutMs,
      }).catch((error: unknown) => {
        console.error(`demo_job_failed ${error instanceof Error ? error.name : "error"}`);
      });
    }, 2000)
    : null;
  stopJobs?.unref();
  const servers = await listenLoopback(app, config.port, config.trustProxy === "1");
  console.log(config.trustProxy === "1"
    ? `Hair Reality listening on the private container port ${config.port}`
    : `Hair Reality listening on localhost:${config.port}`);
  const shutdown = () => {
    if (stopJobs) clearInterval(stopJobs);
    let pending = servers.length;
    const finish = () => {
      if (!pool) {
        process.exit(0);
        return;
      }
      void pool.end().finally(() => process.exit(0));
    };
    if (pending === 0) {
      finish();
      return;
    }
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) finish();
      });
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function listenLoopback(app: ReturnType<typeof createApp>, port: number, privateNetwork: boolean): Promise<Server[]> {
  const hosts = privateNetwork ? ["0.0.0.0"] : ["127.0.0.1", "::1"];
  const servers: Server[] = [];
  return hosts.reduce<Promise<Server[]>>(async (previous, host) => {
    const started = await previous;
    try {
      started.push(await listen(app, port, host));
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (host === "127.0.0.1" || code === "EADDRINUSE") {
        console.error(code === "EADDRINUSE" ? `Port ${port} is already in use.` : "Server failed to start.");
        process.exit(1);
      }
    }
    return started;
  }, Promise.resolve(servers));
}

function listen(app: ReturnType<typeof createApp>, port: number, host: string): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  const name = error instanceof Error ? error.name : "Error";
  console.error(`Server failed to start: ${name}`);
  process.exit(1);
});
