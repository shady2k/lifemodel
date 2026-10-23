-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Retain consumed execution claims independently of Pod/Job cleanup.
CREATE TABLE IF NOT EXISTS task_access.start_claims (
  launch_id text PRIMARY KEY,
  task_id text NOT NULL UNIQUE,
  attempt_id text NOT NULL UNIQUE,
  pod_uid text NOT NULL UNIQUE CHECK (pod_uid <> ''),
  job_uid text NOT NULL CHECK (job_uid <> ''),
  boot_nonce text NOT NULL CHECK (boot_nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  job_started_at timestamptz NOT NULL CHECK (isfinite(job_started_at)),
  soft_due_at timestamptz NOT NULL CHECK (isfinite(soft_due_at)),
  hard_stop_at timestamptz NOT NULL CHECK (isfinite(hard_stop_at) AND hard_stop_at >= soft_due_at),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- migrate:down
