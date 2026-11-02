import type { Pool } from "pg";
import type { AppConfig } from "../config.js";
import { BALANCE_MAX_AGE_MS, fresh } from "./caps.js";

export async function refreshStaleYouCamBalance(
  pool: Pool,
  config: AppConfig,
  now: Date,
  readBalance: () => Promise<{ units: number } | null>,
): Promise<void> {
  if (config.providerMode !== "live" || !config.operatorProbe || !config.youcamLiveSubmission) return;
  const current = await pool.query<{ balance_observed_at: Date | null }>(
    `SELECT balance_observed_at
     FROM provider_budget_accounts
     WHERE provider = 'youcam' AND phase = 'development' AND mode = 'live'`,
  );
  const observed = current.rows[0]?.balance_observed_at ?? null;
  if (fresh(observed, now, BALANCE_MAX_AGE_MS)) return;
  const balance = await readBalance();
  if (!balance || !Number.isInteger(balance.units) || balance.units < 0) return;
  await pool.query(
    `UPDATE provider_budget_accounts
     SET balance_units = $1, balance_observed_at = $2
     WHERE provider = 'youcam' AND phase = 'development' AND mode = 'live'`,
    [balance.units, now],
  );
}
