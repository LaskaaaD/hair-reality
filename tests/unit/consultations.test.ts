import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createConsultationSchema,
  draftUpdateSchema,
  missingRequirements,
  serviceInputFingerprint,
  sortServiceKinds,
} from "../../src/shared/consultations.js";

test("service selection rejects empty, duplicate and unknown values", () => {
  assert.equal(createConsultationSchema.safeParse({ salonId: "00000000-0000-4000-8000-000000000001", services: [] }).success, false);
  assert.equal(createConsultationSchema.safeParse({ salonId: "00000000-0000-4000-8000-000000000001", services: ["haircut", "haircut"] }).success, false);
  assert.equal(createConsultationSchema.safeParse({ salonId: "00000000-0000-4000-8000-000000000001", services: ["highlights"] }).success, false);
  assert.equal(createConsultationSchema.safeParse({
    salonId: "00000000-0000-4000-8000-000000000001",
    services: ["beard"],
    clientUserId: "00000000-0000-4000-8000-000000000002",
    lifecycle: "SUBMITTED",
  }).success, false);
  assert.equal(draftUpdateSchema.safeParse({
    expectedVersion: 1,
    services: ["colour"],
    salonId: "00000000-0000-4000-8000-000000000001",
  }).success, false);
});

test("all seven non-empty service combinations are accepted", () => {
  const combinations = [
    ["haircut"],
    ["colour"],
    ["beard"],
    ["haircut", "colour"],
    ["haircut", "beard"],
    ["colour", "beard"],
    ["haircut", "colour", "beard"],
  ];
  for (const services of combinations) {
    const parsed = createConsultationSchema.safeParse({
      salonId: "00000000-0000-4000-8000-000000000001",
      services,
    });
    assert.equal(parsed.success, true);
  }
  assert.deepEqual(sortServiceKinds(["beard", "haircut"]), ["haircut", "beard"]);
});

test("readiness stays incomplete until every required fact is current", () => {
  const gaps = missingRequirements([{
    kind: "beard",
    hasTarget: false,
    hasPriorities: false,
    hasCurrentAssessment: false,
    hasCurrentPreview: false,
  }]);
  assert.deepEqual(gaps.map((gap) => gap.requirement), ["target", "priorities", "assessment", "preview"]);
  assert.equal(gaps.some((gap) => gap.message.toLowerCase().includes("scalp")), false);
  assert.deepEqual(missingRequirements([{
    kind: "colour",
    hasTarget: true,
    hasPriorities: true,
    hasCurrentAssessment: false,
    hasCurrentPreview: true,
  }]).map((gap) => gap.requirement), ["assessment"]);
  assert.deepEqual(missingRequirements([{
    kind: "haircut",
    hasTarget: true,
    hasPriorities: true,
    hasCurrentAssessment: true,
    hasCurrentPreview: true,
  }]), []);
  assert.equal(serviceInputFingerprint("service-id", 2), "service:service-id:v2");
});
