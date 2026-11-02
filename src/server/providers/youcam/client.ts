import { isIP } from "node:net";
import sharp from "sharp";
import { downloadProviderArtifact, isBlockedAddress, type DownloadTransport } from "../../assets/download.js";
import type { PrivateStorage } from "../../assets/storage.js";
import {
  BEARD_TEMPLATE_PATH,
  CAPABILITY_CONTRACTS,
  CREDIT_BALANCE_PATH,
  VERIFIED_IMAGE_CONTENT_TYPE,
  CREDIT_HISTORY_PATH,
  FACE_ANGLE_LEVELS,
  FACE_FEATURE_LABELS,
  FEATURE_COST_PATH,
  FRIZZ_TERMS,
  HAIR_COLOR_PRESETS,
  HAIR_DENSITY_TERMS,
  HAIR_LENGTH_TERMS,
  HAIR_TYPE_MAPPINGS,
  HAIR_TYPE_TERMS,
  HAIRSTYLE_TEMPLATE_PATH,
  TASK_RETENTION_MS,
  YOUCAM_CONTRACT_VERSION,
  type YouCamCapability,
} from "./contract.js";
import { preparePhotos, type PreparedPhoto } from "./prepare.js";
import { addressesAllowed, nextRedirect, validateTransferUrl } from "./transfer.js";

export type YouCamCode =
  | "INVALID_PHOTO"
  | "RETAKE_REQUIRED"
  | "PROVIDER_AUTH"
  | "PROVIDER_QUOTA"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "UNSUPPORTED_CONFIGURATION"
  | "SUBMISSION_UNCERTAIN"
  | "RESULT_EXPIRED";

