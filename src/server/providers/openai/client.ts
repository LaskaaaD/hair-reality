import {
  IMAGE_DETAIL,
  IMAGE_LIMIT,
  MAX_OUTPUT_TOKENS,
  OPENAI_MODEL_ID,
  RANK_MAX_OUTPUT_TOKENS,
  usageMicro,
} from "./pricing.js";
import {
  instructionsFor,
  outputSchemas,
  userPayload,
  type OpenAIRequest,
} from "./contract.js";

export type OpenAIUsage = { inputTokens: number; outputTokens: number };

export type OpenAICall =
  | { kind: "completed"; text: string; usage: OpenAIUsage | null }
  | { kind: "refused"; usage: OpenAIUsage | null }
  /** The answer stopped early (`reason` is OpenAI's incomplete_details.reason, e.g. max_output_tokens); `text` is the partial output when any came back. */
  | { kind: "incomplete"; usage: OpenAIUsage | null; reason?: string; text?: string }
  | { kind: "malformed"; usage: OpenAIUsage | null }
  | { kind: "failed"; code: "PROVIDER_AUTH" | "PROVIDER_RATE_LIMIT" | "UNSUPPORTED_CONFIGURATION" }
  | { kind: "uncertain"; detail?: string };

export type OpenAITransport = (request: {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Per-request timeout; the transport's own default applies when absent. */
  timeoutMs?: number;
}) => Promise<{ status: number; body: string }>;

export function responseRequest(model: string, request: OpenAIRequest, images: readonly { mimeType: string; base64: string }[]): {
  url: string;
  body: string;
} {
  const content: Record<string, unknown>[] = [
    { type: "input_text", text: userPayload(request) },
  ];
  for (const image of images) {
    content.push({
      type: "input_image",
      image_url: `data:${image.mimeType};base64,${image.base64}`,
      detail: IMAGE_DETAIL,
    });
  }
  const body = {
    model,
    store: false,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: "none" },
    instructions: instructionsFor(request.operation),
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: request.operation,
        strict: true,
        schema: responseSchema(request),
      },
    },
  };
  return { url: "https://api.openai.com/v1/responses", body: JSON.stringify(body) };
}

function responseSchema(request: OpenAIRequest): (typeof outputSchemas)[OpenAIRequest["operation"]] {
  const schema = outputSchemas[request.operation];
  if (request.operation !== "candidate_ranking" || !schema.properties) return schema;
  const item = { type: "string" as const, enum: request.candidateIds };
  return {
    ...schema,
    properties: {
      ...schema.properties,
      rankedIds: { type: "array", maxItems: request.candidateIds.length, items: item },
      omittedIds: { type: "array", maxItems: request.candidateIds.length, items: item },
    },
  };
}

/** Pause before the single retry of a call that hit a transient network error, 429 or 5xx. */
export const RETRY_BACKOFF_MS = 800;

const TRANSIENT_CODES = /UND_ERR_CONNECT_TIMEOUT|ECONNRESET|ETIMEDOUT|UND_ERR_SOCKET|EAI_AGAIN/;

/** True for a failed fetch that a second attempt can fix: connect timeout, reset, dropped socket. Our own request timeout is not retried. */
export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return false;
  return error.message === "fetch failed" || TRANSIENT_CODES.test(errorCode(error));
}

export class OpenAIClient {
  constructor(
    private readonly transport: OpenAITransport,
    private readonly apiKey: string,
    private readonly model = OPENAI_MODEL_ID,
    private readonly retryBackoffMs = RETRY_BACKOFF_MS,
  ) {}

  async respond(request: OpenAIRequest, images: readonly { mimeType: string; base64: string }[] = []): Promise<OpenAICall> {
    if (this.model !== OPENAI_MODEL_ID) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    const prepared = responseRequest(this.model, request, images);
    let response: { status: number; body: string };
    try {
      response = await this.transport({
        url: prepared.url,
        body: prepared.body,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      });
    } catch {
      return { kind: "uncertain" };
    }
    if (response.status === 401) return { kind: "failed", code: "PROVIDER_AUTH" };
    if (response.status === 429) return { kind: "failed", code: "PROVIDER_RATE_LIMIT" };
    if (response.status === 400) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    if (response.status !== 200) return { kind: "uncertain", detail: `status_${response.status}` };
    return interpretBody(response.body);
  }

