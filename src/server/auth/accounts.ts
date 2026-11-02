import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { hashPassword, verifyPassword } from "../db/passwords.js";
import { normalizeEmail } from "./policy.js";

export type AccountRecord = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  deactivatedAt: Date | null;
};

let dummyHash: Promise<string> | undefined;

export async function registerClient(pool: Pool, input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ ok: true; user: AccountRecord } | { ok: false; field: "email" | "password" | "displayName"; message: string } | { ok: false; conflict: true }> {
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, field: "email", message: "Enter a valid email address." };
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    return { ok: false, field: "displayName", message: "Enter a display name of 1 to 80 characters." };
  }
  if (input.password.length < 12 || input.password.length > 200) {
    return { ok: false, field: "password", message: "Use a password of at least 12 characters." };
  }
  const passwordHash = await hashPassword(input.password);
  try {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [email, displayName, passwordHash],
    );
    const id = inserted.rows[0]?.id;
    if (!id) return { ok: false, conflict: true };
    return { ok: true, user: { id, email, displayName, passwordHash, deactivatedAt: null } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, conflict: true };
    throw error;
  }
}

export async function authenticate(pool: Pool, emailInput: string, password: string): Promise<AccountRecord | null> {
  const email = normalizeEmail(emailInput);
  if (!email) {
    await verifyPassword(password, await placeholderHash());
    return null;
  }
  const result = await pool.query<{
    id: string;
    email: string;
    display_name: string;
    password_hash: string;
    deactivated_at: Date | null;
  }>(
    `SELECT id, email, display_name, password_hash, deactivated_at
     FROM users
     WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];
  const hash = row?.password_hash ?? await placeholderHash();
  const matches = await verifyPassword(password, hash);
  if (!row || !matches || row.deactivated_at) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    deactivatedAt: row.deactivated_at,
  };
}

function placeholderHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64url"));
  return dummyHash;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
