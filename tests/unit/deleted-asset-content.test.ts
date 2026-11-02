import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { Pool } from "pg";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";
import type { PrivateStorage } from "../../src/server/assets/storage.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const photoId = "33333333-3333-4333-8333-333333333333";
const storageKey = "ab".repeat(32);
const cookie = `hr_demo=${"cd".repeat(32)}`;

test("a photo outside the session is not found and storage is not opened", async () => {
  let opened = false;
  const response = await getPhoto({
    found: false,
    size: async () => {
      opened = true;
      throw new Error("storage should not be opened");
    },
  });
  assert.equal(response.status, 404);
  assert.equal(response.code, "not_found");
  assert.equal(opened, false);
});

test("a missing private file for a session photo is not found", async () => {
  let sizeCalls = 0;
  const response = await getPhoto({
    found: true,
    size: async () => {
      sizeCalls += 1;
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(response.status, 404);
  assert.equal(response.code, "not_found");
  assert.equal(sizeCalls, 1);
});

async function getPhoto(options: {
  found: boolean;
  size: PrivateStorage["size"];
}): Promise<{ status: number; code: string }> {
  const storage: PrivateStorage = {
    async write() {
      throw new Error("unused");
    },
    async remove() {
      throw new Error("unused");
    },
    async exists() {
      return false;
    },
    size: options.size,
    stream() {
      throw new Error("stream should not be opened");
    },
  };
  const pool = {
    async query(sql: string) {
      if (sql.includes("FROM demo_sessions")) {
        return {
          rows: [{
            id: sessionId,
            service: "haircut",
            answers: {},
            likes: [],
            analysis: null,
            analysis_status: "idle",
            analysis_fingerprint: null,
            persona_id: null,
            expires_at: new Date("2027-01-01T00:00:00.000Z"),
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM demo_photos")) {
        return options.found
          ? {
            rows: [{ id: photoId, role: "front", storage_key: storageKey, content_hash: "abc", mime: "image/jpeg" }],
            rowCount: 1,
          }
          : { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as Pool;
  const app = createApp(loadConfig({
    NODE_ENV: "development",
    PROVIDER_MODE: "fixture",
    APP_ORIGIN: "http://127.0.0.1:4173",
    SESSION_SECRET: "integration-session-secret-32chars",
    DATABASE_URL: "postgres://local:local@127.0.0.1:5434/hair_reality",
    PRIVATE_STORAGE_DIR: tmpdir(),
    DELETION_JOURNAL_DIR: tmpdir(),
    DELETION_JOURNAL_MODE: "local",
  }), path.join(tmpdir(), "missing-client-shell"), {
    pool,
    storage,
    now: () => new Date("2026-10-11T12:00:00.000Z"),
  });
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/demo/photos/${photoId}`, {
      headers: { cookie },
    });
    const parsed = JSON.parse(await response.text()) as { error?: { code?: string } };
    return { status: response.status, code: parsed.error?.code ?? "" };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
