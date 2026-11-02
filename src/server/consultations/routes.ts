import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import {
  consultationListSchema,
  consultationResponseSchema,
  createConsultationSchema,
  draftUpdateSchema,
  publicSalonSchema,
  readinessRequestSchema,
} from "../../shared/consultations.js";
import { catalogueResponseSchema, targetFieldErrors, targetInputSchema, targetResponseSchema } from "../../shared/catalogue.js";
import { briefFieldErrors, clientBriefSchema, type ColourHistory, type PreferencesInput } from "../../shared/client-brief.js";
import { analysisPlanSchema } from "../../shared/face-colour.js";
import { assessmentRequestSchema, realityCheckSchema } from "../../shared/reality-check-schema.js";
import { hairProfileSchema } from "../../shared/hair-profile.js";
import { errorResponseSchema } from "../../shared/http.js";
import { DEMO_SALON_SLUG } from "../../shared/salon.js";
import type { AppConfig } from "../config.js";
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
import { listCatalogue } from "../catalogue/records.js";
import { readClientBrief } from "./client-brief.js";
import { readRealityCheck, saveRealityCheck } from "../reality/records.js";
import { readAnalysisPlan } from "../profiles/read-analysis-plan.js";
import { readHairProfile } from "../profiles/read-hair-profile.js";
import { bookDemoSlot, cancelConsultation, readBooking } from "../booking/records.js";
import type { NotificationHub } from "../notifications/hub.js";
import { approvePlan, PlanRejected, publishSubmission, readCurrentProposal, readRevisionHistory } from "../plans/publish.js";
import {
  checkReadiness,
  createConsultation,
  decodeCursor,
  listConsultations,
  readConsultation,
  readTargets,
  saveTarget,
  TargetRejected,
  updateDraft,
  type ConsultationResult,
} from "./records.js";

const slugSchema = z.string().regex(/^[a-z0-9-]{1,80}$/);
const idSchema = z.uuid();

export type ConsultationRouterOptions = {
  config: AppConfig;
  pool: Pool;
  now?: () => Date;
};

