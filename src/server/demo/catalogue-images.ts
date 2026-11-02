import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { StyleCandidate } from "../../domain/catalogue.js";

type Thumb = Pick<StyleCandidate, "key" | "title" | "swatch">;

const KEY_PATTERN = /^(haircut|beard|colour):[A-Za-z0-9 _-]{1,80}$/;

export function catalogueRoot(): string {
  return path.resolve(process.env.HAIR_REALITY_CATALOGUE_DIR ?? path.join("var", "catalogue"));
}

export function catalogueFile(key: string): string | null {
  if (!KEY_PATTERN.test(key)) return null;
  return path.join(catalogueRoot(), `${key.replaceAll(":", "__")}.jpg`);
}

export async function readCatalogueImage(key: string): Promise<Buffer | null> {
  const file = catalogueFile(key);
  if (!file) return null;
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

export async function publishThumb(candidate: Thumb & { assetFile?: string | null }): Promise<void> {
  const dest = catalogueFile(candidate.key);
  if (candidate.assetFile && dest && /^[a-z0-9-]+\.jpg$/.test(candidate.assetFile)) {
    try {
      const source = path.join(process.cwd(), "assets", "references", candidate.assetFile);
      await access(source);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, await readFile(source));
      return;
    } catch {
      // Fall back to the labelled fixture thumb when the reference file is not on disk yet.
    }
  }
  await ensureFixtureThumb(candidate);
}

export function referenceAssetExists(file: string): boolean {
  if (!/^[a-z0-9-]+\.jpg$/.test(file)) return false;
  return existsSync(path.join(process.cwd(), "assets", "references", file));
}

export async function ensureFixtureThumb(candidate: Thumb): Promise<void> {
  const file = catalogueFile(candidate.key);
  if (!file) return;
  try {
    await access(file);
    return;
  } catch {
    // A missing file is the normal fixture case.
  }
  await mkdir(path.dirname(file), { recursive: true });
  const colour = candidate.swatch ?? "#8a6244";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="480" height="640" viewBox="0 0 480 640" xmlns="http://www.w3.org/2000/svg">
  <rect width="480" height="640" fill="#1b1613"/>
  <ellipse cx="240" cy="250" rx="150" ry="170" fill="${xml(colour)}"/>
  <ellipse cx="240" cy="310" rx="78" ry="96" fill="#d7b39a"/>
  <rect x="190" y="390" width="100" height="70" fill="#2a241f"/>
  <text x="240" y="520" text-anchor="middle" fill="#f6f1ea" font-size="28" font-family="Georgia, serif">${xml(candidate.title)}</text>
</svg>`;
  await writeFile(file, await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer());
}

export function personaDirectory(personaId: string): string | null {
  if (personaId !== "jordan" && personaId !== "maya" && personaId !== "adrian" && personaId !== "nina") return null;
  return path.join(catalogueRoot(), "personas", personaId);
}

export async function personaHasLooks(personaId: string): Promise<boolean> {
  const directory = personaDirectory(personaId);
  if (!directory) return false;
  try {
    const names = await readdir(directory);
    return names.some((name) => name.endsWith(".jpg"));
  } catch {
    return false;
  }
}

export async function readPersonaLook(personaId: string, key: string): Promise<Buffer | null> {
  const directory = personaDirectory(personaId);
  const file = catalogueFile(key);
  if (!directory || !file) return null;
  try {
    return await readFile(path.join(directory, path.basename(file)));
  } catch {
    return null;
  }
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;");
}
