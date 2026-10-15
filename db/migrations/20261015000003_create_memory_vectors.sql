-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.memories (
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
-- Justification: this index is built on a new empty table, and the migration runner uses a transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS memories_embedding_hnsw_idx ON core.memories USING hnsw (embedding vector_cosine_ops);
-- Justification: this index is built on a new empty table, and the migration runner uses a transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS memories_timestamp_idx ON core.memories (timestamp DESC);
-- migrate:down
