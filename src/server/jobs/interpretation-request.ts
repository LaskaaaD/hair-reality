import type { Pool } from "pg";
import { externalProcessingAllowed } from "../assets/consent.js";
import {
  deterministicExplanation,
  type OpenAIOperation,
  type OpenAIRequest,
  type SuppliedFinding,
} from "../providers/openai/contract.js";
import { CANDIDATE_LIMIT, EVIDENCE_LIMIT, FINDING_LIMIT, TEXT_CHAR_LIMIT } from "../providers/openai/pricing.js";

const identifier = /^[a-z0-9-]{1,40}$/;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export type InterpretationAssembly =
  | { ok: true; serviceId: string; request: OpenAIRequest }
  | { ok: false; status: 404 | 422; code: "not_found" | "unsupported_configuration"; message: string };

type CatalogueOption = {
  id: string;
  title: string;
  length: string | null;
  texture: string | null;
};

export function rankingCatalogueText(options: readonly CatalogueOption[]): string {
  return [
    "Supported catalogue options. These titles are not a saved client preference.",
    ...options.map((option) => `${option.id}: ${option.title}; length ${option.length ?? "unknown"}; texture ${option.texture ?? "unknown"}`),
  ].join("\n");
}

type LoadedService = {
  id: string;
  kind: string;
  salonId: string;
};

export async function assembleInterpretationRequest(
  pool: Pool,
  consultationId: string,
  input: { serviceId?: string | undefined; serviceKind?: string | undefined; operation: OpenAIOperation },
): Promise<InterpretationAssembly> {
  const service = await loadService(pool, consultationId, input.serviceId, input.serviceKind);
  if (!service) {
    return { ok: false, status: 404, code: "not_found", message: "That service is not available." };
  }
  const [target, priorities, described, candidates, photographs] = await Promise.all([
    loadTarget(pool, service.id),
    loadPriorities(pool, consultationId),
    loadFindings(pool, consultationId, service.kind),
    loadCandidates(pool, service.salonId, service.kind, input.operation),
    loadPhotographs(pool, consultationId, service.id, input.operation),
  ]);
  const findings = described.findings;
  const candidateIds = candidates.map((candidate) => candidate.id);
  const text = interpretationPromptText(input.operation, target, priorities, candidates, described.narrative, photographs.length > 0);
  if (input.operation === "target_interpretation" && text.trim() === "") {
    return { ok: false, status: 422, code: "unsupported_configuration", message: "Save a target before asking for an interpretation." };
  }
  if (input.operation === "priority_extraction" && priorities.length === 0) {
    return { ok: false, status: 422, code: "unsupported_configuration", message: "Save a priority before asking for extraction." };
  }
  if (input.operation === "candidate_ranking" && candidateIds.length === 0) {
    return { ok: false, status: 422, code: "unsupported_configuration", message: "Ranking requires a supplied candidate set." };
  }
  if ((input.operation === "finding_explanation" || input.operation === "stylist_brief") && findings.length === 0) {
    return { ok: false, status: 422, code: "unsupported_configuration", message: "Save an assessment before asking for this explanation." };
  }
  const request: OpenAIRequest = {
    operation: input.operation,
    text: bounded(text || fallbackText(input.operation)),
    evidenceIds: findings.flatMap((finding) => finding.evidenceIds).slice(0, EVIDENCE_LIMIT),
    candidateIds: input.operation === "priority_extraction" || input.operation === "finding_explanation" ? [] : candidateIds,
    findings: input.operation === "target_interpretation" || input.operation === "priority_extraction" || input.operation === "candidate_ranking" ? [] : findings,
    imageAssetIds: photographs,
  };
  if (emailPattern.test(request.text)) {
    return { ok: false, status: 422, code: "unsupported_configuration", message: "The request includes an account email and cannot be sent." };
  }
  return { ok: true, serviceId: service.id, request };
}

