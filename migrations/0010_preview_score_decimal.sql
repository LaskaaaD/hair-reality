-- Fit is shown with one decimal (74.6, 74.3), so the stored preview score keeps it.
ALTER TABLE demo_previews ALTER COLUMN score TYPE double precision;