export function createConsultationRouter(options: ConsultationRouterOptions): Router {
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

  router.get("/salons/:slug", (req, res, next) => {
    const slug = slugSchema.safeParse(req.params.slug);
    if (!slug.success) {
      sendError(res, 404, "not_found", "That salon is not available.");
      return;
    }
    options.pool.query<{ id: string; slug: string; name: string }>(
      `SELECT id, slug, name FROM salons
       WHERE slug = $1 AND branding->>'kind' = 'demonstration'`,
      [slug.data],
    ).then((result) => {
      const salon = result.rows[0];
      if (!salon) {
        sendError(res, 404, "not_found", "That salon is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(publicSalonSchema.parse({ data: salon }));
    }).catch(next);
  });

  router.get("/catalogue", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const service = catalogueService(req.query.service);
      if (service === "invalid") {
        sendError(res, 400, "invalid_input", "Choose haircut, colour or beard.", { service: ["Choose haircut, colour or beard."] });
        return;
      }
      const salon = await options.pool.query<{ id: string }>(
        "SELECT id FROM salons WHERE slug = $1",
        [DEMO_SALON_SLUG],
      );
      const salonId = salon.rows[0]?.id;
      if (!salonId) {
        sendError(res, 404, "not_found", "That salon is not available.");
        return;
      }
      const entries = await listCatalogue(options.pool, salonId, service);
      res.setHeader("Cache-Control", "private, no-store");
      res.json(catalogueResponseSchema.parse({ data: entries, nextCursor: null }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const limit = parseLimit(req.query.limit);
      if (limit === null) {
        sendError(res, 400, "invalid_input", "Choose a page size from 1 to 50.", { limit: ["Choose a page size from 1 to 50."] });
        return;
      }
      const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
      if (req.query.cursor !== undefined && rawCursor === null) {
        sendError(res, 400, "invalid_input", "That page cursor is not valid.", { cursor: ["That page cursor is not valid."] });
        return;
      }
      const cursor = rawCursor ? decodeCursor(rawCursor) : null;
      if (rawCursor && !cursor) {
        sendError(res, 400, "invalid_input", "That page cursor is not valid.", { cursor: ["That page cursor is not valid."] });
        return;
      }
      const listed = await listConsultations(options.pool, actor.id, cursor, limit);
      if (!listed.ok) {
        sendError(res, listed.status, listed.code, listed.message, listed.fieldErrors, listed.currentVersion);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(consultationListSchema.parse({ data: listed.consultations, nextCursor: listed.nextCursor }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const parsed = createConsultationSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const created = await createConsultation(options.pool, actor.id, parsed.data.salonId, parsed.data.services);
      sendConsultation(res, created, 201);
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/analysis-plan", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const suggestions = suggestionFlags(req, res);
      if (!suggestions) return;
      const plan = await readAnalysisPlan(
        options.pool,
        actor,
        id,
        options.config.providerMode === "fixture" ? "fixture" : "real",
        suggestions,
      );
      if (!plan.ok) {
        sendError(res, plan.status, plan.code, plan.message);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(analysisPlanSchema.parse({ data: plan.plan }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/hair-profile", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const profile = await readHairProfile(
        options.pool,
        actor,
        id,
        options.config.providerMode === "fixture" ? "fixture" : "real",
      );
      if (!profile.ok) {
        sendError(res, profile.status, profile.code, profile.message);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(hairProfileSchema.parse({ data: profile.profile }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/targets", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const consultation = await readConsultation(options.pool, actor, id);
      if (!consultation.ok) {
        sendError(res, consultation.status, consultation.code, consultation.message);
        return;
      }
      const targets = await readTargets(options.pool, id);
      res.setHeader("Cache-Control", "private, no-store");
      res.json(targetResponseSchema.parse({ data: { version: consultation.consultation.version, targets } }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/targets", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = targetInputSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const consultation = await readConsultation(options.pool, actor, id);
      if (!consultation.ok) {
        sendError(res, consultation.status, consultation.code, consultation.message);
        return;
      }
      const selected = consultation.consultation.services.some((service) => service.kind === parsed.data.serviceKind);
      const misplaced = targetFieldErrors(parsed.data, selected);
      if (misplaced) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", misplaced);
        return;
      }
      sendConsultation(res, await saveTarget(options.pool, actor.id, id, parsed.data), 200);
    } catch (error) {
      if (error instanceof TargetRejected) {
        sendError(res, 400, "invalid_input", error.message, { [error.field]: [error.message] });
        return;
      }
      next(error);
    }
  });

  router.get("/consultations/:id/assessments", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const view = await readRealityCheck(options.pool, actor, id);
      if (!view.ok) {
        sendError(res, view.status, view.code, view.message, undefined, view.currentVersion);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(realityCheckSchema.parse({ data: view.view }));
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/assessments", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = assessmentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const view = await saveRealityCheck(
        options.pool,
        actor,
        id,
        parsed.data.expectedVersion,
        options.config.providerMode === "fixture" ? "fixture" : "real",
      );
      if (!view.ok) {
        sendError(res, view.status, view.code, view.message, undefined, view.currentVersion);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(realityCheckSchema.parse({ data: view.view }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/client-brief", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const brief = await readClientBrief(options.pool, actor, id);
      if (!brief.ok) {
        sendError(res, brief.status, brief.code, brief.message);
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json(clientBriefSchema.parse({ data: brief.brief }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      sendConsultation(res, await readConsultation(options.pool, actor, id), 200);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/consultations/:id/draft", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = draftUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const misplaced = briefFieldErrors(parsed.data.services, parsed.data.history, parsed.data.preferences);
      if (misplaced) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", misplaced);
        return;
      }
      const brief: { history?: ColourHistory; preferences?: PreferencesInput } = {};
      if (parsed.data.history) brief.history = parsed.data.history;
      if (parsed.data.preferences) brief.preferences = parsed.data.preferences;
      sendConsultation(res, await updateDraft(
        options.pool,
        actor.id,
        id,
        parsed.data.expectedVersion,
        parsed.data.services,
        brief,
      ), 200);
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/readiness", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = readinessRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      sendConsultation(res, await checkReadiness(options.pool, actor.id, id, parsed.data.expectedVersion), 200);
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/proposal", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const proposal = await readCurrentProposal(options.pool, actor.id, id);
      if (!proposal) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.json({ data: { ...proposal, published: false, revisionId: null, revisionNumber: null, snapshotHash: null } });
    } catch (error) {
      next(error);
    }
  });

  router.get("/consultations/:id/revisions", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const revisions = await readRevisionHistory(options.pool, actor.id, id);
      if (!revisions) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: revisions });
    } catch (error) {
      next(error);
    }
  });

  router.post("/consultations/:id/submissions", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const key = req.get("idempotency-key")?.trim() ?? "";
      if (key.length < 1 || key.length > 200) {
        sendError(res, 400, "invalid_input", "An idempotency key from 1 to 200 characters is required.", {
          "idempotency-key": ["An idempotency key from 1 to 200 characters is required."],
        });
        return;
      }
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        parentRevisionId: z.uuid().nullable(),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const published = await publishSubmission(options.pool, actor.id, id, parsed.data.expectedVersion, parsed.data.parentRevisionId, key);
      res.status(published.created ? 201 : 200).json({ data: { ...published, published: true } });
    } catch (error) {
      if (error instanceof PlanRejected) {
        sendError(res, error.status, error.code, error.message, undefined, error.currentVersion);
        return;
      }
      next(error);
    }
  });

  router.post("/consultations/:id/approvals", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        revisionId: z.uuid(),
        snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const approved = await approvePlan(
        options.pool,
        actor.id,
        id,
        parsed.data.expectedVersion,
        parsed.data.revisionId,
        parsed.data.snapshotHash,
      );
      res.status(approved.created ? 201 : 200).json({ data: approved });
    } catch (error) {
      if (error instanceof PlanRejected) {
        sendError(res, error.status, error.code, error.message, undefined, error.currentVersion);
        return;
      }
      next(error);
    }
  });

  router.get("/consultations/:id/bookings", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, false);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: await readBooking(options.pool, actor.id, id) });
    } catch (error) {
      if (error instanceof PlanRejected) {
        sendError(res, error.status, error.code, error.message, undefined, error.currentVersion);
        return;
      }
      next(error);
    }
  });

  router.post("/consultations/:id/bookings", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const key = req.get("idempotency-key")?.trim() ?? "";
      if (key.length < 1 || key.length > 200) {
        sendError(res, 400, "invalid_input", "An idempotency key from 1 to 200 characters is required.", {
          "idempotency-key": ["An idempotency key from 1 to 200 characters is required."],
        });
        return;
      }
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        revisionId: z.uuid(),
        slotId: z.uuid(),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const booked = await bookDemoSlot(options.pool, actor.id, id, { ...parsed.data, idempotencyKey: key }, now());
      const hub = req.app.get("notifications") as NotificationHub | undefined;
      if (booked.created && hub) {
        await hub.publish({ event: "consultation.updated", consultationId: id, version: booked.version, resourceId: booked.id });
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.status(booked.created ? 201 : 200).json({ data: booked });
    } catch (error) {
      if (error instanceof PlanRejected) {
        sendError(res, error.status, error.code, error.message, undefined, error.currentVersion);
        return;
      }
      next(error);
    }
  });

  router.post("/consultations/:id/cancellation", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = resourceId(req, res);
      if (!id) return;
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.", fieldErrors(parsed.error));
        return;
      }
      const cancelled = await cancelConsultation(options.pool, actor.id, id, parsed.data.expectedVersion);
      const hub = req.app.get("notifications") as NotificationHub | undefined;
      if (hub) {
        await hub.publish({ event: "consultation.updated", consultationId: id, version: cancelled.version, resourceId: id });
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).json({ data: cancelled });
    } catch (error) {
      if (error instanceof PlanRejected) {
        sendError(res, error.status, error.code, error.message, undefined, error.currentVersion);
        return;
      }
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

function suggestionFlags(req: Request, res: Response): { silhouette: boolean; tones: boolean } | null {
  const silhouette = booleanFlag(req.query.silhouette);
  const tones = booleanFlag(req.query.tones);
  if (silhouette === null || tones === null) {
    sendError(res, 400, "invalid_input", "Suggestion flags must be 0 or 1.", {
      ...(silhouette === null ? { silhouette: ["Use 0 or 1."] } : {}),
      ...(tones === null ? { tones: ["Use 0 or 1."] } : {}),
    });
    return null;
  }
  return { silhouette, tones };
}

function booleanFlag(value: unknown): boolean | null {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  return null;
}

function resourceId(req: Request, res: Response): string | null {
  const parsed = idSchema.safeParse(req.params.id);
  if (!parsed.success) {
    sendError(res, 404, "not_found", "That consultation is not available.");
    return null;
  }
  return parsed.data;
}

function catalogueService(value: unknown): "haircut" | "colour" | "beard" | null | "invalid" {
  if (value === undefined) return null;
  if (value === "haircut" || value === "colour" || value === "beard") return value;
  return "invalid";
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 20;
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) return null;
  const limit = Number(value);
  if (limit > 50) return null;
  return limit;
}

function sendConsultation(res: Response, result: ConsultationResult, status: number): void {
  if (!result.ok) {
    sendError(res, result.status, result.code, result.message, result.fieldErrors, result.currentVersion);
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json(consultationResponseSchema.parse({ data: result.consultation }));
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
    errors[name] = [name === "services"
      ? "Choose one or more of haircut, colour and beard, without duplicates."
      : "This value is not valid."];
  }
  return errors;
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
