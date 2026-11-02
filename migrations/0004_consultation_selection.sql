-- Selected services can be retired without deleting historical rows.
-- A later selection of the same kind inserts a new identity.

ALTER TABLE consultation_services
  ADD COLUMN selected boolean NOT NULL DEFAULT true;

ALTER TABLE consultation_services
  DROP CONSTRAINT consultation_services_kind_unique;

CREATE UNIQUE INDEX consultation_services_active_kind_unique
  ON consultation_services (consultation_id, kind)
  WHERE selected;
