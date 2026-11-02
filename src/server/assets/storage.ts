import { mkdir, open, rm, stat } from "node:fs/promises";
import { createReadStream, type ReadStream } from "node:fs";
import path from "node:path";

const KEY_PATTERN = /^[a-f0-9]{64}$/;

export type PrivateStorage = {
  write(key: string, bytes: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number>;
  stream(key: string): ReadStream;
};

export class StorageKeyError extends Error {
  constructor() {
    super("invalid_storage_key");
    this.name = "StorageKeyError";
  }
}

export function createPrivateStorage(root: string): PrivateStorage {
  return {
    async write(key, bytes) {
      const file = resolvePrivatePath(root, key);
      await mkdir(path.dirname(file), { recursive: true });
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async remove(key) {
      const file = resolvePrivatePath(root, key);
      await rm(file, { force: true });
    },
    async exists(key) {
      try {
        const file = await stat(resolvePrivatePath(root, key));
        return file.isFile();
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async size(key) {
      const file = await stat(resolvePrivatePath(root, key));
      if (!file.isFile()) throw new StorageKeyError();
      return file.size;
    },
    stream(key) {
      return createReadStream(resolvePrivatePath(root, key));
    },
  };
}

export function resolvePrivatePath(root: string, key: string): string {
  if (!KEY_PATTERN.test(key)) throw new StorageKeyError();
  const rootPath = path.resolve(root);
  const relative = path.join(key.slice(0, 2), key.slice(2, 4), key);
  const full = path.resolve(rootPath, relative);
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (full !== rootPath && !full.startsWith(prefix)) throw new StorageKeyError();
  return full;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
