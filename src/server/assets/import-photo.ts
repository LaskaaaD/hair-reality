import type { Pool } from "pg";
import { importRoles, providerNames, type ProviderName } from "../../shared/assets.js";
import type { DeletionJournal } from "./journal.js";
import { recordConsent, uploadAsset } from "./records.js";
import type { PrivateStorage } from "./storage.js";
import { authenticate } from "../auth/accounts.js";

export const CONSENT_VERSION = "hr-014-operator-2026-10-11";

const ROLES = new Set<string>(importRoles);

export function consentStatement(providers: readonly ProviderName[]): string {
  const destination = providers.includes("youcam") && providers.includes("openai")
    ? "YouCam (Perfect Corp) for hair analysis and image generation, and to OpenAI for interpretation"
    : providers.includes("youcam")
      ? "YouCam (Perfect Corp) for hair analysis and image generation"
      : "OpenAI for interpretation";
  const counting = providers.includes("openai")
    ? " An OpenAI token count, if used, sends the same text and images before a paid generation."
    : "";
  return `I agree that the selected photographs may be sent to ${destination}.${counting} Storing a photograph in this application is not permission to send it.`;
}

export type ImportResult =
  | {
    ok: true;
    consultationId: string;
    assetId: string | null;
    consentRecorded: boolean;
    statement: string;
  }
  | {
    ok: false;
    code: "account_rejected" | "consultation_required" | "consultation_choice" | "import_rejected" | "consent_rejected";
    message: string;
    consultationIds?: string[];
    statement: string;
  };

export async function importOwnedPhotograph(options: {
  pool: Pool;
  storage: PrivateStorage;
  journal: DeletionJournal;
  now: Date;
  retentionDays: number;
  email: string;
  password: string;
  role?: string;
  file?: Buffer;
  consultationId?: string;
  accept: boolean;
  providers: readonly ProviderName[];
  assetIds?: readonly string[];
}): Promise<ImportResult> {
  const providers = [...new Set(options.providers)];
  const statement = consentStatement(providers);
  if (providers.length === 0 || providers.some((provider) => !providerNames.includes(provider))) {
    return { ok: false, code: "consent_rejected", message: "Choose YouCam, OpenAI, or both.", statement };
  }
  const account = await authenticate(options.pool, options.email, options.password);
  if (!account) {
    return { ok: false, code: "account_rejected", message: "The account could not be confirmed.", statement };
  }
  const actor = { userId: account.id, memberships: [] as const };
  const consultationId = await ownedConsultation(options.pool, account.id, options.consultationId);
  if (!consultationId.ok) return { ...consultationId, statement };
  let assetId: string | null = null;
  if (options.file) {
    if (!options.role || !ROLES.has(options.role) || options.role === "preview") {
      return { ok: false, code: "import_rejected", message: "Choose current_front, current_left, current_right, current_density, current_length, current_face, beard, or inspiration.", statement };
    }
    const saved = await uploadAsset({
      pool: options.pool,
      storage: options.storage,
      actor,
      consultationId: consultationId.id,
      role: options.role,
      expectedVersion: consultationId.version,
      file: options.file,
      retentionDays: options.retentionDays,
      now: options.now,
    });
    if (!saved.ok) {
      return { ok: false, code: "import_rejected", message: saved.message, statement };
    }
    assetId = saved.asset.id;
  }
  const scope = [...new Set([...(options.assetIds ?? []), ...(assetId ? [assetId] : [])])];
  if (!options.accept) {
    return { ok: true, consultationId: consultationId.id, assetId, consentRecorded: false, statement };
  }
  if (scope.length === 0) {
    return { ok: false, code: "consent_rejected", message: "Choose the photographs covered by this consent.", statement };
  }
  const consent = await recordConsent({
    pool: options.pool,
    storage: options.storage,
    journal: options.journal,
    actor,
    consultationId: consultationId.id,
    now: options.now,
    request: {
      consentVersion: CONSENT_VERSION,
      providers,
      assetIds: scope,
      accepted: true,
      statement,
    },
  });
  if (!consent.ok) {
    return { ok: false, code: "consent_rejected", message: consent.message, statement };
  }
  return { ok: true, consultationId: consultationId.id, assetId, consentRecorded: true, statement };
}

async function ownedConsultation(
  pool: Pool,
  userId: string,
  requested: string | undefined,
): Promise<{ ok: true; id: string; version: number } | { ok: false; code: "consultation_required" | "consultation_choice"; message: string; consultationIds?: string[] }> {
  if (requested) {
    const one = await pool.query<{ id: string; version: number }>(
      `SELECT id, version FROM consultations
       WHERE id = $1 AND client_user_id = $2 AND deleted_at IS NULL`,
      [requested, userId],
    );
    const row = one.rows[0];
    if (!row) {
      return { ok: false, code: "consultation_required", message: "That consultation is not available for this account." };
    }
    return { ok: true, id: row.id, version: row.version };
  }
  const found = await pool.query<{ id: string; version: number }>(
    `SELECT id, version FROM consultations
     WHERE client_user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  const first = found.rows[0];
  if (!first) {
    return {
      ok: false,
      code: "consultation_required",
      message: "Create a consultation at /consultations/new after signing in, then run the import again.",
    };
  }
  if (found.rows.length > 1) {
    return {
      ok: false,
      code: "consultation_choice",
      message: "More than one consultation exists. Repeat the command with --consultation and one of the listed ids.",
      consultationIds: found.rows.map((row) => row.id),
    };
  }
  return { ok: true, id: first.id, version: first.version };
}
