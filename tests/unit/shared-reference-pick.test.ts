process.env.PROVIDER_MODE = "fixture";
process.env.YOUCAM_LIVE_SUBMISSION = "";
process.env.OPENAI_LIVE_SUBMISSION = "";
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSelectedStyleKeys, pickedWithSameReference, sharedReferenceNotice } from "../../src/client/flow/flow-logic.js";
import { loadStyles } from "../../src/domain/knowledge-base.js";
import { findSharedReference, referenceIdentity, sharedReferenceMessage } from "../../src/server/demo/render-pick.js";

const styles = [
  { key: "a", title: "Soft side part", referencePhoto: "sha1:one" },
  { key: "b", title: "Classic side part", referencePhoto: "sha1:one" },
  { key: "c", title: "Short curtains", referencePhoto: "sha1:two" },
  { key: "t1", title: "Template one", referencePhoto: null },
  { key: "t2", title: "Template two" },
];

test("client pick: a style whose reference photo is already picked is blocked with a plain message", () => {
  assert.equal(pickedWithSameReference(styles, ["a"], "b")?.key, "a");
  assert.equal(sharedReferenceNotice(styles, ["a"], "b"), "Classic side part and Soft side part use the same reference photo, so their previews would look identical. Pick one of them.");
  assert.equal(sharedReferenceNotice(styles, ["a"], "c"), null);
  assert.equal(sharedReferenceNotice(styles, [], "b"), null);
});

test("client pick: template renders without a reference photo never clash", () => {
  assert.equal(sharedReferenceNotice(styles, ["t1"], "t2"), null);
  assert.equal(sharedReferenceNotice(styles, ["t1"], "t1"), null);
});

test("client pick: the default picks skip a style that shares a photo with an earlier default", () => {
  assert.deepEqual(defaultSelectedStyleKeys(styles), ["a", "c", "t1"]);
  assert.deepEqual(defaultSelectedStyleKeys([styles[0]!, styles[1]!, styles[2]!]), ["a", "c"]);
});

test("server pick: findSharedReference names the first clashing pair and ignores template renders", () => {
  assert.deepEqual(findSharedReference([{ title: "X", ref: "r1" }, { title: "Y", ref: null }, { title: "Z", ref: null }, { title: "W", ref: "r1" }]), { first: "X", second: "W" });
  assert.equal(findSharedReference([{ title: "X", ref: "r1" }, { title: "Y", ref: "r2" }, { title: "Z", ref: null }]), null);
  assert.match(sharedReferenceMessage("Soft side part", "Classic side part"), /^Soft side part and Classic side part use the same reference photo/);
});

test("server pick: the former shared-photo pairs now have their own photos, so no clash is found", () => {
  const byKey = new Map(loadStyles().map((style) => [style.key, style]));
  const pick = (key: string) => ({ title: byKey.get(key)!.title, ref: referenceIdentity(byKey.get(key)!) });
  const clash = findSharedReference([pick("haircut:side-part--soft-side-part"), pick("haircut:crop--side-swept-textured-crop"), pick("haircut:side-part--classic-side-part")]);
  assert.equal(clash, null);
});
