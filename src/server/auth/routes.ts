import { randomBytes, randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { Pool } from "pg";
import { loginRequestSchema, registerRequestSchema, sessionResponseSchema } from "../../shared/auth.js";
import { errorResponseSchema } from "../../shared/http.js";
import type { AppConfig } from "../config.js";
import { authenticate, registerClient } from "./accounts.js";
import {
  AUTH_ACCOUNT_FAILURES,
  AUTH_IP_ATTEMPTS,
  AUTH_PARTITION_HEADER,
  AUTH_WINDOW_MS,
  authRateKey,
  clearCookie,
  clientAddress,
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenForSession,
  originAllowed,
  readCookie,
  secureCookies,
  serializeCookie,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE,
  tokensMatch,
} from "./policy.js";
import { AttemptWindow, type AuthLimits } from "./rate-limit.js";
import { createSession, deleteSession, readSession, touchSession } from "./sessions.js";

const INVALID_CREDENTIALS = "Email or password is incorrect.";
const ABSOLUTE_SECONDS = Math.floor(SESSION_ABSOLUTE_MS / 1000);

export type AuthRouterOptions = {
  config: AppConfig;
  pool: Pool;
  now?: () => Date;
  limits?: AuthLimits;
};

export function createAuthRouter(options: AuthRouterOptions): Router {
  const { config, pool } = options;
  const now = options.now ?? (() => new Date());
  const limits = options.limits ?? {
    accountFailures: AUTH_ACCOUNT_FAILURES,
    ipAttempts: AUTH_IP_ATTEMPTS,
    windowMs: AUTH_WINDOW_MS,
  };
  const accountLimits = new AttemptWindow(limits.accountFailures, limits.windowMs);
  const ipLimits = new AttemptWindow(limits.ipAttempts, limits.windowMs);
  const secure = secureCookies(config.appOrigin);
  const secret = config.sessionSecret;
  const router = Router();

  router.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") {
      next();
      return;
    }
    if (!originAllowed(req.get("origin"), config.appOrigin)) {
      sendError(res, 403, "origin_rejected", "This site cannot accept the request.");
      return;
    }
    next();
  });
  router.use(express.json({ limit: "16kb" }));

  router.get("/session", (req, res, next) => {
    void handleSession(req, res).catch(next);
  });

  router.post("/register", (req, res, next) => {
    void handleRegister(req, res).catch(next);
  });

  router.post("/login", (req, res, next) => {
    void handleLogin(req, res).catch(next);
  });

  router.post("/logout", (req, res, next) => {
    void handleLogout(req, res).catch(next);
  });

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) {
      sendError(res, 400, "invalid_input", "The request body is not valid JSON.");
      return;
    }
    next(error);
  });

  return router;

  async function handleSession(req: Request, res: Response): Promise<void> {
    if (!secret) {
      sendError(res, 503, "dependency_unavailable", "Authentication is not configured.");
      return;
    }
    const current = await currentSession(req);
    if (current) {
      await touchSession(pool, current.rawId, now());
      sendSession(res, 200, current.user, current.csrfToken);
      return;
    }
    if (readCookie(req.get("cookie"), SESSION_COOKIE)) {
      res.append("Set-Cookie", clearCookie(SESSION_COOKIE, secure));
    }
    sendSession(res, 200, null, ensureAnonymousCsrf(req, res));
  }

  async function handleRegister(req: Request, res: Response): Promise<void> {
    if (!acceptedMutation(req, res)) return;
    const parsed = registerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_input", "Check the form and try again.", fieldErrors(parsed.error.issues));
      return;
    }
    if (limited(req, res, parsed.data.email)) return;
    const created = await registerClient(pool, parsed.data);
    if (!created.ok) {
      recordAttempt(req, parsed.data.email, false);
      if ("conflict" in created) {
        sendError(res, 409, "email_taken", "An account with this email already exists.", {
          email: ["An account with this email already exists."],
        });
        return;
      }
      sendError(res, 400, "invalid_input", "Check the form and try again.", {
        [created.field]: [created.message],
      });
      return;
    }
    recordAttempt(req, parsed.data.email, true);
    await replaceSession(req, res, created.user.id, 201);
  }

  async function handleLogin(req: Request, res: Response): Promise<void> {
    if (!acceptedMutation(req, res)) return;
    const parsed = loginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, 400, "invalid_input", "Check the form and try again.", fieldErrors(parsed.error.issues));
      return;
    }
    if (limited(req, res, parsed.data.email)) return;
    const account = await authenticate(pool, parsed.data.email, parsed.data.password);
    if (!account) {
      recordAttempt(req, parsed.data.email, false);
      sendError(res, 401, "invalid_credentials", INVALID_CREDENTIALS);
      return;
    }
    recordAttempt(req, parsed.data.email, true);
    await replaceSession(req, res, account.id, 200);
  }

  async function handleLogout(req: Request, res: Response): Promise<void> {
    if (!acceptedMutation(req, res)) return;
    const current = await currentSession(req);
    if (!current) {
      sendError(res, 401, "unauthenticated", "Sign in to continue.");
      return;
    }
    await deleteSession(pool, current.rawId);
    res.append("Set-Cookie", clearCookie(SESSION_COOKIE, secure));
    const token = randomBytes(32).toString("base64url");
    res.append("Set-Cookie", serializeCookie(CSRF_COOKIE, token, secure, ABSOLUTE_SECONDS));
    sendSession(res, 200, null, token);
  }

  function acceptedMutation(req: Request, res: Response): boolean {
    if (!secret) {
      sendError(res, 503, "dependency_unavailable", "Authentication is not configured.");
      return false;
    }
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

  function rateAddress(req: Request): string {
    return authRateKey(
      clientAddress(req, config.trustProxy === "1"),
      req.get(AUTH_PARTITION_HEADER),
      config.fixtureAuthPartition,
    );
  }

  function limited(req: Request, res: Response, email: string): boolean {
    const moment = now().getTime();
    const address = rateAddress(req);
    if (accountLimits.tooMany(accountKey(email), moment) || ipLimits.tooMany(address, moment)) {
      console.error("auth_rate_limited");
      sendError(res, 429, "rate_limited", "Too many attempts. Try again later.");
      return true;
    }
    return false;
  }

  function recordAttempt(req: Request, email: string, succeeded: boolean): void {
    const moment = now().getTime();
    const address = rateAddress(req);
    ipLimits.add(address, moment);
    const key = accountKey(email);
    if (succeeded) accountLimits.clear(key);
    else accountLimits.add(key, moment);
  }

  async function currentSession(req: Request) {
    if (!secret) return null;
    const rawId = readCookie(req.get("cookie"), SESSION_COOKIE);
    if (!rawId) return null;
    return readSession(pool, rawId, secret, now());
  }

  async function replaceSession(req: Request, res: Response, userId: string, status: number): Promise<void> {
    if (!secret) return;
    const previous = readCookie(req.get("cookie"), SESSION_COOKIE);
    const created = await createSession(pool, userId, secret, now());
    if (previous && previous !== created.rawId) await deleteSession(pool, previous);
    res.append("Set-Cookie", clearCookie(CSRF_COOKIE, secure));
    res.append("Set-Cookie", serializeCookie(SESSION_COOKIE, created.rawId, secure, ABSOLUTE_SECONDS));
    sendSession(res, status, created.user, created.csrfToken);
  }

  function ensureAnonymousCsrf(req: Request, res: Response): string {
    const existing = readCookie(req.get("cookie"), CSRF_COOKIE);
    if (existing && existing.length >= 32) return existing;
    const token = randomBytes(32).toString("base64url");
    res.append("Set-Cookie", serializeCookie(CSRF_COOKIE, token, secure, ABSOLUTE_SECONDS));
    return token;
  }
}

function accountKey(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

function fieldErrors(issues: readonly { code: string; path: readonly PropertyKey[]; keys?: readonly string[] }[]): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    if (issue.code === "unrecognized_keys" && issue.keys) {
      for (const key of issue.keys) errors[key] = ["This field is not allowed."];
      continue;
    }
    const key = issue.path[0];
    const name = typeof key === "string" ? key : "request";
    errors[name] = ["This value is not valid."];
  }
  return errors;
}

function sendSession(res: Response, status: number, user: unknown, csrfToken: string): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json(sessionResponseSchema.parse({ data: { user, csrfToken } }));
}

function sendError(res: Response, status: number, code: string, message: string, fields?: Record<string, string[]>): void {
  const error: {
    code: string;
    message: string;
    requestId: string;
    fieldErrors?: Record<string, string[]>;
  } = {
    code,
    message,
    requestId: randomUUID(),
  };
  if (fields && Object.keys(fields).length > 0) error.fieldErrors = fields;
  res.setHeader("Cache-Control", "private, no-store");
  res.status(status).json(errorResponseSchema.parse({ error }));
}
