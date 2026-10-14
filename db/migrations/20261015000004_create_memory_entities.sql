-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.memory_entities (
  id text PRIMARY KEY,
  name text NOT NULL,
  aliases jsonb NOT NULL,
  type text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activated timestamptz NOT NULL,
  source_memory_ids jsonb NOT NULL
);
-- Justification: this index is built on a new empty table, and the migration runner uses a transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS memory_entities_name_idx ON core.memory_entities (lower(name));
-- migrate:down
