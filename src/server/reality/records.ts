import type { Pool } from "pg";
import type { SessionUser } from "../../shared/auth.js";
import { serviceInputFingerprint, type Consultation, type ServiceKind } from "../../shared/consultations.js";
import { presentFinding, type PublicAlternative, type RealityCheck, type RealityService } from "../../shared/reality-check.js";
import { realityCheckSchema } from "../../shared/reality-check-schema.js";
import { ENGINE_VERSION, evaluateReality, type RealityAlternative, type RealityFinding } from "../../shared/reality-engine.js";
import { listCatalogue } from "../catalogue/records.js";
import { readClientBrief } from "../consultations/client-brief.js";
import { readConsultation, readTargets, withConsultationLock } from "../consultations/records.js";
import { readAnalysisPlan } from "../profiles/read-analysis-plan.js";
import { readHairProfile } from "../profiles/read-hair-profile.js";
import { assembleRealityInput } from "./assemble.js";

type Failure = { ok: false; status: number; code: string; message: string; currentVersion: number | null };
type Success = { ok: true; view: RealityCheck };
export type RealityViewResult = Success | Failure;

type StoredAssessment = {
  fingerprint: string;
  engineVersion: string;
  findings: RealityFinding[];
  alternatives: RealityAlternative[];
  excluded: { candidateId: string; service: ServiceKind; conflicts: { category: "must_keep" | "dont_want"; text: string; evidenceRef?: string }[] }[];
};

export async function readRealityCheck(pool: Pool, actor: SessionUser, consultationId: string): Promise<RealityViewResult> {
  const consultation = await readConsultation(pool, actor, consultationId);
  if (!consultation.ok) return consultation;
  return { ok: true, view: await presentStored(pool, consultation.consultation) };
}

export async function saveRealityCheck(
  pool: Pool,
  actor: SessionUser,
  consultationId: string,
  expectedVersion: number,
  presentation: "fixture" | "real",
): Promise<RealityViewResult> {
  const consultation = await readConsultation(pool, actor, consultationId);
  if (!consultation.ok) return consultation;
  const [profile, plan, brief, targets, catalogue] = await Promise.all([
    readHairProfile(pool, actor, consultationId, presentation),
    readAnalysisPlan(pool, actor, consultationId, presentation, { silhouette: true, tones: true }),
    readClientBrief(pool, actor, consultationId),
    readTargets(pool, consultationId),
    listCatalogue(pool, consultation.consultation.salonId, null),
  ]);
  if (!profile.ok) return { ok: false, status: profile.status, code: profile.code, message: profile.message, currentVersion: null };
  if (!plan.ok) return { ok: false, status: plan.status, code: plan.code, message: plan.message, currentVersion: null };
  if (!brief.ok) return { ok: false, status: brief.status, code: brief.code, message: brief.message, currentVersion: null };
  const result = evaluateReality(assembleRealityInput({
    services: consultation.consultation.services.map((service) => service.kind),
    profile: profile.profile,
    plan: plan.plan,
    history: brief.brief.history,
    preferences: brief.brief.preferences,
    targets,
    catalogue,
  }));
  const saved = await withConsultationLock(pool, actor.id, consultationId, expectedVersion, async (client, row) => {
    const services = await client.query<{ id: string; kind: ServiceKind; input_version: number }>(
      `SELECT id, kind, input_version FROM consultation_services
       WHERE consultation_id = $1 AND selected = true`,
      [row.id],
    );
    for (const service of services.rows) {
      await client.query(
        `INSERT INTO reality_assessments (
           consultation_service_id, input_fingerprint, findings, engine_version, suggestions
         ) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)`,
        [
          service.id,
          serviceInputFingerprint(service.id, service.input_version),
          JSON.stringify(result.findings.filter((finding) => finding.service === service.kind)),
          ENGINE_VERSION,
          JSON.stringify({
            alternatives: result.alternatives.filter((item) => item.service === service.kind),
            excluded: result.excluded.filter((item) => item.service === service.kind),
          }),
        ],
      );
    }
  });
  if (!saved.ok) return saved;
  return { ok: true, view: await presentStored(pool, saved.consultation) };
}

