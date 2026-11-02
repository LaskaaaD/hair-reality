CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  service text NOT NULL CHECK (service IN ('haircut', 'colour', 'beard')),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  likes text[] NOT NULL DEFAULT '{}',
  analysis jsonb,
  analysis_status text NOT NULL DEFAULT 'idle' CHECK (analysis_status IN ('idle', 'running', 'ready', 'failed')),
  analysis_fingerprint text,
  persona_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE demo_photos (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  role text NOT NULL,
  storage_key text NOT NULL,
  content_hash text NOT NULL,
  mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, role)
);

CREATE TABLE demo_references (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  mime text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demo_previews (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  candidate_key text NOT NULL,
  title text NOT NULL,
  score integer NOT NULL,
  label text NOT NULL,
  reasons jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'ready', 'skipped', 'failed')),
  storage_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demo_usage (
  id uuid PRIMARY KEY,
  session_id uuid REFERENCES demo_sessions (id) ON DELETE SET NULL,
  capability text NOT NULL,
  units integer NOT NULL CHECK (units >= 0),
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE INDEX demo_usage_created_idx ON demo_usage (created_at);
CREATE INDEX demo_previews_session_idx ON demo_previews (session_id);

CREATE TABLE demo_jobs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES demo_sessions (id) ON DELETE CASCADE,
  capability text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  provider_task_id text,
  units integer NOT NULL CHECK (units >= 0),
  idempotency_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error_code text,
  storage_key text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX demo_jobs_status_idx ON demo_jobs (status, created_at);
