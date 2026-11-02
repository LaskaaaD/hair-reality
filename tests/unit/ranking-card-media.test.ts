import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  allHaircutCatalogueKeys,
  rankingCardDemoFilename,
} from "../../src/client/flow/ranking-card-media.js";

const demoMediaRoot = path.join(process.cwd(), "public", "demo-media");

test("catalogue lists every haircut key and mapped files exist on disk", () => {
  const keys = allHaircutCatalogueKeys();
  assert.equal(keys.length, 542);
  let mapped = 0;
  for (const key of keys) {
    const filename = rankingCardDemoFilename(key);
    if (!filename) continue;
    mapped += 1;
    const absolute = path.join(demoMediaRoot, ...filename.split("/"));
    assert.ok(existsSync(absolute), `demo-media file missing for ${key}: ${filename}`);
  }
  assert.ok(mapped >= 200);
  assert.ok(mapped <= keys.length);
});

test("ranking card media maps known keys to YouCam or catalog assets", () => {
  assert.equal(rankingCardDemoFilename("haircut:male_textured_crop"), "catalog/men/male-textured-crop.jpg");
  assert.equal(rankingCardDemoFilename("haircut:messy-taper"), "catalog/men/messy-taper.jpg");
  assert.equal(
    rankingCardDemoFilename("haircut:two-block--classic-two-block"),
    "catalog/men/two-block--classic-two-block.jpg",
  );
  assert.equal(rankingCardDemoFilename("haircut:some-unknown-style"), null);
});
