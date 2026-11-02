import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ServiceKind } from "../../domain/catalogue.js";
import { parsePerson, type Person } from "../../domain/person.js";
import type { ProfileOverrideMap } from "../../domain/profile-overrides.js";
import type { Answers } from "../../domain/scoring.js";
import { emptyAnswers } from "../../domain/scoring.js";
import { previewSourceFromDetail, type PreviewImageSource } from "./render-cache.js";

export type DemoSession = {
  id: string;
  service: ServiceKind;
  answers: Answers;
  profileOverrides: ProfileOverrideMap;
  likes: string[];
  analysis: Person | null;
  analysisStatus: "idle" | "running" | "ready" | "failed";
  analysisFingerprint: string | null;
  personaId: string | null;
  audience: "guest" | "judge";
  briefTokenHash: string | null;
  recommendation: unknown;
  expiresAt: Date;
};

export type DemoPhoto = {
  id: string;
  role: string;
  storageKey: string;
  contentHash: string;
  mime: string;
};

export type DemoPreview = {
  id: string;
  candidateKey: string;
  title: string;
  score: number;
  label: string;
  reasons: string[];
  status: "pending" | "ready" | "skipped" | "failed";
  storageKey: string | null;
  source: PreviewImageSource | null;
};

const SERVICE = new Set(["haircut", "colour", "beard"]);

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function storageKey(): string {
  return randomBytes(32).toString("hex");
}

export async function insertSession(
  pool: Pool,
  input: { service: ServiceKind; tokenHash: string; now: Date; personaId: string | null; audience?: "guest" | "judge" },
): Promise<string> {
  const id = randomUUID();
  const expires = new Date(input.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO demo_sessions (id, token_hash, service, persona_id, audience, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, input.tokenHash, input.service, input.personaId, input.audience ?? "guest", input.now, expires],
  );
  return id;
}

export async function sessionByToken(pool: Pool, tokenHash: string, now: Date): Promise<DemoSession | null> {
  const result = await pool.query<{
    id: string;
    service: string;
    answers: unknown;
    likes: string[] | null;
    analysis: unknown;
    analysis_status: string;
    analysis_fingerprint: string | null;
    persona_id: string | null;
    audience: string;
    brief_token_hash: string | null;
    recommendation: unknown;
    expires_at: Date;
  }>(
    `SELECT id, service, answers, likes, analysis, analysis_status, analysis_fingerprint, persona_id, audience, brief_token_hash, recommendation, expires_at
     FROM demo_sessions WHERE token_hash = $1 AND expires_at > $2`,
    [tokenHash, now],
  );
  const row = result.rows[0];
  if (!row || !SERVICE.has(row.service)) return null;
  if (!isStatus(row.analysis_status)) return null;
  return {
    id: row.id,
    service: row.service as ServiceKind,
    answers: readAnswers(row.answers),
    profileOverrides: readProfileOverrides(row.answers),
    likes: row.likes ?? [],
    analysis: parsePerson(row.analysis),
    analysisStatus: row.analysis_status,
    analysisFingerprint: row.analysis_fingerprint,
    personaId: row.persona_id,
    audience: row.audience === "judge" ? "judge" : "guest",
    briefTokenHash: row.brief_token_hash,
    recommendation: row.recommendation,
    expiresAt: row.expires_at,
  };
}

export async function sessionByBriefToken(pool: Pool, tokenHash: string, now: Date): Promise<DemoSession | null> {
  const result = await pool.query<{ token_hash: string }>(
    `SELECT token_hash FROM demo_sessions WHERE brief_token_hash = $1 AND expires_at > $2`,
    [tokenHash, now],
  );
  const token = result.rows[0]?.token_hash;
  if (!token) return null;
  return sessionByToken(pool, token, now);
}

export async function saveBrief(pool: Pool, sessionId: string, briefTokenHash: string, recommendation: unknown): Promise<void> {
  await pool.query(
    `UPDATE demo_sessions SET brief_token_hash = $2,
       recommendation = $3::jsonb || CASE WHEN recommendation ? 'salon' THEN jsonb_build_object('salon', recommendation->'salon') ELSE '{}'::jsonb END
     WHERE id = $1`,
    [sessionId, briefTokenHash, JSON.stringify(recommendation)],
  );
}

