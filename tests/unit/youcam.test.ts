import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import { installFixtureNetworkGuard } from "../../src/server/providers/network-guard.js";
import { FACE_ANGLE_ERROR, NO_FACE_ERROR, YouCamClient, acceptedTemplateId, classifyHistoryCharge, classifyTaskError, historyRowMatchesTask, retakeInstruction, settlementFromHistory, storeProviderImage, type YouCamTransport } from "../../src/server/providers/youcam/client.js";
import { FACE_FEATURE_LABELS, faceAttributeUnits, minimumProbeUnits, providerSlotAssets, storageRolesFor, storedRoleForProviderSlot, STYLING_FACE_FEATURES, YOUCAM_CAPABILITIES, youcamLiveBlocker } from "../../src/server/providers/youcam/contract.js";
import { preparePhotos } from "../../src/server/providers/youcam/prepare.js";
import { syntheticStorageKey } from "../../src/server/providers/youcam/runner.js";

const baseUrl = "https://api.synthetic.youcam.invalid";
const allow = ["synthetic.youcam.invalid"];
const apiKey = "synthetic-test-key";
const resolveHost = async () => [{ address: "8.8.8.8", family: 4 as const }];

test("live template ids are catalogue ids and synthetic ids stay in fixture mode", () => {
  assert.equal(acceptedTemplateId("synthetic-template-style", "synthetic"), true);
  assert.equal(acceptedTemplateId("all_shaved", "synthetic"), false);
  assert.equal(acceptedTemplateId("all_shaved", "live"), true);
  assert.equal(acceptedTemplateId("synthetic-template-style", "live"), false);
  assert.equal(acceptedTemplateId("", "live"), false);
  assert.equal(acceptedTemplateId("bad id", "live"), false);
});

test("YouCam adapter maps nine synthetic contracts without network traffic", async () => {
  const restore = installFixtureNetworkGuard();
  try {
    await assert.rejects(fetch("https://docs.perfectcorp.com"), /Blocked outbound provider traffic/);
    const front = await jpeg(320, 340);
    const right = await jpeg(330, 320);
    const left = await jpeg(320, 320);
    const prepared = await preparePhotos("hair-type", [
      { role: "front", bytes: front },
      { role: "right", bytes: right },
      { role: "left", bytes: left },
    ]);
    assert.equal(prepared.ok, true);
    if (prepared.ok) {
      assert.ok(prepared.photos.every((photo) => photo.width === 330 && photo.height === 340));
    }
    assert.equal((await preparePhotos("hair-type", [{ role: "front", bytes: await jpeg(100, 100) }, { role: "right", bytes: right }, { role: "left", bytes: left }])).ok, false);
    assert.equal((await preparePhotos("hair-density", [{ role: "density", bytes: await jpeg(80, 120) }])).ok, false);
    assert.equal((await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(1500, 1500) }])).ok, true);
    assert.equal((await preparePhotos("hairstyle", [{ role: "source", bytes: await png(400, 400) }])).ok, false);
    assert.equal((await preparePhotos("beard", [{ role: "source", bytes: await png(400, 400) }])).ok, false);
    const fittedBeard = await preparePhotos("beard", [{ role: "source", bytes: await jpeg(1024, 800) }]);
    assert.equal(fittedBeard.ok, true);
    if (fittedBeard.ok) {
      const photo = fittedBeard.photos[0];
      assert.ok(photo !== undefined && photo.width <= 1023 && photo.height <= 1023);
    }
    assert.equal((await preparePhotos("hair-length", [{ role: "length", bytes: await jpeg(200, 320) }])).ok, false);
    assert.equal((await preparePhotos("hair-length", [{ role: "length", bytes: await jpeg(320, 320) }])).ok, true);
    assert.equal((await preparePhotos("face-attributes", [{ role: "face", bytes: await jpeg(200, 400) }])).ok, false);
    assert.equal(youcamLiveBlocker("hair-type", allow), null);
    assert.equal(youcamLiveBlocker("beard", allow), null);

    for (const capability of YOUCAM_CAPABILITIES) {
      const calls: string[] = [];
      const client = new YouCamClient({
        transport: scripted(calls, capability),
        baseUrl,
        apiKey,
        allowlist: allow,
        callMode: "synthetic",
        resolveHost,
      });
      const submitted = await client.run({
        capability,
        photos: photosFor(capability, front, right, left),
        controls: controlsFor(capability),
        providerTaskId: null,
        now: new Date("2026-10-11T12:00:00.000Z"),
        submittedAt: null,
      });
      assert.equal(submitted.kind, "accepted", capability);
      assert.equal(calls.filter((call) => call === `POST ${taskPath(capability)}`).length, 1, capability);
      const polled = await client.run({
        capability,
        photos: [],
        controls: {},
        providerTaskId: "synthetic-task",
        now: new Date("2026-10-11T12:00:00.000Z"),
        submittedAt: new Date("2026-10-11T12:00:00.000Z"),
      });
      assert.equal(polled.kind, "succeeded", capability);
      if (polled.kind === "succeeded") {
        assert.equal(JSON.stringify(polled.evidence).includes("http"), false);
        assert.equal(polled.evidence.fixture, "synthetic-documentation-derived");
      }
    }
  } finally {
    restore();
  }
});

