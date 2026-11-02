import type { IncomingMessage } from "node:http";
import { MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES } from "./images.js";

export type UploadStream = {
  headers: IncomingMessage["headers"];
  resume(): void;
  destroy(error?: Error): void;
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>;
};

export type UploadBody = {
  role: string;
  expectedVersion: string;
  file: Buffer;
};

export type UploadRead =
  | { ok: true; body: UploadBody }
  | { ok: false; status: 400 | 413; code: "invalid_input" | "too_large"; message: string };

const ALLOWED_FIELDS = new Set(["file", "role", "expectedVersion"]);

export async function readUpload(request: UploadStream): Promise<UploadRead> {
  const declared = request.headers["content-length"];
  if (Array.isArray(declared) || (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPLOAD_BYTES))) {
    request.resume();
    return { ok: false, status: 413, code: "too_large", message: "The photograph is larger than 9 MB." };
  }
  const type = request.headers["content-type"];
  const boundary = typeof type === "string" ? boundaryOf(type) : undefined;
  if (!boundary) {
    request.resume();
    return { ok: false, status: 400, code: "invalid_input", message: "Upload a JPEG, PNG or WebP photograph." };
  }
  const raw = await readLimited(request, MAX_UPLOAD_BYTES);
  if (raw === null) return { ok: false, status: 413, code: "too_large", message: "The photograph is larger than 9 MB." };
  return parseMultipart(raw, boundary);
}

function boundaryOf(contentType: string): string | undefined {
  const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = matched?.[1] ?? matched?.[2];
  const boundary = value?.trim();
  if (!boundary || boundary.length > 70) return undefined;
  return boundary;
}

async function readLimited(request: UploadStream, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      request.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(raw: Buffer, boundary: string): UploadRead {
  const parts = raw.toString("latin1").split(`--${boundary}`);
  let file: Buffer | undefined;
  let role: string | undefined;
  let expectedVersion: string | undefined;
  for (const part of parts) {
    if (part === "" || part === "--" || part === "--\r\n" || part.startsWith("--")) continue;
    const body = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const splitAt = body.indexOf("\r\n\r\n");
    if (splitAt === -1) return invalid();
    const headers = body.slice(0, splitAt);
    const content = body.slice(splitAt + 4);
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (!name || !ALLOWED_FIELDS.has(name)) return invalid();
    if (name === "file") {
      if (file) return invalid();
      file = Buffer.from(content, "latin1");
      if (file.length > MAX_IMAGE_BYTES) {
        return { ok: false, status: 413, code: "too_large", message: "The photograph is larger than 9 MB." };
      }
      continue;
    }
    const text = Buffer.from(content, "latin1").toString("utf8").trim();
    if (text.length > 80) return invalid();
    if (name === "role") role = text;
    if (name === "expectedVersion") expectedVersion = text;
  }
  if (!file || role === undefined || expectedVersion === undefined) return invalid();
  return { ok: true, body: { file, role, expectedVersion } };
}

function invalid(): UploadRead {
  return { ok: false, status: 400, code: "invalid_input", message: "Upload a JPEG, PNG or WebP photograph." };
}