async function presentStored(pool: Pool, consultation: Consultation): Promise<RealityCheck> {
  const current = await pool.query<{ id: string }>(
    `SELECT id FROM assets
     WHERE consultation_id = $1 AND role = 'current_front' AND deleted_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [consultation.id],
  );
  const targets = await pool.query<{ kind: ServiceKind; title: string | null; inspiration_asset_id: string | null }>(
    `SELECT DISTINCT ON (s.kind) s.kind, c.title, t.inspiration_asset_id
     FROM consultation_services s
     JOIN targets t ON t.consultation_service_id = s.id
     LEFT JOIN candidates c ON c.id = t.candidate_id
     WHERE s.consultation_id = $1 AND s.selected = true
     ORDER BY s.kind, t.created_at DESC, t.id DESC`,
    [consultation.id],
  );
  const stored = await pool.query<{
    service_id: string;
    input_fingerprint: string | null;
    engine_version: string | null;
    findings: unknown;
    suggestions: unknown;
  }>(
    `SELECT DISTINCT ON (s.id)
            s.id AS service_id, a.input_fingerprint, a.engine_version, a.findings, a.suggestions
     FROM consultation_services s
     LEFT JOIN reality_assessments a ON a.consultation_service_id = s.id
     WHERE s.consultation_id = $1 AND s.selected = true
     ORDER BY s.id, a.created_at DESC NULLS LAST, a.id DESC`,
    [consultation.id],
  );
  const titles = await titlesFor(pool, stored.rows);
  const targetByKind = new Map(targets.rows.map((row) => [row.kind, row]));
  const storedById = new Map(stored.rows.map((row) => [row.service_id, parseStored(row)]));
  const services = consultation.services.map((service) => {
    const parsed = storedById.get(service.id) ?? null;
    const fingerprint = serviceInputFingerprint(service.id, service.inputVersion);
    const currentMatch = parsed !== null && parsed.fingerprint === fingerprint && parsed.engineVersion === ENGINE_VERSION;
    const findings = parsed?.findings.filter((finding) => finding.service === service.kind) ?? [];
    const target = targetByKind.get(service.kind);
    return {
      kind: service.kind,
      state: serviceState(parsed, currentMatch, findings),
      currentAssetId: current.rows[0]?.id ?? null,
      inspirationAssetId: target?.inspiration_asset_id ?? null,
      targetTitle: target?.title ?? null,
      findings: findings.map(presentFinding),
      alternatives: (parsed?.alternatives ?? []).filter((item) => item.service === service.kind).map((item) => publicAlternative(item, titles)),
      excluded: (parsed?.excluded ?? []).filter((item) => item.service === service.kind).map((item) => ({
        candidateId: item.candidateId,
        conflicts: item.conflicts.map((conflict) => ({ category: conflict.category, text: conflict.text })),
      })),
    };
  });
  return realityCheckSchema.parse({ data: { version: consultation.version, services } }).data;
}

function serviceState(stored: StoredAssessment | null, currentMatch: boolean, findings: readonly RealityFinding[]): RealityService["state"] {
  if (!stored) return "missing";
  if (!currentMatch) return "stale";
  if (findings.some((finding) => finding.outcome === "stylist_review_required")) return "review_required";
  return "current";
}

function publicAlternative(item: RealityAlternative, titles: Map<string, string>): PublicAlternative {
  return {
    candidateId: item.candidateId,
    service: item.service,
    title: titles.get(item.candidateId) ?? null,
    retained: [...item.retained],
    changed: [...item.changed],
    preview: item.preview,
    colourRole: item.colourRole,
    note: item.note,
    editorial: item.editorial,
  };
}

function parseStored(row: { input_fingerprint: string | null; engine_version: string | null; findings: unknown; suggestions: unknown }): StoredAssessment | null {
  if (!row.input_fingerprint || !row.engine_version || !Array.isArray(row.findings) || !row.findings.every(isFinding)) return null;
  if (!row.suggestions || typeof row.suggestions !== "object" || Array.isArray(row.suggestions)) return null;
  const suggestions = row.suggestions as { alternatives?: unknown; excluded?: unknown };
  if (!Array.isArray(suggestions.alternatives) || !suggestions.alternatives.every(isAlternative)) return null;
  if (!Array.isArray(suggestions.excluded) || !suggestions.excluded.every(isExcluded)) return null;
  return {
    fingerprint: row.input_fingerprint,
    engineVersion: row.engine_version,
    findings: row.findings,
    alternatives: suggestions.alternatives,
    excluded: suggestions.excluded,
  };
}

function isFinding(value: unknown): value is RealityFinding {
  if (!value || typeof value !== "object") return false;
  const finding = value as { service?: unknown; outcome?: unknown; reason?: unknown; ruleId?: unknown; evidenceRefs?: unknown };
  return typeof finding.service === "string" && typeof finding.outcome === "string" && typeof finding.reason === "string" && typeof finding.ruleId === "string" && Array.isArray(finding.evidenceRefs);
}

function isAlternative(value: unknown): value is RealityAlternative {
  if (!value || typeof value !== "object") return false;
  const item = value as { candidateId?: unknown; service?: unknown; retained?: unknown; changed?: unknown; preview?: unknown };
  return typeof item.candidateId === "string" && typeof item.service === "string" && Array.isArray(item.retained) && Array.isArray(item.changed) && (item.preview === "supported" || item.preview === "unavailable");
}

function isExcluded(value: unknown): value is StoredAssessment["excluded"][number] {
  if (!value || typeof value !== "object") return false;
  const item = value as { candidateId?: unknown; service?: unknown; conflicts?: unknown };
  return typeof item.candidateId === "string" && typeof item.service === "string" && Array.isArray(item.conflicts);
}

async function titlesFor(pool: Pool, rows: { findings: unknown; suggestions: unknown }[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((row) => {
    const suggestions = row.suggestions;
    if (!suggestions || typeof suggestions !== "object" || Array.isArray(suggestions)) return [];
    const alternatives = (suggestions as { alternatives?: unknown }).alternatives;
    if (!Array.isArray(alternatives)) return [];
    return alternatives.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const id = (item as { candidateId?: unknown }).candidateId;
      return typeof id === "string" ? [id] : [];
    });
  });
  if (ids.length === 0) return new Map();
  const titles = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM candidates WHERE id = ANY($1::uuid[])",
    [ids],
  );
  return new Map(titles.rows.map((row) => [row.id, row.title]));
}
