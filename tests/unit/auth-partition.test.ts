import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_IP_ATTEMPTS, authRateKey } from "../../src/server/auth/policy.js";

test("production auth limits stay intact when fixture partitions are separate", () => {
  assert.equal(AUTH_IP_ATTEMPTS, 30);
  assert.equal(authRateKey("127.0.0.1", "abcdef12", false), "127.0.0.1");
  assert.equal(authRateKey("127.0.0.1", "short", true), "127.0.0.1");
  assert.equal(authRateKey("127.0.0.1", undefined, true), "127.0.0.1");
  const left = authRateKey("127.0.0.1", "abcdef12", true);
  const right = authRateKey("127.0.0.1", "abcdef13", true);
  assert.notEqual(left, right);
  assert.notEqual(left, "127.0.0.1");
});