export function fixtureInterpretationValues(request: OpenAIRequest): { values: unknown; uncertainty: string } {
  if (request.operation === "finding_explanation") {
    return {
      values: {
        explanation: deterministicExplanation(request.findings).slice(0, 800),
        findingIds: request.findings.map((finding) => finding.id).slice(0, EVIDENCE_LIMIT),
        provenance: "deterministic_findings",
      },
      uncertainty: "deterministic_fallback",
    };
  }
  if (request.operation === "stylist_brief") {
    return {
      values: {
        brief: deterministicExplanation(request.findings).slice(0, 800),
        evidenceIds: request.findings.flatMap((finding) => finding.evidenceIds).slice(0, EVIDENCE_LIMIT),
        provenance: "deterministic_findings",
      },
      uncertainty: "deterministic_fallback",
    };
  }
  if (request.operation === "priority_extraction") {
    return {
      values: { proposals: [], uncertainty: "Fixture mode does not call OpenAI. No priority was proposed." },
      uncertainty: "fixture_not_a_model",
    };
  }
  if (request.operation === "candidate_ranking") {
    return { values: { rankedIds: [], omittedIds: [] }, uncertainty: "fixture_not_a_model" };
  }
  if (request.operation === "preview_deviation") {
    return { values: { flags: [], provenance: "fixture_not_a_model" }, uncertainty: "fixture_not_a_model" };
  }
  return {
    values: { observations: [], uncertainty: "Fixture mode does not call OpenAI. No model observation was stored." },
    uncertainty: "fixture_not_a_model",
  };
}

export function interpretationSummary(
  source: string,
  values: unknown,
  uncertainty: string | null,
  titles: ReadonlyMap<string, string> = new Map(),
): string {
  if (uncertainty === "deterministic_fallback") {
    const text = stringField(values, "explanation") ?? stringField(values, "brief");
    return text ? `Deterministic fallback. ${text}` : "Deterministic fallback from the stored findings.";
  }
  if (source === "fixture" || uncertainty === "fixture_not_a_model") {
    return "Fixture mode did not call OpenAI. No model proposal was stored, and nothing here was saved as your choice.";
  }
  const observations = arrayField(values, "observations");
  if (observations) {
    const lines = observations.flatMap((item) => {
      const statement = stringField(item, "statement");
      const support = stringField(item, "support") ?? "unknown";
      return statement ? [`${statement} (${support}, unconfirmed)`] : [];
    });
    return lines.length > 0 ? lines.join(" ") : "No confirmed observation was stored.";
  }
  const proposals = arrayField(values, "proposals");
  if (proposals) {
    const lines = proposals.flatMap((item) => {
      const text = stringField(item, "text");
      return text ? [`${text} (unconfirmed)`] : [];
    });
    return lines.length > 0 ? lines.join(" ") : "No priority was proposed.";
  }
  const explanation = stringField(values, "explanation") ?? stringField(values, "brief");
  if (explanation) return explanation;
  const ranked = stringArray(values, "rankedIds");
  const omitted = stringArray(values, "omittedIds");
  if (ranked || omitted) {
    const order = (ranked ?? []).map((id, index) => `${index + 1}. ${titled(id, titles)}`).join(" ");
    const leftOut = (omitted ?? []).map((id) => titled(id, titles)).join(", ");
    return [`Ranked: ${order || "none"}.`, leftOut ? `Omitted: ${leftOut}.` : ""].filter((line) => line !== "").join(" ");
  }
  const flags = arrayField(values, "flags");
  if (flags) {
    const lines = flags.flatMap((item) => {
      const difference = stringField(item, "visibleDifference");
      const candidateId = stringField(item, "candidateId");
      if (!difference) return [];
      const name = candidateId ? titled(candidateId, titles) : "Untitled candidate";
      return [`${name}: ${difference} Review required.`];
    });
    return lines.length > 0 ? lines.join(" ") : "No preview difference was reported. This did not compare photographs.";
  }
  return uncertainty ?? "The interpretation is stored separately from your saved choices.";
}

export function candidateIdsInValues(values: unknown): string[] {
  const ids = [
    ...(stringArray(values, "rankedIds") ?? []),
    ...(stringArray(values, "omittedIds") ?? []),
  ];
  for (const item of arrayField(values, "flags") ?? []) {
    const id = stringField(item, "candidateId");
    if (id) ids.push(id);
  }
  return ids;
}

