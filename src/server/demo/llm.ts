import sharp from "sharp";
import type { Pool } from "pg";
import { z } from "zod";
import { parsePerson, unknownReading, type Person, type Reading } from "../../domain/person.js";
import { applyRanking, type ScoredVariant } from "../../domain/scoring.js";
import type { PrivateStorage } from "../assets/storage.js";
import type { OpenAIClient } from "../providers/openai/client.js";
import { applyVisionDetailed, FIELD_CONFIDENCE_KEYS, readVision } from "./vision.js";
import { EXPLAIN_MODEL, PROFILE_MODEL, demoBudgetAllows, demoMicro, recordDemoSpend } from "./openai-budget.js";

const noteSchema = z.object({
  order: z.array(z.string().min(1).max(80)).max(12),
  notes: z.array(z.object({
    id: z.string().min(1).max(80),
    line: z.string().min(8).max(180),
  })).max(12),
});

const visionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["growthDirection", "cowlickFront", "cowlickCrown", "hairline", "glasses", "lengthCm", "frontCm", "topCm", "sideCm", "curl", "diameter", "density", "faceShape", "faceRatio", "jaw", "forehead", "foreheadWidth", "ears", "recession", "crownWhorl", "occipital", "facialHair", "confidence", "fieldConfidence"],
  properties: {
    growthDirection: { type: "string", enum: ["forward", "back", "left", "right", "unknown"] },
    cowlickFront: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    cowlickCrown: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    hairline: { type: "string", enum: ["low", "average", "high", "receded", "unknown"] },
    glasses: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    lengthCm: { anyOf: [{ type: "number" }, { type: "null" }] },
    frontCm: { anyOf: [{ type: "number" }, { type: "null" }] },
    topCm: { anyOf: [{ type: "number" }, { type: "null" }] },
    sideCm: { anyOf: [{ type: "number" }, { type: "null" }] },
    curl: { type: "string", enum: ["1", "2a", "2b", "2c", "3a", "3b", "3c", "4a", "4b", "4c", "unknown"] },
    diameter: { type: "string", enum: ["fine", "medium", "coarse", "unknown"] },
    density: { anyOf: [{ type: "integer", enum: [1, 2, 3, 4] }, { type: "null" }] },
    faceShape: { type: "string", enum: ["oval", "round", "square", "heart", "long", "unknown"] },
    faceRatio: { anyOf: [{ type: "number" }, { type: "null" }] },
    jaw: { type: "string", enum: ["narrow", "average", "wide", "unknown"] },
    forehead: { type: "string", enum: ["low", "average", "high", "unknown"] },
    foreheadWidth: { type: "string", enum: ["narrow", "average", "wide", "unknown"] },
    ears: { type: "string", enum: ["flat", "average", "prominent", "unknown"] },
    recession: { type: "string", enum: ["none", "mild", "moderate", "advanced", "unknown"] },
    crownWhorl: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    occipital: { type: "string", enum: ["flat", "round", "unknown"] },
    facialHair: { type: "string", enum: ["none", "stubble", "moustache", "short", "medium", "long", "unknown"] },
    confidence: { type: "number" },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      required: [...FIELD_CONFIDENCE_KEYS],
      properties: Object.fromEntries(FIELD_CONFIDENCE_KEYS.map((key) => [key, { type: "number" }])),
    },
  },
} as const;

const noteJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["order", "notes"],
  properties: {
    order: { type: "array", items: { type: "string" } },
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "line"],
        properties: {
          id: { type: "string" },
          line: { type: "string" },
        },
      },
    },
  },
} as const;

export function reviewRecommendations(show: readonly ScoredVariant[]): ScoredVariant[] {
  return applyModelNotes(show, show.map((item) => item.variant.id), []);
}

export function applyModelNotes(
  show: readonly ScoredVariant[],
  order: readonly string[],
  notes: readonly { id: string; line: string }[],
): ScoredVariant[] {
  const reviewed = applyRanking(show, order);
  return reviewed.map((item) => {
    const source = show.find((candidate) => candidate.variant.id === item.variant.id) ?? item;
    const note = notes.find((entry) => entry.id === item.variant.id);
    const line = note && note.line.trim().length >= 8 ? note.line.trim().slice(0, 180) : source.stylistScript;
    return { ...item, score: source.score, label: source.label, stylistScript: line };
  });
}

