import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { normalizeImage } from "../assets/images.js";
import type { PrivateStorage } from "../assets/storage.js";
import { demoMediaRoot } from "./render-cache.js";
import { savePhoto } from "./store.js";

export type PersonaId = "sample" | "jordan" | "maya" | "adrian" | "nina";

export class PersonaPhotosMissing extends Error {
  readonly personaId: PersonaId;

  constructor(personaId: PersonaId) {
    super(`persona_photos_missing:${personaId}`);
    this.name = "PersonaPhotosMissing";
    this.personaId = personaId;
  }
}

const PERSONA_SLOTS: Record<PersonaId, { role: string; file: string }[]> = {
  sample: [
    { role: "front", file: "sample-front.jpg" },
    { role: "left", file: "sample-left.jpg" },
    { role: "right", file: "sample-right.jpg" },
  ],
  jordan: [
    { role: "front", file: "findings-example.jpg" },
    { role: "left", file: "slot-left.jpg" },
    { role: "right", file: "slot-right.jpg" },
    { role: "crown", file: "slot-rear.jpg" },
  ],
  nina: [
    { role: "front", file: "describe-women.jpg" },
    { role: "left", file: "slot-left.jpg" },
    { role: "right", file: "slot-right.jpg" },
  ],
  adrian: [{ role: "front", file: "cat-beard.jpg" }],
  maya: [{ role: "front", file: "cat-colour.jpg" }],
};

function legacyPhotoRoot(): string {
  return path.join(process.cwd(), "src", "client", "photos");
}

function resolvePhotoPath(personaId: PersonaId, file: string): string {
  const root = personaId === "sample" ? demoMediaRoot() : legacyPhotoRoot();
  return path.join(root, file);
}

export async function personaPhotosAvailable(personaId: PersonaId): Promise<boolean> {
  const slots = PERSONA_SLOTS[personaId];
  for (const slot of slots) {
    try {
      await access(resolvePhotoPath(personaId, slot.file));
    } catch {
      return false;
    }
  }
  return true;
}

export async function seedPersonaPhotos(
  pool: Pool,
  storage: PrivateStorage,
  sessionId: string,
  personaId: PersonaId,
  storageKey: () => string,
): Promise<void> {
  if (!(await personaPhotosAvailable(personaId))) {
    throw new PersonaPhotosMissing(personaId);
  }
  const slots = PERSONA_SLOTS[personaId];
  for (const slot of slots) {
    const bytes = await readFile(resolvePhotoPath(personaId, slot.file));
    const image = await normalizeImage(bytes);
    const key = storageKey();
    await storage.write(key, image.bytes);
    await savePhoto(pool, {
      sessionId,
      role: slot.role,
      storageKey: key,
      contentHash: image.contentHash,
      mime: image.mimeType,
    });
  }
}
