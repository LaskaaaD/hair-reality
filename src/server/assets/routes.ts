import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  assetListSchema,
  assetResponseSchema,
  consentRequestSchema,
  consentResponseSchema,
  deletionRequestSchema,
  deletionResponseSchema,
} from "../../shared/assets.js";
import { errorResponseSchema } from "../../shared/http.js";
import type { AppConfig } from "../config.js";
import { actorFromSession } from "../auth/authorization.js";
import {
  clearCookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenForSession,
  originAllowed,
  readCookie,
  secureCookies,
  SESSION_COOKIE,
  tokensMatch,
} from "../auth/policy.js";
import { readSession } from "../auth/sessions.js";
import type { DeletionJournal } from "./journal.js";
import { readUpload } from "./multipart.js";
import { deleteOwnedAsset, deleteOwnedConsultation } from "./deletion.js";
import { listOwnedAssets, openAssetContent, recordConsent, uploadAsset } from "./records.js";
import type { PrivateStorage } from "./storage.js";

const idSchema = z.uuid();

export type AssetRouterOptions = {
  config: AppConfig;
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  now?: () => Date;
};

export function createAssetRouter(options: AssetRouterOptions): Router {
  const now = options.now ?? (() => new Date());
  const secure = secureCookies(options.config.appOrigin);
  const secret = options.config.sessionSecret;
  const router = Router();
  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    if (!originAllowed(req.get("origin"), options.config.appOrigin)) {
      sendError(res, 403, "origin_rejected", "This site cannot accept the request.");
      return;
    }
    next();
  });

  router.get("/consultations/:id/assets", (req, res, next) => {
    void handleList(req, res).catch(next);
  });
  router.post("/consultations/:id/assets", (req, res, next) => {
    void handleUpload(req, res).catch(next);
  });
  router.post("/consultations/:id/consents", express.json({ limit: "16kb" }), (req, res, next) => {
    void handleConsent(req, res).catch(next);
  });
  router.delete("/consultations/:id", express.json({ limit: "16kb" }), (req, res, next) => {
    void handleConsultationDelete(req, res).catch(next);
  });
  router.get("/assets/:id/content", (req, res, next) => {
    void handleContent(req, res).catch(next);
  });
  router.delete("/assets/:id", express.json({ limit: "16kb" }), (req, res, next) => {
    void handleAssetDelete(req, res).catch(next);
  });
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      sendError(res, 400, "invalid_input", "The request body is not valid JSON.");
      return;
    }
    next(error);
  });
  return router;

  async function handleList(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, false);
    if (!actor) return;
    const consultationId = resourceId(req, res);
    if (!consultationId) return;
    const listed = await listOwnedAssets({
      pool: options.pool,
      actor,
      consultationId,
    });
    if (!listed.ok) {
      sendError(res, listed.status, listed.code, listed.message);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json(assetListSchema.parse({ data: listed.assets }));
  }

  async function handleUpload(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, true);
    if (!actor) {
      req.resume();
      return;
    }
    const consultationId = resourceId(req, res);
    if (!consultationId) {
      req.resume();
      return;
    }
    const upload = await readUpload(req);
    if (!upload.ok) {
      sendError(res, upload.status, upload.code, upload.message);
      return;
    }
    const expectedVersion = positiveInteger(upload.body.expectedVersion);
    if (expectedVersion === null) {
      sendError(res, 400, "invalid_input", "The consultation version is not valid.");
      return;
    }
    const saved = await uploadAsset({
      pool: options.pool,
      storage: options.storage,
      actor,
      consultationId,
      role: upload.body.role,
      expectedVersion,
      file: upload.body.file,
      retentionDays: options.config.assetRetentionDays,
      now: now(),
    });
    if (!saved.ok) {
      sendError(res, saved.status, saved.code, saved.message, undefined, saved.currentVersion ?? null);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json(assetResponseSchema.parse({ data: saved.asset }));
  }

  async function handleConsent(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, true);
    if (!actor) return;
    const consultationId = resourceId(req, res);
    if (!consultationId) return;
    const parsed = consentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_input", "Check the consent and try again.");
      return;
    }
    const saved = await recordConsent({
      pool: options.pool,
      storage: options.storage,
      journal: options.journal,
      actor,
      consultationId,
      request: parsed.data,
      now: now(),
    });
    if (!saved.ok) {
      sendError(res, saved.status, saved.code, saved.message, undefined, saved.currentVersion ?? null);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.status(201).json(consentResponseSchema.parse({
      data: {
        ...saved.consent,
        ...(saved.deletions.length > 0 ? { deletions: saved.deletions } : {}),
      },
    }));
  }

  async function handleConsultationDelete(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, true);
    if (!actor) return;
    const consultationId = resourceId(req, res);
    if (!consultationId) return;
    const parsed = deletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_input", "The consultation version is not valid.");
      return;
    }
    const deleted = await deleteOwnedConsultation({
      pool: options.pool,
      storage: options.storage,
      journal: options.journal,
      actor,
      consultationId,
      expectedVersion: parsed.data.expectedVersion,
      now: now(),
    });
    sendDeletion(res, deleted);
  }

  async function handleAssetDelete(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, true);
    if (!actor) return;
    const assetId = resourceId(req, res);
    if (!assetId) return;
    const parsed = deletionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_input", "The consultation version is not valid.");
      return;
    }
    const deleted = await deleteOwnedAsset({
      pool: options.pool,
      storage: options.storage,
      journal: options.journal,
      actor,
      assetId,
      expectedVersion: parsed.data.expectedVersion,
      now: now(),
    });
    sendDeletion(res, deleted);
  }

  async function handleContent(req: Request, res: Response): Promise<void> {
    const actor = await requireActor(req, res, false);
    if (!actor) return;
    const assetId = resourceId(req, res);
    if (!assetId) return;
    const opened = await openAssetContent({
      pool: options.pool,
      storage: options.storage,
      actor,
      assetId,
    });
    if (!opened.ok) {
      sendError(res, opened.status, opened.code, opened.message);
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", opened.mimeType);
    res.setHeader("Content-Length", String(opened.size));
    res.setHeader("Content-Disposition", "inline");
    opened.stream.on("error", () => {
      console.error("asset_stream_failed");
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    opened.stream.pipe(res);
  }

  async function requireActor(req: Request, res: Response, mutation: boolean) {
    if (!secret) {
      sendError(res, 503, "dependency_unavailable", "Authentication is not configured.");
      return null;
    }
    const rawId = readCookie(req.get("cookie"), SESSION_COOKIE);
    const session = rawId ? await readSession(options.pool, rawId, secret, now()) : null;
    if (!session) {
      if (rawId) res.append("Set-Cookie", clearCookie(SESSION_COOKIE, secure));
      sendError(res, 401, "unauthenticated", "Sign in to continue.");
      return null;
    }
    if (mutation && !acceptedMutation(req, res)) return null;
    return actorFromSession(session.user);
  }

  function acceptedMutation(req: Request, res: Response): boolean {
    if (!secret) return false;
    const header = req.get(CSRF_HEADER)?.trim();
    const sessionId = readCookie(req.get("cookie"), SESSION_COOKIE);
    const anonymous = readCookie(req.get("cookie"), CSRF_COOKIE);
    const matchesSession = header !== undefined && sessionId !== undefined && tokensMatch(header, csrfTokenForSession(secret, sessionId));
    const matchesAnonymous = header !== undefined && anonymous !== undefined && tokensMatch(header, anonymous);
    if (!matchesSession && !matchesAnonymous) {
      sendError(res, 403, "csrf_invalid", "Refresh the page and try again.");
      return false;
    }
    return true;
  }
}

function resourceId(req: Request, res: Response): string | null {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) {
    sendError(res, 404, "not_found", "That photograph or consultation is not available.");
    return null;
  }
  return parsed.data;
}

function positiveInteger(value: string): number | null {
  if (!/^[1-9]\d{0,8}$/.test(value)) return null;
  return Number(value);
}

function sendDeletion(res: Response, result: Awaited<ReturnType<typeof deleteOwnedAsset>>): void {
  if (!result.ok) {
    sendError(res, result.status, result.code, result.message, undefined, result.currentVersion ?? null);
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).json(deletionResponseSchema.parse({ data: result.deletion }));
}

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string[]>,
  currentVersion: number | null = null,
): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json(errorResponseSchema.parse({
    error: {
      code,
      message,
      requestId: randomUUID(),
      ...(fields && Object.keys(fields).length > 0 ? { fieldErrors: fields } : {}),
      ...(currentVersion !== null ? { currentVersion } : {}),
    },
  }));
}