export async function explainLooks(show: readonly ScoredVariant[], openai: OpenAIClient, budgetUsd = 6): Promise<ScoredVariant[]> {
  const fallback = reviewRecommendations(show);
  if (show.length === 0) return fallback;
  const reserve = demoMicro(EXPLAIN_MODEL, 4000, 800);
  if (!(await demoBudgetAllows(budgetUsd, reserve))) return fallback;
  try {
    const listed = show.map((item) => ({
      id: item.variant.id,
      title: item.variant.title,
      sentence: item.stylistScript,
    }));
    const call = await openai.completeJson({
      name: "demo_notes",
      model: EXPLAIN_MODEL,
      instructions: "Reorder the given style ids and write one sentence the client can say to a stylist. Use only the given ids. Do not change scores, labels, or which styles are included.",
      schema: noteJsonSchema,
      userText: JSON.stringify({ styles: listed }),
    });
    await recordDemoSpend(call.kind === "failed" || call.kind === "uncertain" ? 0 : demoMicro(EXPLAIN_MODEL, call.usage?.inputTokens ?? 4000, call.usage?.outputTokens ?? 400));
    if (call.kind !== "completed") return fallback;
    const parsed = noteSchema.safeParse(JSON.parse(call.text));
    if (!parsed.success) return fallback;
    return applyModelNotes(show, parsed.data.order, parsed.data.notes);
  } catch {
    return fallback;
  }
}

const VISION_WAIT_MS = 90_000;
const VISION_ATTEMPTS = 2;
const VISION_RUNS = 2;
const visionRuns = new Map<string, number>();
const visionInFlight = new Map<string, Promise<void>>();

/** Registers a running vision step so ranking can wait for it instead of racing it. */
export function trackVision(sessionId: string, work: Promise<void>): Promise<void> {
  const tracked: Promise<void> = work.finally(() => {
    if (visionInFlight.get(sessionId) === tracked) visionInFlight.delete(sessionId);
  });
  visionInFlight.set(sessionId, tracked);
  return tracked;
}

/** Waits for a vision step already running for this session, at most `ms`. Logs when it gives up. */
export async function waitForVision(sessionId: string, ms = VISION_WAIT_MS): Promise<void> {
  const running = visionInFlight.get(sessionId);
  if (!running) return;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = await Promise.race([
    running.then(() => false, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); }),
  ]);
  if (timer) clearTimeout(timer);
  if (gaveUp) console.warn(`demo_vision wait_timeout ms=${Date.now() - started}`);
}

function describeFilled(filled: { field: string; value: unknown; confidence: number }[]): string {
  return filled.map((item) => `${item.field}=${String(item.value)}@${item.confidence.toFixed(2)}`).join(",") || "none";
}

