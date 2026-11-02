import assert from "node:assert/strict";
import { test } from "node:test";
import {
  demoMediaPreferredSrc,
  demoMediaSrcSet,
} from "../../src/client/design/demoMedia.js";

test("demoMediaPreferredSrc ignores non-generated width suffixes", () => {
  const src = "/demo-media/sample-front.jpg";
  assert.equal(
    demoMediaPreferredSrc(src, [128, 256]),
    "/demo-media/optimized/sample-front.webp",
  );
  assert.equal(demoMediaPreferredSrc(src, [240, 280]), "/demo-media/optimized/sample-front-240w.webp");
});

test("demoMediaSrcSet falls back to default webp when widths are unknown", () => {
  const src = "/demo-media/sample-left.jpg";
  assert.equal(demoMediaSrcSet(src, [128, 256]), "/demo-media/optimized/sample-left.webp 1x");
});