export function describeStoredFindings(stored: unknown, serviceKind: string): { findings: SuppliedFinding[]; narrative: string } {
  if (!Array.isArray(stored)) return { findings: [], narrative: "" };
  const used = new Set<string>();
  const findings: SuppliedFinding[] = [];
  const lines: string[] = [];
  for (const item of stored) {
    if (!item || typeof item !== "object") continue;
    const service = "service" in item ? item.service : undefined;
    if (service !== serviceKind) continue;
    const ruleId = "ruleId" in item && typeof item.ruleId === "string" ? item.ruleId.toLowerCase() : "";
    const outcome = mappedOutcome("outcome" in item ? item.outcome : undefined);
    if (!identifier.test(ruleId) || !outcome) continue;
    let id = ruleId;
    let suffix = 2;
    while (used.has(id)) {
      const next = `${ruleId}-${suffix}`;
      suffix += 1;
      if (!identifier.test(next)) break;
      id = next;
    }
    if (used.has(id)) continue;
    used.add(id);
    const evidenceIds = evidenceIdentifiers(item);
    findings.push({ id, outcome, evidenceIds });
    lines.push(findingLine(item, id, outcome));
    if (findings.length === FINDING_LIMIT) break;
  }
  return { findings, narrative: lines.join(" ") };
}

