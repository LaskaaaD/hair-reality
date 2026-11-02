ALTER TABLE consents
  ADD COLUMN accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN withdrawn_at timestamptz,
  ADD COLUMN asset_scope uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN statement text NOT NULL DEFAULT '',
  ADD CONSTRAINT consents_statement_length CHECK (char_length(statement) <= 2000),
  ADD CONSTRAINT consents_withdrawal_check CHECK (withdrawn_at IS NULL OR accepted = false);

ALTER TABLE assets
  ADD COLUMN provenance text NOT NULL DEFAULT 'client_upload',
  ADD COLUMN source_asset_id uuid REFERENCES assets (id),
  ADD CONSTRAINT assets_provenance_check CHECK (provenance IN ('client_upload', 'provider_derivative')),
  ADD CONSTRAINT assets_source_distinct CHECK (source_asset_id IS NULL OR source_asset_id <> id);

CREATE TABLE demo_asset_retentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES assets (id),
  actor_user_id uuid NOT NULL REFERENCES users (id),
  consent_id uuid NOT NULL REFERENCES consents (id),
  retained_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deletion_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  scope text NOT NULL,
  status text NOT NULL,
  journal_sequence bigint,
  journal_checksum text,
  requested_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT deletion_receipts_operation_unique UNIQUE (operation_id),
  CONSTRAINT deletion_receipts_scope_check CHECK (scope IN ('asset', 'consultation')),
  CONSTRAINT deletion_receipts_status_check CHECK (status IN ('pending', 'completed')),
  CONSTRAINT deletion_receipts_checksum_length CHECK (
    journal_checksum IS NULL OR char_length(journal_checksum) = 64
  ),
  CONSTRAINT deletion_receipts_completion_check CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (
      status = 'completed'
      AND journal_sequence IS NOT NULL
      AND journal_checksum IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX deletion_receipts_resource_idx ON deletion_receipts (resource_id, scope);

CREATE FUNCTION assets_expiry_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.expires_at IS NOT NULL AND NEW.expires_at > NEW.created_at + interval '30 days' THEN
    IF NOT EXISTS (
      SELECT 1 FROM demo_asset_retentions
      WHERE asset_id = NEW.id AND retained_until = NEW.expires_at
    ) THEN
      RAISE EXCEPTION 'longer retention requires a demo retention record';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER assets_expiry_guard
  BEFORE INSERT OR UPDATE OF expires_at ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_expiry_guard();

CREATE FUNCTION assets_tombstone_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  consultation_deleted timestamptz;
  source_deleted timestamptz;
BEGIN
  SELECT deleted_at INTO consultation_deleted FROM consultations WHERE id = NEW.consultation_id;
  IF consultation_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'consultation is deleted';
  END IF;
  IF NEW.source_asset_id IS NOT NULL THEN
    SELECT deleted_at INTO source_deleted FROM assets WHERE id = NEW.source_asset_id;
    IF source_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'source asset is deleted';
    END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER assets_tombstone_guard
  BEFORE INSERT ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_tombstone_guard();

CREATE FUNCTION assets_no_restore() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'deleted asset cannot be restored';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER assets_no_restore
  BEFORE UPDATE OF deleted_at ON assets
  FOR EACH ROW EXECUTE FUNCTION assets_no_restore();

CREATE FUNCTION consultations_no_restore() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION 'deleted consultation cannot be restored';
  END IF;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER consultations_no_restore
  BEFORE UPDATE OF deleted_at ON consultations
  FOR EACH ROW EXECUTE FUNCTION consultations_no_restore();
