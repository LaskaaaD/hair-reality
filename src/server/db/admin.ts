import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { hashPassword } from "./passwords.js";
import { normalizeEmail } from "../auth/policy.js";

const { Client } = pg;

export class AccountAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountAdminError";
  }
}

export async function resetAccountPassword(options: {
  connectionString: string;
  email: string;
  credentialsFile: string;
}): Promise<{ email: string }> {
  const email = normalizeEmail(options.email);
  if (!email) throw new AccountAdminError("Account was not found.");
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  const client = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      "UPDATE users SET password_hash = $2 WHERE email = $1 AND deactivated_at IS NULL",
      [email, passwordHash],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      throw new AccountAdminError("Account was not found.");
    }
    await client.query(
      "DELETE FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [email],
    );
    await mkdir(path.dirname(options.credentialsFile), { recursive: true });
    await appendFile(options.credentialsFile, `${email} ${password}\n`, { encoding: "utf8", flag: "a" });
    await client.query("COMMIT");
  } catch (error) {
    if (!(error instanceof AccountAdminError)) await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
  return { email };
}

export async function grantSalonMembership(options: {
  connectionString: string;
  email: string;
  salonSlug: string;
  role: "stylist" | "admin";
}): Promise<{ created: boolean }> {
  const email = normalizeEmail(options.email);
  if (!email) throw new AccountAdminError("Account was not found.");
  const client = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const user = await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND deactivated_at IS NULL", [email]);
    const salon = await client.query<{ id: string }>("SELECT id FROM salons WHERE slug = $1", [options.salonSlug]);
    const userId = user.rows[0]?.id;
    const salonId = salon.rows[0]?.id;
    if (!userId || !salonId) throw new AccountAdminError("Account or salon was not found.");
    const inserted = await client.query(
      `INSERT INTO salon_memberships (salon_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (salon_id, user_id) DO NOTHING`,
      [salonId, userId, options.role],
    );
    return { created: inserted.rowCount === 1 };
  } finally {
    await client.end();
  }
}
