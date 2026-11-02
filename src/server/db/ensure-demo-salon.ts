import pg from "pg";

const { Client } = pg;

export async function ensureDemonstrationSalon(connectionString: string): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO salons (slug, name, timezone, branding)
       VALUES ('hair-reality-demo', 'Hair Reality Demo', 'Europe/Warsaw', '{"kind":"demonstration"}'::jsonb)
       ON CONFLICT (slug) DO NOTHING`,
    );
  } catch {
    throw new Error("Demonstration salon could not be prepared.");
  } finally {
    await client.end();
  }
}