export async function attachVisionIfReady(input: {
  pool: Pool;
  storage: PrivateStorage;
  openai: OpenAIClient;
  sessionId: string;
  budgetUsd?: number;
}): Promise<void> {
  const claimed = await input.pool.query<{ analysis: unknown }>(
    `UPDATE demo_sessions
     SET analysis_fingerprint = analysis_fingerprint || ':vision'
     WHERE id = $1
       AND analysis_status = 'ready'
       AND analysis_fingerprint IS NOT NULL
       AND strpos(analysis_fingerprint, ':vision') = 0
     RETURNING analysis`,
    [input.sessionId],
  );
  const row = claimed.rows[0];
  if (!row) return;
  const started = Date.now();
  const person = parsePerson(row.analysis);
  if (!person) {
    console.warn("demo_vision ran=false reason=analysis_unreadable");
    return;
  }
  const images = await sessionImages(input.pool, input.storage, input.sessionId);
  if (images.length === 0) {
    console.warn("demo_vision ran=false reason=no_photos");
    return;
  }
  const reserve = demoMicro(PROFILE_MODEL, 12000, 900);
  if (!(await demoBudgetAllows(input.budgetUsd ?? 6, reserve))) {
    console.warn("demo_vision ran=false reason=budget");
    return;
  }
  for (let attempt = 1; attempt <= VISION_ATTEMPTS; attempt += 1) {
    try {
      const call = await input.openai.completeJson({
        name: "demo_vision",
        model: PROFILE_MODEL,
        instructions: "You get the YouCam reading as JSON plus the photos. Give your own independent reading of every field from the photos; both readings are kept side by side and a stylist compares them, so do not copy the YouCam value, and say so with a lower confidence when you are unsure. Use unknown or null only when a field truly cannot be seen. Give an honest confidence from 0 to 1 per field in fieldConfidence: 0.8 or more when the photos show it clearly, 0.5 to 0.7 for a reasonable estimate, below 0.5 for a guess.",
        schema: visionJsonSchema,
        userText: `YouCam reading: ${JSON.stringify(youcamReading(person))}
Photo order: front, one side profile, the other side profile, then the crown when present. Return curl (1 = straight, 2a-2c wavy, 3a-3c curly, 4a-4c coily), strand diameter, density 1-4, front/top/side length in centimetres, growth direction, front cowlick, crown whorl (crownWhorl: a spiral growth point at the crown), hairline, recession (none, mild, moderate or advanced: how far the hairline has receded at the temples and front), occipital (back of the head: flat or round), face shape, faceRatio (face length divided by face width, e.g. 1.35), jaw, forehead (low, average or high), forehead width, ears, glasses, facialHair (none when clean shaven, stubble for a few days of growth, moustache, or a short, medium or long beard), one overall confidence, and a confidence per field.`,
        images,
      });
      if (call.kind !== "failed" && call.kind !== "uncertain") {
        await recordDemoSpend(demoMicro(PROFILE_MODEL, call.usage?.inputTokens ?? 12000, call.usage?.outputTokens ?? 500));
      }
      if (call.kind !== "completed") {
        console.warn(`demo_vision attempt=${attempt} call=${call.kind} ms=${Date.now() - started}`);
        continue;
      }
      const read = readVision(JSON.parse(call.text));
      if (!read) {
        console.warn(`demo_vision attempt=${attempt} unreadable_answer ms=${Date.now() - started}`);
        continue;
      }
      const outcome = applyVisionDetailed(person, read.reading);
      await input.pool.query(`UPDATE demo_sessions SET analysis = $2::jsonb WHERE id = $1 AND analysis_status = 'ready'`, [input.sessionId, JSON.stringify(outcome.person)]);
      console.log(
        `demo_vision ran=true attempt=${attempt} ms=${Date.now() - started} filled=[${describeFilled(outcome.filled)}] ` +
        `skipped=[${outcome.skipped.map((item) => `${item.field}:${item.reason}`).join("; ")}] ` +
        `rejected=[${read.rejected.map((item) => `${item.field}:${item.reason}`).join("; ")}]`,
      );
      return;
    } catch (error: unknown) {
      console.warn(`demo_vision attempt=${attempt} error=${error instanceof Error ? error.name : "error"} ms=${Date.now() - started}`);
    }
  }
  // Every attempt failed: free the claim so a later request can run vision once more,
  // but only up to VISION_RUNS times per session so a persistent failure cannot loop on paid calls.
  const runs = (visionRuns.get(input.sessionId) ?? 0) + 1;
  visionRuns.set(input.sessionId, runs);
  if (runs < VISION_RUNS) {
    await input.pool.query(
      `UPDATE demo_sessions SET analysis_fingerprint = regexp_replace(analysis_fingerprint, ':vision$', '') WHERE id = $1`,
      [input.sessionId],
    );
    console.warn(`demo_vision released_for_retry run=${runs}`);
  }
}


/** The YouCam-owned fields the vision call must merge with, compact and without identifiers. */
export function youcamReading(person: Person): Record<string, unknown> {
  const pick = <T,>(reading: Reading<T>) => (reading.value === "unknown" ? null : { value: reading.value, confidence: reading.confidence });
  return {
    faceShape: pick(person.face.shape),
    faceRatio: pick(person.face.aspectRatio),
    jaw: pick(person.face.jaw),
    forehead: pick(person.face.forehead),
    curl: pick(person.hair.curl),
    density: pick(person.hair.density),
    diameter: pick(person.hair.diameter),
    hairline: pick(person.hair.hairline),
    growthDirection: pick(person.hair.growthDirection),
    glasses: pick(person.context.glasses),
  };
}

