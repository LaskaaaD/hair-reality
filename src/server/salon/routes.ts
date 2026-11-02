import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import { errorResponseSchema } from "../../shared/http.js";
import type { AppConfig } from "../config.js";
import { readSession } from "../auth/sessions.js";
import { CSRF_HEADER, originAllowed, readCookie, SESSION_COOKIE } from "../auth/policy.js";
import type { NotificationHub } from "../notifications/hub.js";
import { listDemoSlots } from "../booking/records.js";
import { PlanRejected, publishStylistRevision, requestPlanChange } from "../plans/publish.js";
import { addMessage, listInbox, listMessages, readReview, SalonRejected, startReview } from "./records.js";

export function createSalonRouter(options: { config: AppConfig; pool: Pool; now?: () => Date }): Router {
  const router = Router();
  const json = express.json({ limit: "16kb" });
  const secret = options.config.sessionSecret;

  router.get("/salon/consultations", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res);
      if (!actor) return;
      const status = typeof req.query.status === "string" ? req.query.status : null;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: await listInbox(options.pool, actor, status), nextCursor: null });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.get("/consultations/:id/review", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const review = await readReview(options.pool, actor, id);
      if (!review) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: review });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.get("/consultations/:id/messages", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const messages = await listMessages(options.pool, actor, id);
      if (!messages) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ data: messages });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.post("/consultations/:id/messages", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const parsed = z.strictObject({ text: z.string() }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Write a plain-text message.");
        return;
      }
      const hub = req.app.get("notifications") as NotificationHub | undefined;
      const message = await addMessage(options.pool, actor, id, parsed.data.text, hub ?? null);
      res.status(201).json({ data: message });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.post("/consultations/:id/revisions", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const key = req.header("idempotency-key")?.trim() ?? "";
      if (key.length < 1 || key.length > 200) {
        sendError(res, 400, "invalid_input", "Send an Idempotency-Key header.");
        return;
      }
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        parentRevisionId: z.uuid(),
        reason: z.string(),
        outcome: z.enum(["counterproposal", "consultation_required", "resolution"]),
        addressedChangeRequestIds: z.array(z.uuid()).max(20),
        notes: z.array(z.strictObject({
          kind: z.enum(["haircut", "colour", "beard"]),
          text: z.string(),
          represented: z.boolean(),
        })).max(3),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.");
        return;
      }
      const published = await publishStylistRevision(options.pool, actor.id, id, { ...parsed.data, idempotencyKey: key });
      const hub = req.app.get("notifications") as NotificationHub | undefined;
      if (published.created && hub) {
        await hub.publish({ event: "plan.revised", consultationId: id, version: published.version, resourceId: published.revisionId });
      }
      res.status(published.created ? 201 : 200).json({ data: published });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.post("/consultations/:id/change-requests", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        revisionId: z.uuid(),
        message: z.string(),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.");
        return;
      }
      const created = await requestPlanChange(options.pool, actor.id, id, parsed.data.expectedVersion, parsed.data.revisionId, parsed.data.message);
      res.status(201).json({ data: created });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.post("/consultations/:id/review-start", json, async (req, res, next) => {
    try {
      const actor = await requireActor(req, res, true);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That consultation is not available.");
        return;
      }
      const parsed = z.strictObject({
        expectedVersion: z.number().int().positive(),
        revisionId: z.uuid(),
      }).safeParse(req.body);
      if (!parsed.success) {
        sendError(res, 400, "invalid_input", "Check the highlighted fields.");
        return;
      }
      const hub = req.app.get("notifications") as NotificationHub | undefined;
      const started = await startReview(options.pool, actor, id, parsed.data.expectedVersion, parsed.data.revisionId, hub ?? null);
      res.json({ data: started });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  router.get("/salons/:id/demo-slots", async (req, res, next) => {
    try {
      const actor = await requireActor(req, res);
      if (!actor) return;
      const id = oneId(req.params.id);
      if (!id) {
        sendError(res, 404, "not_found", "That salon is not available.");
        return;
      }
      const from = typeof req.query.from === "string" ? req.query.from : null;
      const to = typeof req.query.to === "string" ? req.query.to : null;
      res.setHeader("Cache-Control", "private, no-store");
      res.json({
        data: await listDemoSlots(options.pool, id, from, to, (options.now ?? (() => new Date()))()),
      });
    } catch (error) {
      sendFailure(res, next, error);
    }
  });

  return router;

  async function requireActor(req: Request, res: Response, mutation = false) {
    if (!secret) {
      sendError(res, 503, "dependency_unavailable", "Authentication is not configured.");
      return null;
    }
    const rawId = readCookie(req.get("cookie"), SESSION_COOKIE);
    const session = rawId ? await readSession(options.pool, rawId, secret, (options.now ?? (() => new Date()))()) : null;
    if (!session) {
      sendError(res, 401, "unauthenticated", "Sign in to continue.");
      return null;
    }
    if (mutation) {
      const origin = req.header("origin") ?? undefined;
      const csrf = req.header(CSRF_HEADER);
      if (!originAllowed(origin, options.config.appOrigin) || !csrf || csrf !== session.csrfToken) {
        sendError(res, 403, "forbidden", "The request was not accepted.");
        return null;
      }
    }
    return session.user;
  }
}

function oneId(value: string | string[] | undefined): string | null {
  const id = Array.isArray(value) ? value[0] : value;
  return z.uuid().safeParse(id).success ? id ?? null : null;
}

function sendFailure(res: Response, next: NextFunction, error: unknown): void {
  if (error instanceof SalonRejected || error instanceof PlanRejected) {
    sendError(res, error.status, error.code, error.message, error.currentVersion);
    return;
  }
  next(error);
}

function sendError(res: Response, status: number, code: string, message: string, currentVersion: number | null = null): void {
  res.status(status).json(errorResponseSchema.parse({
    error: {
      code,
      message,
      requestId: randomUUID(),
      ...(currentVersion === null ? {} : { currentVersion }),
    },
  }));
}
