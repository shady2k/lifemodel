-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Gateway-verified locators, never caller-provided authority. Nullable expansion;
-- bind fails closed until stage 3 writes both names alongside exact UIDs.
ALTER TABLE task_access.projections ADD COLUMN IF NOT EXISTS pod_name text;
ALTER TABLE task_access.projections ADD COLUMN IF NOT EXISTS job_name text;
CREATE TABLE IF NOT EXISTS storage.allocations (
  launch_id text PRIMARY KEY,
  task_id text NOT NULL,
  space_id text NOT NULL UNIQUE REFERENCES storage.spaces(id),
  retention_revision text NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.allocate_receipts (
  effect_key text PRIMARY KEY,
  space_id text NOT NULL REFERENCES storage.spaces(id),
  request jsonb NOT NULL,
  receipt jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.bindings (
  space_id text PRIMARY KEY REFERENCES storage.spaces(id),
  task_id text NOT NULL,
  attempt_id text NOT NULL,
  launch_id text NOT NULL,
  pod_uid text NOT NULL,
  job_uid text NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.bind_receipts (
  effect_key text PRIMARY KEY,
  space_id text NOT NULL REFERENCES storage.spaces(id),
  request jsonb NOT NULL,
  receipt jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.seal_operations (
  space_id text PRIMARY KEY REFERENCES storage.spaces(id),
  effect_key text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  receipt_id text NOT NULL UNIQUE,
  manifest_id text NOT NULL UNIQUE,
  revision bigint NOT NULL CHECK (revision >= 0),
  outcome text NOT NULL CHECK (outcome IN ('completed','failed','stopped')),
  candidates jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('frozen','manifest-committed','cleanup','sealed')),
  frozen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS storage.seal_manifests (
  space_id text PRIMARY KEY REFERENCES storage.seal_operations(space_id),
  id text NOT NULL UNIQUE,
  version bigint NOT NULL CHECK (version=1),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  objects jsonb NOT NULL,
  reason text
);
CREATE TABLE IF NOT EXISTS storage.seal_gc (
  space_id text NOT NULL REFERENCES storage.seal_operations(space_id),
  attempt_id uuid NOT NULL REFERENCES storage.upload_attempts(id),
  s3_key text NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(space_id,attempt_id)
);
-- Tombstones retain the immutable upload/object/attempt identities; bytes alone
-- disappear. Task access is frozen before these entries can be created.
CREATE TABLE IF NOT EXISTS storage.object_tombstones (
  object_id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES storage.spaces(id),
  reason text NOT NULL CHECK (reason='seal_unmarked')
);
CREATE TABLE IF NOT EXISTS storage.seal_receipts (
  effect_key text PRIMARY KEY,
  space_id text NOT NULL UNIQUE REFERENCES storage.spaces(id),
  receipt jsonb NOT NULL
);
-- migrate:down
