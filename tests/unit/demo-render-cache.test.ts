import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import sharp from "sharp";
import { advanceDemoJobs } from "../../src/server/demo/jobs.js";
import {
  candidateKeySlug,
  committedRenderSeedFile,
  readRenderCache,
  renderCacheFileName,
  sampleFrontPhotoHash,
  writeRenderCache,
} from "../../src/server/demo/render-cache.js";
import { createPrivateStorage } from "../../src/server/assets/storage.js";
import type { YouCamClient } from "../../src/server/providers/youcam/client.js";

test("render cache keys and committed seed lookup follow the sample front hash", async () => {
  const hash = await sampleFrontPhotoHash();
  const candidateKey = "haircut:male_short_curly";
  const fileName = renderCacheFileName(hash, candidateKey, "male_short_curly");
  assert.match(fileName, new RegExp(`^${hash}__`));
  assert.equal(candidateKeySlug(candidateKey), "haircut-male_short_curly");
  assert.equal(committedRenderSeedFile(candidateKey), path.join(process.cwd(), "public", "demo-media", "cached-renders", "haircut-male_short_curly.jpg"));

  const cacheDir = await mkdtemp(path.join(tmpdir(), "hr-render-cache-"));
  const jpeg = await sharp({ create: { width: 120, height: 150, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  await writeRenderCache({ cacheDir, contentHash: hash, candidateKey, templateId: "male_short_curly", bytes: jpeg });
  const fromDisk = await readRenderCache({ cacheDir, contentHash: hash, candidateKey, templateId: "male_short_curly", samplePhotoHash: hash });
  assert.ok(fromDisk);
});

test("advanceDemoJobs serves cached preview on failure without charging extra storage work", async () => {
  const hash = await sampleFrontPhotoHash();
  const cacheDir = await mkdtemp(path.join(tmpdir(), "hr-render-cache-"));
  const storageRoot = await mkdtemp(path.join(tmpdir(), "hr-demo-store-"));
  const storage = createPrivateStorage(storageRoot);
  const candidateKey = "haircut:male_textured_crop";
  const cachedBytes = await sharp({ create: { width: 200, height: 250, channels: 3, background: "#aa8855" } }).jpeg().toBuffer();
  await writeRenderCache({ cacheDir, contentHash: hash, candidateKey, templateId: "male_textured_crop", bytes: cachedBytes });

  const youcam = {
    run: async () => ({ kind: "failed", code: "PROVIDER_UNAVAILABLE", providerError: "offline" }),
    readResult: async () => null,
  } as unknown as YouCamClient;

  const pool = {
    connect: async () => ({
      query: async () => ({ rows: [] }),
      release: () => undefined,
    }),
    query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("UPDATE demo_jobs SET status = 'running'")) {
        return {
          rows: [{
            id: "job-1",
            session_id: "session-1",
            capability: "hairstyle",
            provider_task_id: null,
            payload: { candidateKey, templateId: "male_textured_crop" },
            storage_key: null,
            submitted_at: new Date(Date.now() - 60_000),
          }],
        };
      }
      if (sql.includes("SELECT content_hash FROM demo_photos")) {
        return { rows: [{ content_hash: hash }] };
      }
      if (sql.includes("UPDATE demo_jobs SET status = 'succeeded'")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE demo_previews SET status = 'ready'")) {
        assert.match(String(values?.[3]), /"source":"cached"/);
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as import("pg").Pool;

  await advanceDemoJobs({
    pool,
    storage,
    youcam,
    now: new Date(),
    renderCacheDir: cacheDir,
    renderJobTimeoutMs: 45_000,
  });
});
