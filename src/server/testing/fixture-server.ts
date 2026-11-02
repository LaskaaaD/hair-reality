import { E2E_PORT } from "./ports.js";
import { startOwnedServer } from "./owned-server.js";
import { waitForReady } from "./smoke.js";

async function main(): Promise<void> {
  const server = await startOwnedServer(E2E_PORT, "fixture-e2e");
  const shutdown = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await waitForReady(server.baseUrl, server.exited);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Database is not accessible. Start PostgreSQL with docker compose up -d db and run npm run db:migrate.");
    await server.stop();
    process.exit(1);
  }
  console.log(`Hair Reality fixture server listening on ${server.baseUrl}`);
  await new Promise(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Fixture server failed to start.");
  process.exit(1);
});
