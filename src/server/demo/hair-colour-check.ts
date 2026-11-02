import sharp from "sharp";

/**
 * YouCam hair transfer can carry the reference photo's hair colour into the render even with `hair_color: "src"`
 * (a black coiled reference gave a brown-haired client black hair). This compares the hair colour the render put on
 * the client with the colour the client had, from the two images alone, so only a drastic mismatch is corrected.
 */

const WIDTH = 192;
const HEIGHT = 256;
/** Summed per-channel difference (0-765) above which a pixel counts as changed by the transfer. */
const CHANGED = 100;
/** Hair sits in the upper part of the portrait; everything below this share of the height is face, neck and clothes. */
const HAIR_BAND = 0.62;
/** Fewer hair pixels than this on either side and no decision is made (bald, buzzed to the skin, no face found). */
const MIN_PIXELS = 150;

export type HairReading = { l: number; a: number; b: number; hex: string; pixels: number };
export type HairColourComparison = { user: HairReading; render: HairReading; dE: number; dL: number };

/**
 * A render is recoloured only when it is drastically off. Measured on one client's real renders (18 styles, brown hair #504035):
 * ordinary shade drift reads dE 2-13 with dL 0 to -7, while the black coiled Caesar render read dE 12.3 and dL -9.1. So a big
 * colour distance alone (blond over brown) counts, and so does a clear lightness drop with a visible colour distance
 * (black over dark brown). The measured values are logged so the limits can be tuned on more clients.
 */
export const RECOLOUR_DELTA_E = 22;
export const RECOLOUR_DARKER_DELTA_L = 8;
export const RECOLOUR_DARKER_DELTA_E = 11;

export function needsRecolour(comparison: HairColourComparison | null): boolean {
  if (!comparison) return false;
  if (comparison.dE >= RECOLOUR_DELTA_E) return true;
  return Math.abs(comparison.dL) >= RECOLOUR_DARKER_DELTA_L && comparison.dE >= RECOLOUR_DARKER_DELTA_E;
}

type Rgb = readonly [number, number, number];

async function raw(image: Buffer): Promise<Buffer> {
  return sharp(image).rotate().resize(WIDTH, HEIGHT, { fit: "fill" }).removeAlpha().raw().toBuffer();
}

/** Skin-tone pixels are not hair. Very light blond falls in this range too, so a blond render gives no decision rather than a wrong one. */
function isSkin(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 80 && cb >= 80 && cb <= 122 && cr >= 138 && cr <= 175;
}

function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function reading(sum: Rgb, pixels: number): HairReading | null {
  if (pixels < MIN_PIXELS) return null;
  const [r, g, b] = [sum[0] / pixels, sum[1] / pixels, sum[2] / pixels];
  const [l, a, bb] = toLab(r, g, b);
  const hex = `#${[r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  return { l, a, b: bb, hex, pixels };
}

/** Mean hair colour of the client before and after the transfer, or null when either image shows too little hair to judge. */
export async function compareHairColour(source: Buffer, render: Buffer): Promise<HairColourComparison | null> {
  const [before, after] = await Promise.all([raw(source), raw(render)]);
  const corner = (x0: number, y0: number): Rgb => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let y = y0; y < y0 + 8; y += 1) for (let x = x0; x < x0 + 8; x += 1) {
      const o = (y * WIDTH + x) * 3;
      r += before[o]!;
      g += before[o + 1]!;
      b += before[o + 2]!;
    }
    return [r / 64, g / 64, b / 64];
  };
  const corners = [corner(2, 2), corner(WIDTH - 10, 2)];
  const wall: Rgb = [0, 1, 2].map((c) => (corners[0]![c]! + corners[1]![c]!) / 2) as unknown as Rgb;
  const isWall = (r: number, g: number, b: number) => Math.abs(r - wall[0]) + Math.abs(g - wall[1]) + Math.abs(b - wall[2]) < 60;
  const userSum: [number, number, number] = [0, 0, 0];
  const renderSum: [number, number, number] = [0, 0, 0];
  let userPixels = 0;
  let renderPixels = 0;
  for (let y = 0; y < Math.round(HEIGHT * HAIR_BAND); y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const o = (y * WIDTH + x) * 3;
      const diff = Math.abs(before[o]! - after[o]!) + Math.abs(before[o + 1]! - after[o + 1]!) + Math.abs(before[o + 2]! - after[o + 2]!);
      if (diff < CHANGED) continue;
      if (!isSkin(before[o]!, before[o + 1]!, before[o + 2]!) && !isWall(before[o]!, before[o + 1]!, before[o + 2]!)) {
        userSum[0] += before[o]!; userSum[1] += before[o + 1]!; userSum[2] += before[o + 2]!; userPixels += 1;
      }
      if (!isSkin(after[o]!, after[o + 1]!, after[o + 2]!) && !isWall(after[o]!, after[o + 1]!, after[o + 2]!)) {
        renderSum[0] += after[o]!; renderSum[1] += after[o + 1]!; renderSum[2] += after[o + 2]!; renderPixels += 1;
      }
    }
  }
  const user = reading(userSum, userPixels);
  const rendered = reading(renderSum, renderPixels);
  if (!user || !rendered) return null;
  const dL = rendered.l - user.l;
  const dE = Math.hypot(dL, rendered.a - user.a, rendered.b - user.b);
  return { user, render: rendered, dE, dL };
}
