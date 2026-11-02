import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Column shapes for the reviewed migration in migrations/0001_initial.sql.
// Triggers, partial booking indexes and check constraints are owned by that SQL file.

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamps.createdAt,
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
]);

export const salons = pgTable("salons", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  branding: jsonb("branding").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("salons_slug_unique").on(table.slug),
]);

export const salonMemberships = pgTable("salon_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull().references(() => salons.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  role: text("role").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("salon_memberships_pair_unique").on(table.salonId, table.userId),
]);

export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("user_sessions_user_idx").on(table.userId),
]);

export const consultations = pgTable("consultations", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientUserId: uuid("client_user_id").notNull().references(() => users.id),
  salonId: uuid("salon_id").notNull().references(() => salons.id),
  assignedStylistUserId: uuid("assigned_stylist_user_id"),
  lifecycle: text("lifecycle").notNull().default("DRAFT"),
  version: integer("version").notNull().default(1),
  currentRevisionId: uuid("current_revision_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("consultations_client_idx").on(table.clientUserId),
  index("consultations_salon_lifecycle_idx").on(table.salonId, table.lifecycle),
  foreignKey({
    columns: [table.salonId, table.assignedStylistUserId],
    foreignColumns: [salonMemberships.salonId, salonMemberships.userId],
    name: "consultations_stylist_membership_fk",
  }),
]);

export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  consentVersion: text("consent_version").notNull(),
  providers: text("providers").array().notNull(),
  accepted: boolean("accepted").notNull().default(false),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: "date" }),
  assetScope: uuid("asset_scope").array().notNull().default(sql`'{}'::uuid[]`),
  statement: text("statement").notNull().default(""),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("consents_consultation_idx").on(table.consultationId),
]);

export const consultationServices = pgTable("consultation_services", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  kind: text("kind").notNull(),
  inputVersion: integer("input_version").notNull().default(1),
  selected: boolean("selected").notNull().default(true),
}, (table) => [
  uniqueIndex("consultation_services_active_kind_unique").on(table.consultationId, table.kind).where(sql`${table.selected} = true`),
]);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  role: text("role").notNull(),
  storageKey: text("storage_key").notNull(),
  contentHash: text("content_hash").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  mimeType: text("mime_type").notNull(),
  provenance: text("provenance").notNull().default("client_upload"),
  sourceAssetId: uuid("source_asset_id"),
  consentId: uuid("consent_id").references(() => consents.id),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("assets_storage_key_unique").on(table.storageKey),
  index("assets_consultation_idx").on(table.consultationId),
  index("assets_owner_idx").on(table.ownerUserId),
]);

export const analysisResults = pgTable("analysis_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  consultationServiceId: uuid("consultation_service_id").references(() => consultationServices.id),
  capability: text("capability").notNull(),
  inputAssets: jsonb("input_assets").notNull(),
  provider: text("provider").notNull(),
  providerVersion: text("provider_version"),
  source: text("source").notNull(),
  values: jsonb("values").notNull(),
  uncertainty: text("uncertainty"),
  freshness: text("freshness").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true, mode: "date" }).notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("analysis_results_consultation_idx").on(table.consultationId),
]);

export const hairHistories = pgTable("hair_histories", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  version: integer("version").notNull(),
  answers: jsonb("answers").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("hair_histories_version_unique").on(table.consultationId, table.version),
]);

export const candidates = pgTable("candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull().references(() => salons.id),
  serviceKind: text("service_kind").notNull(),
  title: text("title").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  providerReference: text("provider_reference"),
  providerConfiguration: jsonb("provider_configuration").notNull().default(sql`'{}'::jsonb`),
  provenance: text("provenance").notNull(),
  constraints: jsonb("constraints").notNull().default(sql`'{}'::jsonb`),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("candidates_salon_kind_idx").on(table.salonId, table.serviceKind),
]);

export const targets = pgTable("targets", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationServiceId: uuid("consultation_service_id").notNull().references(() => consultationServices.id),
  sourceKind: text("source_kind").notNull(),
  inspirationAssetId: uuid("inspiration_asset_id").references(() => assets.id),
  candidateId: uuid("candidate_id").references(() => candidates.id),
  description: text("description"),
  interpreted: jsonb("interpreted").notNull().default(sql`'{}'::jsonb`),
  uncertainty: text("uncertainty"),
  createdAt: timestamps.createdAt,
});

export const preferences = pgTable("preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  version: integer("version").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("preferences_version_unique").on(table.consultationId, table.version),
]);

export const realityAssessments = pgTable("reality_assessments", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationServiceId: uuid("consultation_service_id").notNull().references(() => consultationServices.id),
  inputFingerprint: text("input_fingerprint").notNull(),
  findings: jsonb("findings").notNull(),
  engineVersion: text("engine_version").notNull(),
  suggestions: jsonb("suggestions").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamps.createdAt,
});

export const providerBudgetAccounts = pgTable("provider_budget_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  phase: text("phase").notNull(),
  mode: text("mode").notNull().default("live"),
  settledUnits: bigint("settled_units", { mode: "number" }).notNull().default(0),
  reservedUnits: bigint("reserved_units", { mode: "number" }).notNull().default(0),
  externalUnits: bigint("external_units", { mode: "number" }).notNull().default(0),
  balanceUnits: bigint("balance_units", { mode: "number" }),
  balanceObservedAt: timestamp("balance_observed_at", { withTimezone: true, mode: "date" }),
  pricesObservedAt: timestamp("prices_observed_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  uniqueIndex("provider_budget_accounts_identity_unique").on(table.provider, table.phase, table.mode),
]);

