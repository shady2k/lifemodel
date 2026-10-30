-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='core.task_transcript'::regclass
    AND conname='task_transcript_message_id_check') THEN
    ALTER TABLE core.task_transcript ADD CONSTRAINT task_transcript_message_id_check
      CHECK (message_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$');
  END IF;
END $$;
CREATE OR REPLACE FUNCTION core.guard_task_transcript() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'transcript immutable content' USING ERRCODE='23514', TABLE='task_transcript';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER task_transcript_immutable BEFORE UPDATE ON core.task_transcript
FOR EACH ROW EXECUTE FUNCTION core.guard_task_transcript();
REVOKE EXECUTE ON FUNCTION core.guard_task_transcript() FROM PUBLIC;
-- migrate:down
