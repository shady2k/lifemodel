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
-- migrate:down