export const providerJobs = pgTable("provider_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  provider: text("provider").notNull(),
  operation: text("operation").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  costPhase: text("cost_phase").notNull(),
  state: text("state").notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true, mode: "date" }),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true, mode: "date" }),
  fencingToken: bigint("fencing_token", { mode: "number" }).notNull().default(0),
  providerTaskId: text("provider_task_id"),
  attempt: integer("attempt").notNull().default(0),
  errorCode: text("error_code"),
  mode: text("mode").notNull().default("fixture"),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  requestHash: text("request_hash"),
  providerVersion: text("provider_version").notNull().default("fixture"),
  configurationFingerprint: text("configuration_fingerprint").notNull().default(""),
  priceSnapshot: jsonb("price_snapshot").notNull().default(sql`'{}'::jsonb`),
  maxCost: bigint("max_cost", { mode: "number" }).notNull().default(0),
  consultationServiceId: uuid("consultation_service_id").references(() => consultationServices.id),
  sourceAssetIds: uuid("source_asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
  serviceInputVersion: integer("service_input_version"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("provider_jobs_state_idx").on(table.state),
  index("provider_jobs_consultation_idx").on(table.consultationId),
]);

export const previews = pgTable("previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationServiceId: uuid("consultation_service_id").notNull().references(() => consultationServices.id),
  jobId: uuid("job_id").references(() => providerJobs.id),
  sourceAssetId: uuid("source_asset_id").notNull().references(() => assets.id),
  candidateId: uuid("candidate_id").references(() => candidates.id),
  configurationFingerprint: text("configuration_fingerprint").notNull(),
  resultAssetId: uuid("result_asset_id").references(() => assets.id),
  provider: text("provider").notNull(),
  providerVersion: text("provider_version"),
  freshness: text("freshness").notNull(),
  representationLimits: jsonb("representation_limits").notNull().default(sql`'[]'::jsonb`),
  stale: boolean("stale").notNull().default(false),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamps.createdAt,
});

export const planRevisions = pgTable("plan_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  revisionNumber: integer("revision_number").notNull(),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  parentRevisionId: uuid("parent_revision_id"),
  snapshot: jsonb("snapshot").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  reviewConditions: jsonb("review_conditions").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("plan_revisions_number_unique").on(table.consultationId, table.revisionNumber),
  foreignKey({
    columns: [table.parentRevisionId],
    foreignColumns: [table.id],
    name: "plan_revisions_parent_revision_id_fkey",
  }),
]);

export const approvals = pgTable("approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  revisionId: uuid("revision_id").notNull().references(() => planRevisions.id),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  party: text("party").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("approvals_party_unique").on(table.revisionId, table.party),
]);

export const discussionMessages = pgTable("discussion_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  authorUserId: uuid("author_user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("discussion_messages_consultation_idx").on(table.consultationId),
]);

export const changeRequests = pgTable("change_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  revisionId: uuid("revision_id").notNull().references(() => planRevisions.id),
  requesterUserId: uuid("requester_user_id").notNull().references(() => users.id),
  reason: text("reason").notNull(),
  createdAt: timestamps.createdAt,
  resolvingRevisionId: uuid("resolving_revision_id").references(() => planRevisions.id),
});

export const demoSlots = pgTable("demo_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  salonId: uuid("salon_id").notNull().references(() => salons.id),
  stylistUserId: uuid("stylist_user_id"),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }).notNull(),
  label: text("label").notNull().default("Demo booking — no real salon appointment has been made."),
}, (table) => [
  uniqueIndex("demo_slots_time_unique").on(table.salonId, table.startsAt),
  foreignKey({
    columns: [table.salonId, table.stylistUserId],
    foreignColumns: [salonMemberships.salonId, salonMemberships.userId],
    name: "demo_slots_stylist_membership_fk",
  }),
]);

export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  consultationId: uuid("consultation_id").notNull().references(() => consultations.id),
  revisionId: uuid("revision_id").notNull().references(() => planRevisions.id),
  demoSlotId: uuid("demo_slot_id").notNull().references(() => demoSlots.id),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("bookings_idempotency_unique").on(table.consultationId, table.idempotencyKey),
  uniqueIndex("bookings_one_confirmed_slot_idx").on(table.demoSlotId).where(sql`${table.status} = 'confirmed'`),
  uniqueIndex("bookings_one_confirmed_consultation_idx").on(table.consultationId).where(sql`${table.status} = 'confirmed'`),
]);

export const usageLedger = pgTable("usage_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id").references(() => providerJobs.id, { onDelete: "set null" }),
  provider: text("provider").notNull(),
  budgetBucket: text("budget_bucket").notNull(),
  unit: text("unit").notNull(),
  estimatedUnits: bigint("estimated_units", { mode: "number" }).notNull(),
  actualUnits: bigint("actual_units", { mode: "number" }),
  settlementState: text("settlement_state").notNull(),
  mode: text("mode").notNull().default("fixture"),
  phase: text("phase").notNull().default("development"),
  priceSnapshot: jsonb("price_snapshot").notNull().default(sql`'{}'::jsonb`),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("usage_ledger_provider_state_idx").on(table.provider, table.settlementState),
]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id),
  operation: text("operation").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  resourceId: uuid("resource_id"),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("idempotency_keys_identity_unique").on(table.actorUserId, table.operation, table.idempotencyKey),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  eventName: text("event_name").notNull(),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  notifiedAt: timestamp("notified_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  index("audit_events_entity_idx").on(table.entityType, table.entityId),
]);