export type YouCamTransport = {
  request(input: {
    method: "GET" | "POST" | "PUT";
    url: string;
    headers: Record<string, string>;
    body?: Buffer | string;
  }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
};

export type PublicEvidence = {
  capability: YouCamCapability;
  contractVersion: string;
  fixture: "synthetic-documentation-derived";
  values: Record<string, unknown>;
  unknown: string[];
  withheld: string[];
};

export type YouCamRunResult =
  | { kind: "accepted"; taskId: string }
  | { kind: "uncertain" }
  | { kind: "running" }
  | { kind: "failed"; code: YouCamCode; providerError?: string | null; detail?: string }
  | { kind: "succeeded"; evidence: PublicEvidence; downloadUrl: string | null };

export type HistoryCharge =
  | { outcome: "not_billed" }
  | { outcome: "billed"; units: number }
  | { outcome: "unresolved" };

type Inventory<T> = { complete: boolean; items: T[]; reason: string | null };

export const FACE_ANGLE_ERROR = "The face angle is not within the supported range. For front-facing photos, keep the head within 10°; for side-facing photos, use more than 15°.";
export const NO_FACE_ERROR = "No face was detected in the source image.";

const RETAKE = new Set([
  "error_below_min_image_size",
  "error_exceed_max_image_size",
  "error_mismatch_image_size",
  "error_face_position_invalid",
  "error_face_position_too_small",
  "error_face_position_out_of_boundary",
  "error_insufficient_lighting",
  "error_face_angle_invalid",
  "error_face_angle_upward",
  "error_face_angle_downward",
  "error_face_angle_leftward",
  "error_face_angle_rightward",
  "error_face_angle_left_tilt",
  "error_face_angle_right_tilt",
  "error_no_face",
  "error_pose",
  "exceed_max_filesize",
]);

export class YouCamClient {
  constructor(private readonly options: {
    transport: YouCamTransport;
    baseUrl: string;
    apiKey: string;
    allowlist: readonly string[];
    callMode: "live" | "synthetic";
    resolveHost?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
    download?: DownloadTransport;
  }) {}

  async listFeatureCosts(): Promise<Inventory<{ runTaskUrl: string; units: number }>> {
    return this.pages(FEATURE_COST_PATH, (body) => {
      const result = objectAt(body, "result");
      if (!result || !Array.isArray(result.skus)) return null;
      const items: { runTaskUrl: string; units: number }[] = [];
      for (const sku of result.skus) {
        if (!isRecord(sku) || typeof sku.run_task_url !== "string" || typeof sku.amount !== "number") return null;
        if (!Number.isInteger(sku.amount) || sku.amount < 0) return null;
        items.push({ runTaskUrl: sku.run_task_url, units: sku.amount });
      }
      return { items, next: tokenOf(result.next_token) };
    });
  }

  async readBalance(): Promise<{ ok: true; units: number } | { ok: false; code: YouCamCode }> {
    const response = await this.api("GET", CREDIT_BALANCE_PATH);
    if (response.kind !== "json") return { ok: false, code: response.kind === "transport" ? "PROVIDER_UNAVAILABLE" : "PROVIDER_RESPONSE_INVALID" };
    const mapped = mapStatus(response.status, response.body);
    if (mapped) return { ok: false, code: mapped };
    if (!Array.isArray(response.body.results)) return { ok: false, code: "PROVIDER_RESPONSE_INVALID" };
    let total = 0;
    for (const row of response.body.results) {
      if (!isRecord(row) || typeof row.amount_dec !== "number" || !Number.isInteger(row.amount_dec)) {
        return { ok: false, code: "PROVIDER_RESPONSE_INVALID" };
      }
      total += row.amount_dec;
    }
    return { ok: true, units: total };
  }

  async listUsage(): Promise<Inventory<{ action: string; targetId: string; units: number }>> {
    return this.pages(CREDIT_HISTORY_PATH, (body) => {
      const result = objectAt(body, "result");
      if (!result || !Array.isArray(result.history)) return null;
      const items: { action: string; targetId: string; units: number }[] = [];
      for (const row of result.history) {
        if (!isRecord(row) || typeof row.action !== "string" || typeof row.target_id !== "string") return null;
        const units = creditUnits(row.info);
        if (units === null) return null;
        items.push({ action: row.action, targetId: row.target_id, units });
      }
      return { items, next: tokenOf(result.next_token) };
    });
  }

  async discoverTemplates(): Promise<Inventory<TemplateCard>> {
    return this.pages(HAIRSTYLE_TEMPLATE_PATH, readHairstyleTemplates);
  }

  async discoverBeardTemplates(): Promise<Inventory<TemplateCard>> {
    return this.pages(BEARD_TEMPLATE_PATH, readBeardTemplates);
  }

  async run(input: {
    capability: YouCamCapability;
    photos: readonly { role: string; bytes: Buffer }[];
    controls: Record<string, unknown>;
    providerTaskId: string | null;
    now: Date;
    submittedAt: Date | null;
    referenceBytes?: Buffer;
  }): Promise<YouCamRunResult> {
    const contract = CAPABILITY_CONTRACTS[input.capability];
    if (input.providerTaskId) {
      if (input.submittedAt && input.now.getTime() - input.submittedAt.getTime() > TASK_RETENTION_MS) {
        return { kind: "failed", code: "RESULT_EXPIRED" };
      }
      return this.poll(input.capability, input.providerTaskId);
    }
    if (this.options.callMode === "live" && (contract.liveBlockers.length > 0 || this.options.allowlist.length === 0)) {
      return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    }
    let controls = input.controls;
    if (input.referenceBytes) {
      if (input.capability !== "hairstyle" || Object.keys(controls).length > 0) {
        return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
      }
      const preparedRef = await preparePhotos("hairstyle", [{ role: "source", bytes: input.referenceBytes }]);
      if (!preparedRef.ok) return { kind: "failed", code: preparedRef.reason === "invalid_photo" ? "INVALID_PHOTO" : "UNSUPPORTED_CONFIGURATION" };
      const uploadedRef = await this.uploadAll("hairstyle", preparedRef.photos);
      if (!uploadedRef.ok) return uploadedRef.result;
      const refId = uploadedRef.fileIds[0];
      if (!refId) return { kind: "uncertain" };
      controls = { ref_file_id: refId, hair_color: "src" };
    }
    const prepared = await preparePhotos(input.capability, input.photos);
    if (!prepared.ok) return { kind: "failed", code: prepared.reason === "invalid_photo" ? "INVALID_PHOTO" : "UNSUPPORTED_CONFIGURATION" };
    if (!sameRoles(contract.photos, prepared.photos)) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    const built = buildTaskBody(input.capability, controls, this.options.callMode);
    if (!built.ok) return { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" };
    const uploaded = await this.uploadAll(input.capability, prepared.photos);
    if (!uploaded.ok) return uploaded.result;
    const fileIds = uploaded.fileIds;
    const body = built.body(fileIds);
    const submitted = await this.api("POST", contract.taskPost, body);
    if (submitted.kind !== "json" || submitted.status >= 500) return { kind: "uncertain" };
    const mapped = mapStatus(submitted.status, submitted.body);
    if (mapped) return { kind: "failed", code: mapped, detail: statusDetail("submit", submitted.status, submitted.body) };
    const data = objectAt(submitted.body, "data");
    const taskId = data && typeof data.task_id === "string" && data.task_id.length > 0 ? data.task_id : null;
    if (!taskId) return { kind: "uncertain" };
    return { kind: "accepted", taskId };
  }

  async readResult(url: string): Promise<Buffer | null> {
    if (!this.options.download) return null;
    const downloaded = await downloadProviderArtifact({
      url,
      allowlist: this.options.allowlist,
      transport: this.options.download,
    });
    return downloaded.ok ? downloaded.image.bytes : null;
  }

  private async poll(capability: YouCamCapability, taskId: string): Promise<YouCamRunResult> {
    const path = CAPABILITY_CONTRACTS[capability].taskPoll.replace("{task_id}", encodeURIComponent(taskId));
    const response = await this.api("GET", path);
    if (response.kind !== "json" || response.status >= 500) return { kind: "running" };
    const mapped = mapStatus(response.status, response.body);
    if (mapped) return { kind: "failed", code: mapped, detail: statusDetail("poll", response.status, response.body) };
    return parseSuccess(capability, response.body);
  }

  private async uploadAll(
    capability: YouCamCapability,
    photos: readonly PreparedPhoto[],
  ): Promise<{ ok: true; fileIds: string[] } | { ok: false; result: YouCamRunResult }> {
    const contract = CAPABILITY_CONTRACTS[capability];
    const filePath = contract.filePost ?? (this.options.callMode === "synthetic" ? "/synthetic/documentation-gap/file" : null);
    if (!filePath) return { ok: false, result: { kind: "failed", code: "UNSUPPORTED_CONFIGURATION" } };
    const fileIds: string[] = [];
    for (const photo of photos) {
      const wireBytes = await jpegWireBytes(photo);
      if (!wireBytes) return { ok: false, result: { kind: "failed", code: "INVALID_PHOTO", detail: `wire_bytes_rejected role=${photo.role}` } };
      const prepared = await this.api("POST", filePath, {
        files: [{
          content_type: VERIFIED_IMAGE_CONTENT_TYPE,
          file_name: `${photo.role}.jpg`,
          file_size: wireBytes.length,
        }],
      });
      if (prepared.kind !== "json") return { ok: false, result: { kind: "failed", code: "PROVIDER_UNAVAILABLE", detail: `file_init_${prepared.kind} role=${photo.role}` } };
      const instruction = uploadInstruction(prepared.body);
      if (!instruction) return { ok: false, result: { kind: "failed", code: "PROVIDER_RESPONSE_INVALID", detail: statusDetail("file_init_no_instruction", prepared.status, prepared.body) } };
      const uploaded = await this.putBytes(instruction, wireBytes);
      if (uploaded !== null) return { ok: false, result: { kind: "failed", code: "PROVIDER_UNAVAILABLE", detail: `file_put_${uploaded} role=${photo.role} bytes=${wireBytes.length}` } };
      fileIds.push(instruction.fileId);
    }
    return { ok: true, fileIds };
  }

  /** Returns null on success, otherwise a short secret-free reason. */
  private async putBytes(instruction: UploadInstruction, bytes: Buffer): Promise<string | null> {
    let current = instruction.url;
    for (let hop = 0; hop <= 3; hop += 1) {
      const target = validateTransferUrl(current, this.options.allowlist);
      if (!target.ok) return "url_not_allowed";
      const resolved = await this.resolve(target.url.hostname);
      if (!resolved) return `dns_rejected host=${target.url.hostname}`;
      const headers = { ...instruction.headers };
      delete headers.authorization;
      delete headers.Authorization;
      for (const [name, value] of Object.entries(headers)) {
        if (value.includes(this.options.apiKey)) delete headers[name];
      }
      let response;
      let firstError: string | null = null;
      for (let attempt = 1; attempt <= UPLOAD_PUT_ATTEMPTS; attempt += 1) {
        try {
          response = await this.options.transport.request({
            method: instruction.method,
            url: target.url.toString(),
            headers,
            body: bytes,
          });
          break;
        } catch (error: unknown) {
          const reason = transportReason(error);
          if (attempt < UPLOAD_PUT_ATTEMPTS) {
            firstError = reason;
            console.warn(`youcam_file_put_retry host=${target.url.hostname} bytes=${bytes.length} reason=${reason}`);
            await new Promise((resolve) => setTimeout(resolve, UPLOAD_PUT_RETRY_DELAY_MS));
            continue;
          }
          return `transport_${reason}${firstError ? ` first=${firstError}` : ""} host=${target.url.hostname}`;
        }
      }
      if (!response) return `transport_none host=${target.url.hostname}`;
      const location = response.headers.location ?? response.headers.Location;
      const redirect = nextRedirect(response.status, location, target.url, hop);
      if (redirect === "limit") return "redirect_limit";
      if (redirect) {
        current = redirect.toString();
        continue;
      }
      return response.status >= 200 && response.status < 300 ? null : `status_${response.status} host=${target.url.hostname}`;
    }
    return "redirect_limit";
  }

  private async resolve(hostname: string): Promise<boolean> {
    if (isIP(hostname) !== 0) return !isBlockedAddress(hostname);
    if (!this.options.resolveHost) return false;
    try {
      const records = await this.options.resolveHost(hostname);
      return addressesAllowed(records);
    } catch {
      return false;
    }
  }

  private async api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ kind: "json"; status: number; body: Record<string, unknown> } | { kind: "transport" } | { kind: "invalid" }> {
    const url = new URL(path, this.options.baseUrl);
    if (url.origin !== new URL(this.options.baseUrl).origin) return { kind: "invalid" };
    try {
      const response = await this.options.transport.request({
        method,
        url: url.toString(),
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const parsed = parseJson(response.body);
      if (!parsed) return { kind: "invalid" };
      return { kind: "json", status: response.status, body: parsed };
    } catch {
      return { kind: "transport" };
    }
  }

  private async pages<T>(
    path: string,
    read: (body: Record<string, unknown>) => { items: T[]; next: string | null } | null,
  ): Promise<Inventory<T>> {
    const items: T[] = [];
    let token: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const query = token === null ? "?page_size=20" : `?page_size=20&starting_token=${encodeURIComponent(token)}`;
      const response = await this.api("GET", `${path}${query}`);
      if (response.kind !== "json" || mapStatus(response.status, response.body)) {
        return { complete: false, items: [], reason: "page_failed" };
      }
      const parsed = read(response.body);
      if (!parsed) return { complete: false, items: [], reason: "page_invalid" };
      items.push(...parsed.items);
      if (parsed.next === null) return { complete: true, items, reason: null };
      token = parsed.next;
    }
    return { complete: false, items: [], reason: "page_limit" };
  }
}

export async function storeProviderImage(options: {
  url: string;
  allowlist: readonly string[];
  transport: DownloadTransport;
  storage: PrivateStorage;
  key: string;
}): Promise<{ ok: true; evidence: { stored: true; width: number; height: number } } | { ok: false; code: YouCamCode }> {
  try {
    const downloaded = await downloadProviderArtifact({
      url: options.url,
      allowlist: options.allowlist,
      transport: options.transport,
    });
    if (!downloaded.ok) return { ok: false, code: "PROVIDER_UNAVAILABLE" };
    await options.storage.write(options.key, downloaded.image.bytes);
    return { ok: true, evidence: { stored: true, width: downloaded.image.width, height: downloaded.image.height } };
  } catch {
    return { ok: false, code: "PROVIDER_UNAVAILABLE" };
  }
}

type UploadInstruction = { fileId: string; url: string; method: "PUT" | "POST"; headers: Record<string, string> };

function uploadInstruction(body: Record<string, unknown>): UploadInstruction | null {
  const data = objectAt(body, "data");
  const files = data && Array.isArray(data.files) ? data.files : null;
  const file = files && isRecord(files[0]) ? files[0] : null;
  const requests = file && Array.isArray(file.requests) ? file.requests : null;
  const request = requests && isRecord(requests[0]) ? requests[0] : null;
  if (!file || typeof file.file_id !== "string" || !request) return null;
  if (typeof request.url !== "string" || (request.method !== "PUT" && request.method !== "POST")) return null;
  const headers: Record<string, string> = {};
  if (isRecord(request.headers)) {
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  return { fileId: file.file_id, url: request.url, method: request.method, headers };
}

function buildTaskBody(
  capability: YouCamCapability,
  controls: Record<string, unknown>,
  callMode: "live" | "synthetic",
): { ok: true; body: (fileIds: string[]) => Record<string, unknown> } | { ok: false } {
  const keys = Object.keys(controls);
  if (capability === "hair-type" || capability === "hair-length" || capability === "hair-density" || capability === "hair-frizziness") {
    if (keys.length > 0) return { ok: false };
    return { ok: true, body: (fileIds) => fileRef(capability, fileIds) };
  }
  if (capability === "face-attributes") {
    if (keys.some((key) => key !== "features" && key !== "face_angle_strictness_level")) return { ok: false };
    if (!Array.isArray(controls.features) || controls.features.length === 0) return { ok: false };
    if (!controls.features.every((feature) => typeof feature === "string" && (FACE_FEATURE_LABELS as readonly string[]).includes(feature))) {
      return { ok: false };
    }
    if (!validAngle(controls.face_angle_strictness_level)) return { ok: false };
    return {
      ok: true,
      body: (fileIds) => ({
        src_file_id: fileIds[0],
        features: controls.features,
        ...(controls.face_angle_strictness_level === undefined ? {} : { face_angle_strictness_level: controls.face_angle_strictness_level }),
      }),
    };
  }
  if (capability === "facial-color-tones") {
    if (keys.some((key) => key !== "face_angle_strictness_level")) return { ok: false };
    if (!validAngle(controls.face_angle_strictness_level)) return { ok: false };
    return {
      ok: true,
      body: (fileIds) => ({
        src_file_id: fileIds[0],
        ...(controls.face_angle_strictness_level === undefined ? {} : { face_angle_strictness_level: controls.face_angle_strictness_level }),
      }),
    };
  }
  if (capability === "hairstyle") {
    const hairColor = controls.hair_color;
    if (hairColor !== undefined && hairColor !== "src" && hairColor !== "ref") return { ok: false };
    const rest = keys.filter((key) => key !== "hair_color");
    if (rest.length === 1 && rest[0] === "ref_file_id" && typeof controls.ref_file_id === "string" && acceptedReferenceFileId(controls.ref_file_id)) {
      return {
        ok: true,
        body: (fileIds) => ({
          src_file_id: fileIds[0],
          ref_file_id: controls.ref_file_id,
          hair_color: hairColor === "ref" ? "ref" : "src",
        }),
      };
    }
    if (hairColor !== undefined) return { ok: false };
    if (rest.some((key) => key !== "template_id")) return { ok: false };
    if (typeof controls.template_id !== "string" || !acceptedTemplateId(controls.template_id, callMode)) return { ok: false };
    return { ok: true, body: (fileIds) => ({ src_file_id: fileIds[0], template_id: controls.template_id }) };
  }
  if (capability === "beard") {
    if (keys.some((key) => key !== "template_id")) return { ok: false };
    if (typeof controls.template_id !== "string" || !acceptedTemplateId(controls.template_id, callMode)) return { ok: false };
    return { ok: true, body: (fileIds) => ({ src_file_id: fileIds[0], template_id: controls.template_id }) };
  }
  if (keys.some((key) => key !== "preset" && key !== "pattern" && key !== "palettes")) return { ok: false };
  if (controls.preset !== undefined && (controls.pattern !== undefined || controls.palettes !== undefined)) return { ok: false };
  if (typeof controls.preset === "string") {
    if (!(HAIR_COLOR_PRESETS as readonly string[]).includes(controls.preset)) return { ok: false };
    return { ok: true, body: (fileIds) => ({ src_file_id: fileIds[0], preset: controls.preset }) };
  }
  if (!isRecord(controls.pattern) || !Array.isArray(controls.palettes)) return { ok: false };
  if (controls.pattern.name !== "full" && controls.pattern.name !== "ombre") return { ok: false };
  const colors = controls.palettes.every((entry) => isRecord(entry) && typeof entry.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(entry.color));
  if (!colors) return { ok: false };
  if (controls.pattern.name === "full" && controls.palettes.length !== 1) return { ok: false };
  if (controls.pattern.name === "ombre") {
    if (controls.palettes.length !== 2) return { ok: false };
    if (controls.pattern.coloring_section !== "top") return { ok: false };
    if (typeof controls.pattern.blend_strength !== "number" || controls.pattern.blend_strength < 0 || controls.pattern.blend_strength > 100) return { ok: false };
    if (typeof controls.pattern.line_offset !== "number" || controls.pattern.line_offset < -0.99 || controls.pattern.line_offset > 0.99) return { ok: false };
  }
  return { ok: true, body: (fileIds) => ({ src_file_id: fileIds[0], pattern: controls.pattern, palettes: controls.palettes }) };
}

function fileRef(capability: YouCamCapability, fileIds: string[]): Record<string, unknown> {
  if (capability === "hair-type" || capability === "hair-frizziness") return { src_file_ids: fileIds };
  return { src_file_id: fileIds[0] };
}

function acceptedReferenceFileId(value: string): boolean {
  return value.length >= 8 && value.length <= 400 && !/[\s"'<>]/.test(value);
}

export function acceptedTemplateId(value: string, callMode: "live" | "synthetic"): boolean {
  if (value.length < 1 || value.length > 80) return false;
  if (callMode === "synthetic") return value.startsWith("synthetic-template-");
  if (value.startsWith("synthetic-template-")) return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function validAngle(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && (FACE_ANGLE_LEVELS as readonly string[]).includes(value);
}

function parseSuccess(capability: YouCamCapability, body: Record<string, unknown>): YouCamRunResult {
  const data = objectAt(body, "data");
  if (data && (data.task_status === "running" || data.task_status === "success" || data.task_status === "error")) {
    if (data.task_status === "running") return { kind: "running" };
    if (data.task_status === "error") {
      const error = typeof data.error === "string" ? data.error : "";
      return { kind: "failed", code: classifyTaskError(error), providerError: error.length > 0 ? error : null, detail: `task_error=${error.slice(0, 120) || "empty"}` };
    }
    const results = objectAt(data, "results");
    if (!results) return { kind: "failed", code: "PROVIDER_RESPONSE_INVALID" };
    if (typeof results.url === "string") {
      return { kind: "succeeded", evidence: imageEvidence(capability), downloadUrl: results.url };
    }
    const evidence = normalizeAnalysis(capability, results);
    if (!evidence) return { kind: "failed", code: "PROVIDER_RESPONSE_INVALID" };
    return { kind: "succeeded", evidence, downloadUrl: null };
  }
  if (typeof body.url === "string") {
    return { kind: "succeeded", evidence: imageEvidence(capability), downloadUrl: body.url };
  }
  return { kind: "failed", code: "PROVIDER_RESPONSE_INVALID" };
}

function imageEvidence(capability: YouCamCapability): PublicEvidence {
  return {
    capability,
    contractVersion: YOUCAM_CONTRACT_VERSION,
    fixture: "synthetic-documentation-derived",
    values: { stored: false },
    unknown: [],
    withheld: [],
  };
}

function normalizeAnalysis(capability: YouCamCapability, results: Record<string, unknown>): PublicEvidence | null {
  const unknown: string[] = [];
  const withheld: string[] = [];
  if (capability === "hair-type") {
    const hair = objectAt(results, "hair_type");
    if (!hair) return null;
    return evidence(capability, {
      mapping: known(hair.mapping, HAIR_TYPE_MAPPINGS, unknown, "mapping"),
      term: known(hair.term, HAIR_TYPE_TERMS, unknown, "term"),
    }, unknown, withheld);
  }
  if (capability === "hair-length") {
    const hair = objectAt(results, "hair_length");
    if (!hair) return null;
    return evidence(capability, { term: known(hair.term, HAIR_LENGTH_TERMS, unknown, "term") }, unknown, withheld);
  }
  if (capability === "hair-density") {
    const hair = objectAt(results, "hair_density");
    if (!hair) return null;
    const mapping = typeof hair.mapping === "string" && /^-?\d+(\.\d+)?$/.test(hair.mapping) ? hair.mapping : null;
    if (mapping === null) unknown.push("mapping");
    return evidence(capability, {
      mapping: mapping ?? { known: false },
      term: known(hair.term, HAIR_DENSITY_TERMS, unknown, "term"),
    }, unknown, withheld);
  }
  if (capability === "hair-frizziness") {
    const hair = objectAt(results, "hair_frizziness");
    if (!hair) return null;
    const mapping = hair.mapping === 0 || hair.mapping === 1 || hair.mapping === 2 || hair.mapping === 3 ? hair.mapping : null;
    if (mapping === null) unknown.push("mapping");
    return evidence(capability, {
      mapping: mapping ?? { known: false },
      term: known(hair.term, FRIZZ_TERMS, unknown, "term"),
    }, unknown, withheld);
  }
  if (capability === "face-attributes") {
    withheld.push("agegender", "eyebrow", "eyelid", "cheekbone", "nose", "lipshape", "color", "attractiveness");
    const ratio = objectAt(results, "facialratio");
    if (typeof results.faceshape !== "string" || !ratio) return null;
    const horizontalThird = ratioNumbers(ratio, "horizontal_third", 3) ?? ratioNumbers(ratio, "horizontalThird", 3);
    const verticalFifth = ratioNumbers(ratio, "vertical_fifth", 5) ?? ratioNumbers(ratio, "verticalFifth", 5);
    const faceAspectRatio = ratioNumbers(ratio, "face_aspect_ratio", 2) ?? ratioNumbers(ratio, "faceAspectRatio", 2);
    if (!horizontalThird) unknown.push("horizontalThird");
    if (!verticalFifth) unknown.push("verticalFifth");
    if (!faceAspectRatio) unknown.push("faceAspectRatio");
    return evidence(capability, {
      faceshape: results.faceshape,
      horizontalThird: horizontalThird ?? { known: false },
      verticalFifth: verticalFifth ?? { known: false },
      faceAspectRatio: faceAspectRatio ?? { known: false },
    }, unknown, withheld);
  }
  if (capability === "facial-color-tones") {
    const color = objectAt(results, "color");
    if (!color) return null;
    withheld.push("face_quality", "attractiveness", "agegender");
    return evidence(capability, {
      skin_color: color.skin_color ?? { known: false },
      hair_color: color.hair_color ?? { known: false },
      hair_color_name: color.hair_color_name ?? { known: false },
      eye_color: color.eye_color ?? { known: false },
      eye_color_name: color.eye_color_name ?? { known: false },
      eyebrow_color: color.eyebrow_color ?? { known: false },
      lip_color: color.lip_color ?? { known: false },
    }, unknown, withheld);
  }
  return null;
}

function evidence(
  capability: YouCamCapability,
  values: Record<string, unknown>,
  unknown: string[],
  withheld: string[],
): PublicEvidence {
  return {
    capability,
    contractVersion: YOUCAM_CONTRACT_VERSION,
    fixture: "synthetic-documentation-derived",
    values,
    unknown,
    withheld,
  };
}

function ratioNumbers(record: Record<string, unknown>, key: string, length: number): number[] | null {
  const value = record[key];
  if (!Array.isArray(value) || value.length !== length) return null;
  if (!value.every((item) => typeof item === "number" && Number.isInteger(item))) return null;
  return value;
}

function known(value: unknown, allowed: readonly string[], unknown: string[], field: string): unknown {
  if (typeof value === "string" && allowed.includes(value)) return value;
  unknown.push(field);
  return { known: false };
}

/** A presigned PUT is free (YouCam bills per task), so one retry after a transport drop costs no units. */
const UPLOAD_PUT_ATTEMPTS = 2;
const UPLOAD_PUT_RETRY_DELAY_MS = 1500;

/** undici reports "TypeError: fetch failed" and hides the real reason (ECONNRESET, UND_ERR_CONNECT_TIMEOUT, ...) in cause. */
export function transportReason(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const own = (error as unknown as { code?: unknown }).code;
  const cause = (error as { cause?: unknown }).cause;
  const causeCode = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  const causeName = cause instanceof Error ? cause.name : undefined;
  const parts = [typeof own === "string" ? own : error.name];
  if (typeof causeCode === "string") parts.push(causeCode);
  else if (causeName) parts.push(causeName);
  return parts.join(":");
}

function statusDetail(stage: string, status: number, body: Record<string, unknown>): string {
  const code = typeof body.error_code === "string" ? body.error_code.slice(0, 60) : "";
  const message = typeof body.error === "string" ? body.error.replace(/\s+/g, " ").slice(0, 120) : "";
  return `${stage}_status_${status}${code ? ` error_code=${code}` : ""}${message ? ` error=${message}` : ""}`;
}

function mapStatus(status: number, body: Record<string, unknown>): YouCamCode | null {
  const code = typeof body.error_code === "string" ? body.error_code : "";
  if (status === 401 || code === "InvalidApiKey" || code === "InactiveApiKey" || code === "ExpiredApiKey") return "PROVIDER_AUTH";
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (code === "CreditInsufficiency") return "PROVIDER_QUOTA";
  if (code === "InvalidTaskId") return "RESULT_EXPIRED";
  if (code === "InvalidStyle" || code === "InvalidStyleGroup" || code === "InvalidParameters" || code === "BadRequest") {
    return "UNSUPPORTED_CONFIGURATION";
  }
  if (status === 500 || code === "TaskTimeout") return "PROVIDER_UNAVAILABLE";
  if (status >= 200 && status < 300) return null;
  return "PROVIDER_RESPONSE_INVALID";
}

function sameRoles(expected: readonly string[], photos: readonly PreparedPhoto[]): boolean {
  if (expected.length !== photos.length) return false;
  return expected.every((role, index) => photos[index]?.role === role);
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

async function jpegWireBytes(photo: PreparedPhoto): Promise<Buffer | null> {
  try {
    const bytes = photo.mimeType === "image/jpeg"
      ? photo.bytes
      : await sharp(photo.bytes).jpeg({ quality: 90 }).toBuffer();
    if (bytes.length === 0 || bytes.length >= MAX_UPLOAD_BYTES) return null;
    return bytes;
  } catch {
    return null;
  }
}

export type TemplateCard = { id: string; title: string; thumb: string };

const BEARD_TEMPLATE_FIELDS = ["category_name", "id", "thumb", "title"];

function readBeardTemplates(body: Record<string, unknown>): { items: TemplateCard[]; next: string | null } | null {
  const top = Object.keys(body).sort();
  if (top.length !== 2 || top[0] !== "data" || top[1] !== "status" || body.status !== 200) return null;
  const data = objectAt(body, "data");
  if (!data || !Object.hasOwn(data, "templates") || !Object.hasOwn(data, "next_token")) return null;
  const dataKeys = Object.keys(data).sort();
  if (dataKeys.length !== 2 || dataKeys[0] !== "next_token" || dataKeys[1] !== "templates") return null;
  if (!Array.isArray(data.templates)) return null;
  if (data.next_token !== null && typeof data.next_token !== "string") return null;
  if (data.next_token === "") return null;
  const items: TemplateCard[] = [];
  for (const row of data.templates) {
    if (!isRecord(row)) return null;
    const keys = Object.keys(row).sort();
    if (keys.length !== BEARD_TEMPLATE_FIELDS.length || BEARD_TEMPLATE_FIELDS.some((field, index) => keys[index] !== field)) return null;
    const card = templateCard(row);
    if (!card || typeof row.category_name !== "string" || row.category_name.length === 0) return null;
    items.push(card);
  }
  return { items, next: tokenOf(data.next_token) };
}

function readHairstyleTemplates(body: Record<string, unknown>): { items: TemplateCard[]; next: string | null } | null {
  const data = objectAt(body, "data");
  if (!data || !Array.isArray(data.templates)) return null;
  if (data.next_token !== undefined && data.next_token !== null && typeof data.next_token !== "string") return null;
  const items: TemplateCard[] = [];
  for (const row of data.templates) {
    if (!isRecord(row)) return null;
    const card = templateCard(row);
    if (!card) return null;
    items.push(card);
  }
  return { items, next: tokenOf(data.next_token) };
}

function templateCard(row: Record<string, unknown>): TemplateCard | null {
  if (typeof row.id !== "string" || row.id.length === 0) return null;
  if (typeof row.title !== "string" || row.title.length === 0) return null;
  if (typeof row.thumb !== "string" || !row.thumb.startsWith("https://")) return null;
  return { id: row.id, title: row.title, thumb: row.thumb };
}

export function classifyTaskError(error: string): YouCamCode {
  if (RETAKE.has(error) || error === FACE_ANGLE_ERROR) return "RETAKE_REQUIRED";
  if (error === NO_FACE_ERROR) return "INVALID_PHOTO";
  return "PROVIDER_RESPONSE_INVALID";
}

export function retakeInstruction(error: string, roles: readonly string[]): string | null {
  const listed = roles.length > 0 ? roles.join(", ") : "the submitted photograph";
  if (error === FACE_ANGLE_ERROR) {
    return `Retake ${listed}. Keep a front-facing head within 10° of the camera. For a side view, turn more than 15° rather than a near-full profile.`;
  }
  if (error === NO_FACE_ERROR) {
    return `Retake ${listed}. The provider detected no face. Include a detectable face and keep the crown visible.`;
  }
  return null;
}

export function historyRowMatchesTask(targetId: string, taskId: string): boolean {
  if (taskId.length === 0) return false;
  if (targetId === taskId) return true;
  if (!targetId.startsWith(`${taskId}:`)) return false;
  return /^[0-9]+$/.test(targetId.slice(taskId.length + 1));
}

export function settlementFromHistory(
  taskId: string | null,
  history: { complete: boolean; items: readonly { action: string; targetId: string; units: number }[] },
): { kind: "reservation" } | { kind: "billed"; units: number } | { kind: "not_billed" } | { kind: "unresolved" } {
  if (!taskId || !history.complete) return { kind: "reservation" };
  const rows = history.items.filter((item) => historyRowMatchesTask(item.targetId, taskId));
  if (rows.length === 0) return { kind: "reservation" };
  const charge = classifyHistoryCharge(true, rows);
  if (charge.outcome === "billed") return { kind: "billed", units: charge.units };
  if (charge.outcome === "not_billed") return { kind: "not_billed" };
  return { kind: "unresolved" };
}

export function classifyHistoryCharge(
  complete: boolean,
  rows: readonly { action: string; units: number }[],
): HistoryCharge {
  if (!complete || rows.length === 0 || rows.some((row) => !Number.isInteger(row.units))) return { outcome: "unresolved" };
  const charges = rows.filter((row) => row.units < 0 && !row.action.endsWith("_failed"));
  const reversals = rows.filter((row) => row.units > 0 && row.action.endsWith("_failed"));
  const net = rows.reduce((sum, row) => sum + row.units, 0);
  const paired = charges.length > 0 && reversals.length === charges.length && charges.every((charge) => (
    reversals.some((reversal) => reversal.action === `${charge.action}_failed` && reversal.units === -charge.units)
  ));
  if (paired && net === 0 && charges.length + reversals.length === rows.length) return { outcome: "not_billed" };
  if (reversals.length === 0 && charges.length === rows.length && net < 0) return { outcome: "billed", units: -net };
  return { outcome: "unresolved" };
}

function creditUnits(info: unknown): number | null {
  if (!isRecord(info) || !Array.isArray(info.credits) || info.credits.length === 0) return null;
  let total = 0;
  for (const credit of info.credits) {
    if (!isRecord(credit) || typeof credit.amount_dec !== "number" || !Number.isInteger(credit.amount_dec)) return null;
    total += credit.amount_dec;
  }
  return total;
}

function tokenOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && value !== "" ? value : null;
}

function objectAt(body: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = body[key];
  return isRecord(value) ? value : null;
}

function parseJson(body: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
