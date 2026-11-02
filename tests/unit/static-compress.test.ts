import assert from "node:assert/strict";
import { brotliCompressSync } from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import {
  contentTypeForPath,
  negotiatePrecompressedEncoding,
  precompressedSidecarPath,
} from "../../src/server/static-compress.js";

test("negotiatePrecompressedEncoding prefers brotli over gzip", () => {
  assert.equal(negotiatePrecompressedEncoding("gzip, deflate, br"), "br");
  assert.equal(negotiatePrecompressedEncoding("gzip"), "gzip");
  assert.equal(negotiatePrecompressedEncoding("deflate"), null);
  assert.equal(negotiatePrecompressedEncoding(undefined), null);
});

test("precompressedSidecarPath appends the correct extension", () => {
  assert.equal(precompressedSidecarPath("/tmp/main.js", "br"), "/tmp/main.js.br");
  assert.equal(precompressedSidecarPath("/tmp/main.js", "gzip"), "/tmp/main.js.gz");
});

test("contentTypeForPath maps common asset extensions", () => {
  assert.match(contentTypeForPath("main.js"), /javascript/);
  assert.match(contentTypeForPath("styles.css"), /css/);
  assert.match(contentTypeForPath("index.html"), /html/);
});

test("precompressed static serves brotli with Content-Encoding when sidecar exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "hr-static-"));
  const assetDir = join(root, "assets");
  await mkdir(assetDir, { recursive: true });
  const source = "console.log('landing');";
  await writeFile(join(assetDir, "chunk-abc.js"), source);
  await writeFile(join(assetDir, "chunk-abc.js.br"), brotliCompressSync(source));

  const { createPrecompressedStatic } = await import("../../src/server/static-compress.js");
  const app = express();
  app.use(createPrecompressedStatic(assetDir, { immutable: true }));
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("missing");
  });

  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const br = await fetch(`${base}/chunk-abc.js`, { headers: { "Accept-Encoding": "br" } });
    assert.equal(br.status, 200);
    assert.equal(br.headers.get("content-encoding"), "br");
    assert.equal(br.headers.get("vary"), "Accept-Encoding");
    assert.match(br.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await br.text(), source);

    const plain = await fetch(`${base}/chunk-abc.js`, { headers: { "Accept-Encoding": "identity" } });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(await plain.text(), "console.log('landing');");

    const sidecarUrl = await fetch(`${base}/chunk-abc.js.br`);
    assert.equal(sidecarUrl.status, 404);
  } finally {
    await new Promise<void>((done, fail) => {
      server.close((err) => (err ? fail(err) : done()));
    });
  }
});
