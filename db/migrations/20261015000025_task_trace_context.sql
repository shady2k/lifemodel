-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE core.tasks
  ADD COLUMN IF NOT EXISTS trace_id text,
  ADD COLUMN IF NOT EXISTS parent_span_id text;
-- Existing tasks have no earlier trace to recover. Their immutable id provides
-- a deterministic root, shared by every resumed diagnostic for that task.
UPDATE core.tasks SET trace_id=id WHERE trace_id IS NULL;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='core.tasks'::regclass AND conname='task_trace_present') THEN
    ALTER TABLE core.tasks ADD CONSTRAINT task_trace_present CHECK (trace_id IS NOT NULL) NOT VALID;
  END IF;
  ALTER TABLE core.tasks VALIDATE CONSTRAINT task_trace_present;
END;
$migration$;
-- The validated CHECK enforces presence without another ACCESS EXCLUSIVE scan.
CREATE OR REPLACE FUNCTION core.guard_task_trace_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.trace_id,NEW.parent_span_id) IS DISTINCT FROM ROW(OLD.trace_id,OLD.parent_span_id) THEN
    RAISE EXCEPTION 'task trace immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_trace_update BEFORE UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_trace_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_trace_update() FROM PUBLIC;
-- migrate:down
