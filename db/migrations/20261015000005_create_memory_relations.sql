-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE core.memory_relations (
  id text PRIMARY KEY,
  from_id text NOT NULL REFERENCES core.memory_entities(id) ON DELETE CASCADE,
  to_id text NOT NULL REFERENCES core.memory_entities(id) ON DELETE CASCADE,
  type text NOT NULL,
  strength double precision NOT NULL,
  confidence double precision NOT NULL,
  source_trace_id text,
  last_activated timestamptz NOT NULL,
  source_memory_ids jsonb NOT NULL
);
CREATE INDEX memory_relations_from_idx ON core.memory_relations (from_id);
CREATE INDEX memory_relations_to_idx ON core.memory_relations (to_id);
-- migrate:down
