import { RANKED_STYLES } from "./fixtures.js";

export type PhotoSlots = {
  front?: string;
  right?: string;
  left?: string;
  down?: string;
};

export const MAX_SELECTED_STYLES = 3;

export function canProceedFromPhotos(photos: PhotoSlots, consent: boolean): boolean {
  return Boolean(photos.front && photos.left && photos.right && photos.down) && consent;
}

const REQUIRED_PHOTO_ROLES = ["front", "left", "right", "crown"] as const;

export function canProceedFromServerPhotos(
  photos: readonly { role: string }[],
  consent: boolean,
): boolean {
  return REQUIRED_PHOTO_ROLES.every((role) => photos.some((photo) => photo.role === role)) && consent;
}

export function toggleStyleSelection(selected: string[], styleId: string): string[] {
  if (selected.includes(styleId)) {
    return selected.filter((id) => id !== styleId);
  }
  if (selected.length >= MAX_SELECTED_STYLES) {
    return selected;
  }
  return [...selected, styleId];
}

type PickableStyle = { key: string; title?: string | undefined; family?: string | undefined; referencePhoto?: string | null | undefined; renderable?: boolean | undefined };

/** The picked style that renders from the same reference photo as `key`, or null (template renders have no photo and never clash). */
export function pickedWithSameReference(
  styles: readonly PickableStyle[],
  picked: readonly string[],
  key: string,
): PickableStyle | null {
  const photo = styles.find((style) => style.key === key)?.referencePhoto;
  if (!photo) return null;
  return styles.find((style) => style.key !== key && picked.includes(style.key) && style.referencePhoto === photo) ?? null;
}

/** Plain-English reason a style cannot be added to the picks, or null when it can. */
export function sharedReferenceNotice(
  styles: readonly PickableStyle[],
  picked: readonly string[],
  key: string,
): string | null {
  const other = pickedWithSameReference(styles, picked, key);
  if (!other) return null;
  const title = styles.find((style) => style.key === key)?.title ?? "This style";
  return `${title} and ${other.title ?? "a style you picked"} use the same reference photo, so their previews would look identical. Pick one of them.`;
}

export function defaultSelectedStyleKeys(
  allStyles: readonly PickableStyle[],
): string[] {
  const picked: string[] = [];
  const families = new Set<string>();
  // A style with no colour-safe reference photo (renderable false) is ranked and shown but never pre-picked for a render.
  const styles = allStyles.filter((style) => style.renderable !== false);
  for (const style of styles) {
    const family = style.family ?? style.key.split(":")[0] ?? style.key;
    if (picked.length >= MAX_SELECTED_STYLES) break;
    if (families.has(family) || pickedWithSameReference(styles, picked, style.key)) continue;
    families.add(family);
    picked.push(style.key);
  }
  if (picked.length < MAX_SELECTED_STYLES) {
    for (const style of styles) {
      if (picked.includes(style.key) || pickedWithSameReference(styles, picked, style.key)) continue;
      picked.push(style.key);
      if (picked.length >= MAX_SELECTED_STYLES) break;
    }
  }
  return picked;
}

/** @deprecated use defaultSelectedStyleKeys */
export function defaultSelectedStyleIds(
  styles: readonly { key?: string; family?: string; id?: string }[] = RANKED_STYLES.map((style) => ({
    id: style.id,
    family: style.group,
  })),
): string[] {
  return defaultSelectedStyleKeys(
    styles.map((style) => {
      const entry: { key: string; family?: string } = { key: style.key ?? style.id ?? "" };
      if (style.family) entry.family = style.family;
      return entry;
    }),
  );
}

export function confidenceDots(confidence: number): number {
  if (confidence >= 0.85) return 3;
  if (confidence >= 0.7) return 2;
  return 1;
}
