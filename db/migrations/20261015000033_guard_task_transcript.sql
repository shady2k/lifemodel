-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE core.task_transcript ADD CONSTRAINT task_transcript_message_id_check
  CHECK (message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');
CREATE OR REPLACE FUNCTION core.guard_task_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'transcript immutable content' USING ERRCODE='23514', TABLE='task_transcript';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER task_transcript_immutable BEFORE UPDATE ON core.task_transcript
FOR EACH ROW EXECUTE FUNCTION core.guard_task_transcript();
-- migrate:down