export function restoreVisionFields(previous: Person, next: Person): Person {
  const merged = structuredClone(next);
  keep(previous.hair.growthDirection, merged.hair.growthDirection, (value) => { merged.hair.growthDirection = value; });
  keep(previous.hair.cowlickFront, merged.hair.cowlickFront, (value) => { merged.hair.cowlickFront = value; });
  keep(previous.hair.cowlickCrown, merged.hair.cowlickCrown, (value) => { merged.hair.cowlickCrown = value; });
  keep(previous.hair.hairline, merged.hair.hairline, (value) => { merged.hair.hairline = value; });
  if (previous.hair.recession) keep(previous.hair.recession, merged.hair.recession ?? unknownReading("vision"), (value) => { merged.hair.recession = value; });
  keep(previous.head.occipital, merged.head.occipital, (value) => { merged.head.occipital = value; });
  keep(previous.hair.lengthCm, merged.hair.lengthCm, (value) => { merged.hair.lengthCm = value; });
  keep(previous.hair.frontCm, merged.hair.frontCm, (value) => { merged.hair.frontCm = value; });
  keep(previous.hair.topCm, merged.hair.topCm, (value) => { merged.hair.topCm = value; });
  keep(previous.hair.sideCm, merged.hair.sideCm, (value) => { merged.hair.sideCm = value; });
  keep(previous.hair.curl, merged.hair.curl, (value) => { merged.hair.curl = value; });
  keep(previous.hair.diameter, merged.hair.diameter, (value) => { merged.hair.diameter = value; });
  keep(previous.hair.density, merged.hair.density, (value) => { merged.hair.density = value; });
  keep(previous.face.shape, merged.face.shape, (value) => { merged.face.shape = value; });
  keep(previous.face.aspectRatio, merged.face.aspectRatio, (value) => { merged.face.aspectRatio = value; });
  keep(previous.face.jaw, merged.face.jaw, (value) => { merged.face.jaw = value; });
  keep(previous.face.forehead, merged.face.forehead, (value) => { merged.face.forehead = value; });
  if (previous.face.foreheadWidth) keep(previous.face.foreheadWidth, merged.face.foreheadWidth ?? unknownReading("vision"), (value) => { merged.face.foreheadWidth = value; });
  if (previous.head.ears) keep(previous.head.ears, merged.head.ears ?? unknownReading("vision"), (value) => { merged.head.ears = value; });
  keep(previous.context.glasses, merged.context.glasses, (value) => { merged.context.glasses = value; });
  keep(previous.facialHair.style, merged.facialHair.style, (value) => { merged.facialHair.style = value; });
  return merged;
}

/** A vision-merged value already won the merge against YouCam; a later YouCam refresh must not undo it. */
function keep<T>(previous: Reading<T>, next: Reading<T>, write: (value: Reading<T>) => void): void {
  if (previous.source === "vision" && previous.value !== "unknown" && (next.value === "unknown" || next.source !== "vision")) write(previous);
}

async function sessionImages(pool: Pool, storage: PrivateStorage, sessionId: string): Promise<{ mimeType: string; base64: string }[]> {
  const photos = await pool.query<{ role: string; storage_key: string }>(
    `SELECT role, storage_key FROM demo_photos WHERE session_id = $1 AND role IN ('front', 'left', 'right', 'crown')`,
    [sessionId],
  );
  const front = photos.rows.find((row) => row.role === "front");
  if (!front) return [];
  const ordered = ["front", "left", "right", "crown"].flatMap((role) => photos.rows.filter((row) => row.role === role));
  const images = [];
  for (const row of ordered) {
    const bytes = await readKey(storage, row.storage_key);
    const jpeg = await sharp(bytes, { failOn: "none" }).rotate().resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    images.push({ mimeType: "image/jpeg", base64: jpeg.toString("base64") });
  }
  return images;
}

async function readKey(storage: PrivateStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of storage.stream(key)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
