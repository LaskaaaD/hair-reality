import type { Pool, PoolClient } from "pg";
import { catalogueEntrySchema, type CatalogueEntry } from "../../shared/catalogue.js";
import type { ServiceKind } from "../../shared/consultations.js";
import { catalogueBindingError, catalogueSeed, verifiedTemplateIds, type CatalogueSeed } from "./inventory.js";

const UNSUPPORTED = ["prompt", "density", "exact length"];

export async function ensureCatalogue(pool: Pool, salonId: string): Promise<void> {
  for (const entry of catalogueSeed) {
    await pool.query(
      `INSERT INTO candidates (
         salon_id, service_kind, title, metadata, provider_reference, provider_configuration, provenance, constraints, enabled
       )
       SELECT $1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8::jsonb, true
       WHERE NOT EXISTS (
         SELECT 1 FROM candidates
         WHERE salon_id = $1 AND metadata->>'catalogueKey' = $9
       )`,
      [
        salonId,
        entry.serviceKind,
        entry.title,
        JSON.stringify({
          catalogueKey: entry.key,
          length: entry.length,
          texture: entry.texture,
        }),
        entry.providerReference,
        JSON.stringify(entry.configuration),
        entry.provenance,
        JSON.stringify({ unsupported: UNSUPPORTED }),
        entry.key,
      ],
    );
  }
}

export async function listCatalogue(
  pool: Pool,
  salonId: string,
  service: ServiceKind | null,
): Promise<CatalogueEntry[]> {
  await ensureCatalogue(pool, salonId);
  const result = await pool.query<{
    id: string;
    service_kind: ServiceKind;
    title: string;
    provenance: "youcam" | "fixture";
    provider_reference: string | null;
    metadata: { length?: string; texture?: string; maintenance?: string };
    provider_configuration: Record<string, unknown>;
  }>(
    `SELECT id, service_kind, title, provenance, provider_reference, metadata, provider_configuration
     FROM candidates
     WHERE salon_id = $1 AND enabled = true AND ($2::text IS NULL OR service_kind = $2)
     ORDER BY service_kind, title, id`,
    [salonId, service],
  );
  return result.rows.flatMap((row) => {
    const presented = presentCandidate(row);
    return presented ? [presented] : [];
  });
}

export async function supportedCandidate(
  client: Pool | PoolClient,
  salonId: string,
  candidateId: string,
  serviceKind: ServiceKind,
): Promise<{ id: string; title: string } | null> {
  const result = await client.query<{
    id: string;
    service_kind: ServiceKind;
    title: string;
    provenance: "youcam" | "fixture";
    provider_reference: string | null;
    metadata: { length?: string; texture?: string; maintenance?: string };
    provider_configuration: Record<string, unknown>;
    enabled: boolean;
  }>(
    `SELECT id, service_kind, title, provenance, provider_reference, metadata, provider_configuration, enabled
     FROM candidates
     WHERE id = $1 AND salon_id = $2`,
    [candidateId, salonId],
  );
  const row = result.rows[0];
  if (!row || !row.enabled || row.service_kind !== serviceKind) return null;
  return presentCandidate(row) ? { id: row.id, title: row.title } : null;
}

function presentCandidate(row: {
  id: string;
  service_kind: ServiceKind;
  title: string;
  provenance: "youcam" | "fixture";
  provider_reference: string | null;
  metadata: { length?: string; texture?: string; maintenance?: string };
  provider_configuration: Record<string, unknown>;
}): CatalogueEntry | null {
  const seed = seedFor(row);
  if (!seed || catalogueBindingError(seed) !== null) return null;
  const maintenance = maintenanceOf(row.metadata.maintenance);
  return catalogueEntrySchema.parse({
    id: row.id,
    serviceKind: row.service_kind,
    title: row.title,
    provenance: row.provenance,
    providerReference: row.provider_reference,
    length: lengthOf(row.metadata.length),
    texture: textureOf(row.metadata.texture),
    configuration: {
      templateId: typeof row.provider_configuration.template_id === "string" ? row.provider_configuration.template_id : null,
      preset: typeof row.provider_configuration.preset === "string" ? row.provider_configuration.preset : null,
    },
    unsupported: UNSUPPORTED,
    ...(maintenance ? { maintenance } : {}),
  });
}

function seedFor(row: {
  service_kind: ServiceKind;
  provenance: "youcam" | "fixture";
  provider_reference: string | null;
  provider_configuration: Record<string, unknown>;
}): CatalogueSeed | null {
  const configuration: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.provider_configuration)) {
    if (typeof value !== "string") return null;
    configuration[key] = value;
  }
  const reference = row.provider_reference;
  if (row.service_kind === "haircut" || row.service_kind === "beard") {
    const allowed = verifiedTemplateIds[row.service_kind] as readonly string[];
    if (reference === null || !allowed.includes(reference)) return null;
  }
  return {
    key: "stored",
    serviceKind: row.service_kind,
    title: "stored",
    provenance: row.provenance,
    providerReference: reference,
    length: "unknown",
    texture: "unknown",
    configuration,
  };
}

function lengthOf(value: string | undefined): CatalogueEntry["length"] {
  if (value === "short" || value === "medium" || value === "long" || value === "unknown") return value;
  return "unknown";
}

function textureOf(value: string | undefined): CatalogueEntry["texture"] {
  if (value === "straight" || value === "wavy" || value === "curly" || value === "unknown") return value;
  return "unknown";
}

function maintenanceOf(value: string | undefined): CatalogueEntry["maintenance"] {
  if (value === "low" || value === "moderate" || value === "high") return value;
  return undefined;
}
