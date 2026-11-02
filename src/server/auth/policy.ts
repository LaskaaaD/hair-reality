import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { safeNextPath } from "../../shared/redirect.js";

export { safeNextPath };

export const SESSION_COOKIE = "hr_session";
export const CSRF_COOKIE = "hr_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const AUTH_ACCOUNT_FAILURES = 8;
export const AUTH_IP_ATTEMPTS = 30;
export const AUTH_PARTITION_HEADER = "x-hair-reality-auth-partition";
export const AUTH_WINDOW_MS = 15 * 60 * 1000;

const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export function normalizeEmail(value: string): string | null {
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  if (normalized.length > 254 || !EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

export function originAllowed(origin: string | undefined, appOrigin: string): boolean {
  return origin === appOrigin;
}

export function authRateKey(address: string, partition: string | undefined, enabled: boolean): string {
  if (!enabled || partition === undefined || !/^[A-Za-z0-9]{8,64}$/.test(partition)) return address;
  return `${address}\n${partition}`;
}

export function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const hops = typeof forwarded === "string"
      ? forwarded.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "")
      : [];
    const addedByProxy = hops[hops.length - 1];
    if (addedByProxy) return addedByProxy;
  }
  return request.socket.remoteAddress ?? "unknown";
}

export function secureCookies(appOrigin: string): boolean {
  return new URL(appOrigin).protocol === "https:";
}

export function serializeCookie(name: string, value: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

export function csrfTokenForSession(secret: string, sessionId: string): string {
  return createHmac("sha256", secret).update(sessionId).digest("base64url");
}

export function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
