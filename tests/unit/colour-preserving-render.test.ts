import assert from "node:assert/strict";
import { test } from "node:test";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { renderModeFor, templateRenderRefused } from "../../src/server/demo/reference-photo.js";
import { pickRenderLooks, referenceIdentity } from "../../src/server/demo/render-pick.js";

const HAIRCUTS = loadStyles().filter((style) => style.service === "haircut");
const look = (key: string) => ({ variant: HAIRCUTS.find((style) => style.key === key)! });
const CAESAR = "haircut:crop--textured-caesar-low-taper";
const FRENCH = "haircut:crop--textured-french-crop-low-taper";
// Since round 23 every real style has an own photo, so the template-only case is a synthetic style with no catalogue photo.
const CURTAINS = "haircut:synthetic--template-only";
const SYNTHETIC = { variant: { ...HAIRCUTS.find((style) => style.reference.kind === "youcam")!, key: CURTAINS } };
const SOFT = "haircut:side-part--soft-side-part";
const IVY = "haircut:crew--ivy-league";

test("colour-safe render: no pick is ever a template source, whatever the order", () => {
  const all = HAIRCUTS.map((variant) => ({ variant }));
  for (const ordered of [all, [...all].reverse()]) {
    for (const picked of pickRenderLooks(ordered, 3)) assert.notEqual(renderModeFor(picked.variant), "template", picked.variant.key);
  }
  assert.equal(all.filter(({ variant }) => renderModeFor(variant) === "template").length, 0);
  assert.equal(renderModeFor(SYNTHETIC.variant), "template");
  assert.deepEqual(pickRenderLooks([SYNTHETIC], 3), []);
});

test("colour-safe render: excluded styles (a template-only style) are never picked", () => {
  assert.equal(templateRenderRefused(SYNTHETIC.variant), true);
  const picks = pickRenderLooks([SYNTHETIC, look(SOFT), look(IVY)], 3).map((p) => p.variant.key);
  assert.deepEqual(picks, [SOFT, IVY]);
  for (const variant of HAIRCUTS.filter(templateRenderRefused)) {
    assert.ok(!pickRenderLooks([{ variant }, look(IVY)], 3).some((p) => p.variant.key === variant.key), variant.key);
  }
});

test("colour-safe render: Textured Caesar and Textured French crop have distinct own photos", () => {
  assert.notEqual(referenceIdentity(look(CAESAR).variant), referenceIdentity(look(FRENCH).variant));
  const picks = pickRenderLooks([look(CAESAR), look(FRENCH), look(SOFT), look(IVY)], 3).map((p) => p.variant.key);
  assert.deepEqual(picks, [CAESAR, FRENCH, SOFT]);
  assert.equal(pickRenderLooks([look(FRENCH), look(CAESAR)], 3).length, 2);
});
