import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { rankingCardDemoFilename } from "../../src/client/flow/ranking-card-media.js";
import { catalogueReferenceFile, renderModeFor, templateRenderRefused } from "../../src/server/demo/reference-photo.js";
import { demoMediaRoot } from "../../src/server/demo/render-cache.js";

const WOMEN_DIR = path.join(demoMediaRoot(), "catalog", "women");
const MAPPING = JSON.parse(readFileSync(path.join(WOMEN_DIR, "mapping.json"), "utf8")) as Record<string, string>;
const HAIRCUTS = loadStyles().filter((style) => style.service === "haircut");
const WOMENS = HAIRCUTS.filter((style) => style.affinity === "feminine");
const MENS = HAIRCUTS.filter((style) => style.affinity !== "feminine");
const OWN_KEYS = Object.keys(MAPPING);

test("round 23: 272 women's mapping entries each resolve to an existing, distinct file", () => {
  assert.equal(OWN_KEYS.length, 272);
  assert.equal(new Set(Object.values(MAPPING)).size, 272);
  for (const key of OWN_KEYS) {
    const file = `catalog/women/${MAPPING[key]}`;
    assert.ok(existsSync(path.join(demoMediaRoot(), file)), file);
    assert.equal(rankingCardDemoFilename(key), file, key);
    assert.equal(HAIRCUTS.find((style) => style.key === key)?.affinity, "feminine", key);
  }
});

test("round 23: every feminine style renders from a photo under catalog/women/", () => {
  assert.equal(WOMENS.length, 279);
  for (const style of WOMENS) {
    assert.ok(rankingCardDemoFilename(style.key)?.startsWith("catalog/women/"), style.key);
    assert.equal(templateRenderRefused(style), false, style.key);
    if (style.reference.kind === "asset") continue; // the 7 committed photos stay asset sources
    assert.equal(renderModeFor(style), "reference", style.key);
    assert.ok(catalogueReferenceFile(style)?.startsWith("catalog/women/"), style.key);
  }
});

test("round 23: no template-only or unrendered feminine style", () => {
  const count = (mode: string) => WOMENS.filter((style) => renderModeFor(style) === mode).length;
  assert.equal(count("template"), 0);
  assert.equal(count("none"), 0);
  assert.equal(count("reference") + count("asset"), 279);
});

test("round 23: no cross-gender photos in either direction", () => {
  for (const style of WOMENS) {
    const file = rankingCardDemoFilename(style.key);
    assert.ok(file && !file.startsWith("catalog/men/"), `${style.key} -> ${file}`);
  }
  for (const style of MENS) {
    const file = rankingCardDemoFilename(style.key);
    if (!file) continue;
    assert.ok(!file.startsWith("catalog/women/") && !file.includes("female_"), `${style.key} -> ${file}`);
    const ref = catalogueReferenceFile(style);
    assert.ok(!ref || !ref.startsWith("catalog/women/"), style.key);
  }
});

test("round 23: men's counts still hold", () => {
  const count = (mode: string) => MENS.filter((style) => renderModeFor(style) === mode).length;
  assert.equal(MENS.length, 263);
  assert.equal(count("reference"), 241);
  assert.equal(count("asset"), 22);
});
