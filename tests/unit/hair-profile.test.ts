import assert from "node:assert/strict";
import { test } from "node:test";
import { hairProfileSchema } from "../../src/shared/hair-profile.js";
import { assembleHairProfile, type HairProfileInput, type ProfileAsset, type ProfileJob, type ProfileObservation } from "../../src/server/profiles/hair-profile.js";

const front = "11111111-1111-4111-8111-111111111111";
const right = "22222222-2222-4222-8222-222222222222";
const left = "33333333-3333-4333-8333-333333333333";
const length = "44444444-4444-4444-8444-444444444444";
const newerLength = "55555555-5555-4555-8555-555555555555";
const density = "66666666-6666-4666-8666-666666666666";

test("hair profile keeps provider ranges and hides fixture results from a real consultation", () => {
  const profile = assembleHairProfile(input({
    presentation: "real",
    services: ["haircut", "colour"],
    assets: triplet().concat([photo(length, "current_length"), photo(density, "current_density")]),
    observations: [
      observed("hair-type", "youcam", [front, right, left], { mapping: "3a to 3b", term: "Loose to Medium Curls" }),
      observed("hair-length", "youcam", [length], { term: "ear length or longer" }),
      observed("hair-density", "youcam", [density], { term: "Medium Density", mapping: "1.74" }),
      observed("hair-frizziness", "fixture", [front, right, left], { term: "Not Frizzy", mapping: 0 }),
    ],
  }));
  hairProfileSchema.parse({ data: profile });
  const type = slot(profile, "hair-type");
  assert.equal(type.status, "current");
  assert.equal(type.value?.label, "Loose to Medium Curls");
  assert.deepEqual(type.value?.range, { kind: "categories", from: "3a", to: "3b", openEnded: false });
  const lengthSlot = slot(profile, "hair-length");
  assert.equal(lengthSlot.value?.label, "ear length or longer");
  assert.equal(lengthSlot.value?.range?.openEnded, true);
  assert.equal(lengthSlot.value?.range?.from, "ear length");
  assert.equal(lengthSlot.value?.range?.to, null);
  const densitySlot = slot(profile, "hair-density");
  assert.equal(densitySlot.value?.label, "Medium Density");
  assert.equal(densitySlot.value?.providerMapping, "1.74");
  assert.equal(typeof densitySlot.value?.providerMapping, "string");
  assert.equal(densitySlot.value?.range, null);
  const frizz = slot(profile, "hair-frizziness");
  assert.equal(frizz.status, "unknown");
  assert.equal(frizz.source, null);
  assert.equal(frizz.value, null);
  assert.equal(frizz.nextAction, "stylist_review");
  assert.deepEqual(profile.schedule, ["hair-frizziness"]);
  assert.equal(JSON.stringify(profile).includes("cm"), false);
  assert.equal(containsNumber(profile), false);
});

test("fixture observations stay labelled fixture and a changed photo drops only the affected result", () => {
  const stored = assembleHairProfile(input({
    presentation: "fixture",
    services: ["haircut"],
    assets: triplet().concat([photo(length, "current_length"), photo(density, "current_density")]),
    observations: [
      observed("hair-type", "fixture", [front, right, left], { mapping: "1 to 2a", term: "Straight to Slight Wavy" }),
      observed("hair-length", "youcam", [length], { term: "above the ears" }),
    ],
    jobs: [failed("hair-density", [density], "RETAKE_REQUIRED")],
  }));
  assert.equal(slot(stored, "hair-type").source, "fixture");
  assert.equal(slot(stored, "hair-length").status, "current");
  assert.equal(slot(stored, "hair-density").status, "retake");
  assert.equal(slot(stored, "hair-density").value, null);
  assert.equal(stored.schedule.includes("hair-type"), false);
  assert.equal(stored.schedule.includes("hair-length"), false);
  assert.equal(stored.schedule.includes("hair-density"), false);

  const replaced = assembleHairProfile(input({
    presentation: "fixture",
    services: ["haircut"],
    assets: triplet().concat([
      photo(length, "current_length", "2026-10-11T10:00:00.000Z"),
      photo(newerLength, "current_length", "2026-10-11T11:00:00.000Z"),
      photo(density, "current_density"),
    ]),
    observations: [
      observed("hair-type", "fixture", [front, right, left], { mapping: "1 to 2a", term: "Straight to Slight Wavy" }),
      observed("hair-length", "youcam", [length], { term: "above the ears" }),
    ],
    jobs: [failed("hair-length", [length], "RETAKE_REQUIRED", "2026-10-11T10:30:00.000Z")],
  }));
  assert.equal(slot(replaced, "hair-length").status, "unknown");
  assert.equal(slot(replaced, "hair-length").value, null);
  assert.equal(JSON.stringify(slot(replaced, "hair-length")).includes("above the ears"), false);
  assert.equal(slot(replaced, "hair-type").status, "current");
  assert.deepEqual(replaced.schedule, ["hair-length", "hair-density", "hair-frizziness"]);
});

