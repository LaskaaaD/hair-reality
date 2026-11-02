import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";

test("health is secret-free and an unbuilt shell reports unavailable", async () => {
  const app = createApp(loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "fixture" }), join(tmpdir(), "missing-client-shell"));
  const server = await listen(app);
  try {
    const health = await fetch(`${server.base}/api/v1/health`);
    const healthBody: unknown = await health.json();
    assert.equal(health.status, 200);
    assert.deepEqual(healthBody, { data: { status: "ok" } });
    assert.equal(JSON.stringify(healthBody).includes("postgres"), false);
    assert.equal(JSON.stringify(healthBody).includes("secret"), false);

    const ready = await fetch(`${server.base}/api/v1/ready`);
    const readyBody = await ready.json() as { error: { code: string; requestId: string; message: string } };
    assert.equal(ready.status, 503);
    assert.equal(readyBody.error.code, "dependency_unavailable");
    assert.equal(typeof readyBody.error.requestId, "string");
    assert.equal(JSON.stringify(readyBody).includes("postgres://"), false);
    assert.equal(JSON.stringify(readyBody).includes("127.0.0.1"), false);

    const shell = await fetch(`${server.base}/s/hair-reality-demo`);
    assert.equal(shell.status, 503);
    assert.match(await shell.text(), /not built/);
  } finally {
    await server.close();
  }
});

test("a built client route refreshes to the application shell", async () => {
  const clientDir = await mkdtemp(join(tmpdir(), "hair-reality-client-"));
  await writeFile(join(clientDir, "index.html"), "<!doctype html><div id=\"root\"></div><script type=\"module\" src=\"/assets/main.js\"></script>");
  const app = createApp(loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "fixture" }), clientDir);
  const server = await listen(app);
  try {
    const response = await fetch(`${server.base}/s/hair-reality-demo`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /html/);
    const html = await response.text();
    assert.match(html, /id="root"/);
    assert.match(html, /\/assets\/main\.js/);

    const missingAsset = await fetch(`${server.base}/assets/missing.js`);
    assert.equal(missingAsset.status, 404);

    const unknownApi = await fetch(`${server.base}/api/v1/salons/hair-reality-demo`);
    assert.equal(unknownApi.status, 404);
  } finally {
    await server.close();
  }
});

test("every /demo deep link gets the flow-styled demo shell", async () => {
  const clientDir = await mkdtemp(join(tmpdir(), "hair-reality-client-"));
  await writeFile(join(clientDir, "index.html"), "<!doctype html><style>landing</style><div id=\"root\"></div>");
  await writeFile(join(clientDir, "demo-shell.html"), "<!doctype html><style>flow</style><div id=\"root\" data-hr-demo-shell=\"1\"></div>");
  const app = createApp(loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "fixture" }), clientDir);
  const server = await listen(app);
  try {
    for (const path of ["/demo", "/demo/", "/demo/goal", "/demo/results", "/demo/tryon", "/s/studio-aria", "/brief/abc"]) {
      const response = await fetch(`${server.base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(await response.text(), /<style>flow<\/style>/, path);
    }
    for (const path of ["/", "/demonstration", "/pricing"]) {
      const response = await fetch(`${server.base}${path}`);
      assert.match(await response.text(), /<style>landing<\/style>/, path);
    }
  } finally {
    await server.close();
  }
});

test("readiness does not report ready when the database port is closed", async () => {
  const app = createApp(loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    DATABASE_URL: "postgres://hair_reality:unit-test@127.0.0.1:1/hair_reality",
  }));
  const server = await listen(app);
  try {
    const ready = await fetch(`${server.base}/api/v1/ready`);
    const body = await ready.json() as { error: { code: string } };
    assert.equal(ready.status, 503);
    assert.equal(body.error.code, "dependency_unavailable");
    assert.equal(JSON.stringify(body).includes("unit-test"), false);
  } finally {
    await server.close();
  }
});

function listen(app: ReturnType<typeof createApp>): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Expected a TCP port"));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => {
          server.close((error) => error ? fail(error) : done());
        }),
      });
    });
  });
}