/** Salon branding rides in the saved recommendation JSON so the brief can show it without a salons table. */
export async function saveSalon(pool: Pool, sessionId: string, salon: { name: string; color: string }): Promise<void> {
  await pool.query(
    `UPDATE demo_sessions SET recommendation = jsonb_set(COALESCE(recommendation, '{}'::jsonb), '{salon}', $2::jsonb) WHERE id = $1`,
    [sessionId, JSON.stringify(salon)],
  );
}

export async function listPhotos(pool: Pool | PoolClient, sessionId: string): Promise<DemoPhoto[]> {
  const result = await pool.query<{ id: string; role: string; storage_key: string; content_hash: string; mime: string }>(
    `SELECT id, role, storage_key, content_hash, mime FROM demo_photos WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    storageKey: row.storage_key,
    contentHash: row.content_hash,
    mime: row.mime,
  }));
}

export async function savePhoto(
  pool: Pool,
  input: { sessionId: string; role: string; storageKey: string; contentHash: string; mime: string },
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM demo_photos WHERE session_id = $1 AND role = $2 FOR UPDATE`,
      [input.sessionId, input.role],
    );
    const previous = existing.rows[0];
    if (previous) {
      await client.query(
        `UPDATE demo_photos SET storage_key = $2, content_hash = $3, mime = $4, created_at = now() WHERE id = $1`,
        [previous.id, input.storageKey, input.contentHash, input.mime],
      );
    } else {
      await client.query(
        `INSERT INTO demo_photos (id, session_id, role, storage_key, content_hash, mime) VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), input.sessionId, input.role, input.storageKey, input.contentHash, input.mime],
      );
    }
    await client.query(
      `UPDATE demo_sessions SET analysis_status = 'idle', analysis_fingerprint = NULL WHERE id = $1 AND persona_id IS NULL`,
      [input.sessionId],
    );
    await client.query("COMMIT");
    return previous && previous.storage_key !== input.storageKey ? previous.storage_key : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePhoto(pool: Pool, sessionId: string, role: string): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string; storage_key: string }>(
      `SELECT id, storage_key FROM demo_photos WHERE session_id = $1 AND role = $2 FOR UPDATE`,
      [sessionId, role],
    );
    const row = existing.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(`DELETE FROM demo_photos WHERE id = $1`, [row.id]);
    await client.query(
      `UPDATE demo_sessions SET analysis_status = 'idle', analysis_fingerprint = NULL WHERE id = $1 AND persona_id IS NULL`,
      [sessionId],
    );
    await client.query("COMMIT");
    return row.storage_key;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function photoForSession(pool: Pool, sessionId: string, photoId: string): Promise<DemoPhoto | null> {
  const result = await clientPhoto(pool, sessionId, photoId);
  return result;
}

async function clientPhoto(pool: Pool, sessionId: string, photoId: string): Promise<DemoPhoto | null> {
  const result = await pool.query<{ id: string; role: string; storage_key: string; content_hash: string; mime: string }>(
    `SELECT id, role, storage_key, content_hash, mime FROM demo_photos WHERE session_id = $1 AND id = $2`,
    [sessionId, photoId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, role: row.role, storageKey: row.storage_key, contentHash: row.content_hash, mime: row.mime };
}

export async function saveAnswers(
  pool: Pool,
  sessionId: string,
  answers: Answers,
  profileOverrides: ProfileOverrideMap = {},
): Promise<void> {
  const payload = { ...answers, profileOverrides };
  await pool.query(`UPDATE demo_sessions SET answers = $2::jsonb WHERE id = $1`, [sessionId, JSON.stringify(payload)]);
}

export async function saveLikes(pool: Pool, sessionId: string, likes: readonly string[]): Promise<void> {
  await pool.query(`UPDATE demo_sessions SET likes = $2 WHERE id = $1`, [sessionId, likes]);
}

export async function saveAnalysis(
  pool: Pool,
  input: { sessionId: string; analysis: Person; status: DemoSession["analysisStatus"]; fingerprint: string },
): Promise<void> {
  await pool.query(
    `UPDATE demo_sessions
     SET analysis = $2::jsonb, analysis_status = $3, analysis_fingerprint = $4
     WHERE id = $1`,
    [input.sessionId, JSON.stringify(input.analysis), input.status, input.fingerprint],
  );
}

export async function countReferences(pool: Pool, sessionId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM demo_references WHERE session_id = $1`,
    [sessionId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function insertReference(
  pool: Pool,
  input: { sessionId: string; storageKey: string; mime: string },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO demo_references (id, session_id, storage_key, mime) VALUES ($1, $2, $3, $4)`,
    [id, input.sessionId, input.storageKey, input.mime],
  );
  return id;
}

export async function listReferenceIds(pool: Pool | PoolClient, sessionId: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM demo_references WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return result.rows.map((row) => row.id);
}

export async function referenceBytesKey(pool: Pool, sessionId: string, referenceId: string): Promise<string | null> {
  const result = await pool.query<{ storage_key: string }>(
    `SELECT storage_key FROM demo_references WHERE session_id = $1 AND id = $2`,
    [sessionId, referenceId],
  );
  return result.rows[0]?.storage_key ?? null;
}

export async function listReferences(pool:Pool,sessionId:string):Promise<{id:string;storageKey:string;mime:string}[]> {
  const result=await pool.query<{id:string;storage_key:string;mime:string}>(
    `SELECT id, storage_key, mime FROM demo_references WHERE session_id = $1 ORDER BY created_at`,[sessionId],
  );
  return result.rows.map(row=>({id:row.id,storageKey:row.storage_key,mime:row.mime}));
}

export async function listPreviews(pool: Pool | PoolClient, sessionId: string): Promise<DemoPreview[]> {
  const result = await pool.query<{
    id: string;
    candidate_key: string;
    title: string;
    score: number;
    label: string;
    reasons: unknown;
    status: string;
    storage_key: string | null;
    detail: unknown;
  }>(
    `SELECT id, candidate_key, title, score, label, reasons, status, storage_key, detail
     FROM demo_previews WHERE session_id = $1 ORDER BY score DESC, created_at`,
    [sessionId],
  );
  return result.rows.flatMap((row) => {
    if (row.status !== "pending" && row.status !== "ready" && row.status !== "skipped" && row.status !== "failed") return [];
    return [{
      id: row.id,
      candidateKey: row.candidate_key,
      title: row.title,
      score: row.score,
      label: row.label,
      reasons: Array.isArray(row.reasons) ? row.reasons.filter((item): item is string => typeof item === "string") : [],
      status: row.status,
      storageKey: row.storage_key,
      source: previewSourceFromDetail(row.detail),
    }];
  });
}

export async function replacePreviews(pool: Pool, sessionId: string, previews: readonly {
  candidateKey: string;
  title: string;
  score: number;
  label: string;
  reasons: readonly string[];
  status: DemoPreview["status"];
  storageKey: string | null;
  source: PreviewImageSource | null;
}[]): Promise<DemoPreview[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM demo_previews WHERE session_id = $1`, [sessionId]);
    const created: DemoPreview[] = [];
    for (const preview of previews) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO demo_previews (id, session_id, candidate_key, title, score, label, reasons, status, storage_key, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)`,
        [
          id,
          sessionId,
          preview.candidateKey,
          preview.title,
          preview.score,
          preview.label,
          JSON.stringify(preview.reasons),
          preview.status,
          preview.storageKey,
          preview.source ? JSON.stringify({ source: preview.source }) : "{}",
        ],
      );
      created.push({ id, ...preview, reasons: [...preview.reasons] });
    }
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function previewForSession(pool: Pool, sessionId: string, previewId: string): Promise<DemoPreview | null> {
  const rows = await listPreviews(pool, sessionId);
  return rows.find((row) => row.id === previewId) ?? null;
}

export async function reserveUnits(
  pool: Pool,
  input: {
    sessionId: string;
    capability: string;
    units: number;
    idempotencyKey: string;
    now: Date;
    sessionCap: number;
    dailyCap: number;
    audience?: "guest" | "judge";
  },
  transaction?: PoolClient,
): Promise<{ ok: true; charged: boolean } | { ok: false; code: "session_cap" | "daily_cap" }> {
  const client = transaction ?? await pool.connect();
  try {
    if(!transaction)await client.query("BEGIN");
    await client.query(`SELECT id FROM demo_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
    const existing = await client.query(`SELECT 1 FROM demo_usage WHERE idempotency_key = $1`, [input.idempotencyKey]);
    if ((existing.rowCount ?? 0) > 0) {
      if(!transaction)await client.query("COMMIT");
      return { ok: true, charged: false };
    }
    const sessionUnits = await sumUnits(client, `SELECT COALESCE(SUM(units), 0)::int AS units FROM demo_usage WHERE session_id = $1`, [input.sessionId]);
    const dayStart = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate()));
    const dayUnits = await sumUnits(
      client,
      `SELECT COALESCE(SUM(u.units), 0)::int AS units
       FROM demo_usage u
       JOIN demo_sessions s ON s.id = u.session_id
       WHERE u.created_at >= $1 AND s.audience = $2`,
      [dayStart, input.audience ?? "guest"],
    );
    if (sessionUnits + input.units > input.sessionCap) {
      if(!transaction)await client.query("ROLLBACK");
      return { ok: false, code: "session_cap" };
    }
    if (dayUnits + input.units > input.dailyCap) {
      if(!transaction)await client.query("ROLLBACK");
      return { ok: false, code: "daily_cap" };
    }
    await client.query(
      `INSERT INTO demo_usage (id, session_id, capability, units, idempotency_key, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), input.sessionId, input.capability, input.units, input.idempotencyKey, input.now],
    );
    if(!transaction)await client.query("COMMIT");
    return { ok: true, charged: true };
  } catch (error) {
    if(!transaction)await client.query("ROLLBACK");
    throw error;
  } finally {
    if(!transaction)client.release();
  }
}

async function sumUnits(client: PoolClient, sql: string, values: readonly unknown[]): Promise<number> {
  const result = await client.query<{ units: number }>(sql, [...values]);
  return result.rows[0]?.units ?? 0;
}

export function readProfileOverrides(value: unknown): ProfileOverrideMap {
  if (!isRecord(value) || !isRecord(value.profileOverrides)) return {};
  const out: ProfileOverrideMap = {};
  for (const [key, entry] of Object.entries(value.profileOverrides)) {
    if (typeof entry === "string" && entry.trim()) out[key] = entry.trim();
  }
  return out;
}

function readAnswers(value: unknown): Answers {
  const base = emptyAnswers();
  if (!isRecord(value)) return base;
  return {
    stylingMinutes: oneOf(value.stylingMinutes, ["5", "15", "30"] as const, base.stylingMinutes),
    heatStyle: oneOf(value.heatStyle, ["none", "sometimes", "daily"] as const, base.heatStyle),
    keep: oneOf(value.keep, ["length", "fringe", "nothing"] as const, base.keep),
    colourHistory: oneOf(value.colourHistory, ["natural", "box-dye", "lightened", "unknown"] as const, base.colourHistory),
    beardGrowth: oneOf(value.beardGrowth, ["full", "patchy", "unknown"] as const, base.beardGrowth),
    presentation: oneOf(value.presentation, ["masculine", "feminine", "either", "auto"] as const, base.presentation),
    naturalState: oneOf(value.naturalState, ["natural", "styled", "unknown"] as const, base.naturalState),
    chemical: oneOf(value.chemical, ["none", "lightened", "permed", "relaxed", "unknown"] as const, base.chemical),
    strand: oneOf(value.strand, ["fine", "medium", "coarse", "unknown"] as const, base.strand),
    blowdryer: oneOf(value.blowdryer, ["yes", "no", "unknown"] as const, base.blowdryer),
    products: oneOf(value.products, ["yes", "no", "unknown"] as const, base.products),
    canShorten: oneOf(value.canShorten, ["yes", "no", "unknown"] as const, base.canShorten),
    canGrow: oneOf(value.canGrow, ["yes", "a-little", "no", "unknown"] as const, base.canGrow),
    forehead: oneOf(value.forehead, ["cover", "show", "either", "unknown"] as const, base.forehead),
    glassesDaily: oneOf(value.glassesDaily, ["yes", "no", "unknown"] as const, base.glassesDaily),
    facialHair: oneOf(value.facialHair, ["none", "stubble", "moustache", "short", "medium", "long", "unknown"] as const, base.facialHair),
    cowlick: oneOf(value.cowlick, ["none", "front", "crown", "both", "unknown"] as const, base.cowlick),
    wish: typeof value.wish === "string" ? value.wish.trim().slice(0, 300) : base.wish,
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function isStatus(value: string): value is DemoSession["analysisStatus"] {
  return value === "idle" || value === "running" || value === "ready" || value === "failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