  // Sends the same payload as generation, including any images. Billing is not published.
  // Callers must already have consent for that external processing.
  async completeJson(input: {
    name: string;
    instructions: string;
    schema: object;
    userText: string;
    model?: string;
    images?: readonly { mimeType: string; base64: string }[];
    /** Send the request once more after a transient network error, 429 or 5xx. Only for calls that never create paid work elsewhere. */
    retryTransient?: boolean;
    /** Output-token ceiling; only the demo_rank call may raise it (up to RANK_MAX_OUTPUT_TOKENS), every other call keeps MAX_OUTPUT_TOKENS. */
    maxOutputTokens?: number;
    /** Timeout of each request, for a call whose answer takes longer than the transport default. */
    timeoutMs?: number;
  }): Promise<OpenAICall> {
    const model = input.model ?? this.model;
    const demoCall = input.name === "demo_vision" || input.name === "demo_notes" || input.name === "demo_rank";
    if (model !== OPENAI_MODEL_ID && !(demoCall && model === "gpt-5.4")) {
      return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    }
    const imageLimit = input.name === "demo_vision" ? 4 : IMAGE_LIMIT;
    if ((input.images?.length ?? 0) > imageLimit) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    const outputCeiling = input.name === "demo_rank" && input.maxOutputTokens !== undefined
      ? Math.max(1, Math.min(RANK_MAX_OUTPUT_TOKENS, Math.floor(input.maxOutputTokens)))
      : MAX_OUTPUT_TOKENS;
    const content: Record<string, unknown>[] = [{ type: "input_text", text: input.userText }];
    for (const image of input.images ?? []) {
      content.push({
        type: "input_image",
        image_url: `data:${image.mimeType};base64,${image.base64}`,
        detail: IMAGE_DETAIL,
      });
    }
    const body = JSON.stringify({
      model,
      store: false,
      max_output_tokens: outputCeiling,
      reasoning: { effort: "none" },
      instructions: input.instructions,
      input: [{ role: "user", content }],
      text: { format: { type: "json_schema", name: input.name, strict: true, schema: input.schema } },
    });
    const headers = { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" };
    const attempts = input.retryTransient ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= attempts;
      let response: { status: number; body: string };
      try {
        response = await this.transport({ url: "https://api.openai.com/v1/responses", body, headers, ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}) });
      } catch (error: unknown) {
        const cause = errorCode(error);
        if (!last && isTransientTransportError(error)) {
          await this.backoff(input.name, `transport_${cause}`);
          continue;
        }
        return { kind: "uncertain", detail: `transport_${cause}${attempt > 1 ? " after_retry" : ""}` };
      }
      if (response.status === 401) return { kind: "failed", code: "PROVIDER_AUTH" };
      if (response.status === 400) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
      if (!last && (response.status === 429 || response.status >= 500)) {
        await this.backoff(input.name, `status_${response.status}`);
        continue;
      }
      if (response.status === 429) return { kind: "failed", code: "PROVIDER_RATE_LIMIT" };
      if (response.status !== 200) return { kind: "uncertain", detail: `status_${response.status}${attempt > 1 ? " after_retry" : ""}` };
      return interpretBody(response.body);
    }
  }

  private async backoff(name: string, reason: string): Promise<void> {
    console.warn(`openai_retry name=${name} reason=${reason} backoffMs=${this.retryBackoffMs}`);
    await new Promise((resolve) => setTimeout(resolve, this.retryBackoffMs));
  }

  async countInput(
    request: OpenAIRequest,
    images: readonly { mimeType: string; base64: string }[] = [],
  ): Promise<{ ok: true; inputTokens: number } | { ok: false }> {
    if (this.model !== OPENAI_MODEL_ID) return { ok: false };
    const prepared = responseRequest(this.model, request, images);
    let response: { status: number; body: string };
    try {
      response = await this.transport({
        url: "https://api.openai.com/v1/responses/input_tokens",
        body: prepared.body,
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      });
    } catch {
      return { ok: false };
    }
    if (response.status !== 200) return { ok: false };
    let payload: unknown;
    try {
      payload = JSON.parse(response.body);
    } catch {
      return { ok: false };
    }
    if (!payload || typeof payload !== "object") return { ok: false };
    const record = payload as Record<string, unknown>;
    if (record.object !== "response.input_tokens" || !Number.isSafeInteger(record.input_tokens)) return { ok: false };
    const inputTokens = record.input_tokens as number;
    if (inputTokens < 1) return { ok: false };
    return { ok: true, inputTokens };
  }
}

function interpretBody(body: string): OpenAICall {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: "malformed", usage: null };
  }
  if (!payload || typeof payload !== "object") return { kind: "malformed", usage: null };
  const record = payload as Record<string, unknown>;
  const usage = readUsage(record.usage);
  const text = outputText(record.output);
  if (record.status === "incomplete") {
    const details = record.incomplete_details;
    const reason = details && typeof details === "object" && typeof (details as { reason?: unknown }).reason === "string" ? (details as { reason: string }).reason : undefined;
    return { kind: "incomplete", usage, ...(reason !== undefined ? { reason } : {}), ...(text.kind === "text" ? { text: text.value } : {}) };
  }
  if (text.kind === "refusal") return { kind: "refused", usage };
  if (text.kind === "missing") return { kind: "malformed", usage };
  return { kind: "completed", text: text.value, usage };
}

function outputText(value: unknown): { kind: "text"; value: string } | { kind: "refusal" } | { kind: "missing" } {
  if (!Array.isArray(value)) return { kind: "missing" };
  let refusal = false;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const typed = part as { type?: unknown; text?: unknown };
      if (typed.type === "refusal") refusal = true;
      if (typed.type === "output_text" && typeof typed.text === "string") return { kind: "text", value: typed.text };
    }
  }
  return refusal ? { kind: "refusal" } : { kind: "missing" };
}

function readUsage(value: unknown): OpenAIUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as { input_tokens?: unknown; output_tokens?: unknown };
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return null;
  if (usageMicro(inputTokens, outputTokens) === null) return null;
  return { inputTokens, outputTokens };
}

/** A secret-free reason for a failed fetch: undici puts the real error (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ...) in cause. */
export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const cause = (error as unknown as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : null;
  const own = typeof (error as unknown as { code?: unknown }).code === "string" ? (error as unknown as { code: string }).code : null;
  return [own ?? error.name, causeCode].filter(Boolean).join(":");
}
