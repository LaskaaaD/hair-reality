import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StyleVariant } from "../../domain/knowledge-base.js";
import { catalogueReferenceFile, templateRenderRefused } from "./reference-photo.js";
import { demoMediaRoot } from "./render-cache.js";

/**
 * Picks up to `count` keys in the given order (best Fit first) so that no two share a reference image.
 * `referenceOf` returns the image identity a key renders from, or null for a template render (never a clash).
 * A candidate whose image is already taken is skipped, and the walk goes on down the list.
 */
export function pickDistinctRenderKeys(ordered: readonly string[], count: number, referenceOf: (key: string) => string | null): string[] {
  const keys: string[] = [];
  const taken = new Set<string>();
  for (const key of ordered) {
    if (keys.length >= count) break;
    if (keys.includes(key)) continue;
    const ref = referenceOf(key);
    if (ref !== null && taken.has(ref)) continue;
    if (ref !== null) taken.add(ref);
    keys.push(key);
  }
  return keys;
}

/** The plain-English refusal for two picks that render from one catalogue photo; shared by the server and the picker. */
export function sharedReferenceMessage(first: string, second: string): string {
  return `${first} and ${second} use the same reference photo, so their previews would look identical. Pick one of them.`;
}

/**
 * Best-Fit-first walk for the (up to) `count` renders: colour-changing template styles are never picked, and no two picks
 * share a reference image or a near-duplicate group.
 */
export function pickRenderLooks<T extends { variant: Pick<StyleVariant, "key" | "service" | "affinity" | "reference"> }>(ordered: readonly T[], count: number): T[] {
  const byKey = new Map(ordered.map((look) => [look.variant.key, look]));
  const keys = pickDistinctRenderKeys(
    ordered.filter((look) => !templateRenderRefused(look.variant)).map((look) => look.variant.key),
    count,
    (key) => { const look = byKey.get(key); return look ? referenceIdentity(look.variant) : null; },
  );
  return keys.flatMap((key) => { const look = byKey.get(key); return look ? [look] : []; });
}

/** The first pair of picks (in the given order) that render from the same reference photo, or null. Template renders never clash. */
export function findSharedReference(picks: readonly { title: string; ref: string | null }[]): { first: string; second: string } | null {
  const seen = new Map<string, string>();
  for (const pick of picks) {
    const ref = pick.ref;
    if (ref === null) continue;
    const earlier = seen.get(ref);
    if (earlier) return { first: earlier, second: pick.title };
    seen.set(ref, pick.title);
  }
  return null;
}

const hashes = new Map<string, string>();

/** Reference photos that render near-identical pictures (Textured Caesar vs Textured French crop): one identity, so one pick. */
const NEAR_DUPLICATE_PHOTOS = new Map<string, string>([
  ["style-textured-crop.jpg", "group:crop-caesar-french"],
  ["style-french-crop.jpg", "group:crop-caesar-french"],
]);

/** Identity of the catalogue photo a style renders from: the file's content hash (same picture under two names counts once), else its path. */
export function referenceIdentity(variant: Pick<StyleVariant, "key" | "service" | "affinity" | "reference">): string | null {
  const file = catalogueReferenceFile(variant);
  if (!file) return null;
  const group = NEAR_DUPLICATE_PHOTOS.get(file);
  if (group) return group;
  const cached = hashes.get(file);
  if (cached) return cached;
  const full = path.join(demoMediaRoot(), file);
  const id = existsSync(full) ? `sha1:${createHash("sha1").update(readFileSync(full)).digest("hex")}` : `file:${file}`;
  hashes.set(file, id);
  return id;
}
