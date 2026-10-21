-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- The storage module's own catalog (ADR-015 S-D4): the spaces it hands out and
-- the access revision and mode each one is in. It lives beside the core schema
-- and is read by the module alone; the module's readiness answers
-- `catalog_unavailable` until this table exists (S-D7).
CREATE SCHEMA IF NOT EXISTS storage;

-- One row per task space. Access starts at revision zero in mode `open`;
-- freeze, seal and revoke move the revision forward (S-D4). 653.7.2 adds the
-- binding, retention and revoke-receipt columns.
CREATE TABLE IF NOT EXISTS storage.spaces (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  access_revision bigint NOT NULL DEFAULT 0 CHECK (access_revision >= 0),
  mode text NOT NULL DEFAULT 'open' CHECK (mode IN ('open', 'wrapping', 'frozen', 'sealed', 'revoked'))
);
-- migrate:down
