-- migrate:up
CREATE TABLE core.soul (
  id text PRIMARY KEY CHECK (id = 'soul'),
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL
);

CREATE TABLE core.recipient_registry (
  recipient_id text PRIMARY KEY CHECK (left(recipient_id, 5) = 'rcpt_'),
  channel text NOT NULL,
  destination text NOT NULL,
  registered_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  UNIQUE (channel, destination)
);
-- migrate:down