test("a later retake keeps the successful observation and beard-only does not schedule density", () => {
  const kept = assembleHairProfile(input({
    presentation: "real",
    services: ["haircut"],
    assets: triplet().concat([photo(length, "current_length"), photo(density, "current_density")]),
    observations: [observed("hair-frizziness", "youcam", [front, right, left], { term: "Slightly Frizzy", mapping: 1 })],
    jobs: [failed("hair-frizziness", [front, right, left], "RETAKE_REQUIRED", "2026-10-11T12:00:00.000Z")],
  }));
  assert.equal(slot(kept, "hair-frizziness").status, "current");
  assert.equal(slot(kept, "hair-frizziness").value?.label, "Slightly Frizzy");
  assert.equal(kept.schedule.includes("hair-frizziness"), false);

  const beard = assembleHairProfile(input({
    presentation: "real",
    services: ["beard"],
    assets: [photo(density, "current_density")],
  }));
  assert.deepEqual(beard.schedule, []);
  assert.equal(slot(beard, "hair-density").required, false);
  assert.equal(slot(beard, "hair-density").nextAction, "none");

  const conflict = assembleHairProfile(input({
    presentation: "real",
    services: ["haircut"],
    assets: triplet(),
    observations: [observed("hair-frizziness", "youcam", [front, right, left], { term: "Frizzy", mapping: 0 })],
  }));
  assert.equal(slot(conflict, "hair-frizziness").status, "unknown");
  assert.equal(slot(conflict, "hair-frizziness").uncertainty, "conflicting provider labels");
  assert.equal(conflict.schedule.includes("hair-frizziness"), false);

  const missing = assembleHairProfile(input({
    presentation: "real",
    services: ["haircut"],
    assets: triplet(),
  }));
  assert.equal(slot(missing, "hair-density").status, "unknown");
  assert.equal(slot(missing, "hair-density").nextAction, "stylist_review");
  assert.equal(missing.schedule.includes("hair-density"), false);
});

function input(overrides: Partial<HairProfileInput> & Pick<HairProfileInput, "presentation" | "services">): HairProfileInput {
  return {
    assets: [],
    observations: [],
    jobs: [],
    ...overrides,
  };
}

function triplet(): ProfileAsset[] {
  return [photo(front, "current_front"), photo(right, "current_right"), photo(left, "current_left")];
}

function photo(id: string, role: string, createdAt = "2026-10-11T10:00:00.000Z"): ProfileAsset {
  return { id, role, deleted: false, createdAt };
}

function observed(capability: string, source: string, inputAssetIds: string[], values: Record<string, unknown>): ProfileObservation {
  return {
    capability,
    source,
    values,
    uncertainty: null,
    observedAt: "2026-10-11T10:05:00.000Z",
    inputAssetIds,
  };
}

function failed(capability: string, sourceAssetIds: string[], errorCode: string, createdAt = "2026-10-11T10:06:00.000Z"): ProfileJob {
  return { capability, state: "FAILED", errorCode, mode: "live", sourceAssetIds, createdAt };
}

function slot(profile: ReturnType<typeof assembleHairProfile>, capability: string) {
  const found = profile.slots.find((item) => item.capability === capability);
  if (!found) throw new Error(`Missing ${capability}`);
  return found;
}

function containsNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.some((item) => containsNumber(item));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsNumber(item));
  return false;
}
