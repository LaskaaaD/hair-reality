import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { RENDER_TIMEOUT_REASON, renderFailureReason } from "../../src/server/demo/render-failure.js";
import { YouCamClient, type YouCamTransport } from "../../src/server/providers/youcam/client.js";

test("every failure code maps to a specific English sentence, never the generic one", () => {
  const codes = ["INVALID_PHOTO", "RETAKE_REQUIRED", "PROVIDER_AUTH", "PROVIDER_QUOTA", "PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_INVALID", "UNSUPPORTED_CONFIGURATION", "SUBMISSION_UNCERTAIN", "RESULT_EXPIRED"];
  const reasons = codes.map((code) => renderFailureReason({ code }));
  for (const reason of reasons) {
    assert.match(reason, /^[A-Z][^.]*\.( [A-Z][^.]*\.)*$/);
    assert.notEqual(reason, "We could not finish this render.");
  }
  assert.equal(new Set(reasons).size >= codes.length - 2, true);
  assert.match(RENDER_TIMEOUT_REASON, /took too long/);
});

test("a failed photo upload reads as a network problem and a photo rejection tells the client what to retake", () => {
  const upload = renderFailureReason({ code: "PROVIDER_UNAVAILABLE", detail: "file_put_transport_TypeError host=yce-us.s3-accelerate.amazonaws.com role=source bytes=86970" });
  assert.match(upload, /network error/);
  assert.match(renderFailureReason({ code: "RETAKE_REQUIRED", providerError: "error_face_angle_leftward" }), /Retake it looking straight/);
  assert.match(renderFailureReason({ code: "INVALID_PHOTO", providerError: "error_no_face" }), /No face was found/);
  assert.match(renderFailureReason({ code: "SUBMISSION_UNCERTAIN" }), /was not sent again/);
});

test("a reference render sends hair_color src so the client keeps their own colour", async () => {
  const posts: Record<string, unknown>[] = [];
  let uploads = 0;
  const transport: YouCamTransport = {
    async request(input) {
      const pathname = new URL(input.url).pathname;
      if (input.method === "PUT") return { status: 200, headers: {}, body: Buffer.from("") };
      if (pathname.includes("/file")) {
        uploads += 1;
        const files = [{ file_id: `synthetic-file-${uploads}`, requests: [{ url: "https://synthetic.youcam.invalid/upload", method: "PUT", headers: {} }] }];
        return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ status: 200, data: { files } })) };
      }
      posts.push(JSON.parse(input.body?.toString() ?? "{}") as Record<string, unknown>);
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ status: 200, data: { task_id: "synthetic-task" } })) };
    },
  };
  const client = new YouCamClient({
    transport,
    baseUrl: "https://api.synthetic.youcam.invalid",
    apiKey: "synthetic-test-key",
    allowlist: ["synthetic.youcam.invalid"],
    callMode: "synthetic",
    resolveHost: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const photo = await sharp({ create: { width: 640, height: 800, channels: 3, background: "#996644" } }).jpeg().toBuffer();
  const result = await client.run({
    capability: "hairstyle",
    photos: [{ role: "source", bytes: photo }],
    controls: {},
    providerTaskId: null,
    now: new Date(),
    submittedAt: null,
    referenceBytes: photo,
  });
  assert.equal(result.kind, "accepted");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.hair_color, "src");
  assert.equal(typeof posts[0]?.ref_file_id, "string");
  assert.equal(posts[0]?.template_id, undefined);
});
