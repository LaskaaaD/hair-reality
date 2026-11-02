ALTER TABLE previews
  ADD COLUMN selected boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX previews_one_selected
  ON previews (consultation_service_id)
  WHERE selected;
