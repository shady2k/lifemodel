-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE core.memories (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('message', 'thought', 'fact', 'intention')),
  content text NOT NULL,
  timestamp timestamptz NOT NULL,
  recipient_id text,
  tags jsonb,
  confidence double precision NOT NULL DEFAULT 0.5,
  salience double precision,
  metadata jsonb,
  tick_id text,
  parent_signal_id text,
  trigger jsonb,
  status text,
  expires_at timestamptz,
  embedding vector(384) NOT NULL
);
CREATE INDEX memories_embedding_hnsw_idx ON core.memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memories_timestamp_idx ON core.memories (timestamp DESC);
CREATE TABLE core.memory_entities (
  id text PRIMARY KEY,
  name text NOT NULL,
  aliases jsonb NOT NULL,
  type text NOT NULL,
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_activated timestamptz NOT NULL,
  source_memory_ids jsonb NOT NULL
);
CREATE UNIQUE INDEX memory_entities_name_idx ON core.memory_entities (lower(name));
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
