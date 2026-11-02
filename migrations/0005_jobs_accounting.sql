-- Separate synthetic accounting from live balances, and keep the price snapshot
-- with each reservation. Existing live rows stay at mode 'live' and are not reset.

ALTER TABLE provider_budget_accounts
  ADD COLUMN mode text NOT NULL DEFAULT 'live',
  ADD COLUMN external_units bigint NOT NULL DEFAULT 0,
  ADD COLUMN balance_units bigint,
  ADD COLUMN balance_observed_at timestamptz,
  ADD COLUMN prices_observed_at timestamptz;

ALTER TABLE provider_budget_accounts
  DROP CONSTRAINT provider_budget_accounts_identity_unique;

ALTER TABLE provider_budget_accounts
  ADD CONSTRAINT provider_budget_accounts_mode_check CHECK (mode IN ('fixture', 'recorded_demo', 'live')),
  ADD CONSTRAINT provider_budget_accounts_identity_unique UNIQUE (provider, phase, mode),
  ADD CONSTRAINT provider_budget_accounts_external_check CHECK (external_units >= 0),
  ADD CONSTRAINT provider_budget_accounts_balance_check CHECK (balance_units IS NULL OR balance_units >= 0);

ALTER TABLE provider_jobs
  ADD COLUMN mode text NOT NULL DEFAULT 'fixture',
  ADD COLUMN actor_user_id uuid REFERENCES users (id),
  ADD COLUMN request_hash text,
  ADD COLUMN provider_version text NOT NULL DEFAULT 'fixture',
  ADD COLUMN configuration_fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN max_cost bigint NOT NULL DEFAULT 0,
  ADD COLUMN consultation_service_id uuid REFERENCES consultation_services (id),
  ADD COLUMN source_asset_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN service_input_version integer,
  ADD CONSTRAINT provider_jobs_mode_check CHECK (mode IN ('fixture', 'recorded_demo', 'live')),
  ADD CONSTRAINT provider_jobs_max_cost_check CHECK (max_cost >= 0);

ALTER TABLE usage_ledger
  ADD COLUMN mode text NOT NULL DEFAULT 'fixture',
  ADD COLUMN phase text NOT NULL DEFAULT 'development',
  ADD COLUMN price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT usage_ledger_mode_check CHECK (mode IN ('fixture', 'recorded_demo', 'live')),
  ADD CONSTRAINT usage_ledger_phase_check CHECK (phase IN ('development', 'demo'));

ALTER TABLE idempotency_keys
  ADD COLUMN resource_id uuid;

CREATE TABLE provider_price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  mode text NOT NULL,
  operation text NOT NULL,
  units bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  CONSTRAINT provider_price_observations_units_check CHECK (units >= 0),
  CONSTRAINT provider_price_observations_provider_check CHECK (provider IN ('youcam', 'openai')),
  CONSTRAINT provider_price_observations_mode_check CHECK (mode IN ('fixture', 'recorded_demo', 'live'))
);

CREATE INDEX provider_price_observations_lookup_idx
  ON provider_price_observations (provider, mode, operation, observed_at DESC);

CREATE TABLE fixture_provider_tasks (
  task_id text PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES provider_jobs (id),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fixture_provider_tasks_status_check CHECK (status IN ('running', 'succeeded', 'failed'))
);
