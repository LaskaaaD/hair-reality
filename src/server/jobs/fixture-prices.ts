import type { Pool } from "pg";

const FIXTURE_PRICES = [
  ["youcam", "analysis", 2],
  ["youcam", "preview", 2],
  ["youcam", "probe", 1],
  ["openai", "interpretation", 1],
] as const;

/** Fixture admission prices are local placeholders. They are not provider invoices. */
export async function ensureFixturePrices(pool: Pool, observedAt: Date): Promise<void> {
  for (const [provider, operation, units] of FIXTURE_PRICES) {
    const updated = await pool.query(
      `UPDATE provider_price_observations
       SET observed_at = $1
       WHERE provider = $2 AND mode = 'fixture' AND operation = $3`,
      [observedAt, provider, operation],
    );
    if ((updated.rowCount ?? 0) === 0) {
      await pool.query(
        `INSERT INTO provider_price_observations (provider, mode, operation, units, observed_at)
         VALUES ($1, 'fixture', $2, $3, $4)`,
        [provider, operation, units, observedAt],
      );
    }
  }
}
