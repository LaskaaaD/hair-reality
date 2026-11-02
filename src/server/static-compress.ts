import { existsSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { Request, RequestHandler, Response } from "express";

export type PrecompressedEncoding = "br" | "gzip";

/** Pick brotli or gzip from Accept-Encoding (brotli preferred). */
export function negotiatePrecompressedEncoding(
  acceptEncoding: string | undefined,
): PrecompressedEncoding | null {
  if (!acceptEncoding) return null;
  const tokens = acceptEncoding
    .toLowerCase()
    .split(",")
    .map((part) => part.trim().split(";")[0]?.trim())
    .filter((token): token is string => Boolean(token));
  if (tokens.includes("br")) return "br";
  if (tokens.includes("gzip")) return "gzip";
  return null;
}

export function precompressedSidecarPath(filePath: string, encoding: PrecompressedEncoding): string {
  return encoding === "br" ? `${filePath}.br` : `${filePath}.gz`;
}

export function contentTypeForPath(relativePath: string): string {
  const ext = extname(relativePath).toLowerCase();
  switch (ext) {
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

function safeFileUnderRoot(rootDir: string, urlPath: string): string | null {
  const cleaned = urlPath.replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  const absolute = normalize(join(rootDir, cleaned));
  const rootNorm = normalize(rootDir + sep);
  if (!absolute.startsWith(rootNorm)) return null;
  return absolute;
}

export type SendPrecompressedOptions = {
  cacheControl?: string;
};

const DEMO_MEDIA_CACHE = "public, max-age=604800";
const MARKETING_FONT_CACHE = "public, max-age=31536000, immutable";

/** Long-lived cache for demo-media assets (7 days). */
export function cacheControlForDemoMedia(): string {
  return DEMO_MEDIA_CACHE;
}

/** Immutable one-year cache for self-hosted marketing fonts. */
export function cacheControlForMarketingFont(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.includes("marketing/fonts/") && normalized.endsWith(".woff2")) {
    return MARKETING_FONT_CACHE;
  }
  return undefined;
}

export function injectBeforeCloseHead(html: string, snippet: string): string {
  if (!snippet.trim()) return html;
  if (html.includes(snippet.trim())) return html;
  const marker = "</head>";
  const index = html.indexOf(marker);
  if (index === -1) return html;
  return `${html.slice(0, index)}${snippet}\n  ${html.slice(index)}`;
}

/** Send a file with optional precompressed sidecar (.br / .gz). */
export async function sendPrecompressedFile(
  res: Response,
  filePath: string,
  req: Request,
  options: SendPrecompressedOptions = {},
): Promise<boolean> {
  if (!existsSync(filePath)) return false;

  const encoding = negotiatePrecompressedEncoding(req.headers["accept-encoding"]);
  let bodyPath = filePath;
  let contentEncoding: PrecompressedEncoding | undefined;

  if (encoding) {
    const sidecar = precompressedSidecarPath(filePath, encoding);
    if (existsSync(sidecar)) {
      bodyPath = sidecar;
      contentEncoding = encoding;
    }
  }

  const body = await readFile(bodyPath);
  const type = contentTypeForPath(filePath);
  res.setHeader("Content-Type", type);
  res.setHeader("Vary", "Accept-Encoding");
  if (contentEncoding) {
    res.setHeader("Content-Encoding", contentEncoding);
  }
  if (options.cacheControl) {
    res.setHeader("Cache-Control", options.cacheControl);
  }
  res.send(body);
  return true;
}

export type PrecompressedStaticOptions = {
  cacheControl?: string;
  immutable?: boolean;
  /** Per-file Cache-Control override (relative path under rootDir). */
  resolveCacheControl?: (relativePath: string) => string | undefined;
};

export function createPrecompressedStatic(
  rootDir: string,
  options: PrecompressedStaticOptions = {},
): RequestHandler {
  const defaultCacheControl =
    options.cacheControl ??
    (options.immutable ? "public, max-age=31536000, immutable" : undefined);

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    const relative = req.path.startsWith("/") ? req.path.slice(1) : req.path;
    if (relative.endsWith(".br") || relative.endsWith(".gz")) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    const filePath = safeFileUnderRoot(rootDir, relative);
    if (!filePath) {
      next();
      return;
    }
    const resolved =
      options.resolveCacheControl?.(relative) ?? defaultCacheControl;
    const sendOptions: SendPrecompressedOptions = resolved ? { cacheControl: resolved } : {};
    void sendPrecompressedFile(res, filePath, req, sendOptions).then((sent) => {
      if (sent) return;
      next();
    }).catch((error: unknown) => {
      next(error);
    });
  };
}

/** Verify a sidecar exists (for tests). */
export async function sidecarExists(filePath: string, encoding: PrecompressedEncoding): Promise<boolean> {
  try {
    await access(precompressedSidecarPath(filePath, encoding));
    return true;
  } catch {
    return false;
  }
}
