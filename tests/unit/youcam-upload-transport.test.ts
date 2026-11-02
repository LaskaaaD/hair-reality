import assert from "node:assert/strict";
import { test } from "node:test";
import { transportReason } from "../../src/server/providers/youcam/client.js";

test("upload transport reason surfaces the undici cause code", () => {
  const error = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  assert.equal(transportReason(error), "TypeError:UND_ERR_CONNECT_TIMEOUT");
  assert.equal(transportReason(new TypeError("fetch failed")), "TypeError");
  assert.equal(transportReason("x"), "error");
});