test("YouCam adapter rejects unsafe controls, bad responses and failed transfers", async () => {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const client = clientWith(async (input) => {
    calls.push({ method: input.method, url: input.url, headers: input.headers });
    if (input.url.includes("/task/")) throw new Error("ambiguous");
    if (input.method === "PUT") {
      assert.equal(input.headers.authorization, undefined);
      assert.equal(JSON.stringify(input.headers).includes(apiKey), false);
      return { status: 500, headers: {}, body: Buffer.from("") };
    }
    return json({
      status: 200,
      data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: { "x-upload": "1" } }] }] },
    });
  });
  const density = await client.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(density.kind, "failed");
  assert.equal(calls.some((call) => call.url.includes("/task/")), false);

  const prompted = await client.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: { prompt: "make it thicker" },
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(prompted.kind, "failed");

  const expired = await client.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date("2026-10-12T13:00:00.000Z"),
    submittedAt: new Date("2026-10-11T12:00:00.000Z"),
  });
  assert.equal(expired.kind, "failed");
  if (expired.kind === "failed") assert.equal(expired.code, "RESULT_EXPIRED");

  const resumeCalls: string[] = [];
  const resume = clientWith(async (input) => {
    resumeCalls.push(input.method);
    assert.equal(input.method, "GET");
    return json({ status: 200, data: { task_status: "running" } });
  });
  const running = await resume.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date("2026-10-11T12:10:00.000Z"),
    submittedAt: new Date("2026-10-11T12:00:00.000Z"),
  });
  assert.equal(running.kind, "running");
  assert.deepEqual(resumeCalls, ["GET"]);

  const uncertainCalls: string[] = [];
  const uncertain = clientWith(async (input) => {
    uncertainCalls.push(`${input.method} ${new URL(input.url).pathname}`);
    if (input.url.includes("/task/")) throw new Error("socket reset");
    if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
    return json({
      status: 200,
      data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }] },
    });
  });
  const ambiguous = await uncertain.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(ambiguous.kind, "uncertain");
  assert.equal(uncertainCalls.filter((call) => call.includes("/task/")).length, 1);

  const blocked = new YouCamClient({
    transport: { request: () => { throw new Error("live transport"); } },
    baseUrl,
    apiKey,
    allowlist: allow,
    callMode: "live",
  });
  const live = await blocked.run({
    capability: "hair-type",
    photos: [],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(live.kind, "failed");
    assert.equal(youcamLiveBlocker("hair-color", allow), null);
    const conservative = await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(1600, 1000) }]);
    assert.equal(conservative.ok, true);
    const square = await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(1800, 1800) }]);
    assert.equal(square.ok, true);
    if (square.ok) {
      assert.ok(square.photos[0] && square.photos[0].width <= 1919 && square.photos[0].height <= 1079);
      assert.ok(square.photos[0].width >= 320 && square.photos[0].height >= 320);
    }
    const wide = await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(1920, 720) }]);
    assert.equal(wide.ok, true);
    const portrait = await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(1000, 3000) }]);
    assert.equal(portrait.ok, true);
    if (portrait.ok && portrait.photos[0]) {
      const ratio = portrait.photos[0].width / portrait.photos[0].height;
      assert.ok(Math.abs(ratio - (1000 / 3000)) < 0.02);
    }
    assert.equal((await preparePhotos("hair-color", [{ role: "source", bytes: await jpeg(4000, 80) }])).ok, false);
});

