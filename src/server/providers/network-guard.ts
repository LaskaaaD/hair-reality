import net from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

export class ProviderTrafficError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Blocked outbound provider traffic to ${host}`);
    this.name = "ProviderTrafficError";
    this.host = host;
  }
}

let restoreGuard: (() => void) | undefined;

export function databaseHost(connectionString: string | undefined): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
}

export function installFixtureNetworkGuard(databaseHostname?: string): () => void {
  if (restoreGuard) return restoreGuard;
  const allowedDatabaseHost = normalizeHost(databaseHostname);
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  globalThis.fetch = guardedFetch(originalFetch, allowedDatabaseHost);
  net.Socket.prototype.connect = guardedConnect(originalConnect, allowedDatabaseHost) as typeof net.Socket.prototype.connect;
  restoreGuard = () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    restoreGuard = undefined;
  };
  return restoreGuard;
}

function guardedFetch(originalFetch: typeof fetch, allowedDatabaseHost: string | undefined): typeof fetch {
  return (input, init) => {
    const href = requestHref(input);
    let host: string | undefined;
    try {
      host = new URL(href).hostname;
    } catch {
      host = undefined;
    }
    if (host !== undefined && !isAllowedHost(host, allowedDatabaseHost)) return Promise.reject(new ProviderTrafficError(host));
    return originalFetch(input, init);
  };
}

function guardedConnect(originalConnect: typeof net.Socket.prototype.connect, allowedDatabaseHost: string | undefined) {
  return function (this: net.Socket, ...args: unknown[]) {
    const host = hostFromConnectArgs(args);
    if (host !== undefined && !isAllowedHost(host, allowedDatabaseHost)) throw new ProviderTrafficError(host);
    return originalConnect.apply(this, args as never);
  };
}

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hostFromConnectArgs(args: unknown[]): string | undefined {
  const first = args[0];
  if (typeof first === "number") {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  if (typeof first !== "object" || first === null) return undefined;
  const options = first as { path?: unknown; host?: unknown };
  if (typeof options.path === "string" && options.path !== "") return undefined;
  if (typeof options.host === "string" && options.host !== "") return options.host;
  return "localhost";
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  if (normalized === undefined) return false;
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  return normalized.startsWith("::ffff:127.");
}

function isAllowedHost(host: string, allowedDatabaseHost: string | undefined): boolean {
  if (isLoopbackHost(host)) return true;
  return allowedDatabaseHost !== undefined && normalizeHost(host) === allowedDatabaseHost;
}

function normalizeHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}
