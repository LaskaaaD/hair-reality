import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/http.js";
import {
  analysisJobSchema,
  interpretationJobSchema,
  interpretationResultsSchema,
  jobResponseSchema,
  previewJobSchema,
  previewSelectionSchema,
  resolutionSchema,
  usageResponseSchema,
} from "../../shared/jobs.js";
import type { AppConfig } from "../config.js";
import { assembleInterpretationRequest, candidateIdsInValues, interpretationSummary } from "./interpretation-request.js";
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
import { haircutPreviewResponseSchema } from "../../shared/preview-schema.js";
import { admitJob, readAuthorizedJob, resolveUncertain, usageReport, type AdmitResult } from "./accounting.js";
import { refreshStaleYouCamBalance } from "./youcam-balance.js";
import { PreviewRejected, readHaircutPreviews, selectPreviewForActor } from "../previews/records.js";

const idSchema = z.uuid();

export type JobRouterOptions = {
  config: AppConfig;
  pool: Pool;
  now?: () => Date;
  readYouCamBalance?: () => Promise<{ units: number } | null>;
};

export function createJobRouter(options: JobRouterOptions): Router {
  const now = options.now ?? (() => new Date());
  const secure = secureCookies(options.config.appOrigin);
  const secret = options.config.sessionSecret;
  const router = Router();
  const json = express.json({ limit: "16kb" });
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

  router.post("/consultations/:id/analysis-jobs", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const parsed = analysisJobSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const key = idempotencyKey(req, res);
      if (!key) return;
      await refreshYouCamBalance(options, now);
      const result = await admitJob({
        pool: options.pool,
        config: options.config,
        actorId: actor.id,
        consultationId,
        operation: "analysis",
        provider: "youcam",
        idempotencyKey: key,
        body: parsed.data,
        expectedVersion: parsed.data.expectedVersion,
        assetIds: parsed.data.assetIds,
        serviceId: null,
        configuration: JSON.stringify(parsed.data.capabilities),
        now: now(),
      });
      sendJob(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/interpretation-results", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const rows = await options.pool.query<{
        capability: string;
        source: string;
        values: unknown;
        uncertainty: string | null;
        observed_at: Date;
      }>(
        `SELECT analysis_results.capability, analysis_results.source, analysis_results.values,
                analysis_results.uncertainty, analysis_results.observed_at
         FROM analysis_results
         JOIN consultations ON consultations.id = analysis_results.consultation_id
         WHERE analysis_results.consultation_id = $1
           AND analysis_results.capability LIKE 'openai-%'
           AND consultations.deleted_at IS NULL
           AND (
             consultations.client_user_id = $2
             OR EXISTS (
               SELECT 1 FROM salon_memberships
               WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
             )
           )
         ORDER BY analysis_results.observed_at DESC
         LIMIT 12`,
        [consultationId, actor.id],
      );
      const visible = await options.pool.query(
        `SELECT 1 FROM consultations
         WHERE id = $1 AND deleted_at IS NULL AND (
           client_user_id = $2
           OR EXISTS (
             SELECT 1 FROM salon_memberships
             WHERE salon_id = consultations.salon_id AND user_id = $2 AND role IN ('stylist', 'admin')
           )
         )`,
        [consultationId, actor.id],
      );
      if ((visible.rowCount ?? 0) !== 1) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const titles = await candidateTitles(options.pool, rows.rows.flatMap((row) => candidateIdsInValues(row.values)));
      res.setHeader("Cache-Control", "private, no-store");
      res.json(interpretationResultsSchema.parse({
        data: rows.rows.map((row) => ({
          capability: row.capability,
          source: row.source,
          uncertainty: row.uncertainty,
          observedAt: row.observed_at.toISOString(),
          summary: interpretationSummary(row.source, row.values, row.uncertainty, titles),
        })),
      }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/interpretation-jobs", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const parsed = interpretationJobSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const key = idempotencyKey(req, res);
      if (!key) return;
      const operation = parsed.data.operation ?? "target_interpretation";
      const assembled = await assembleInterpretationRequest(options.pool, consultationId, {
        serviceId: parsed.data.serviceId,
        serviceKind: parsed.data.serviceKind,
        operation,
      });
      if (!assembled.ok) {
        sendError(res, assembled.status, assembled.code, assembled.message);
        return;
      }
      const result = await admitJob({
        pool: options.pool,
        config: options.config,
        actorId: actor.id,
        consultationId,
        operation: "interpretation",
        provider: "openai",
        idempotencyKey: key,
        body: parsed.data,
        expectedVersion: parsed.data.expectedVersion,
        assetIds: assembled.request.imageAssetIds,
        serviceId: assembled.serviceId,
        configuration: JSON.stringify(assembled.request),
        now: now(),
      });
      sendJob(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/preview-jobs", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const parsed = previewJobSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const key = idempotencyKey(req, res);
      if (!key) return;
      await refreshYouCamBalance(options, now);
      const result = await admitJob({
        pool: options.pool,
        config: options.config,
        actorId: actor.id,
        consultationId,
        operation: "preview",
        provider: "youcam",
        idempotencyKey: key,
        body: parsed.data,
        expectedVersion: parsed.data.expectedVersion,
        assetIds: [parsed.data.sourceAssetId],
        serviceId: parsed.data.serviceId,
        configuration: `preview:${parsed.data.candidateId}`,
        now: now(),
      });
      sendJob(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/previews", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const screen = await readHaircutPreviews(options.pool, actor.id, consultationId);
      if (!screen) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(haircutPreviewResponseSchema.parse({ data: screen }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/preview-selections", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const consultationId = resourceId(req, res, "That consultation is not available.");
      if (!consultationId) return;
      const parsed = previewSelectionSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      try {
        await selectPreviewForActor(
          options.pool,
          actor.id,
          consultationId,
          parsed.data.serviceId,
          parsed.data.previewId,
          parsed.data.expectedVersion,
        );
      } catch (error) {
        if (error instanceof PreviewRejected) {
          sendError(res, error.status, error.code, error.message);
          return;
        }
        throw error;
      }
      const screen = await readHaircutPreviews(options.pool, actor.id, consultationId);
      if (!screen) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(haircutPreviewResponseSchema.parse({ data: screen }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:id", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const jobId = resourceId(req, res, "That job is not available.");
      if (!jobId) return;
      const job = await readAuthorizedJob(options.pool, actor.id, jobId);
      if (!job) {
        sendError(res, 404, "not_found", "That job is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(jobResponseSchema.parse({ data: job }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/operator/usage", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const report = await usageReport(options.pool, actor.id, options.config);
      if (!report.ok) {
        sendError(res, report.status, report.code, report.message);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(usageResponseSchema.parse({ data: report.body }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/operator/jobs/:id/resolution", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const jobId = resourceId(req, res, "That job is not available.");
      if (!jobId) return;
      const parsed = resolutionSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const result = await resolveUncertain(
        options.pool,
        actor.id,
        jobId,
        parsed.data.outcome,
        parsed.data.actualUnits ?? null,
        options.config.providerMode,
      );
      sendJob(res, result);
    } catch (error) {
      next(error);
    }
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      sendError(res, 400, "invalid_input", "The request body is not valid JSON.");
      return;
    }
    next(error);
  });

  return router;

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
    if (mutation && !acceptedMutation(req, res, session.rawId, secret)) return null;
    return session.user;
  }

  function acceptedMutation(req: Request, res: Response, rawSessionId: string, sessionSecret: string): boolean {
    const header = req.get(CSRF_HEADER)?.trim();
    const sessionToken = csrfTokenForSession(sessionSecret, rawSessionId);
    const anonymous = readCookie(req.get("cookie"), CSRF_COOKIE);
    const matchesSession = header !== undefined && tokensMatch(header, sessionToken);
    const matchesAnonymous = header !== undefined && anonymous !== undefined && tokensMatch(header, anonymous);
    if (!matchesSession && !matchesAnonymous) {
      sendError(res, 403, "csrf_invalid", "Refresh the page and try again.");
      return false;
    }
    return true;
  }
}

function idempotencyKey(req: Request, res: Response): string | null {
  const key = req.get("idempotency-key")?.trim() ?? "";
  if (key.length < 1 || key.length > 200) {
    sendError(res, 400, "invalid_input", "An idempotency key from 1 to 200 characters is required.", {
      "idempotency-key": ["An idempotency key from 1 to 200 characters is required."],
    });
    return null;
  }
  return key;
}

async function refreshYouCamBalance(options: JobRouterOptions, now: () => Date): Promise<void> {
  if (!options.readYouCamBalance) return;
  await refreshStaleYouCamBalance(options.pool, options.config, now(), options.readYouCamBalance);
}

function resourceId(req: Request, res: Response, message: string): string | null {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) {
    sendError(res, 404, "not_found", message);
    return null;
  }
  return parsed.data;
}

function sendJob(res: Response, result: AdmitResult): void {
  if (!result.ok) {
    sendError(res, result.status, result.code, result.message, undefined, result.currentVersion);
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.status(result.created ? 202 : 200).json(jobResponseSchema.parse({ data: result.job }));
}

function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const record = issue as { code: string; path: PropertyKey[]; keys?: string[] };
    if (record.code === "unrecognized_keys" && record.keys) {
      for (const key of record.keys) errors[key] = ["This field is not allowed."];
      continue;
    }
    const key = record.path[0];
    const name = typeof key === "string" ? key : "request";
    errors[name] = ["This value is not valid."];
  }
  return errors;
}

async function candidateTitles(pool: Pool, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => idSchema.safeParse(id).success))];
  const titles = new Map<string, string>();
  if (unique.length === 0) return titles;
  const result = await pool.query<{ id: string; title: string }>(
    "SELECT id::text AS id, title FROM candidates WHERE id = ANY($1::uuid[])",
    [unique],
  );
  for (const row of result.rows) titles.set(row.id, row.title);
  return titles;
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
      ...(fields ? { fieldErrors: fields } : {}),
      ...(currentVersion !== null ? { currentVersion } : {}),
    },
  }));
}
