import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  downloadProviderArtifact,
  type DownloadResponse,
  type DownloadTarget,
  type DownloadTransport,
  type ResolvedAddress,
} from "../../src/server/assets/download.js";

const allow = ["cdn.example.test"];
const image = await sharp({
  create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
}).png().toBuffer();

test("provider download fails closed without a verified allowlist", async () => {
  const transport = fake("203.0.113.10", ok(image));
  const result = await downloadProviderArtifact({ url: "https://cdn.example.test/a.png", allowlist: [], transport });
  assert.deepEqual(result, { ok: false, reason: "allowlist_empty" });
  assert.equal(transport.resolved, 0);
});

test("provider download rejects user URLs, private DNS, redirects and rebinding", async () => {
  const rejected = await downloadProviderArtifact({
    url: "http://cdn.example.test/a.png",
    allowlist: allow,
    transport: fake("203.0.113.10", ok(image)),
  });
  assert.equal(rejected.ok, false);

  const metadata = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    transport: fake("169.254.169.254", ok(image)),
  });
  assert.deepEqual(metadata, { ok: false, reason: "address_rejected" });

  const rebound = fakeSequence(
    [["203.0.113.10"], ["127.0.0.1"]],
    ok(image),
  );
  const saved = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    transport: rebound,
  });
  assert.equal(saved.ok, true);
  assert.equal(rebound.resolved, 1);
  assert.deepEqual(rebound.opened, ["203.0.113.10"]);

  const redirected = fake("203.0.113.10", {
    status: 302,
    headers: { location: "https://169.254.169.254/latest/meta-data" },
    body: iterate(),
  });
  const followed = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    transport: redirected,
  });
  assert.equal(followed.ok, false);
  assert.equal(redirected.opened.length, 1);

  const oversized = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    maxBytes: 4,
    transport: fake("203.0.113.10", ok(image)),
  });
  assert.deepEqual(oversized, { ok: false, reason: "too_large" });
});

test("provider download times out when the body never arrives", async () => {
  const result = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    timeoutMs: 20,
    transport: fake("203.0.113.10", {
      status: 200,
      headers: {},
      body: {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) };
        },
      },
    }),
  });
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});

test("provider download times out without using a second address", async () => {
  const transport: DownloadTransport = {
    async resolve() {
      return [{ address: "203.0.113.10", family: 4 }];
    },
    open() {
      return new Promise(() => undefined);
    },
  };
  const result = await downloadProviderArtifact({
    url: "https://cdn.example.test/a.png",
    allowlist: allow,
    timeoutMs: 20,
    transport,
  });
  assert.deepEqual(result, { ok: false, reason: "timeout" });
});

function ok(bytes: Buffer): DownloadResponse {
  return { status: 200, headers: {}, body: iterate(bytes) };
}

function iterate(bytes?: Buffer): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      if (bytes) yield bytes;
    },
  };
}

function fake(address: string, response: DownloadResponse): DownloadTransport & { resolved: number; opened: string[] } {
  return fakeSequence([[address]], response);
}

function fakeSequence(
  lookups: string[][],
  response: DownloadResponse,
): DownloadTransport & { resolved: number; opened: string[] } {
  const state = { resolved: 0, opened: [] as string[] };
  return {
    get resolved() {
      return state.resolved;
    },
    opened: state.opened,
    async resolve(): Promise<readonly ResolvedAddress[]> {
      const hop = lookups[Math.min(state.resolved, lookups.length - 1)] ?? [];
      state.resolved += 1;
      return hop.map((address) => ({ address, family: 4 as const }));
    },
    async open(target: DownloadTarget) {
      state.opened.push(target.address);
      return response;
    },
  };
}
