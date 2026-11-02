export type Salon = { name: string; color: string };

const STORAGE_KEY = "hr_salon";
export const DEFAULT_SALON_COLOR = "#2f5d50";

export function normaliseSalon(name: string | null | undefined, color: string | null | undefined): Salon | null {
  const cleanName = [...(name ?? "")]
    .filter((char) => char.charCodeAt(0) >= 32 && char !== "<" && char !== ">")
    .join("")
    .trim()
    .slice(0, 40);
  if (!cleanName) return null;
  const cleanColor = color && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : DEFAULT_SALON_COLOR;
  return { name: cleanName, color: cleanColor };
}

export function readSalon(): Salon | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { name, color } = parsed as { name?: unknown; color?: unknown };
    return normaliseSalon(typeof name === "string" ? name : null, typeof color === "string" ? color : null);
  } catch {
    return null;
  }
}

export function writeSalon(salon: Salon): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(salon));
  } catch {
    // private mode: the salon still shows for this page view
  }
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "salon";
}

export function buildSalonLink(origin: string, salon: Salon): string {
  const query = new URLSearchParams({ name: salon.name, color: salon.color });
  return `${origin}/s/${slugify(salon.name)}?${query.toString()}`;
}

/** Readable ink colour (black or white) for text sitting on the salon accent. */
export function inkOn(color: string): string {
  const value = Number.parseInt(color.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#1c1917" : "#faf7f2";
}

export function salonStyleVars(salon: Salon): Record<string, string> {
  return {
    "--hr-accent": salon.color,
    "--hr-accent-hover": salon.color,
    "--hr-accent-ink": salon.color,
    "--hr-success": salon.color,
    "--hr-accent-tint": `color-mix(in srgb, ${salon.color} 14%, white)`,
  };
}
