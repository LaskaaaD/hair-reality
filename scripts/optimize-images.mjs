#!/usr/bin/env node
/**
 * Generate WebP under public/demo-media/optimized/ plus width variants for srcset.
 * Requires sharp (devDependency). Run: node scripts/optimize-images.mjs
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mediaRoot = path.join(root, "public", "demo-media");
const outRoot = path.join(mediaRoot, "optimized");

/** Relative path from demo-media → max long edge in px (default export). */
const MAX_EDGE = new Map([
  ["sample-front.jpg", 1440],
  ["sample-left.jpg", 640],
  ["sample-right.jpg", 640],
  ["sample-down.jpg", 640],
  ["tryon-textured-crop.jpg", 1440],
  ["tryon-french-crop.jpg", 1440],
  ["style-side-part.jpg", 1280],
  ["style-ivy-league.jpg", 1280],
]);

/** Extra `-{w}w.webp` widths (capped by source dimensions). */
const WIDTH_VARIANTS = [240, 280, 400, 480, 560, 640, 720, 960, 1200, 1440];

const DEFAULT_MAX = 1024;

function listRasterFiles(dir, base = "") {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "optimized") continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRasterFiles(abs, rel));
      continue;
    }
    if (/\.(jpe?g|png)$/i.test(entry.name)) {
      files.push(rel.replace(/\\/g, "/"));
    }
  }
  return files;
}

async function writeWebp(sharp, pipeline, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline.webp({ quality: 82, effort: 4 }).toFile(dest);
}

async function main() {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.error("sharp is not available in node_modules — skip WebP generation");
    process.exit(0);
  }

  mkdirSync(outRoot, { recursive: true });
  const files = listRasterFiles(mediaRoot);
  let written = 0;

  for (const rel of files) {
    const src = path.join(mediaRoot, rel);
    const stem = rel.replace(/\.(jpe?g|png)$/i, "");
    const defaultDest = path.join(outRoot, `${stem}.webp`);
    const maxEdge = MAX_EDGE.get(rel) ?? DEFAULT_MAX;
    const image = sharp(src);
    const meta = await image.metadata();
    const w = meta.width ?? maxEdge;
    const h = meta.height ?? maxEdge;
    const long = Math.max(w, h);

    let basePipeline = image;
    if (long > maxEdge) {
      basePipeline = basePipeline.resize({
        width: w >= h ? maxEdge : undefined,
        height: h > w ? maxEdge : undefined,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    await writeWebp(sharp, basePipeline.clone(), defaultDest);
    written += 1;

    const usableWidths = WIDTH_VARIANTS.filter((target) => target <= Math.max(w, h, maxEdge));
    for (const targetW of usableWidths) {
      const variantDest = path.join(outRoot, `${stem}-${targetW}w.webp`);
      const variantPipeline = sharp(src).resize({
        width: w >= h ? targetW : undefined,
        height: h > w ? targetW : undefined,
        fit: "inside",
        withoutEnlargement: true,
      });
      await writeWebp(sharp, variantPipeline, variantDest);
      written += 1;
    }
  }

  console.log(`optimized ${written} webp files → ${path.relative(root, outRoot)}`);
  if (!existsSync(outRoot)) {
    console.error("optimized output missing");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
