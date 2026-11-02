-- Hair Reality initial schema. Applied by the migration runner, which records a checksum.
-- Plan revisions are immutable. Personal-content purge is a later deletion task and is not granted here.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email = lower(email) AND position('@' IN email) > 1),
  CONSTRAINT users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80),
  CONSTRAINT users_password_argon2id CHECK (password_hash LIKE '$argon2id$%')
);

CREATE TABLE salons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL,
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salons_slug_unique UNIQUE (slug),
  CONSTRAINT salons_slug_format CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT salons_name_length CHECK (char_length(name) BETWEEN 1 AND 120)
);

CREATE TABLE salon_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons (id),
  user_id uuid NOT NULL REFERENCES users (id),
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salon_memberships_pair_unique UNIQUE (salon_id, user_id),
  CONSTRAINT salon_memberships_role_check CHECK (role IN ('stylist', 'admin'))
);

CREATE TABLE user_sessions (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_sessions_id_length CHECK (char_length(id) >= 32)
);

CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id uuid NOT NULL REFERENCES users (id),
  salon_id uuid NOT NULL REFERENCES salons (id),
  assigned_stylist_user_id uuid,
  lifecycle text NOT NULL DEFAULT 'DRAFT',
  version integer NOT NULL DEFAULT 1,
  current_revision_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultations_lifecycle_check CHECK (lifecycle IN (
    'DRAFT', 'READY_FOR_REVIEW', 'SUBMITTED', 'STYLIST_REVIEWING', 'AWAITING_CLIENT',
    'CONSULTATION_REQUIRED', 'PLAN_APPROVED', 'BOOKED', 'CANCELLED'
  )),
  CONSTRAINT consultations_version_check CHECK (version >= 1),
  CONSTRAINT consultations_stylist_membership_fk FOREIGN KEY (salon_id, assigned_stylist_user_id)
    REFERENCES salon_memberships (salon_id, user_id)
);

CREATE INDEX consultations_client_idx ON consultations (client_user_id);
CREATE INDEX consultations_salon_lifecycle_idx ON consultations (salon_id, lifecycle);

CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  consent_version text NOT NULL,
  providers text[] NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consents_version_length CHECK (char_length(consent_version) BETWEEN 1 AND 80)
);

CREATE INDEX consents_consultation_idx ON consents (consultation_id);

CREATE TABLE consultation_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  kind text NOT NULL,
  input_version integer NOT NULL DEFAULT 1,
  CONSTRAINT consultation_services_kind_unique UNIQUE (consultation_id, kind),
  CONSTRAINT consultation_services_kind_check CHECK (kind IN ('haircut', 'colour', 'beard')),
  CONSTRAINT consultation_services_input_version_check CHECK (input_version >= 1)
);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  role text NOT NULL,
  storage_key text NOT NULL,
  content_hash text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  mime_type text NOT NULL,
  consent_id uuid REFERENCES consents (id),
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT assets_role_check CHECK (role IN (
    'current_front', 'current_side', 'current_back', 'beard', 'inspiration', 'preview'
  )),
  CONSTRAINT assets_dimensions_check CHECK (width > 0 AND height > 0),
  CONSTRAINT assets_mime_check CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

CREATE INDEX assets_consultation_idx ON assets (consultation_id);
CREATE INDEX assets_owner_idx ON assets (owner_user_id);

CREATE TABLE analysis_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  consultation_service_id uuid REFERENCES consultation_services (id),
  capability text NOT NULL,
  input_assets jsonb NOT NULL,
  provider text NOT NULL,
  provider_version text,
  source text NOT NULL,
  values jsonb NOT NULL,
  uncertainty text,
  freshness text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_results_source_check CHECK (source IN (
    'youcam', 'llm_observation', 'client_report', 'stylist_report', 'fixture'
  )),
  CONSTRAINT analysis_results_freshness_check CHECK (freshness IN ('current', 'stale', 'unknown'))
);

CREATE INDEX analysis_results_consultation_idx ON analysis_results (consultation_id);

