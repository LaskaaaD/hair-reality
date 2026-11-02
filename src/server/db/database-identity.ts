const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

export type DatabaseIdentity = {
  host: string;
  port: number;
  database: string;
};

export class DatabaseUrlError extends Error {
  constructor() {
    super("Database URL is not a PostgreSQL connection string");
    this.name = "DatabaseUrlError";
  }
}

export class TestDatabaseGuardError extends Error {
  constructor() {
    super("Refusing to reset the application database");
    this.name = "TestDatabaseGuardError";
  }
}

export function databaseIdentity(connectionString: string): DatabaseIdentity {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new DatabaseUrlError();
  }
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "postgres" && protocol !== "postgresql") {
    throw new DatabaseUrlError();
  }
  // node-pg keeps host and port query parameters ahead of the URL authority.
  const host = normalizeHost(lastParam(url, "host") ?? url.hostname);
  const port = resolvePort(lastParam(url, "port"), url.port);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")).toLowerCase();
  if (host === "" || host.includes("/") || !Number.isInteger(port) || port < 1 || port > 65535 || database === "") {
    throw new DatabaseUrlError();
  }
  return { host, port, database };
}

export function isSameDatabase(left: string, right: string): boolean {
  const a = databaseIdentity(left);
  const b = databaseIdentity(right);
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

export function assertTestDatabase(applicationUrl: string, testUrl: string): void {
  try {
    if (isSameDatabase(applicationUrl, testUrl)) throw new TestDatabaseGuardError();
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw error;
    throw new TestDatabaseGuardError();
  }
}

function lastParam(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name);
  if (values.length === 0) return undefined;
  // node-pg keeps the last query value, and an empty value falls back to the URL authority.
  const value = values[values.length - 1]?.trim() ?? "";
  return value === "" ? undefined : value;
}

function resolvePort(queryPort: string | undefined, urlPort: string): number {
  const raw = queryPort ?? (urlPort === "" ? "5432" : urlPort);
  if (!/^\d+$/.test(raw)) throw new DatabaseUrlError();
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DatabaseUrlError();
  return port;
}

function normalizeHost(hostname: string): string {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) ? "loopback" : host;
}
