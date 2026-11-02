import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";

export const PRICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BALANCE_MAX_AGE_MS = 60 * 1000;
export const PROBE_DEVELOPMENT_CAP = 100;
export const LEASE_MS = 60_000;
export const RENEW_MS = 20_000;
export const POLL_STEPS_MS = [2_000, 4_000, 8_000] as const;
export const POLL_CAP_MS = 10_000;
export const ACTIVE_STATES = [
  "QUEUED",
  "CLAIMED",
  "UPLOADING",
  "SUBMITTING",
  "RUNNING",
  "SUBMISSION_UNCERTAIN",
] as const;

export const QUOTAS = {
  activePerConsultation: 1,
  youcamGlobal: 2,
  openaiGlobal: 1,
  previewsPerConsultation: 6,
  previewsPerAccountPerDay: 10,
} as const;

export type Exposure = {
  settled: number;
  reserved: number;
  uncertain: number;
};

export function exposureOf(exposure: Exposure): number {
  return exposure.settled + exposure.reserved + exposure.uncertain;
}

export function openaiCapMicro(usd: number): number {
  if (!Number.isInteger(usd) || usd < 0 || usd > 6) {
    throw new Error("OpenAI cap must be an integer number of dollars from 0 to 6");
  }
  return usd * 1_000_000;
}

export function phaseCap(provider: "youcam" | "openai", phase: "development" | "demo", config: AppConfig): number {
  if (provider === "openai") return openaiCapMicro(config.openaiBudgetUsd);
  return phase === "development" ? config.youcamDevCap : config.youcamDemoCap;
}

export function totalCap(provider: "youcam" | "openai", config: AppConfig): number {
  if (provider === "openai") return openaiCapMicro(config.openaiBudgetUsd);
  return config.youcamTotalCap;
}

export function fresh(observedAt: Date | null, now: Date, maxAgeMs: number): boolean {
  if (!observedAt) return false;
  return now.getTime() - observedAt.getTime() <= maxAgeMs && now.getTime() >= observedAt.getTime();
}

export function jobFingerprint(parts: {
  ownerId: string;
  assetHashes: readonly string[];
  operation: string;
  provider: string;
  providerVersion: string;
  configuration: string;
  inputVersion: number | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    assetHashes: [...parts.assetHashes].sort(),
    configuration: parts.configuration,
    inputVersion: parts.inputVersion,
    operation: parts.operation,
    ownerId: parts.ownerId,
    provider: parts.provider,
    providerVersion: parts.providerVersion,
  })).digest("hex");
}

export function requestHash(consultationId: string, body: unknown): string {
  return createHash("sha256").update(JSON.stringify({ body, consultationId })).digest("hex");
}

export function leaseDurationMs(mode: AppConfig["providerMode"], env: NodeJS.ProcessEnv = process.env): number {
  if (mode === "live") return LEASE_MS;
  return boundedOverride(env.JOB_LEASE_MS, LEASE_MS);
}

export function renewDurationMs(mode: AppConfig["providerMode"], env: NodeJS.ProcessEnv = process.env): number {
  if (mode === "live") return RENEW_MS;
  return boundedOverride(env.JOB_RENEW_MS, RENEW_MS);
}

export function nextPollDelayMs(attempt: number, mode: AppConfig["providerMode"], env: NodeJS.ProcessEnv = process.env): number {
  if (mode !== "live" && env.JOB_POLL_MS === "0") return 0;
  const step = POLL_STEPS_MS[Math.min(attempt, POLL_STEPS_MS.length - 1)] ?? POLL_CAP_MS;
  return Math.min(step, POLL_CAP_MS);
}

function boundedOverride(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (parsed < 0 || parsed > fallback) return fallback;
  return parsed;
}
