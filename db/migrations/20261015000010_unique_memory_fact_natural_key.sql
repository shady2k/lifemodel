-- migrate:no-transaction
-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS memories_fact_natural_key_idx
  ON core.memories ((metadata->>'subject'), (metadata->>'attribute'))
  WHERE type = 'fact' AND metadata ? 'subject' AND metadata ? 'attribute';
-- migrate:down
