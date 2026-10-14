-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.settings (
  id text PRIMARY KEY CHECK (id = 'agent-config'),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- migrate:down
