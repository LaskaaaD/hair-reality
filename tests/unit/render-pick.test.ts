import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { pickDistinctRenderKeys, referenceIdentity } from "../../src/server/demo/render-pick.js";

const STYLES = new Map(loadStyles().map((style) => [style.key, style]));
const refOf = (key: string) => { const style = STYLES.get(key); return style ? referenceIdentity(style) : null; };
const SOFT = "haircut:side-part--soft-side-part";
const CLASSIC = "haircut:side-part--classic-side-part";
const SWEPT = "haircut:crop--side-swept-textured-crop";
const CAESAR = "haircut:crop--textured-caesar-low-taper";
const CURTAINS = "haircut:curtains--short-curtains-low-taper";

test("render pick: a candidate whose reference image is already picked is skipped and the walk goes down the list", () => {
  const ref: Record<string, string | null> = { a: "img1", b: "img1", c: "img2", d: null, e: "img2" };
  assert.deepEqual(pickDistinctRenderKeys(["a", "b", "c", "d", "e"], 3, (k) => ref[k] ?? null), ["a", "c", "d"]);
  assert.deepEqual(pickDistinctRenderKeys(["a", "b", "e"], 3, (k) => ref[k] ?? null), ["a", "e"]);
  assert.deepEqual(pickDistinctRenderKeys(["d", "d", "a"], 3, (k) => ref[k] ?? null), ["d", "a"]);
});

test("render pick: template renders (no reference image) never clash with each other", () => {
  assert.deepEqual(pickDistinctRenderKeys(["x", "y", "z", "w"], 3, () => null), ["x", "y", "z"]);
});

test("render pick: Soft/Classic side part and Side-swept crop/Textured Caesar each have their own photo, so the v9 picks give three distinct images", () => {
  assert.ok(refOf(SOFT), "Soft side part renders from a catalogue reference");
  assert.notEqual(refOf(SOFT), refOf(CLASSIC));
  assert.notEqual(refOf(SWEPT), refOf(CAESAR));
  const keys = pickDistinctRenderKeys([SOFT, SWEPT, CLASSIC, CAESAR, CURTAINS], 3, refOf);
  assert.deepEqual(keys, [SOFT, SWEPT, CLASSIC]);
  const images = keys.map(refOf).filter((id) => id !== null);
  assert.equal(new Set(images).size, images.length);
});
