-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Narrow read contract, NOT the task launch/outcome registry. Stage 3's fenced
-- lifecycle writer updates this stable row in place (never delete/reinsert):
-- UPDATE conflicts with the reader's short FOR SHARE lock before its final read.
CREATE SCHEMA IF NOT EXISTS task_access;
CREATE TABLE task_access.intents (
  task_id text NOT NULL,
  attempt_id text NOT NULL,
  launch_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  mode text NOT NULL CHECK (mode IN ('active', 'wrapping', 'revoked')),
  soft_due_at timestamptz NOT NULL CHECK (isfinite(soft_due_at)),
  hard_stop_at timestamptz NOT NULL CHECK (isfinite(hard_stop_at) AND hard_stop_at >= soft_due_at),
  PRIMARY KEY (task_id, attempt_id, launch_id)
);
-- Once-only verified binding, written by gateway reconciliation (ADR-014 D3).
-- No briefing, secret, grant, outcome or permission to launch is stored here.
CREATE TABLE task_access.projections (
  task_id text NOT NULL,
  attempt_id text NOT NULL,
  launch_id text NOT NULL,
  job_uid text NOT NULL CHECK (job_uid <> ''),
  pod_uid text NOT NULL UNIQUE CHECK (pod_uid <> ''),
  space_id text NOT NULL UNIQUE,
  access_revision bigint NOT NULL CHECK (access_revision >= 0),
  intent_revision bigint NOT NULL CHECK (intent_revision >= 0),
  mode text NOT NULL CHECK (mode IN ('active', 'wrapping', 'revoked')),
  soft_due_at timestamptz NOT NULL CHECK (isfinite(soft_due_at)),
  hard_stop_at timestamptz NOT NULL CHECK (isfinite(hard_stop_at) AND hard_stop_at >= soft_due_at),
  PRIMARY KEY (task_id, attempt_id, launch_id)
);
-- No FK to the future registry or intent: a missing authority row must deny.
-- A global key records the entire request identity, including expected revision.
CREATE TABLE storage.revoke_receipts (
  effect_key text PRIMARY KEY CHECK (length(effect_key) BETWEEN 1 AND 128),
  space_id text NOT NULL REFERENCES storage.spaces(id),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  revision bigint NOT NULL CHECK (revision > expected_revision),
  receipt_id text NOT NULL UNIQUE
);
-- migrate:down
