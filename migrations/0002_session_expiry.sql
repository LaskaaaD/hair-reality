-- Session lifetime. expires_at is the idle deadline and moves forward on use.
-- absolute_expires_at is fixed at creation and is never extended.

ALTER TABLE user_sessions
  ADD COLUMN absolute_expires_at timestamptz;

UPDATE user_sessions
SET absolute_expires_at = GREATEST(expires_at, created_at + interval '7 days')
WHERE absolute_expires_at IS NULL;

ALTER TABLE user_sessions
  ALTER COLUMN absolute_expires_at SET NOT NULL;

ALTER TABLE user_sessions
  ADD CONSTRAINT user_sessions_idle_within_absolute CHECK (expires_at <= absolute_expires_at);
