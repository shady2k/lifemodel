-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Separate from the control mailbox: captured content never wakes cognition.
-- Capture stops at 1024 immutable entries (max 8 MiB logical JSON per task).
CREATE TABLE IF NOT EXISTS core.task_transcript (
  task_id text NOT NULL REFERENCES core.tasks(id) ON DELETE CASCADE,
  ordinal bigint GENERATED ALWAYS AS IDENTITY,
  attempt_id text NOT NULL,
  message_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id,message_id),
  UNIQUE(task_id,ordinal),
  UNIQUE(task_id,attempt_id,sequence)
);
-- migrate:down
