import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The demo job runner is the only hair-transfer submit path; a hairstyle job with no reference photo must fail before YouCam is called.
test("hair-transfer submit path refuses template sources before any YouCam call", () => {
  const source = readFileSync("src/server/demo/jobs.ts", "utf8");
  const guard = source.indexOf('job.capability === "hairstyle" && job.provider_task_id === null && !reference');
  const run = source.indexOf("input.youcam.run(");
  assert.ok(guard > 0 && run > guard, "guard sits before the submit");
  assert.match(source.slice(guard, run), /TEMPLATE_RENDER_REFUSAL[\s\S]*return;/);
});