test("hairstyle and beard template pages use the verified template identifier", async () => {
  const calls: string[] = [];
  const client = clientWith(async (input) => {
    calls.push(input.url);
    return json({
      status: 200,
      data: {
        templates: [{ id: "good_template_001", title: "Example", thumb: "https://synthetic.youcam.invalid/thumb" }],
        next_token: null,
      },
    });
  });
  const listed = await client.discoverTemplates();
  assert.equal(listed.complete, true);
  assert.deepEqual(listed.items, [{ id: "good_template_001", title: "Example", thumb: "https://synthetic.youcam.invalid/thumb" }]);
  assert.match(calls[0] ?? "", /\/s2s\/v2\.1\/task\/template\/hair-transfer\?page_size=20$/);
  const beard = await client.discoverBeardTemplates();
  assert.equal(beard.complete, false);
  assert.equal(beard.reason, "page_invalid");
  assert.match(calls[1] ?? "", /\/s2s\/v2\.0\/task\/template\/beard-style\?page_size=20$/);
});

test("beard templates parse only the observed account fields", async () => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/youcam/beard-templates.json", import.meta.url), "utf8")) as {
    documentationSchema: string;
    response: { status: number; data: { templates: { id: string }[] } };
  };
  assert.equal(fixture.documentationSchema, "absent");
  const listed = clientWith(async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(fixture.response)) }));
  const beard = await listed.discoverBeardTemplates();
  assert.equal(beard.complete, true);
  assert.equal(beard.items.length, 15);
  assert.equal(beard.items[0]?.id, "all_shaved");
  const changed = structuredClone(fixture.response);
  const first = changed.data.templates[0];
  if (!first) return;
  Object.assign(first, { keep_users_color: false });
  const rejected = clientWith(async () => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(changed)) }));
  const result = await rejected.discoverBeardTemplates();
  assert.equal(result.complete, false);
  assert.equal(result.reason, "page_invalid");
  const identifierOnly = clientWith(async () => json({ status: 200, data: { templates: [{ id: "all_shaved" }], next_token: null } }));
  const incomplete = await identifierOnly.discoverBeardTemplates();
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.reason, "page_invalid");
});

test("photograph roles stay distinct and the face probe uses the silhouette tier", () => {
  assert.deepEqual(storageRolesFor("hair-type"), ["current_front", "current_right", "current_left"]);
  assert.deepEqual(storageRolesFor("hair-frizziness"), ["current_front", "current_right", "current_left"]);
  assert.deepEqual(storageRolesFor("hair-density"), ["current_density"]);
  assert.deepEqual(storageRolesFor("hair-length"), ["current_length"]);
  assert.deepEqual(storageRolesFor("face-attributes"), ["current_face"]);
  assert.deepEqual(storageRolesFor("facial-color-tones"), ["current_face"]);
  assert.deepEqual(storageRolesFor("hair-color"), ["current_front"]);
  assert.deepEqual(storageRolesFor("hairstyle"), ["current_front"]);
  assert.deepEqual(storageRolesFor("beard"), ["beard"]);
  assert.equal(storageRolesFor("hair-density").includes("current_back"), false);
  assert.equal(storageRolesFor("hair-type").includes("current_side"), false);
  assert.deepEqual(STYLING_FACE_FEATURES, ["faceShape", "faceAspectRatio", "horizontalThird", "verticalFifth"]);
  assert.ok(STYLING_FACE_FEATURES.every((feature) => (FACE_FEATURE_LABELS as readonly string[]).includes(feature)));
  assert.equal((STYLING_FACE_FEATURES as readonly string[]).includes("eyeShape"), false);
  assert.equal(faceAttributeUnits(STYLING_FACE_FEATURES.length), 10);
  assert.equal(minimumProbeUnits(), 42);
});

