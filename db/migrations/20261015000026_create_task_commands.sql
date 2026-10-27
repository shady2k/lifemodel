-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Expands the accepted kinds; the replacement keeps every previously valid row.
-- squawk-ignore ban-drop-constraint
ALTER TABLE core.task_mailbox DROP CONSTRAINT IF EXISTS task_mailbox_kind_check;
ALTER TABLE core.task_mailbox ADD CONSTRAINT task_mailbox_kind_check CHECK (kind IN ('step','question','terminal')) NOT VALID;
CREATE TABLE IF NOT EXISTS core.task_commands (
  task_id text NOT NULL REFERENCES core.tasks(id),
  attempt_id text NOT NULL,
  command_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  content jsonb NOT NULL CHECK (octet_length(content::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  PRIMARY KEY(task_id,command_id),
  UNIQUE(task_id,attempt_id,sequence)
);
CREATE TABLE IF NOT EXISTS core.task_command_acks (
  task_id text NOT NULL,
  command_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('accepted','rejected','uncertain')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id,command_id),
  FOREIGN KEY(task_id,command_id) REFERENCES core.task_commands(task_id,command_id)
);
CREATE TABLE IF NOT EXISTS core.task_command_receipts (
  task_id text NOT NULL,
  command_id text NOT NULL,
  receipt_id text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('inserted','deferred-to-next-turn','failed','uncertain')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(task_id,receipt_id),
  FOREIGN KEY(task_id,command_id) REFERENCES core.task_commands(task_id,command_id)
);
CREATE TABLE IF NOT EXISTS core.task_questions (
  task_id text NOT NULL REFERENCES core.tasks(id),
  question_id text NOT NULL,
  answer_command_id text,
  PRIMARY KEY(task_id,question_id),
  FOREIGN KEY(task_id,answer_command_id) REFERENCES core.task_commands(task_id,command_id)
);
-- New empty table in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS task_one_open_question ON core.task_questions(task_id) WHERE answer_command_id IS NULL;
CREATE OR REPLACE FUNCTION core.guard_task_command_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.task_id,NEW.attempt_id,NEW.command_id,NEW.sequence,NEW.content,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.command_id,OLD.sequence,OLD.content,OLD.created_at)
    OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
    OR (NEW.retired_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.task_command_acks WHERE task_id=NEW.task_id AND command_id=NEW.command_id)) THEN
    RAISE EXCEPTION 'command requires immutable content and ACK before retirement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_command_update BEFORE UPDATE ON core.task_commands FOR EACH ROW EXECUTE FUNCTION core.guard_task_command_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_command_update() FROM PUBLIC;
-- migrate:down
