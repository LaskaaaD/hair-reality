import assert from "node:assert/strict";
import { test } from "node:test";
import { registerRequestSchema } from "../../src/shared/auth.js";
import { safeNextPath } from "../../src/shared/redirect.js";
import {
  clientAddress,
  csrfTokenForSession,
  originAllowed,
  secureCookies,
  serializeCookie,
  tokensMatch,
} from "../../src/server/auth/policy.js";
import { AttemptWindow } from "../../src/server/auth/rate-limit.js";

test("authentication policy rejects open redirects, foreign origins and spoofed addresses", () => {
  assert.equal(safeNextPath("/account"), "/account");
  assert.equal(safeNextPath("/account?tab=profile"), "/account?tab=profile");
  assert.equal(safeNextPath("//evil.example"), null);
  assert.equal(safeNextPath("/\\evil.example"), null);
  assert.equal(safeNextPath("https://evil.example"), null);
  assert.equal(safeNextPath("/account/../../etc"), null);

  assert.equal(originAllowed("http://127.0.0.1:4173", "http://127.0.0.1:4173"), true);
  assert.equal(originAllowed("https://evil.example", "http://127.0.0.1:4173"), false);
  assert.equal(originAllowed(undefined, "http://127.0.0.1:4173"), false);

  const local = httpRequest("127.0.0.1", "203.0.113.10");
  const proxied = httpRequest("10.0.0.8", "203.0.113.10, 198.51.100.4");
  assert.equal(clientAddress(local, false), "127.0.0.1");
  assert.equal(clientAddress(proxied, false), "10.0.0.8");
  assert.equal(clientAddress(proxied, true), "198.51.100.4");

  assert.equal(secureCookies("http://127.0.0.1:4173"), false);
  assert.match(serializeCookie("hr_session", "abc", false, 60), /HttpOnly/);
  assert.equal(serializeCookie("hr_session", "abc", false, 60).includes("Secure"), false);
  assert.match(serializeCookie("hr_session", "abc", true, 60), /Secure/);
  assert.equal(serializeCookie("hr_session", "abc", true, 60).includes("SameSite=Lax"), true);

  const token = csrfTokenForSession("session-secret-value-32-characters", "raw-session");
  assert.equal(tokensMatch(token, csrfTokenForSession("session-secret-value-32-characters", "raw-session")), true);
  assert.equal(tokensMatch(token, "different"), false);
});

test("registration rejects privileged fields", () => {
  const rejected = registerRequestSchema.safeParse({
    email: "client@example.com",
    password: "a-long-password",
    displayName: "Client",
    role: "admin",
    memberships: [{ salonId: "x", role: "stylist" }],
  });
  assert.equal(rejected.success, false);
});

test("authentication attempts recover after the time window", () => {
  const window = new AttemptWindow(2, 1_000);
  assert.equal(window.tooMany("account", 0), false);
  window.add("account", 0);
  window.add("account", 10);
  assert.equal(window.tooMany("account", 20), true);
  assert.equal(window.tooMany("account", 1_010), false);
  window.clear("account");
  assert.equal(window.tooMany("account", 1_010), false);
});

function httpRequest(remoteAddress: string, forwardedFor: string): import("node:http").IncomingMessage {
  return {
    socket: { remoteAddress },
    headers: { "x-forwarded-for": forwardedFor },
  } as unknown as import("node:http").IncomingMessage;
}
