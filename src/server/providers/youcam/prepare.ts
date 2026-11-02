import sharp from "sharp";
import { ImageRejected, normalizeImage, type NormalizedImage } from "../../assets/images.js";
import type { PhotoRole, YouCamCapability } from "./contract.js";

export type PreparedPhoto = {
  role: PhotoRole;
  bytes: Buffer;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
};

export type PrepareFailure = "invalid_photo" | "unsupported_configuration";

const LIMITS: Record<YouCamCapability, { minSide: number | null; maxSide: number | null; maxWidth: number | null; maxHeight: number | null }> = {
  "hair-type": { minSide: 320, maxSide: 4096, maxWidth: null, maxHeight: null },
  "hair-length": { minSide: 320, maxSide: 4096, maxWidth: null, maxHeight: null },
  "hair-density": { minSide: 100, maxSide: 4096, maxWidth: null, maxHeight: null },
  "hair-frizziness": { minSide: 320, maxSide: 4096, maxWidth: null, maxHeight: null },
  "face-attributes": { minSide: 320, maxSide: 4096, maxWidth: null, maxHeight: null },
  "facial-color-tones": { minSide: 320, maxSide: 4096, maxWidth: null, maxHeight: null },
  hairstyle: { minSide: null, maxSide: 1024, maxWidth: null, maxHeight: null },
  "hair-color": { minSide: 320, maxSide: null, maxWidth: 1919, maxHeight: 1079 },
  beard: { minSide: null, maxSide: 1023, maxWidth: null, maxHeight: null },
};

export async function preparePhotos(
  capability: YouCamCapability,
  photos: readonly { role: string; bytes: Buffer }[],
): Promise<{ ok: true; photos: PreparedPhoto[] } | { ok: false; reason: PrepareFailure }> {
  const normalized: PreparedPhoto[] = [];
  for (const photo of photos) {
    if (!isRole(photo.role)) return { ok: false, reason: "unsupported_configuration" };
    let image: NormalizedImage;
    try {
      image = await normalizeImage(photo.bytes);
    } catch (error) {
      if (error instanceof ImageRejected) return { ok: false, reason: "invalid_photo" };
      throw error;
    }
    if (image.mimeType === "image/webp") return { ok: false, reason: "invalid_photo" };
    if ((capability === "hairstyle" || capability === "beard") && image.mimeType !== "image/jpeg") {
      return { ok: false, reason: "invalid_photo" };
    }
    const limited = await fitLimits(capability, image);
    if (!limited) return { ok: false, reason: "invalid_photo" };
    normalized.push({ role: photo.role, ...limited });
  }
  if (capability === "hair-type" || capability === "hair-frizziness") {
    const equalized = await equalize(normalized);
    if (!equalized) return { ok: false, reason: "invalid_photo" };
    return { ok: true, photos: equalized };
  }
  return { ok: true, photos: normalized };
}

async function fitLimits(
  capability: YouCamCapability,
  image: NormalizedImage,
): Promise<Omit<PreparedPhoto, "role"> | null> {
  const limits = LIMITS[capability];
  let width = image.width;
  let height = image.height;
  let bytes = image.bytes;
  let mimeType = image.mimeType;
  const boxWidth = limits.maxWidth;
  const boxHeight = limits.maxHeight;
  if ((boxWidth !== null && width > boxWidth) || (boxHeight !== null && height > boxHeight)) {
    const fitted = await sharp(bytes).resize({
      ...(boxWidth !== null ? { width: boxWidth } : {}),
      ...(boxHeight !== null ? { height: boxHeight } : {}),
      fit: "inside",
      withoutEnlargement: true,
    }).toBuffer({ resolveWithObject: true });
    bytes = fitted.data;
    width = fitted.info.width;
    height = fitted.info.height;
  }
  const maxSide = limits.maxSide;
  if (maxSide !== null && (width > maxSide || height > maxSide)) {
    const scale = maxSide / Math.max(width, height);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
    const fitted = await sharp(bytes).resize(width, height, { fit: "inside", withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
    bytes = fitted.data;
    width = fitted.info.width;
    height = fitted.info.height;
    mimeType = image.mimeType;
  }
  if (limits.minSide !== null && (width < limits.minSide || height < limits.minSide)) return null;
  if (limits.maxWidth !== null && width > limits.maxWidth) return null;
  if (limits.maxHeight !== null && height > limits.maxHeight) return null;
  if (mimeType === "image/webp") return null;
  return { bytes, mimeType, width, height };
}

async function equalize(photos: PreparedPhoto[]): Promise<PreparedPhoto[] | null> {
  if (photos.length !== 3) return null;
  const width = Math.max(...photos.map((photo) => photo.width));
  const height = Math.max(...photos.map((photo) => photo.height));
  if (width > 4096 || height > 4096) return null;
  const padded: PreparedPhoto[] = [];
  for (const photo of photos) {
    if (photo.width === width && photo.height === height) {
      padded.push(photo);
      continue;
    }
    const output = await sharp(photo.bytes)
      .extend({
        top: 0,
        left: 0,
        right: width - photo.width,
        bottom: height - photo.height,
        background: { r: 0, g: 0, b: 0 },
      })
      .toBuffer({ resolveWithObject: true });
    padded.push({
      role: photo.role,
      bytes: output.data,
      mimeType: photo.mimeType,
      width: output.info.width,
      height: output.info.height,
    });
  }
  const same = padded.every((photo) => photo.width === width && photo.height === height);
  return same ? padded : null;
}

function isRole(value: string): value is PhotoRole {
  return ["front", "right", "left", "density", "length", "face", "source", "reference"].includes(value);
}
