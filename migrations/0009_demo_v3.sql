ALTER TABLE demo_sessions
  ADD COLUMN audience text NOT NULL DEFAULT 'guest' CHECK (audience IN ('guest', 'judge')),
  ADD COLUMN brief_token_hash text UNIQUE,
  ADD COLUMN recommendation jsonb;

ALTER TABLE demo_previews
  ADD COLUMN detail jsonb NOT NULL DEFAULT '{}'::jsonb;