test("hair-type provider slots follow the successful v4 image-relative order", async () => {
  const frontHash = "hash-synthetic-front";
  const leftHash = "hash-synthetic-left";
  const rightHash = "hash-synthetic-right";
  const assets = [
    { id: "front-asset", role: "current_front", contentHash: frontHash },
    { id: "anatomical-right", role: "current_right", contentHash: rightHash },
    { id: "anatomical-left", role: "current_left", contentHash: leftHash },
  ];
  const assigned = providerSlotAssets("hair-type", assets);
  assert.deepEqual(assigned?.map((item) => item.slot), ["front", "right", "left"]);
  assert.equal(assigned?.[0]?.asset.id, "front-asset");
  assert.equal(assigned?.[1]?.asset.id, "anatomical-left");
  assert.equal(assigned?.[1]?.asset.contentHash, leftHash);
  assert.equal(assigned?.[2]?.asset.id, "anatomical-right");
  assert.equal(assigned?.[2]?.asset.contentHash, rightHash);
  assert.equal(assets.find((asset) => asset.role === "current_right")?.id, "anatomical-right");
  assert.equal(assets.find((asset) => asset.role === "current_left")?.id, "anatomical-left");
  assert.equal(storedRoleForProviderSlot("hair-type", "right"), "current_left");
  assert.equal(storedRoleForProviderSlot("hair-type", "left"), "current_right");
  assert.equal(providerSlotAssets("hair-frizziness", assets)?.[1]?.asset.id, "anatomical-left");
  assert.equal(storedRoleForProviderSlot("hair-length", "length"), "current_length");
  assert.equal(storedRoleForProviderSlot("hairstyle", "source"), "current_front");
  assert.equal(storedRoleForProviderSlot("beard", "source"), "beard");
});

