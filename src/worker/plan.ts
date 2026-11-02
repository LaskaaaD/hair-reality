import type { AppConfig } from "../server/config.js";

export function workerPlan(config: AppConfig): "fixture" | "probe" | "idle" {
  if (!config.databaseUrl) return "idle";
  if (config.providerMode === "fixture") return "fixture";
  if (config.providerMode !== "live" || !config.operatorProbe) return "idle";
  const youcamReady = config.youcamLiveSubmission
    && Boolean(config.youcamApiKey)
    && Boolean(config.youcamApiBaseUrl)
    && config.providerDownloadHosts.length > 0;
  const openaiReady = config.openaiLiveSubmission && Boolean(config.openaiApiKey);
  return youcamReady || openaiReady ? "probe" : "idle";
}
