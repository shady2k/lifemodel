-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.soul (
  id text PRIMARY KEY CHECK (id = 'soul'),
  version bigint NOT NULL CHECK (version > 0),
  document jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS core.recipient_registry (
  recipient_id text PRIMARY KEY CHECK (left(recipient_id, 5) = 'rcpt_'),
  channel text NOT NULL,
  destination text NOT NULL,
  registered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (channel, destination)
);
-- migrate:down