test("YouCam account reads stay incomplete when a page or amount is not usable", async () => {
  let costPage = 0;
  const costs = clientWith(async (input) => {
    costPage += 1;
    if (costPage === 1) {
      return json({ status: 200, result: { next_token: "next", skus: [{ run_task_url: "https://example.invalid/task", amount: 2, unit: "result_image", proc_unit: 1 }] } });
    }
    assert.equal(new URL(input.url).searchParams.get("starting_token"), "next");
    throw new Error("page failed");
  });
  const inventory = await costs.listFeatureCosts();
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.items, []);

  const balance = clientWith(async () => json({ status: 200, results: [{ amount_dec: 10.04, type: "ApiPaygToken" }] }));
  const units = await balance.readBalance();
  assert.equal(units.ok, false);

  const auth = clientWith(async () => json({ status: 401, error_code: "InvalidApiKey" }));
  const denied = await auth.readBalance();
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.code, "PROVIDER_AUTH");

  const quota = clientWith(async () => json({ status: 400, error_code: "CreditInsufficiency" }));
  const limited = await quota.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(limited.kind, "failed");
  if (limited.kind === "failed") assert.equal(limited.code, "PROVIDER_QUOTA");

  const rate = clientWith(async () => json({ status: 429, error: "Too many requests" }));
  const throttled = await rate.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(throttled.kind, "failed");
  if (throttled.kind === "failed") assert.equal(throttled.code, "PROVIDER_RATE_LIMIT");

  const retake = clientWith(async () => json({ status: 200, data: { task_status: "error", error: "error_face_angle_invalid" } }));
  const again = await retake.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(again.kind, "failed");
  if (again.kind === "failed") assert.equal(again.code, "RETAKE_REQUIRED");

  const fixture = JSON.parse(await readFile(path.resolve("tests/fixtures/youcam/task-errors.json"), "utf8")) as {
    faceAngle: Record<string, unknown>;
    noFace: Record<string, unknown>;
    unknown: Record<string, unknown>;
  };
  const angle = await clientWith(async (input) => {
    assert.equal(input.headers["content-type"], "application/json");
    return json(fixture.faceAngle);
  }).run({
    capability: "hair-type",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(angle.kind, "failed");
  if (angle.kind === "failed") {
    assert.equal(angle.code, "RETAKE_REQUIRED");
    assert.equal(retakeInstruction(angle.providerError ?? "", storageRolesFor("hair-type")), `Retake current_front, current_right, current_left. Keep a front-facing head within 10° of the camera. For a side view, turn more than 15° rather than a near-full profile.`);
  }
  const missingFace = await clientWith(async () => json(fixture.noFace)).run({
    capability: "hair-density",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(missingFace.kind, "failed");
  if (missingFace.kind === "failed") {
    assert.equal(missingFace.code, "INVALID_PHOTO");
    assert.match(retakeInstruction(missingFace.providerError ?? "", storageRolesFor("hair-density")) ?? "", /current_density/);
  }
  const unrecognized = await clientWith(async () => json(fixture.unknown)).run({
    capability: "hair-type",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(unrecognized.kind, "failed");
  if (unrecognized.kind === "failed") {
    assert.equal(unrecognized.code, "PROVIDER_RESPONSE_INVALID");
    assert.equal(retakeInstruction(unrecognized.providerError ?? "", storageRolesFor("hair-type")), null);
  }
  assert.equal(classifyTaskError(FACE_ANGLE_ERROR), "RETAKE_REQUIRED");
  assert.equal(classifyTaskError(NO_FACE_ERROR), "INVALID_PHOTO");
  assert.equal(classifyHistoryCharge(true, [
    { action: "api_hair_type_detection", units: -2 },
    { action: "api_hair_type_detection_failed", units: 2 },
  ]).outcome, "not_billed");
  assert.deepEqual(classifyHistoryCharge(true, [{ action: "api_hair_length_detection", units: -2 }]), { outcome: "billed", units: 2 });
  assert.equal(classifyHistoryCharge(false, [{ action: "api_hair_type_detection", units: -2 }]).outcome, "unresolved");
  assert.equal(classifyHistoryCharge(true, []).outcome, "unresolved");
  assert.equal(classifyHistoryCharge(true, [
    { action: "api_hair_type_detection", units: -2 },
    { action: "api_hair_type_detection_failure", units: 2 },
  ]).outcome, "unresolved");

  const history = clientWith(async () => json({
    status: 200,
    result: {
      history: [{
        action: "api_hair_length_detection",
        target_id: "task-1:122239387970",
        info: { credits: [{ amount_dec: -2 }] },
      }],
    },
  }));
  const listed = await history.listUsage();
  assert.equal(listed.complete, true);
  assert.equal(listed.items[0]?.targetId, "task-1:122239387970");
  assert.equal(historyRowMatchesTask("task-10:122", "task-1"), false);
  assert.equal(historyRowMatchesTask("task-1:12a", "task-1"), false);
  assert.deepEqual(settlementFromHistory("task-1", listed), { kind: "billed", units: 2 });
  assert.deepEqual(settlementFromHistory("task-1", { complete: false, items: listed.items }), { kind: "reservation" });
  assert.deepEqual(settlementFromHistory("missing", listed), { kind: "reservation" });
  assert.deepEqual(settlementFromHistory("old-task", {
    complete: true,
    items: [
      { action: "api_hair_type_detection", targetId: "old-task:1", units: -2 },
      { action: "api_hair_type_detection_failed", targetId: "old-task:1", units: 2 },
    ],
  }), { kind: "not_billed" });

  const missing = clientWith(async () => json({ status: 400, error_code: "InvalidTaskId" }));
  const gone = await missing.run({
    capability: "hair-length",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(gone.kind, "failed");
  if (gone.kind === "failed") assert.equal(gone.code, "RESULT_EXPIRED");

  const malformed = clientWith(async () => json({ status: 200, data: { task_status: "success" } }));
  const broken = await malformed.run({
    capability: "hair-type",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(broken.kind, "failed");
  if (broken.kind === "failed") assert.equal(broken.code, "PROVIDER_RESPONSE_INVALID");

  const unknown = clientWith(async () => json({
    status: 200,
    data: { task_status: "success", results: { hair_type: { mapping: "not-a-range", term: "not-a-term" } } },
  }));
  const parsed = await unknown.run({
    capability: "hair-type",
    photos: [],
    controls: {},
    providerTaskId: "known-task",
    now: new Date(),
    submittedAt: new Date(),
  });
  assert.equal(parsed.kind, "succeeded");
  if (parsed.kind === "succeeded") assert.deepEqual(parsed.evidence.unknown, ["mapping", "term"]);

  const redirect = clientWith(async (input) => {
    if (input.method === "PUT") return { status: 302, headers: { location: "https://evil.example/collect" }, body: Buffer.from("") };
    return json({
      status: 200,
      data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: { authorization: `Bearer ${apiKey}` } }] }] },
    });
  });
  const redirected = await redirect.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(redirected.kind, "failed");

  const opaque = clientWith(async (input) => {
    if (input.url.includes("/task/")) return { status: 200, headers: {}, body: Buffer.from("{}") };
    if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
    return json({
      status: 200,
      data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }] },
    });
  });
  const unnamed = await opaque.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(unnamed.kind, "uncertain");

  const serverError = clientWith(async (input) => {
    if (input.url.includes("/task/")) return json({ status: 500, error_code: "TaskTimeout", data: { task_id: "maybe" } });
    if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
    return json({
      status: 200,
      data: { files: [{ file_id: "synthetic-file", requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }] },
    });
  });
  const timedOut = await serverError.run({
    capability: "hair-density",
    photos: [{ role: "density", bytes: await jpeg(120, 120) }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
  });
  assert.equal(timedOut.kind, "uncertain");
});

test("generated YouCam bytes are stored privately", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hr-youcam-"));
  const storage = createPrivateStorage(root);
  const pngBytes = await png(8, 8);
  const stored = await storeProviderImage({
    url: "https://synthetic.youcam.invalid/result.png",
    allowlist: allow,
    storage,
    key: syntheticStorageKey("result"),
    transport: {
      async resolve() {
        return [{ address: "8.8.8.8", family: 4 }];
      },
      async open() {
        return { status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield pngBytes; })() };
      },
    },
  });
  assert.equal(stored.ok, true);
  if (stored.ok) {
    assert.equal(JSON.stringify(stored.evidence).includes("http"), false);
    assert.equal(await storage.exists(syntheticStorageKey("result")), true);
  }
  const rejected = await storeProviderImage({
    url: "https://evil.example/result.png",
    allowlist: allow,
    storage,
    key: syntheticStorageKey("rejected"),
    transport: { async resolve() { return [{ address: "8.8.8.8", family: 4 }]; }, async open() { throw new Error("no"); } },
  });
  assert.equal(rejected.ok, false);
});

