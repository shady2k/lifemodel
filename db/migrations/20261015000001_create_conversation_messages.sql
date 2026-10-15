-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.conversation_messages (
  recipient_id text NOT NULL,
  message_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('message', 'status', 'action', 'actions_clear', 'clear', 'compaction')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, message_id),
  UNIQUE (sequence)
);
-- Justification: this index is built on a new empty table, and the migration runner uses a transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS conversation_messages_recipient_sequence_idx
  ON core.conversation_messages (recipient_id, sequence);
-- migrate:down
