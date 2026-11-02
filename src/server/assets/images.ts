import { createHash } from "node:crypto";
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 9 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 25_000_000;
export const MAX_UPLOAD_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageFormat = "jpeg" | "png" | "webp";
export type ImageMime = "image/jpeg" | "image/png" | "image/webp";

export type NormalizedImage = {
  bytes: Buffer;
  mimeType: ImageMime;
  width: number;
  height: number;
  contentHash: string;
};

export class ImageRejected extends Error {
  readonly reason: "unsupported" | "corrupt" | "too_large" | "too_many_pixels";

  constructor(reason: ImageRejected["reason"]) {
    super(reason);
    this.name = "ImageRejected";
    this.reason = reason;
  }
}

export async function normalizeImage(input: Buffer): Promise<NormalizedImage> {
  if (input.length > MAX_IMAGE_BYTES) throw new ImageRejected("too_large");
  const sniffed = sniff(input);
  if (!sniffed) throw new ImageRejected("unsupported");
  const source = decoder(input);
  let meta;
  try {
    meta = await source.metadata();
  } catch (error) {
    throw rejectedDecode(error);
  }
  if (meta.format !== sniffed) throw new ImageRejected("unsupported");
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 1 || height < 1) throw new ImageRejected("corrupt");
  if (width * height > MAX_IMAGE_PIXELS) throw new ImageRejected("too_many_pixels");

  let output;
  try {
    const pipeline = decoder(input).rotate();
    const encoded = sniffed === "jpeg" ? pipeline.jpeg() : sniffed === "png" ? pipeline.png() : pipeline.webp();
    output = await encoded.toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw rejectedDecode(error);
  }
  if (output.info.width * output.info.height > MAX_IMAGE_PIXELS) throw new ImageRejected("too_many_pixels");
  if (output.data.length > MAX_IMAGE_BYTES) throw new ImageRejected("too_large");
  const confirmed = await sharp(output.data, { failOn: "error", limitInputPixels: MAX_IMAGE_PIXELS, animated: false }).metadata();
  if (confirmed.format !== sniffed || confirmed.exif) throw new ImageRejected("corrupt");
  return {
    bytes: output.data,
    mimeType: mimeType(sniffed),
    width: output.info.width,
    height: output.info.height,
    contentHash: createHash("sha256").update(output.data).digest("hex"),
  };
}

function decoder(input: Buffer) {
  return sharp(input, {
    failOn: "error",
    limitInputPixels: MAX_IMAGE_PIXELS,
    animated: false,
    pages: 1,
    sequentialRead: true,
  });
}

function sniff(input: Buffer): ImageFormat | null {
  if (input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "jpeg";
  if (input.length >= PNG_SIGNATURE.length && input.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return "png";
  if (input.length >= 12 && input.subarray(0, 4).toString("ascii") === "RIFF" && input.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  return null;
}

function mimeType(format: ImageFormat): ImageMime {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function rejectedDecode(error: unknown): ImageRejected {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("pixel") || message.includes("limit")) return new ImageRejected("too_many_pixels");
  return new ImageRejected("corrupt");
}