function clientWith(request: YouCamTransport["request"]): YouCamClient {
  return new YouCamClient({ transport: { request }, baseUrl, apiKey, allowlist: allow, callMode: "synthetic", resolveHost });
}

function scripted(calls: string[], capability: string): YouCamTransport {
  return {
    async request(input) {
      const pathname = new URL(input.url).pathname;
      calls.push(`${input.method} ${pathname}`);
      if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
      if (input.method === "POST" && pathname.includes("/file")) {
        const uploaded = JSON.parse(input.body?.toString() ?? "{}") as { files?: { content_type?: string; file_name?: string }[] };
        assert.equal(uploaded.files?.[0]?.content_type, "image/jpg");
        assert.match(uploaded.files?.[0]?.file_name ?? "", /\.jpg$/);
        return json({
          status: 200,
          data: { files: [{ file_id: `synthetic-file-${calls.length}`, requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }] },
        });
      }
      if (input.method === "POST") {
        const body = JSON.parse(input.body?.toString() ?? "{}") as Record<string, unknown>;
        assert.equal(JSON.stringify(body).includes("prompt"), false);
        assert.equal(pathname, taskPath(capability));
        return json({ status: 200, data: { task_id: "synthetic-task" } });
      }
      return json(successBody(capability));
    },
  };
}

function taskPath(capability: string): string {
  const paths: Record<string, string> = {
    "hair-type": "/s2s/v2.0/task/hair-type-detection",
    "hair-length": "/s2s/v2.0/task/hair-length-detection",
    "hair-density": "/s2s/v2.0/task/hair-density-detection",
    "hair-frizziness": "/s2s/v2.0/task/hair-frizziness-detection",
    "face-attributes": "/s2s/v2.0/task/face-attr-analysis",
    "facial-color-tones": "/s2s/v2.0/task/skin-tone-analysis",
    hairstyle: "/s2s/v2.1/task/hair-transfer",
    "hair-color": "/s2s/v2.0/task/hair-color",
    beard: "/s2s/v2.0/task/beard-style",
  };
  const pathName = paths[capability];
  if (!pathName) throw new Error(capability);
  return pathName;
}