CREATE TABLE hair_histories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  version integer NOT NULL,
  answers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hair_histories_version_unique UNIQUE (consultation_id, version),
  CONSTRAINT hair_histories_version_check CHECK (version >= 1)
);

CREATE TABLE targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_service_id uuid NOT NULL REFERENCES consultation_services (id),
  source_kind text NOT NULL,
  inspiration_asset_id uuid REFERENCES assets (id),
  candidate_id uuid,
  description text,
  interpreted jsonb NOT NULL DEFAULT '{}'::jsonb,
  uncertainty text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT targets_source_kind_check CHECK (source_kind IN ('catalogue', 'upload', 'text'))
);

CREATE TABLE preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  version integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT preferences_version_unique UNIQUE (consultation_id, version),
  CONSTRAINT preferences_version_check CHECK (version >= 1)
);

CREATE TABLE reality_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_service_id uuid NOT NULL REFERENCES consultation_services (id),
  input_fingerprint text NOT NULL,
  findings jsonb NOT NULL,
  engine_version text NOT NULL,
  suggestions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons (id),
  service_kind text NOT NULL,
  title text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_reference text,
  provider_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance text NOT NULL,
  constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidates_service_kind_check CHECK (service_kind IN ('haircut', 'colour', 'beard')),
  CONSTRAINT candidates_provenance_check CHECK (provenance IN ('fixture', 'youcam')),
  CONSTRAINT candidates_reference_matches_provenance CHECK (
    (provenance = 'youcam' AND provider_reference IS NOT NULL)
    OR (provenance = 'fixture' AND provider_reference IS NULL)
  )
);

CREATE INDEX candidates_salon_kind_idx ON candidates (salon_id, service_kind);

ALTER TABLE targets
  ADD CONSTRAINT targets_candidate_fk FOREIGN KEY (candidate_id) REFERENCES candidates (id);

CREATE TABLE provider_budget_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  phase text NOT NULL,
  settled_units bigint NOT NULL DEFAULT 0,
  reserved_units bigint NOT NULL DEFAULT 0,
  CONSTRAINT provider_budget_accounts_identity_unique UNIQUE (provider, phase),
  CONSTRAINT provider_budget_accounts_provider_check CHECK (provider IN ('youcam', 'openai')),
  CONSTRAINT provider_budget_accounts_phase_check CHECK (phase IN ('development', 'demo')),
  CONSTRAINT provider_budget_accounts_units_check CHECK (settled_units >= 0 AND reserved_units >= 0)
);

CREATE TABLE provider_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  provider text NOT NULL,
  operation text NOT NULL,
  input_fingerprint text NOT NULL,
  cost_phase text NOT NULL,
  state text NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  next_poll_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  provider_task_id text,
  attempt integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_jobs_provider_check CHECK (provider IN ('youcam', 'openai')),
  CONSTRAINT provider_jobs_phase_check CHECK (cost_phase IN ('development', 'demo')),
  CONSTRAINT provider_jobs_state_check CHECK (state IN (
    'QUEUED', 'CLAIMED', 'UPLOADING', 'SUBMITTING', 'RUNNING', 'SUCCEEDED',
    'FAILED', 'CANCELLED', 'SUBMISSION_UNCERTAIN', 'RESULT_EXPIRED'
  )),
  CONSTRAINT provider_jobs_attempt_check CHECK (attempt >= 0),
  CONSTRAINT provider_jobs_fencing_check CHECK (fencing_token >= 0)
);

CREATE INDEX provider_jobs_state_idx ON provider_jobs (state);
CREATE INDEX provider_jobs_consultation_idx ON provider_jobs (consultation_id);

