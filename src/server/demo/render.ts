import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { PERSONA_RENDER_VARIANTS, type PersonaRenderVariant } from "../../shared/persona-render-variants.js";
import { demoStylePreviewFile } from "../../shared/demo-style-preview.js";
import { demoMediaRoot } from "./render-cache.js";

const OUTPUT_W = 960;
const OUTPUT_H = 1200;

function photoRoot(): string {
  return demoMediaRoot();
}

async function loadStockPreview(candidateKey: string): Promise<Buffer | null> {
  const file = demoStylePreviewFile(candidateKey);
  if (!file) return null;
  try {
    return await readFile(path.join(photoRoot(), file));
  } catch {
    return null;
  }
}

const FALLBACK_PERSONA_VARIANTS: readonly PersonaRenderVariant[] = [
  { position: "top", zoom: 1.12, saturation: 0.93 },
  { position: "left top", zoom: 1.14, brightness: 1.03 },
  { position: "right top", zoom: 1.1, saturation: 1.07, brightness: 0.97 },
  { position: "attention", zoom: 1.16, saturation: 0.9, brightness: 1.02 },
  { position: "left", zoom: 1.08, saturation: 1.08 },
  { position: "right", zoom: 1.11, brightness: 0.95 },
];

function resolvePersonaVariant(candidateKey: string): PersonaRenderVariant {
  const known = PERSONA_RENDER_VARIANTS[candidateKey];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < candidateKey.length; i += 1) {
    hash = (hash * 31 + candidateKey.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PERSONA_VARIANTS[hash % FALLBACK_PERSONA_VARIANTS.length]!;
}

async function renderPersonaFromSource(source: Buffer, candidateKey: string): Promise<Buffer> {
  const variant = resolvePersonaVariant(candidateKey);
  const scale = Math.min(1.35, Math.max(1, variant.zoom));
  const innerW = Math.round(OUTPUT_W * scale);
  const innerH = Math.round(OUTPUT_H * scale);
  let pipeline = sharp(source)
    .rotate()
    .resize(innerW, innerH, { fit: "cover", position: variant.position })
    .resize(OUTPUT_W, OUTPUT_H, { fit: "cover", position: variant.position });
  if (variant.brightness !== undefined || variant.saturation !== undefined) {
    pipeline = pipeline.modulate({
      brightness: variant.brightness ?? 1,
      saturation: variant.saturation ?? 1,
    });
  }
  return pipeline.jpeg({ quality: 88 }).toBuffer();
}

export async function renderLookOnPhoto(
  source: Buffer,
  candidateKey: string,
  personaId: string | null = null,
): Promise<Buffer> {
  const mapped = await loadStockPreview(candidateKey);
  if (mapped) {
    return sharp(mapped)
      .rotate()
      .jpeg({ quality: 88 })
      .toBuffer();
  }
  if (personaId) {
    return renderPersonaFromSource(source, candidateKey);
  }
  return sharp(source).rotate().resize(OUTPUT_W, OUTPUT_H, { fit: "cover", position: "attention" }).jpeg({ quality: 88 }).toBuffer();
}
