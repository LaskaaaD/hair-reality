import { existsSync } from "node:fs";
import path from "node:path";
import { rankingCardDemoFilename } from "../../client/flow/ranking-card-media.js";
import type { StyleVariant } from "../../domain/knowledge-base.js";
import { demoMediaRoot } from "./render-cache.js";

/** Catalogue photos made for exactly one style; the shared `youcam/` template thumbnails are not references. */
const OWN_PHOTO = /^(catalog\/(men|women)\/[a-z0-9-]+\.jpg|style-[a-z0-9-]+\.jpg)$/;

/**
 * The catalogue photo to send to YouCam as `ref_file_id` (hair colour stays the client's), or null when the
 * style has none, the photo's gender does not fit the style, or the file is missing: those use `template_id`.
 */
export function catalogueReferenceFile(variant: Pick<StyleVariant, "key" | "service" | "affinity" | "reference">): string | null {
  if (variant.service !== "haircut" || variant.reference.kind === "asset") return null;
  const file = rankingCardDemoFilename(variant.key);
  if (!file || !OWN_PHOTO.test(file)) return null;
  // A brief-only style (thumbnail unlinked as a mismatch) is renderable only through its own men's/women's photo (rounds 22-23).
  if (variant.reference.kind === "brief" && !file.startsWith("catalog/men/") && !file.startsWith("catalog/women/")) return null;
  const women = file.startsWith("catalog/women/");
  if (women && variant.affinity === "masculine") return null;
  if (!women && variant.affinity === "feminine") return null;
  return existsSync(path.join(demoMediaRoot(), file)) ? file : null;
}

/** Render-cache style id: reference renders never share a file with template renders. */
export function referenceCacheStyle(file: string): string {
  return `ref:${path.basename(file, ".jpg")}`;
}

export function isCatalogueReferenceFile(value: unknown): value is string {
  return typeof value === "string" && OWN_PHOTO.test(value);
}

export type RenderMode = "reference" | "template" | "asset" | "none";

/**
 * How a haircut is sent to YouCam: a catalogue reference photo, its YouCam template, its own asset, or not at all.
 * A style whose reference is only a brief (every style whose thumbnail was unlinked as a mismatch) is never rendered.
 */
export function renderModeFor(variant: Pick<StyleVariant, "key" | "service" | "affinity" | "reference">): RenderMode {
  if (catalogueReferenceFile(variant)) return "reference";
  if (variant.service === "colour") return "none";
  if (variant.reference.kind === "youcam") return "template";
  return variant.reference.kind === "asset" ? "asset" : "none";
}

/**
 * A haircut rendered from a YouCam template takes the template model's hair colour (27 Oct 2026: Short curtains came back
 * blonde). Only reference photos (`ref_file_id` + `hair_color: "src"`) keep the client's own colour, so a haircut whose only
 * source is a template is never rendered. It may still be ranked and shown without a preview. Beard templates do not touch hair.
 */
export function templateRenderRefused(variant: Pick<StyleVariant, "key" | "service" | "affinity" | "reference">): boolean {
  return variant.service === "haircut" && renderModeFor(variant) === "template";
}

export const TEMPLATE_RENDER_REFUSAL = "This style has no colour-safe reference photo, so it is not rendered: a template render would change your hair colour.";
