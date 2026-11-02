import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";

const root = process.cwd();
const cacheDir = path.resolve(process.env.RENDER_CACHE_DIR?.trim() || "var/render-cache");
const seedDir = path.join(root, "public", "demo-media", "cached-renders");
const sampleFront = path.join(root, "public", "demo-media", "sample-front.jpg");

function slug(candidateKey) {
  return candidateKey.replace(/:/g, "-");
}

async function contentHash(file) {
  const bytes = await readFile(file);
  const normalized = await sharp(bytes, {
    failOn: "error",
    limitInputPixels: 25_000_000,
    animated: false,
    pages: 1,
    sequentialRead: true,
  }).rotate().jpeg().toBuffer();
  return createHash("sha256").update(normalized).digest("hex");
}

async function main() {
  const sampleHash = await contentHash(sampleFront);
  await mkdir(seedDir, { recursive: true });
  const entries = await readdir(cacheDir);
  let copied = 0;
  for (const name of entries) {
    if (!name.endsWith(".jpg")) continue;
    const prefix = `${sampleHash}__`;
    if (!name.startsWith(prefix)) continue;
    const stylePart = name.slice(prefix.length, -".jpg".length);
    const destination = path.join(seedDir, `${stylePart}.jpg`);
    await copyFile(path.join(cacheDir, name), destination);
    copied += 1;
  }
  console.log(`Copied ${copied} sample render(s) into ${path.relative(root, seedDir)}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "seed_render_cache_failed");
  process.exit(1);
});
