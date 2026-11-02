import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ceilDiv } from "../providers/openai/pricing.js";

/** Spend ledger; tests point OPENAI_DEMO_LEDGER at a temp file so mocks never touch the real one. */
function ledgerPath(): string {
  return process.env.OPENAI_DEMO_LEDGER ?? path.join("var", "openai-demo-ledger.json");
}

export const PROFILE_MODEL = "gpt-5.4";
export const EXPLAIN_MODEL = "gpt-5.4-mini";

export function demoMicro(model: string, inputTokens: number, outputTokens: number): number {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) return 0;
  if (model === PROFILE_MODEL) return ceilDiv(inputTokens * 5, 2) + outputTokens * 15;
  return ceilDiv(inputTokens * 3, 4) + ceilDiv(outputTokens * 9, 2);
}

export async function demoBudgetAllows(capUsd: number, reserveMicro: number): Promise<boolean> {
  const spent = await spentMicro();
  return spent + reserveMicro <= Math.round(capUsd * 1_000_000);
}

export async function recordDemoSpend(micro: number): Promise<void> {
  if (!Number.isSafeInteger(micro) || micro <= 0) return;
  const next = (await spentMicro()) + micro;
  await mkdir(path.dirname(ledgerPath()), { recursive: true });
  await writeFile(ledgerPath(), JSON.stringify({ microDollars: next }));
}

async function spentMicro(): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(), "utf8")) as { microDollars?: unknown };
    return typeof parsed.microDollars === "number" && Number.isSafeInteger(parsed.microDollars) ? parsed.microDollars : 0;
  } catch {
    return 0;
  }
}
