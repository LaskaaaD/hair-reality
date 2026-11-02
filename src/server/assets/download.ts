import { BlockList, isIP } from "node:net";
import type { LookupOptions } from "node:dns";
import https from "node:https";
import { ImageRejected, normalizeImage, type NormalizedImage, MAX_IMAGE_BYTES } from "./images.js";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;

const blockedAddresses = new BlockList();
blockedAddresses.addSubnet("0.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("10.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("127.0.0.0", 8, "ipv4");
blockedAddresses.addSubnet("169.254.0.0", 16, "ipv4");
blockedAddresses.addSubnet("172.16.0.0", 12, "ipv4");
blockedAddresses.addSubnet("192.168.0.0", 16, "ipv4");
blockedAddresses.addSubnet("224.0.0.0", 4, "ipv4");
blockedAddresses.addSubnet("240.0.0.0", 4, "ipv4");
blockedAddresses.addAddress("::", "ipv6");
blockedAddresses.addAddress("::1", "ipv6");
blockedAddresses.addSubnet("fc00::", 7, "ipv6");
blockedAddresses.addSubnet("fe80::", 10, "ipv6");
blockedAddresses.addSubnet("ff00::", 8, "ipv6");

const blockedHostnames = new Set(["localhost", "metadata.google.internal", "metadata.google.com"]);

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type DownloadTarget = {
  hostname: string;
  address: string;
  family: 4 | 6;
  port: number;
  path: string;
  timeoutMs: number;
};

export type DownloadResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
};

export type DownloadTransport = {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
  open(target: DownloadTarget): Promise<DownloadResponse>;
};

export type DownloadFailure =
  | "allowlist_empty"
  | "url_rejected"
  | "redirect_limit"
  | "address_rejected"
  | "too_large"
  | "timeout"
  | "invalid_image";

export function isBlockedAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 0) return true;
  if (family === 4) return blockedAddresses.check(value, "ipv4");
  const mapped = value.toLowerCase().startsWith("::ffff:") ? value.slice("::ffff:".length) : null;
  if (mapped && isIP(mapped) === 4) return isBlockedAddress(mapped);
  return blockedAddresses.check(value, "ipv6");
}

export function pinnedLookup(address: string, family: 4 | 6) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
  ) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

export function createPinnedHttpsTransport(): DownloadTransport {
  return {
    async resolve(hostname) {
      const { lookup } = await import("node:dns/promises");
      const records = await lookup(hostname, { all: true, verbatim: true });
      return records.map((record) => ({
        address: record.address,
        family: record.family === 6 ? 6 as const : 4 as const,
      }));
    },
    open(target) {
      return new Promise((resolve, reject) => {
        const request = https.request({
          protocol: "https:",
          hostname: target.hostname,
          port: target.port,
          path: target.path,
          method: "GET",
          timeout: target.timeoutMs,
          lookup: pinnedLookup(target.address, target.family),
        }, (response) => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
          });
        });
        request.on("timeout", () => {
          request.destroy(new Error("timeout"));
        });
        request.on("error", (error) => {
          if (error.message === "timeout") reject(new Error("timeout"));
          else reject(error);
        });
        request.end();
      });
    },
  };
}

export async function downloadProviderArtifact(options: {
  url: string;
  allowlist: readonly string[];
  transport: DownloadTransport;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{ ok: true; image: NormalizedImage } | { ok: false; reason: DownloadFailure }> {
  if (options.allowlist.length === 0 || options.allowlist.some((host) => host.includes("*"))) {
    return { ok: false, reason: "allowlist_empty" };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  let current = options.url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const target = validateUrl(current, options.allowlist);
    if (!target) return { ok: false, reason: "url_rejected" };
    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await options.transport.resolve(target.hostname);
    } catch {
      return { ok: false, reason: "address_rejected" };
    }
    if (addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address))) {
      return { ok: false, reason: "address_rejected" };
    }
    const selected = addresses[0];
    if (!selected) return { ok: false, reason: "address_rejected" };
    let response: DownloadResponse;
    try {
      response = await withTimeout(options.transport.open({
        hostname: target.hostname,
        address: selected.address,
        family: selected.family,
        port: target.port === "" ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        timeoutMs,
      }), timeoutMs);
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.message === "timeout" ? "timeout" : "url_rejected" };
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirect === MAX_REDIRECTS) return { ok: false, reason: "redirect_limit" };
      const location = headerValue(response.headers.location);
      if (!location) return { ok: false, reason: "url_rejected" };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "url_rejected" };
      }
      continue;
    }
    if (response.status !== 200) return { ok: false, reason: "url_rejected" };
    let bytes: Buffer | null;
    try {
      bytes = await withTimeout(readLimited(response.body, maxBytes), timeoutMs);
    } catch (error) {
      return { ok: false, reason: error instanceof Error && error.message === "timeout" ? "timeout" : "url_rejected" };
    }
    if (bytes === null) return { ok: false, reason: "too_large" };
    try {
      return { ok: true, image: await normalizeImage(bytes) };
    } catch (error) {
      if (error instanceof ImageRejected) return { ok: false, reason: "invalid_image" };
      return { ok: false, reason: "invalid_image" };
    }
  }
  return { ok: false, reason: "redirect_limit" };
}

function validateUrl(value: string, allowlist: readonly string[]): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (blockedHostnames.has(hostname) || !allowlist.includes(hostname)) return null;
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) return null;
  return url;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readLimited(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("download_failed"));
    });
  });
}
