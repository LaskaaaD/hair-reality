import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeImage } from "../assets/images.js";

export type PreviewImageSource = "youcam" | "cached" | "fixture";

export function demoMediaRoot(): string {
  return path.join(process.cwd(), "public", "demo-media");
}

export function committedRenderCacheRoot(): string {
  return path.join(demoMediaRoot(), "cached-renders");
}

/** RENDER_CACHE_BYPASS=1 makes every render-path cache read (readRenderCache: disk and committed seeds) return a miss (a fresh render for a live test); results are still written. Off by default. */
export function renderCacheBypassed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RENDER_CACHE_BYPASS === "1";
}

export function renderCacheDir(configured: string | undefined): string {
  return path.resolve(configured?.trim() || "var/render-cache");
}

export function candidateKeySlug(candidateKey: string): string {
  return candidateKey.replace(/:/g, "-");
}

export function renderCacheFileName(contentHash: string, candidateKey: string, templateId?: string | null): string {
  const styleKey = typeof templateId === "string" && templateId.length > 0 ? templateId : candidateKey;
  return `${contentHash}__${candidateKeySlug(styleKey)}.jpg`;
}

/** Reference renders carry the `ref:` style id (see referenceCacheStyle); template renders never do. */
export function isReferenceStyle(templateId: string | null | undefined): boolean {
  return typeof templateId === "string" && templateId.startsWith("ref:");
}

export function committedRenderSeedFile(candidateKey: string): string {
  return path.join(committedRenderCacheRoot(), `${candidateKeySlug(candidateKey)}.jpg`);
}

let sampleFrontHashPromise: Promise<string> | null = null;

export function sampleFrontPhotoHash(): Promise<string> {
  if (!sampleFrontHashPromise) {
    sampleFrontHashPromise = (async () => {
      const bytes = await readFile(path.join(demoMediaRoot(), "sample-front.jpg"));
      const image = await normalizeImage(bytes);
      return image.contentHash;
    })();
  }
  return sampleFrontHashPromise;
}

export async function readRenderCache(input: {
  cacheDir: string;
  contentHash: string;
  candidateKey: string;
  templateId?: string | null;
  samplePhotoHash?: string | null;
}): Promise<Buffer | null> {
  // Single choke point for every render-path cache read (disk cache and committed sample seeds).
  if (renderCacheBypassed()) return null;
  const diskPath = path.join(input.cacheDir, renderCacheFileName(input.contentHash, input.candidateKey, input.templateId));
  try {
    return await readFile(diskPath);
  } catch {
    // Fall through to committed seed for the sample persona photo hash only.
  }
  if (!input.samplePhotoHash || input.contentHash !== input.samplePhotoHash) return null;
  // Committed seeds are template renders of the sample photo; a reference-mode request must never get one.
  if (isReferenceStyle(input.templateId)) return null;
  try {
    return await readFile(committedRenderSeedFile(input.candidateKey));
  } catch {
    return null;
  }
}

export async function writeRenderCache(input: {
  cacheDir: string;
  contentHash: string;
  candidateKey: string;
  templateId?: string | null;
  bytes: Buffer;
}): Promise<void> {
  const file = path.join(input.cacheDir, renderCacheFileName(input.contentHash, input.candidateKey, input.templateId));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, input.bytes);
}

export async function copyRenderCacheEntry(input: {
  cacheDir: string;
  contentHash: string;
  candidateKey: string;
  templateId?: string | null;
  destinationFile: string;
}): Promise<boolean> {
  const source = path.join(input.cacheDir, renderCacheFileName(input.contentHash, input.candidateKey, input.templateId));
  try {
    await access(source);
    await mkdir(path.dirname(input.destinationFile), { recursive: true });
    await copyFile(source, input.destinationFile);
    return true;
  } catch {
    return false;
  }
}

export function previewSourceFromDetail(detail: unknown): PreviewImageSource | null {
  if (!isRecord(detail) || detail.source === undefined) return null;
  if (detail.source === "youcam" || detail.source === "cached" || detail.source === "fixture") return detail.source;
  return null;
}

export function detailWithSource(source: PreviewImageSource): { source: PreviewImageSource } {
  return { source };
}

export async function cachedPreviewBytes(input: {
  cacheDir: string;
  frontContentHash: string;
  candidateKey: string;
  templateId?: string | null;
}): Promise<Buffer | null> {
  let sampleHash: string | null = null;
  try {
    sampleHash = await sampleFrontPhotoHash();
  } catch {
    sampleHash = null;
  }
  return readRenderCache({
    cacheDir: input.cacheDir,
    contentHash: input.frontContentHash,
    candidateKey: input.candidateKey,
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
    samplePhotoHash: sampleHash,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
