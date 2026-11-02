import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { rankingCardDemoFilename } from "../../src/client/flow/ranking-card-media.js";
import { catalogueReferenceFile, renderModeFor, templateRenderRefused } from "../../src/server/demo/reference-photo.js";
import { demoMediaRoot } from "../../src/server/demo/render-cache.js";
import { referenceIdentity } from "../../src/server/demo/render-pick.js";

const MEN_DIR = path.join(demoMediaRoot(), "catalog", "men");
const MAPPING = JSON.parse(readFileSync(path.join(MEN_DIR, "mapping.json"), "utf8")) as Record<string, string>;
const HAIRCUTS = loadStyles().filter((style) => style.service === "haircut");
const MENS = HAIRCUTS.filter((style) => style.affinity !== "feminine");
const OWN_KEYS = Object.keys(MAPPING);

test("round 22: 241 men's styles each have an own photo on disk", () => {
  assert.equal(OWN_KEYS.length, 241);
  assert.equal(new Set(Object.values(MAPPING)).size, 241);
  for (const key of OWN_KEYS) {
    const file = `catalog/men/${MAPPING[key]}`;
    assert.ok(existsSync(path.join(demoMediaRoot(), file)), file);
    assert.equal(rankingCardDemoFilename(key), file, key);
  }
});

test("round 21/22: each of the 241 is a colour-preserving reference render", () => {
  for (const key of OWN_KEYS) {
    const variant = HAIRCUTS.find((style) => style.key === key);
    assert.ok(variant, key);
    assert.equal(renderModeFor(variant), "reference", key);
    assert.equal(templateRenderRefused(variant), false, key);
    assert.equal(catalogueReferenceFile(variant), `catalog/men/${MAPPING[key]}`, key);
  }
});

test("round 21/22: each new photo is its own near-duplicate identity", () => {
  const identities = OWN_KEYS.map((key) => referenceIdentity(HAIRCUTS.find((style) => style.key === key)!));
  assert.ok(identities.every((id) => id !== null && !id.startsWith("group:")));
  assert.equal(new Set(identities).size, 241);
});

test("round 21/22: no men's or unisex style maps to a women's photo", () => {
  for (const style of MENS) {
    const file = rankingCardDemoFilename(style.key);
    if (!file) continue;
    assert.ok(!file.startsWith("catalog/women/") && !file.includes("female_"), `${style.key} -> ${file}`);
  }
});

test("round 22: every men's/unisex style has an own or asset source; none is unrendered or template-only", () => {
  const count = (mode: string) => MENS.filter((style) => renderModeFor(style) === mode).length;
  assert.equal(MENS.length, 263);
  assert.equal(count("none"), 0);
  assert.equal(count("template"), 0);
  assert.equal(count("reference"), 241);
  assert.equal(count("asset"), 22);
});