CREATE TABLE previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_service_id uuid NOT NULL REFERENCES consultation_services (id),
  job_id uuid REFERENCES provider_jobs (id),
  source_asset_id uuid NOT NULL REFERENCES assets (id),
  candidate_id uuid REFERENCES candidates (id),
  configuration_fingerprint text NOT NULL,
  result_asset_id uuid REFERENCES assets (id),
  provider text NOT NULL,
  provider_version text,
  freshness text NOT NULL,
  representation_limits jsonb NOT NULL DEFAULT '[]'::jsonb,
  stale boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT previews_freshness_check CHECK (freshness IN ('current', 'stale', 'unknown'))
);

CREATE TABLE plan_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  revision_number integer NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users (id),
  parent_revision_id uuid REFERENCES plan_revisions (id),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  review_conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_revisions_number_unique UNIQUE (consultation_id, revision_number),
  CONSTRAINT plan_revisions_number_check CHECK (revision_number >= 1),
  CONSTRAINT plan_revisions_hash_length CHECK (char_length(snapshot_hash) = 64)
);

ALTER TABLE consultations
  ADD CONSTRAINT consultations_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES plan_revisions (id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES plan_revisions (id),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  party text NOT NULL,
  snapshot_hash text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approvals_party_unique UNIQUE (revision_id, party),
  CONSTRAINT approvals_party_check CHECK (party IN ('client', 'stylist')),
  CONSTRAINT approvals_hash_length CHECK (char_length(snapshot_hash) = 64)
);

CREATE TABLE discussion_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  author_user_id uuid NOT NULL REFERENCES users (id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discussion_messages_body_length CHECK (char_length(body) BETWEEN 1 AND 4000)
);

CREATE INDEX discussion_messages_consultation_idx ON discussion_messages (consultation_id);

CREATE TABLE change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  revision_id uuid NOT NULL REFERENCES plan_revisions (id),
  requester_user_id uuid NOT NULL REFERENCES users (id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolving_revision_id uuid REFERENCES plan_revisions (id),
  CONSTRAINT change_requests_reason_length CHECK (char_length(reason) BETWEEN 1 AND 4000),
  CONSTRAINT change_requests_distinct_resolution CHECK (
    resolving_revision_id IS NULL OR resolving_revision_id <> revision_id
  )
);

CREATE INDEX change_requests_open_idx ON change_requests (consultation_id) WHERE resolving_revision_id IS NULL;

CREATE TABLE demo_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES salons (id),
  stylist_user_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  label text NOT NULL DEFAULT 'Demo booking — no real salon appointment has been made.',
  CONSTRAINT demo_slots_time_unique UNIQUE (salon_id, starts_at),
  CONSTRAINT demo_slots_time_check CHECK (ends_at > starts_at),
  CONSTRAINT demo_slots_stylist_membership_fk FOREIGN KEY (salon_id, stylist_user_id)
    REFERENCES salon_memberships (salon_id, user_id)
);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations (id),
  revision_id uuid NOT NULL REFERENCES plan_revisions (id),
  demo_slot_id uuid NOT NULL REFERENCES demo_slots (id),
  idempotency_key text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_idempotency_unique UNIQUE (consultation_id, idempotency_key),
  CONSTRAINT bookings_status_check CHECK (status IN ('confirmed', 'cancelled')),
  CONSTRAINT bookings_idempotency_length CHECK (char_length(idempotency_key) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX bookings_one_confirmed_slot_idx
  ON bookings (demo_slot_id)
  WHERE status = 'confirmed';

CREATE UNIQUE INDEX bookings_one_confirmed_consultation_idx
  ON bookings (consultation_id)
  WHERE status = 'confirmed';

CREATE TABLE usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid REFERENCES provider_jobs (id) ON DELETE SET NULL,
  provider text NOT NULL,
  budget_bucket text NOT NULL,
  unit text NOT NULL,
  estimated_units bigint NOT NULL,
  actual_units bigint,
  settlement_state text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_provider_check CHECK (provider IN ('youcam', 'openai')),
  CONSTRAINT usage_ledger_unit_check CHECK (unit IN ('youcam_unit', 'usd_micro')),
  CONSTRAINT usage_ledger_estimate_check CHECK (estimated_units >= 0),
  CONSTRAINT usage_ledger_actual_check CHECK (actual_units IS NULL OR actual_units >= 0),
  CONSTRAINT usage_ledger_settlement_check CHECK (settlement_state IN (
    'reserved', 'settled', 'released', 'uncertain'
  ))
);