test("sanitized live export keeps the status error and drops personal payloads", async () => {
  const raw = await readFile(path.resolve("tests/fixtures/youcam/live-capability-export.json"), "utf8");
  assert.equal(/https?:\/\//.test(raw), false);
  assert.equal(raw.includes("@"), false);
  assert.equal(/bearer |api[_-]?key/i.test(raw), false);
  const fixture = JSON.parse(raw) as {
    provenance: string;
    youcamStatusError: { body: { status: number; data: Record<string, unknown> } };
    storedResultShapes: Record<string, unknown>;
  };
  assert.equal(fixture.provenance, "live-rows-and-status-reads-2026-10-11");
  const data = fixture.youcamStatusError.body.data;
  assert.deepEqual(Object.keys(data).sort(), ["error", "error_message", "results", "task_status"]);
  assert.equal(data.results, null);
  assert.equal(data.task_status, "error");
  assert.equal(data.error, data.error_message);
  assert.equal(classifyTaskError(String(data.error)), "RETAKE_REQUIRED");
  assert.equal("index" in data, false);
  assert.equal(fixture.storedResultShapes["hair-type"], undefined);
  assert.equal(fixture.storedResultShapes["hair-frizziness"], undefined);
});

function successBody(capability: string): Record<string, unknown> {
  if (capability === "hair-type") return { status: 200, data: { task_status: "success", results: { hair_type: { mapping: "3a to 3b", term: "Loose to Medium Curls" } } } };
  if (capability === "hair-length") return { status: 200, data: { task_status: "success", results: { hair_length: { term: "long hair" } } } };
  if (capability === "hair-density") return { status: 200, data: { task_status: "success", results: { hair_density: { mapping: "2.16", term: "Low Density" } } } };
  if (capability === "hair-frizziness") return { status: 200, data: { task_status: "success", results: { hair_frizziness: { mapping: 1, term: "Slightly Frizzy" } } } };
  if (capability === "face-attributes") {
    return { status: 200, data: { task_status: "success", results: { faceshape: "Oval", facialratio: { horizontal_third: [33, 33, 33] }, eyebrow: { gap: "Average" }, color: { hair_color_name: "Brown" }, agegender: { age: 30, gender: "unknown" } } } };
  }
  if (capability === "facial-color-tones") {
    return { status: 200, data: { task_status: "success", results: { color: { skin_color: "#b9947c", hair_color_name: "Brown", eye_color_name: "Brown", eyebrow_color: "#5B2B31", lip_color: "#D23245", hair_color: "#42280E", eye_color: "#293F9B" } } } };
  }
  if (capability === "hair-color") return { status: 200, data: { task_status: "success", results: { url: "https://synthetic.youcam.invalid/result" } } };
  return { status: 200, url: "https://synthetic.youcam.invalid/result" };
}

function photosFor(capability: string, front: Buffer, right: Buffer, left: Buffer): { role: string; bytes: Buffer }[] {
  if (capability === "hair-type" || capability === "hair-frizziness") {
    return [{ role: "front", bytes: front }, { role: "right", bytes: right }, { role: "left", bytes: left }];
  }
  const role = capability === "hair-density" ? "density" : capability === "hair-length" ? "length" : capability === "face-attributes" || capability === "facial-color-tones" ? "face" : "source";
  return [{ role, bytes: capability === "hair-color" ? front : left }];
}

function controlsFor(capability: string): Record<string, unknown> {
  if (capability === "face-attributes") return { features: ["faceShape"] };
  if (capability === "hairstyle" || capability === "beard") return { template_id: "synthetic-template-style" };
  if (capability === "hair-color") return { preset: "Jet Black" };
  return {};
}

function json(body: Record<string, unknown>): { status: number; headers: Record<string, string>; body: Buffer } {
  return { status: Number(body.status ?? 200), headers: {}, body: Buffer.from(JSON.stringify(body)) };
}

function jpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#888888" } }).jpeg().toBuffer();
}

function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#888888" } }).png().toBuffer();
}
