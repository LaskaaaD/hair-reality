import { lookup } from "node:dns/promises";
import https from "node:https";
import type { AppConfig } from "../config.js";
import type { DownloadTarget, DownloadTransport } from "../assets/download.js";
import { OpenAIClient, type OpenAITransport } from "./openai/client.js";
import { YouCamClient, type YouCamTransport } from "./youcam/client.js";

export function createProbeClients(config: AppConfig): { youcam: YouCamClient | null; openai: OpenAIClient | null } {
  const youcam = config.youcamLiveSubmission && config.youcamApiKey && config.youcamApiBaseUrl
    ? new YouCamClient({
      baseUrl: config.youcamApiBaseUrl,
      apiKey: config.youcamApiKey,
      allowlist: config.providerDownloadHosts,
      callMode: "live",
      resolveHost: resolvePublicHost,
      transport: liveYouCamTransport(),
      download: liveDownload(),
    })
    : null;
  const openai = config.openaiLiveSubmission && config.openaiApiKey
    ? new OpenAIClient(liveOpenAITransport(config.openaiTimeoutMs), config.openaiApiKey, config.openaiModel)
    : null;
  return { youcam, openai };
}

function liveYouCamTransport(): YouCamTransport {
  return {
    async request(input) {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        ...(input.body === undefined ? {} : { body: typeof input.body === "string" ? input.body : new Uint8Array(input.body) }),
        redirect: "manual",
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
    },
  };
}

export function liveOpenAITransport(timeoutMs: number): OpenAITransport {
  return async (input) => {
    const response = await fetch(input.url, {
      method: "POST",
      headers: input.headers,
      body: input.body,
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
}

async function resolvePublicHost(hostname: string): Promise<readonly { address: string; family: 4 | 6 }[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => ({ address: record.address, family: record.family === 6 ? 6 : 4 }));
}

function liveDownload(): DownloadTransport {
  return {
    resolve: resolvePublicHost,
    open(target) {
      return openOnce(target);
    },
  };
}

function openOnce(target: DownloadTarget): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: AsyncIterable<Uint8Array> }> {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: target.address,
      servername: target.hostname,
      port: target.port,
      path: target.path,
      method: "GET",
      timeout: target.timeoutMs,
      headers: { host: target.hostname },
    }, (response) => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
      });
    });
    request.once("error", reject);
    request.once("timeout", () => {
      request.destroy(new Error("download timed out"));
    });
    request.end();
  });
}
