import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { SessionUser } from "../../shared/auth.js";
import { csrfTokenForSession, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./policy.js";

export type LoadedSession = {
  rawId: string;
  user: SessionUser;
  csrfToken: string;
};

type SessionRow = {
  user_id: string;
  email: string;
  display_name: string;
  deactivated_at: Date | null;
  expires_at: Date;
  absolute_expires_at: Date;
  salon_id: string | null;
  salon_slug: string | null;
  role: string | null;
};

export async function createSession(pool: Pool, userId: string, secret: string, now: Date): Promise<LoadedSession> {
  const rawId = randomBytes(32).toString("base64url");
  const absolute = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  const idle = new Date(now.getTime() + SESSION_IDLE_MS);
  await pool.query(
    `INSERT INTO user_sessions (id, user_id, expires_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4)`,
    [sessionKey(rawId), userId, idle, absolute],
  );
  const loaded = await readSession(pool, rawId, secret, now);
  if (!loaded) throw new Error("Session was not stored");
  return loaded;
}

export async function readSession(pool: Pool, rawId: string, secret: string, now: Date): Promise<LoadedSession | null> {
  const key = sessionKey(rawId);
  const result = await pool.query<SessionRow>(
    `SELECT users.id AS user_id, users.email, users.display_name, users.deactivated_at,
            user_sessions.expires_at, user_sessions.absolute_expires_at,
            salon_memberships.salon_id, salons.slug AS salon_slug, salon_memberships.role
     FROM user_sessions
     JOIN users ON users.id = user_sessions.user_id
     LEFT JOIN salon_memberships ON salon_memberships.user_id = users.id
     LEFT JOIN salons ON salons.id = salon_memberships.salon_id
     WHERE user_sessions.id = $1`,
    [key],
  );
  const first = result.rows[0];
  if (!first) return null;
  if (first.deactivated_at || first.expires_at <= now || first.absolute_expires_at <= now) {
    await pool.query("DELETE FROM user_sessions WHERE id = $1", [key]);
    return null;
  }
  const memberships: SessionUser["memberships"] = [];
  for (const row of result.rows) {
    if (row.salon_id && row.salon_slug && (row.role === "stylist" || row.role === "admin")) {
      memberships.push({ salonId: row.salon_id, salonSlug: row.salon_slug, role: row.role });
    }
  }
  return {
    rawId,
    csrfToken: csrfTokenForSession(secret, rawId),
    user: {
      id: first.user_id,
      email: first.email,
      displayName: first.display_name,
      memberships,
    },
  };
}

export async function touchSession(pool: Pool, rawId: string, now: Date): Promise<void> {
  await pool.query(
    `UPDATE user_sessions
     SET expires_at = LEAST(absolute_expires_at, $2::timestamptz)
     WHERE id = $1 AND expires_at > $3 AND absolute_expires_at > $3`,
    [sessionKey(rawId), new Date(now.getTime() + SESSION_IDLE_MS), now],
  );
}

export async function deleteSession(pool: Pool, rawId: string): Promise<void> {
  await pool.query("DELETE FROM user_sessions WHERE id = $1", [sessionKey(rawId)]);
}

export async function deleteUserSessions(pool: Pool, userId: string): Promise<void> {
  await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
}

function sessionKey(rawId: string): string {
  return createHash("sha256").update(rawId).digest("hex");
}
