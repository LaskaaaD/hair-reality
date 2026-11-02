import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BALANCE_MAX_AGE_MS,
  exposureOf,
  fresh,
  leaseDurationMs,
  LEASE_MS,
  openaiCapMicro,
  PRICE_MAX_AGE_MS,
} from "../../src/server/jobs/caps.js";

test("budget arithmetic stays in integers and live timing ignores fixture overrides", () => {
  assert.equal(openaiCapMicro(5), 5_000_000);
  assert.equal(exposureOf({ settled: 10, reserved: 20, uncertain: 30 }), 60);
  assert.equal(leaseDurationMs("live", { JOB_LEASE_MS: "1" }), LEASE_MS);
  assert.equal(leaseDurationMs("fixture", { JOB_LEASE_MS: "1" }), 1);
  const now = new Date("2026-10-11T12:00:00.000Z");
  assert.equal(fresh(new Date(now.getTime() - PRICE_MAX_AGE_MS - 1), now, PRICE_MAX_AGE_MS), false);
  assert.equal(fresh(new Date(now.getTime() - BALANCE_MAX_AGE_MS - 1), now, BALANCE_MAX_AGE_MS), false);
  assert.equal(fresh(now, now, PRICE_MAX_AGE_MS), true);
  assert.throws(() => openaiCapMicro(5.5), /integer/);
});
