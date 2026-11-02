import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { downloadHosts, loadConfig } from "../../src/server/config.js";
import { crc32 } from "node:zlib";
import { normalizeImage, MAX_IMAGE_BYTES } from "../../src/server/assets/images.js";
import { readUpload } from "../../src/server/assets/multipart.js";
import { LocalDeletionJournal, parseJournal } from "../../src/server/assets/journal.js";
import { createPrivateStorage, resolvePrivatePath, StorageKeyError } from "../../src/server/assets/storage.js";
import { isBlockedAddress, pinnedLookup } from "../../src/server/assets/download.js";

test("the documented download host is the default and wildcards are rejected", () => {
  const config = loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "fixture" });
  assert.deepEqual(config.providerDownloadHosts, ["yce-us.s3-accelerate.amazonaws.com", "app-cdn.makeupar.com"]);
  assert.equal(config.youcamApiBaseUrl, "https://yce-api-01.makeupar.com");
  assert.deepEqual(downloadHosts("cdn.example.com"), downloadHosts("CDN.Example.com"));
  assert.equal(downloadHosts("*.example.com"), null);
  assert.throws(() => loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    PROVIDER_DOWNLOAD_ALLOWLIST: "*.example.com",
  }), /PROVIDER_DOWNLOAD_ALLOWLIST/);
});

test("private storage rejects traversal and keeps files under the root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hr-storage-"));
  const storage = createPrivateStorage(root);
  assert.throws(() => resolvePrivatePath(root, "../secret"), StorageKeyError);
  assert.throws(() => resolvePrivatePath(root, `${"a".repeat(62)}/b`), StorageKeyError);
  const key = "ab".padEnd(64, "0");
  await storage.write(key, Buffer.from("png"));
  assert.equal(await storage.exists(key), true);
  const resolved = resolvePrivatePath(root, key);
  assert.equal(resolved.startsWith(path.resolve(root)), true);
  assert.equal(resolved.includes("secret"), false);
});

test("normalization rotates jpeg orientation and strips location metadata", async () => {
  const input = await sharp({
    create: { width: 8, height: 4, channels: 3, background: { r: 200, g: 10, b: 10 } },
  }).jpeg().withMetadata({
    orientation: 6,
    exif: { IFD0: { ImageDescription: "secret-location" } },
  }).toBuffer();
  const before = await sharp(input).metadata();
  assert.equal(before.orientation, 6);
  assert.equal(Boolean(before.exif), true);
  const normalized = await normalizeImage(input);
  assert.equal(normalized.width, 4);
  assert.equal(normalized.height, 8);
  assert.equal(normalized.mimeType, "image/jpeg");
  const after = await sharp(normalized.bytes).metadata();
  assert.equal(after.exif, undefined);
  assert.equal(normalized.bytes.includes(Buffer.from("secret-location")), false);
});

test("normalization rejects spoofed, corrupt and oversized images", async () => {
  await assert.rejects(() => normalizeImage(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), /unsupported/);
  await assert.rejects(() => normalizeImage(Buffer.from("GIF89a")), /unsupported/);
  await assert.rejects(() => normalizeImage(Buffer.from([0xff, 0xd8, 0xff, 0x00])), /corrupt/);
  await assert.rejects(() => normalizeImage(Buffer.alloc(MAX_IMAGE_BYTES + 1, 1)), /too_large/);
  await assert.rejects(() => normalizeImage(pngHeader(5_001, 5_000)), /too_many_pixels|corrupt/);
});

test("multipart upload stops before buffering an oversized body", async () => {
  let read = false;
  const result = await readUpload({
    headers: {
      "content-type": "multipart/form-data; boundary=bound",
      "content-length": String(MAX_IMAGE_BYTES + 64 * 1024 + 1),
    },
    resume() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      read = true;
      yield Buffer.from("small");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 413);
  assert.equal(read, false);
});

test("multipart upload rejects an injected field", async () => {
  const extra = multipart(Buffer.from("x"), "current_front", "1", "ownerUserId");
  const result = await readUpload({
    headers: { "content-type": extra.contentType, "content-length": String(extra.body.length) },
    resume() {},
    destroy() {},
    async *[Symbol.asyncIterator]() {
      yield extra.body;
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 400);
});

test("local deletion journal acknowledges idempotently and is not an off-host store", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hr-journal-"));
  const journal = new LocalDeletionJournal(directory);
  const entry = {
    operationId: "4f1b5d8e-6c2a-4e7b-9d11-223344556677",
    resourceId: "8c0a9b11-2233-4455-6677-8899aabbccdd",
    scope: "asset" as const,
    timestamp: "2026-10-10T12:00:00.000Z",
  };
  const first = await journal.append(entry);
  const second = await journal.append(entry);
  assert.equal(second.sequence, first.sequence);
  assert.equal(first.checksum.length, 64);
  const stored = parseJournal(await readFile(path.join(directory, "intents.jsonl"), "utf8"));
  assert.equal(stored.length, 1);
  assert.equal(JSON.stringify(stored).includes("password"), false);
});

test("blocked addresses include loopback, private, link-local and metadata ranges", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.5.4", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress("203.0.113.10"), false);
  const seen: string[] = [];
  pinnedLookup("203.0.113.10", 4)("cdn.example.test", {}, (_error, address) => {
    if (typeof address === "string") seen.push(address);
  });
  assert.deepEqual(seen, ["203.0.113.10"]);
  const all: { address: string }[][] = [];
  pinnedLookup("203.0.113.10", 4)("cdn.example.test", { all: true }, (_error, addresses) => {
    if (Array.isArray(addresses)) all.push(addresses);
  });
  assert.deepEqual(all, [[{ address: "203.0.113.10", family: 4 }]]);
});

function multipart(file: Buffer, role: string, version: string, extraField: string): { body: Buffer; contentType: string } {
  const boundary = "hrtestboundary";
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${extraField}"\r\n\nsecret\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="role"\r\n\r\n${role}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n${version}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\n\r\n`,
    "utf8",
  );
  return {
    body: Buffer.concat([body, file, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function pngHeader(width: number, height: number): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  const type = Buffer.from("IHDR");
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 0);
  const length = Buffer.from([0, 0, 0, 13]);
  return Buffer.concat([signature, length, type, data, checksum]);
}