async function loadService(
  pool: Pool,
  consultationId: string,
  serviceId: string | undefined,
  serviceKind: string | undefined,
): Promise<LoadedService | null> {
  const result = await pool.query<{ id: string; kind: string; salon_id: string }>(
    `SELECT consultation_services.id, consultation_services.kind, consultations.salon_id
     FROM consultation_services
     JOIN consultations ON consultations.id = consultation_services.consultation_id
     WHERE consultation_services.consultation_id = $1
       AND consultation_services.selected = true
       AND consultations.deleted_at IS NULL
       AND ($2::uuid IS NULL OR consultation_services.id = $2::uuid)
       AND ($3::text IS NULL OR consultation_services.kind = $3)
     ORDER BY consultation_services.kind ASC
     LIMIT 1`,
    [consultationId, serviceId ?? null, serviceId ? null : serviceKind ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, salonId: row.salon_id };
}

async function loadTarget(pool: Pool, serviceId: string): Promise<{ description: string | null; title: string | null }> {
  const result = await pool.query<{ description: string | null; title: string | null }>(
    `SELECT targets.description, candidates.title
     FROM targets
     LEFT JOIN candidates ON candidates.id = targets.candidate_id
     WHERE targets.consultation_service_id = $1
     ORDER BY targets.created_at DESC
     LIMIT 1`,
    [serviceId],
  );
  return result.rows[0] ?? { description: null, title: null };
}

async function loadPriorities(pool: Pool, consultationId: string): Promise<string[]> {
  const result = await pool.query<{ payload: unknown }>(
    `SELECT payload FROM preferences
     WHERE consultation_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [consultationId],
  );
  const payload = result.rows[0]?.payload;
  if (!payload || typeof payload !== "object" || !("priorities" in payload) || !Array.isArray(payload.priorities)) return [];
  const lines: string[] = [];
  for (const item of payload.priorities) {
    if (!item || typeof item !== "object") continue;
    const text = "text" in item && typeof item.text === "string" ? item.text.trim() : "";
    const category = "category" in item && typeof item.category === "string" ? item.category : "priority";
    if (text) lines.push(`${category}: ${text}`);
  }
  return lines;
}

async function loadFindings(
  pool: Pool,
  consultationId: string,
  serviceKind: string,
): Promise<{ findings: SuppliedFinding[]; narrative: string }> {
  const result = await pool.query<{ findings: unknown }>(
    `SELECT reality_assessments.findings
     FROM reality_assessments
     JOIN consultation_services ON consultation_services.id = reality_assessments.consultation_service_id
     WHERE consultation_services.consultation_id = $1 AND consultation_services.kind = $2
     ORDER BY reality_assessments.created_at DESC
     LIMIT 1`,
    [consultationId, serviceKind],
  );
  return describeStoredFindings(result.rows[0]?.findings, serviceKind);
}

async function loadCandidates(pool: Pool, salonId: string, serviceKind: string, operation: OpenAIOperation): Promise<CatalogueOption[]> {
  if (operation === "priority_extraction" || operation === "finding_explanation") return [];
  const result = await pool.query<{ id: string; title: string; length: string | null; texture: string | null }>(
    `SELECT id, title, metadata->>'length' AS length, metadata->>'texture' AS texture
     FROM candidates
     WHERE salon_id = $1 AND service_kind = $2 AND enabled = true
     ORDER BY title ASC
     LIMIT $3`,
    [salonId, serviceKind, CANDIDATE_LIMIT],
  );
  return result.rows.filter((row) => identifier.test(row.id));
}

async function loadPhotographs(pool: Pool, consultationId: string, serviceId: string, operation: OpenAIOperation): Promise<string[]> {
  const wanted: string[] = [];
  if (operation === "target_interpretation" || operation === "stylist_brief") {
    const inspiration = await pool.query<{ id: string }>(
      `SELECT id FROM assets
       WHERE consultation_id = $1 AND role = 'inspiration' AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [consultationId],
    );
    const id = inspiration.rows[0]?.id;
    if (id) wanted.push(id);
  }
  if (operation === "preview_deviation") {
    const preview = await pool.query<{ result_asset_id: string }>(
      `SELECT result_asset_id FROM previews
       WHERE consultation_service_id = $1 AND stale = false AND result_asset_id IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [serviceId],
    );
    const id = preview.rows[0]?.result_asset_id;
    if (id) wanted.push(id);
  }
  const allowed: string[] = [];
  for (const id of wanted) {
    if (await externalProcessingAllowed(pool, consultationId, [id], ["openai"])) allowed.push(id);
  }
  return allowed.slice(0, 2);
}

export function interpretationPromptText(
  operation: OpenAIOperation,
  target: { description: string | null; title: string | null },
  priorities: readonly string[],
  candidates: readonly CatalogueOption[],
  narrative: string,
  photographsAttached: boolean,
): string {
  const parts: string[] = [];
  if (operation === "candidate_ranking" && candidates.length > 0) parts.push(rankingCatalogueText(candidates));
  if (target.description) parts.push(target.description);
  if (target.title) parts.push(`Catalogue target: ${target.title}`);
  if (operation === "priority_extraction" || operation === "stylist_brief" || operation === "target_interpretation" || operation === "candidate_ranking") {
    parts.push(...priorities);
  }
  if ((operation === "finding_explanation" || operation === "stylist_brief") && narrative !== "") parts.push(narrative);
  if (operation === "preview_deviation" && !photographsAttached) {
    parts.push("No photograph was attached. This is not a visual comparison.");
  }
  return parts.join("\n");
}

function fallbackText(operation: OpenAIOperation): string {
  if (operation === "candidate_ranking") return "Rank only the supplied catalogue candidates.";
  if (operation === "preview_deviation") return "Compare the stored preview with the saved target. Do not approve it.";
  return "Use only the supplied findings.";
}

function mappedOutcome(value: unknown): SuppliedFinding["outcome"] | null {
  if (value === "compatible") return "pass";
  if (value === "potential_mismatch") return "fail";
  if (value === "unknown" || value === "stylist_review_required") return "unknown";
  return null;
}

function findingLine(item: object, id: string, outcome: SuppliedFinding["outcome"]): string {
  const dimension = stringField(item, "dimension") ?? "unspecified";
  const reason = stringField(item, "reason") ?? "No stored reason.";
  const nextAction = stringField(item, "nextAction") ?? "none";
  return `${id} dimension ${dimension} outcome ${outcome}. ${reason} Next action: ${nextAction}.`;
}

function evidenceIdentifiers(item: object): string[] {
  if (!("evidenceRefs" in item) || !Array.isArray(item.evidenceRefs)) return [];
  const ids: string[] = [];
  for (const ref of item.evidenceRefs) {
    if (typeof ref !== "string") continue;
    const normalized = ref.toLowerCase();
    if (!identifier.test(normalized)) continue;
    ids.push(normalized);
    if (ids.length === EVIDENCE_LIMIT) break;
  }
  return ids;
}

function titled(id: string, titles: ReadonlyMap<string, string>): string {
  return titles.get(id) ?? "Untitled candidate";
}

function bounded(value: string): string {
  return value.slice(0, TEXT_CHAR_LIMIT);
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() !== "" ? field : null;
}

function arrayField(value: unknown, key: string): unknown[] | null {
  if (!value || typeof value !== "object" || !(key in value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return Array.isArray(field) ? field : null;
}

function stringArray(value: unknown, key: string): string[] | null {
  const field = arrayField(value, key);
  if (!field) return null;
  return field.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}
