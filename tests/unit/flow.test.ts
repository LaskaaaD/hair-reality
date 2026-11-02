import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RANKED_STYLES,
  REJECTED_STYLES,
  DEMO_PROFILE,
  RANKING_GROUP_LABELS,
  rankedStyleCardImage,
  youcamMatchForVariant,
} from "../../src/client/flow/fixtures.js";
import {
  canProceedFromPhotos,
  canProceedFromServerPhotos,
  defaultSelectedStyleKeys,
  toggleStyleSelection,
  MAX_SELECTED_STYLES,
} from "../../src/client/flow/flow-logic.js";

test("fixtures expose static presentation catalogue data", () => {
  assert.equal(Object.keys(DEMO_PROFILE).length, 6);
  assert.equal(RANKED_STYLES.length, 16);
  assert.equal(REJECTED_STYLES.length, 3);
  for (const style of RANKED_STYLES) {
    assert.ok(RANKING_GROUP_LABELS[style.group]);
    const cardImage = rankedStyleCardImage(style);
    assert.ok(cardImage.endsWith(".jpg"));
    if (style.catalogVariantId && youcamMatchForVariant(style.catalogVariantId)) {
      assert.ok(cardImage.startsWith("youcam/"));
    }
  }
});

test("photo gate requires all four photos and consent", () => {
  const four = [{ role: "front" }, { role: "left" }, { role: "right" }, { role: "crown" }];
  assert.equal(canProceedFromPhotos({}, false), false);
  assert.equal(canProceedFromPhotos({ front: "data:image/jpeg;base64,x" }, false), false);
  assert.equal(canProceedFromPhotos({ front: "x", left: "x", right: "x", down: "x" }, true), true);
  assert.equal(canProceedFromPhotos({ front: "x", left: "x", right: "x" }, true), false);
  assert.equal(canProceedFromServerPhotos([], true), false);
  assert.equal(canProceedFromServerPhotos([{ role: "front" }], true), false);
  assert.equal(canProceedFromServerPhotos(four.slice(0, 3), true), false);
  assert.equal(canProceedFromServerPhotos(four, false), false);
  assert.equal(canProceedFromServerPhotos(four, true), true);
});

test("selection enforces max three and defaults to top three families", () => {
  const styles = RANKED_STYLES.map((style) => ({ key: style.id, family: style.group }));
  const defaults = defaultSelectedStyleKeys(styles);
  assert.equal(defaults.length, MAX_SELECTED_STYLES);
  const unique = new Set(defaults);
  assert.equal(unique.size, MAX_SELECTED_STYLES);

  let selected = defaults;
  const extra = styles.find((style) => !selected.includes(style.key));
  assert.ok(extra);
  selected = toggleStyleSelection(selected, extra.key);
  assert.deepEqual(selected, defaults);

  const removable = selected[0];
  assert.ok(removable);
  selected = toggleStyleSelection(selected, removable);
  assert.equal(selected.length, 2);
  selected = toggleStyleSelection(selected, extra.key);
  assert.equal(selected.length, 3);
  assert.ok(selected.includes(extra.key));
});
