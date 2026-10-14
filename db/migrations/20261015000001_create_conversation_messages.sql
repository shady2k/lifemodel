-- migrate:up
CREATE TABLE core.conversation_messages (
  recipient_id text NOT NULL,
  message_id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('message', 'status', 'action', 'actions_clear', 'clear')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recipient_id, message_id),
  UNIQUE (sequence)
);
CREATE INDEX conversation_messages_recipient_sequence_idx
  ON core.conversation_messages (recipient_id, sequence);
-- migrate:down
