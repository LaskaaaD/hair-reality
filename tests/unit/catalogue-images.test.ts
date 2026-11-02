import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rankingCardImage } from "../../src/client/flow/flow-mappers.js";
import { allHaircutCatalogueKeys, rankingCardDemoFilename } from "../../src/client/flow/ranking-card-media.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";

const root = process.cwd();
const catalogue = JSON.parse(readFileSync(join(root, "src", "shared", "haircuts.catalogue.json"), "utf8")) as {
  families: { variants: { id: string; affinity: string }[] }[];
};
const variants = catalogue.families.flatMap((family) => family.variants);

test("the haircut catalogue has 542 styles and each has its own photo on disk", () => {
  assert.equal(variants.length, 542);
  assert.equal(variants.filter((variant) => variant.affinity === "masculine").length, 263);
  assert.equal(variants.filter((variant) => variant.affinity === "feminine").length, 279);
  assert.equal(allHaircutCatalogueKeys().length, 542);

  const seen = new Map<string, string>();
  for (const variant of variants) {
    const key = `haircut:${variant.id}`;
    const file = rankingCardDemoFilename(key);
    assert.ok(file, `${key} has no photo`);
    const folder = variant.affinity === "feminine" ? "catalog/women/" : "catalog/men/";
    assert.ok(file.startsWith(folder), `${key} uses ${file}, expected ${folder}`);
    assert.ok(existsSync(join(root, "public", "demo-media", file)), `${key}: ${file} is missing on disk`);
    assert.equal(seen.has(file), false, `${key} shares ${file} with ${seen.get(file)}`);
    seen.set(file, key);
  }
});

test("every catalogue card resolves to its own photo, never a placeholder", () => {
  for (const variant of variants) {
    const key = `haircut:${variant.id}`;
    const card = { key, title: variant.id, imageUrl: null, affinity: variant.affinity } as unknown as Parameters<typeof rankingCardImage>[0];
    const image = rankingCardImage(card);
    assert.equal(image.kind, "demo", `${key} resolved to ${image.kind}`);
    assert.equal(image.kind === "demo" ? image.filename : "", rankingCardDemoFilename(key));
  }
});

test("the haircut ranking pool is exactly the 542 catalogue styles", () => {
  const pool = loadStyles().filter((entry) => entry.service === "haircut");
  assert.equal(pool.length, 542);
  assert.deepEqual(new Set(pool.map((entry) => entry.key)), new Set(variants.map((variant) => `haircut:${variant.id}`)));
});

test("the LLM catalogue describes all 542 styles and matches the haircut catalogue", () => {
  const llm = JSON.parse(readFileSync(join(root, "src", "shared", "haircuts.llm.json"), "utf8")) as {
    count: number;
    styles: { key: string; description: string; gender: string; image: string; suitsFaceShapes: string[]; avoidFaceShapes: string[]; hairTypes: string[] }[];
  };
  assert.equal(llm.count, 542);
  assert.equal(llm.styles.length, 542);
  assert.deepEqual(new Set(llm.styles.map((style) => style.key)), new Set(variants.map((variant) => `haircut:${variant.id}`)));
  for (const style of llm.styles) {
    assert.ok(style.description.length > 40, `${style.key} has no description`);
    assert.ok(style.hairTypes.length > 0, `${style.key} has no hair types`);
    assert.equal(style.image, rankingCardDemoFilename(style.key), `${style.key} image differs from the media index`);
    assert.equal(style.suitsFaceShapes.some((shape) => style.avoidFaceShapes.includes(shape)), false, `${style.key} suits and avoids one shape`);
  }
  const first = loadStyles().find((entry) => entry.service === "haircut");
  assert.ok(first);
});
