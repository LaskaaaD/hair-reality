import { SMOKE_PORT } from "./ports.js";
import { redact, startOwnedServer } from "./owned-server.js";

export async function runSmoke(): Promise<void> {
  const server = await startOwnedServer(SMOKE_PORT, "fixture-smoke");
  try {
    await waitForReady(server.baseUrl, server.exited);
    await assertJson(server.baseUrl, "/api/v1/health", 200, "ok");
    await assertJson(server.baseUrl, "/api/v1/ready", 200, "ready");
    const page = await fetch(`${server.baseUrl}/s/hair-reality-demo`);
    const html = await page.text();
    if (page.status !== 200 || !html.includes('id="root"')) {
      throw new Error("Salon page did not serve the application shell.");
    }
    console.log(`Smoke passed at ${server.baseUrl}`);
  } finally {
    await server.stop();
  }
}

export async function waitForReady(baseUrl: string, exited?: Promise<never>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastBody = "";
  let lastStatus = 0;
  let exitError: Error | undefined;
  void exited?.catch((error: unknown) => {
    exitError = error instanceof Error ? error : new Error("Owned server exited.");
  });
  while (Date.now() < deadline) {
    if (exitError) throw exitError;
    try {
      const response = await fetch(`${baseUrl}/api/v1/ready`);
      lastStatus = response.status;
      lastBody = await response.text();
      if (response.status === 200) return;
    } catch {
      lastStatus = 0;
    }
    await delay(250);
    if (exitError) throw exitError;
  }
  throw new Error(readinessFailure(lastStatus, lastBody));
}

export function readinessFailure(status: number, body: string): string {
  const safeBody = redact(body).replace(/127\.0\.0\.1:\d+/g, "[redacted-host]");
  const detail = safeBody ? ` Last response ${status}: ${safeBody}` : "";
  return `Database is not accessible.${detail} Start PostgreSQL with docker compose up -d db and run npm run db:migrate.`;
}

async function assertJson(baseUrl: string, pathname: string, status: number, marker: string): Promise<void> {
  const response = await fetch(`${baseUrl}${pathname}`);
  const body = await response.text();
  if (response.status !== status || !body.includes(marker) || body.includes("postgres://")) {
    throw new Error(`${pathname} returned ${response.status}. ${readinessFailure(response.status, body)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isDirect = process.argv[1]?.includes("smoke.ts") === true;
if (isDirect) {
  runSmoke().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Smoke failed.");
    process.exitCode = 1;
  });
}
