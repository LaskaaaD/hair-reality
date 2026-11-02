import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { AttemptWindow } from "./auth/rate-limit.js";
import { errorResponseSchema, healthResponseSchema, readyResponseSchema } from "../shared/http.js";
import { createDemoRouter } from "./demo/routes.js";
import type { OpenAIClient } from "./providers/openai/client.js";
import { createPrivateStorage, type PrivateStorage } from "./assets/storage.js";
import type { AppConfig } from "./config.js";
import { databaseIsAccessible } from "./readiness.js";
import {
  cacheControlForDemoMedia,
  cacheControlForMarketingFont,
  createPrecompressedStatic,
  sendPrecompressedFile,
} from "./static-compress.js";

const healthBody = healthResponseSchema.parse({ data: { status: "ok" } });
const readyBody = readyResponseSchema.parse({ data: { status: "ready" } });

export type AppDependencies = {
  pool?: Pool;
  now?: () => Date;
  storage?: PrivateStorage;
  demoIpLimit?: AttemptWindow;
  openai?: OpenAIClient | null;
};

export function createApp(
  config: AppConfig,
  clientDir = resolve(process.cwd(), "dist", "client"),
  dependencies: AppDependencies = {},
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(clientDir));
    next();
  });

  app.get("/api/v1/health", (_req, res) => {
    res.json(healthBody);
  });

  app.get("/api/v1/ready", (req, res, next) => {
    void databaseIsAccessible(config.databaseUrl)
      .then((ready) => {
        if (ready) {
          res.json(readyBody);
          return;
        }
        sendError(res, 503, "dependency_unavailable", "Database is not accessible");
      })
      .catch((error: unknown) => {
        next(error);
      });
  });

  if (dependencies.pool) {
    app.use("/api/v1", createDemoRouter({
      config,
      pool: dependencies.pool,
      storage: dependencies.storage ?? createPrivateStorage(config.privateStorageDir),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.demoIpLimit ? { ipLimit: dependencies.demoIpLimit } : {}),
      ...(dependencies.openai ? { openai: dependencies.openai } : {}),
    }));
  }

  app.use("/api", (_req, res) => {
    sendError(res, 404, "not_found", "Not found");
  });

  const demoMediaBundled = resolve(clientDir, "demo-media");
  const demoMediaPublic = resolve(process.cwd(), "public", "demo-media");
  const demoMediaCacheHeaders = (res: Response) => {
    res.setHeader("Cache-Control", cacheControlForDemoMedia());
  };
  app.use("/demo-media", express.static(demoMediaBundled, {
    index: false,
    fallthrough: true,
    dotfiles: "deny",
    setHeaders: demoMediaCacheHeaders,
  }));
  app.use("/demo-media/mediapipe/wasm", express.static(resolve(process.cwd(), "node_modules", "@mediapipe", "tasks-vision", "wasm"), {
    index: false,
    fallthrough: true,
    dotfiles: "deny",
    setHeaders: demoMediaCacheHeaders,
  }));
  app.use("/demo-media", express.static(demoMediaPublic, {
    index: false,
    fallthrough: true,
    dotfiles: "deny",
    setHeaders: demoMediaCacheHeaders,
  }));

  app.get("/robots.txt", (req, res, next) => {
    void sendPrecompressedFile(res, resolve(clientDir, "robots.txt"), req, {
      cacheControl: "public, max-age=3600",
    }).then((sent) => {
      if (sent) return;
      res.status(404).type("text/plain").send("Not found");
    }).catch(next);
  });

  const assetDir = resolve(clientDir, "assets");
  app.use(
    "/assets",
    createPrecompressedStatic(assetDir, {
      immutable: true,
      resolveCacheControl: (relativePath) => cacheControlForMarketingFont(relativePath),
    }),
  );
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    // Every wizard route (/demo, /demo/goal, /demo/results, /demo/tryon) needs the flow-styled shell; index.html only carries landing CSS.
    if (isDemoRoute(req.path)) {
      const demoShellPath = resolve(clientDir, "demo-shell.html");
      if (existsSync(demoShellPath)) {
        void sendPrecompressedFile(res, demoShellPath, req, {
          cacheControl: "no-cache",
        }).then((sent) => {
          if (sent) return;
          next();
        }).catch(next);
        return;
      }
    }
    const indexPath = resolve(clientDir, "index.html");
    void sendPrecompressedFile(res, indexPath, req, {
      cacheControl: "no-cache",
    }).then((sent) => {
      if (sent) return;
      if (!existsSync(indexPath)) {
        res.status(503).type("text/plain").send("Application shell is not built");
        return;
      }
      next(new Error("index shell unreadable"));
    }).catch((error: unknown) => {
      if (fileMissing(error)) {
        res.status(503).type("text/plain").send("Application shell is not built");
        return;
      }
      next(error);
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`request_failed ${errorName(error)}`);
    if (res.headersSent) return;
    sendError(res, 500, "internal_error", "Something went wrong");
  });

  return app;
}

export function isDemoRoute(path: string): boolean {
  return path === "/demo" || path === "/demo/" || path.startsWith("/demo/") || path.startsWith("/brief/") || path.startsWith("/s/");
}

function sendError(res: Response, status: number, code: string, message: string): void {
  const body = errorResponseSchema.parse({
    error: { code, message, requestId: randomUUID() },
  });
  res.status(status).json(body);
}

function fileMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function contentSecurityPolicy(clientDir: string): string {
  const styleHashes = readInlineStyleHashes(clientDir)
    .map((hash) => `'sha256-${hash}'`)
    .join(" ");
  const styleSrc = styleHashes.length > 0 ? `style-src 'self' ${styleHashes}` : "style-src 'self'";
  return [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    styleSrc,
    "script-src 'self' 'wasm-unsafe-eval' https://plugins-media.makeupar.com",
    "connect-src 'self' https://plugins-media.makeupar.com https://yce-api-01.makeupar.com",
    "media-src 'self' blob:",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

function readInlineStyleHashes(clientDir: string): string[] {
  const hashPath = resolve(clientDir, "csp-style-hashes.json");
  if (!existsSync(hashPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(hashPath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  } catch {
    return [];
  }
}
