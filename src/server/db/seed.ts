import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { hashPassword } from "./passwords.js";
import * as schema from "./schema.js";

const { Client } = pg;

const DEMO_LABEL = "Demo booking — no real salon appointment has been made.";

const DEMO_ACCOUNTS = [
  { email: "client.demo@example.com", displayName: "Demo Client", role: "client", passwordEnv: "SEED_CLIENT_PASSWORD" },
  { email: "stylist.demo@example.com", displayName: "Demo Stylist", role: "stylist", passwordEnv: "SEED_STYLIST_PASSWORD" },
  { email: "admin.demo@example.com", displayName: "Demo Admin", role: "admin", passwordEnv: "SEED_ADMIN_PASSWORD" },
] as const;

const ISOLATION_ACCOUNT = {
  email: "client.isolation@example.com",
  displayName: "Isolation Client",
  role: "client",
  passwordEnv: "SEED_ISOLATION_PASSWORD",
} as const;

const SLOT_STARTS = [
  "2026-11-02T09:00:00.000Z",
  "2026-11-02T10:00:00.000Z",
  "2026-11-02T11:00:00.000Z",
];

export type SeedOptions = {
  connectionString: string;
  nodeEnv: string;
  passwords?: Record<string, string | undefined>;
  includeIsolation?: boolean;
  credentialsFile?: string | null;
};

export type SeedResult = {
  createdUsers: number;
  wroteCredentials: boolean;
};

type AccountSpec = {
  email: string;
  displayName: string;
  role: "client" | "stylist" | "admin";
  passwordEnv: string;
};

export async function seed(options: SeedOptions): Promise<SeedResult> {
  if (options.nodeEnv === "production") {
    throw new Error("Refusing to seed a production database");
  }
  const client = new Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  const db = drizzle(client, { schema });
  const createdLines: string[] = [];
  let createdUsers = 0;

  async function upsertSalon(values: { slug: string; name: string; timezone: string; branding: { kind: string } }): Promise<string> {
    const inserted = await db.insert(schema.salons).values(values)
      .onConflictDoNothing({ target: schema.salons.slug })
      .returning({ id: schema.salons.id });
    if (inserted[0]) return inserted[0].id;
    const existing = await db.select({ id: schema.salons.id }).from(schema.salons).where(eq(schema.salons.slug, values.slug));
    const row = existing[0];
    if (!row) throw new Error("Salon seed did not resolve an existing row");
    return row.id;
  }

  async function upsertMembership(salonId: string, userId: string, role: "stylist" | "admin"): Promise<void> {
    await db.insert(schema.salonMemberships).values({ salonId, userId, role })
      .onConflictDoNothing({ target: [schema.salonMemberships.salonId, schema.salonMemberships.userId] });
  }

  async function upsertAccount(account: AccountSpec): Promise<{ id: string; created: boolean; generatedPassword?: string }> {
    const supplied = blank(options.passwords?.[account.passwordEnv]);
    if (supplied !== undefined && supplied.length < 12) {
      throw new Error("Seed password does not meet the minimum length");
    }
    const generatedPassword = supplied === undefined ? randomBytes(24).toString("base64url") : undefined;
    const password = supplied ?? generatedPassword;
    if (!password) throw new Error("Seed password was not available");
    const passwordHash = await hashPassword(password);
    const inserted = await db.insert(schema.users).values({
      email: account.email,
      displayName: account.displayName,
      passwordHash,
    }).onConflictDoNothing({ target: schema.users.email }).returning({ id: schema.users.id });
    if (inserted[0]) {
      return generatedPassword
        ? { id: inserted[0].id, created: true, generatedPassword }
        : { id: inserted[0].id, created: true };
    }
    const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, account.email));
    const row = existing[0];
    if (!row) throw new Error("Account seed did not resolve an existing row");
    return { id: row.id, created: false };
  }

  try {
    const salonId = await upsertSalon({
      slug: "hair-reality-demo",
      name: "Hair Reality Demo",
      timezone: "Europe/Warsaw",
      branding: { kind: "demonstration" },
    });
    const users = new Map<string, string>();
    for (const account of DEMO_ACCOUNTS) {
      const result = await upsertAccount(account);
      users.set(account.email, result.id);
      if (result.created) createdUsers += 1;
      if (result.created && result.generatedPassword) createdLines.push(`${account.email} ${result.generatedPassword}`);
      if (account.role !== "client") {
        await upsertMembership(salonId, result.id, account.role);
      }
    }
    const stylistId = users.get("stylist.demo@example.com");
    if (!stylistId) throw new Error("Demo stylist was not provisioned");
    for (const start of SLOT_STARTS) {
      const startsAt = new Date(start);
      const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
      await db.insert(schema.demoSlots).values({
        salonId,
        stylistUserId: stylistId,
        startsAt,
        endsAt,
        label: DEMO_LABEL,
      }).onConflictDoNothing({ target: [schema.demoSlots.salonId, schema.demoSlots.startsAt] });
    }
    for (const provider of ["youcam", "openai"] as const) {
      for (const phase of ["development", "demo"] as const) {
        await db.insert(schema.providerBudgetAccounts).values({
          provider,
          phase,
          settledUnits: 0,
          reservedUnits: 0,
          mode: "live",
        }).onConflictDoNothing({
          target: [
            schema.providerBudgetAccounts.provider,
            schema.providerBudgetAccounts.phase,
            schema.providerBudgetAccounts.mode,
          ],
        });
      }
    }
    if (options.includeIsolation) {
      await upsertSalon({
        slug: "isolation-test",
        name: "Isolation Test",
        timezone: "Europe/Warsaw",
        branding: { kind: "isolation" },
      });
      const isolation = await upsertAccount(ISOLATION_ACCOUNT);
      if (isolation.created) createdUsers += 1;
      if (isolation.created && isolation.generatedPassword) {
        createdLines.push(`${ISOLATION_ACCOUNT.email} ${isolation.generatedPassword}`);
      }
    }
  } finally {
    await client.end();
  }
  const wroteCredentials = createdLines.length > 0 && Boolean(options.credentialsFile);
  if (wroteCredentials && options.credentialsFile) {
    await mkdir(path.dirname(options.credentialsFile), { recursive: true });
    await appendFile(options.credentialsFile, `${createdLines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
  }
  return { createdUsers, wroteCredentials };
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