CREATE INDEX usage_ledger_provider_state_idx ON usage_ledger (provider, settlement_state);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_identity_unique UNIQUE (actor_user_id, operation, idempotency_key),
  CONSTRAINT idempotency_keys_length_check CHECK (
    char_length(operation) BETWEEN 1 AND 80 AND char_length(idempotency_key) BETWEEN 1 AND 200
  )
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users (id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  event_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);

CREATE FUNCTION reject_plan_revision_update() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'plan revision is immutable';
END;
$fn$;

CREATE TRIGGER plan_revisions_no_update
  BEFORE UPDATE ON plan_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_plan_revision_update();

CREATE FUNCTION plan_revisions_parent_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  parent_consultation uuid;
BEGIN
  IF NEW.parent_revision_id IS NOT NULL THEN
    SELECT consultation_id INTO parent_consultation
    FROM plan_revisions
    WHERE id = NEW.parent_revision_id;
    IF parent_consultation IS DISTINCT FROM NEW.consultation_id THEN
      RAISE EXCEPTION 'parent revision belongs to another consultation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER plan_revisions_parent_guard
  BEFORE INSERT ON plan_revisions
  FOR EACH ROW EXECUTE FUNCTION plan_revisions_parent_guard();

CREATE FUNCTION approvals_hash_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  revision_hash text;
  revision_consultation uuid;
BEGIN
  SELECT snapshot_hash, consultation_id INTO revision_hash, revision_consultation
  FROM plan_revisions
  WHERE id = NEW.revision_id;
  IF revision_hash IS DISTINCT FROM NEW.snapshot_hash THEN
    RAISE EXCEPTION 'approval hash does not match revision';
  END IF;
  IF revision_consultation IS NULL THEN
    RAISE EXCEPTION 'approval revision is missing';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER approvals_hash_guard
  BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_hash_guard();

CREATE FUNCTION consultations_current_revision_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  revision_consultation uuid;
BEGIN
  IF NEW.current_revision_id IS NOT NULL THEN
    SELECT consultation_id INTO revision_consultation
    FROM plan_revisions
    WHERE id = NEW.current_revision_id;
    IF revision_consultation IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'current revision belongs to another consultation';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER consultations_current_revision_guard
  BEFORE INSERT OR UPDATE OF current_revision_id ON consultations
  FOR EACH ROW EXECUTE FUNCTION consultations_current_revision_guard();

CREATE FUNCTION bookings_relationship_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  revision_consultation uuid;
  slot_salon uuid;
  consultation_salon uuid;
BEGIN
  SELECT consultation_id INTO revision_consultation FROM plan_revisions WHERE id = NEW.revision_id;
  IF revision_consultation IS DISTINCT FROM NEW.consultation_id THEN
    RAISE EXCEPTION 'booking revision belongs to another consultation';
  END IF;
  SELECT salon_id INTO slot_salon FROM demo_slots WHERE id = NEW.demo_slot_id;
  SELECT salon_id INTO consultation_salon FROM consultations WHERE id = NEW.consultation_id;
  IF slot_salon IS DISTINCT FROM consultation_salon THEN
    RAISE EXCEPTION 'booking slot belongs to another salon';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER bookings_relationship_guard
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_relationship_guard();

CREATE FUNCTION provider_jobs_deletion_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  deleted timestamptz;
BEGIN
  SELECT deleted_at INTO deleted FROM consultations WHERE id = NEW.consultation_id;
  IF deleted IS NOT NULL THEN
    RAISE EXCEPTION 'consultation is deleted';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER provider_jobs_deletion_guard
  BEFORE INSERT ON provider_jobs
  FOR EACH ROW EXECUTE FUNCTION provider_jobs_deletion_guard();
