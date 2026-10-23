-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.task_mailbox (
  task_id text NOT NULL REFERENCES core.tasks(id),
  attempt_id text NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  direction text NOT NULL CHECK (direction = 'task_to_core'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  message_id text NOT NULL CHECK (message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  kind text NOT NULL CHECK (kind IN ('step','terminal')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 60000),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signalled_at timestamptz,
  PRIMARY KEY (task_id,direction,message_id),
  UNIQUE (task_id,direction,attempt_id,sequence)
);
-- New empty table, created in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS task_mailbox_one_terminal
  ON core.task_mailbox(task_id,attempt_id) WHERE kind='terminal';
-- New empty table, created in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS task_mailbox_unsignalled
  ON core.task_mailbox(received_at,task_id,message_id) WHERE signalled_at IS NULL;
CREATE TABLE IF NOT EXISTS core.task_mailbox_cursors (
  task_id text NOT NULL REFERENCES core.tasks(id),
  direction text NOT NULL CHECK (direction = 'task_to_core'),
  received_count bigint NOT NULL CHECK (received_count > 0),
  last_received_message_id text NOT NULL,
  signalled_count bigint NOT NULL DEFAULT 0 CHECK (signalled_count >= 0 AND signalled_count <= received_count),
  last_signalled_message_id text,
  PRIMARY KEY(task_id,direction)
);
CREATE OR REPLACE FUNCTION core.guard_task_mailbox_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.task_id,NEW.attempt_id,NEW.direction,NEW.sequence,NEW.message_id,NEW.kind,NEW.payload,NEW.received_at)
     IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.direction,OLD.sequence,OLD.message_id,OLD.kind,OLD.payload,OLD.received_at)
     OR (OLD.signalled_at IS NOT NULL AND NEW.signalled_at IS DISTINCT FROM OLD.signalled_at) THEN
    RAISE EXCEPTION 'mailbox immutable content' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_mailbox_update BEFORE UPDATE ON core.task_mailbox
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_mailbox_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_mailbox_update() FROM PUBLIC;
-- migrate:down
