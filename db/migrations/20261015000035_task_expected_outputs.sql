-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE core.tasks
  ADD COLUMN IF NOT EXISTS expected_outputs text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS redo_of text;

CREATE OR REPLACE FUNCTION core.valid_task_expected_outputs(names text[])
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT names IS NOT NULL AND cardinality(names)<=16
    AND (cardinality(names)=0 OR array_ndims(names)=1)
    AND NOT EXISTS (SELECT 1 FROM unnest(names) name
      WHERE name IS NULL OR name !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')
    AND cardinality(names)=(SELECT count(DISTINCT name) FROM unnest(names) name)
$$;
REVOKE EXECUTE ON FUNCTION core.valid_task_expected_outputs(text[]) FROM PUBLIC;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='core.tasks'::regclass AND conname='task_expected_outputs_shape') THEN
    ALTER TABLE core.tasks ADD CONSTRAINT task_expected_outputs_shape
      CHECK (core.valid_task_expected_outputs(expected_outputs)) NOT VALID;
  END IF;
  ALTER TABLE core.tasks VALIDATE CONSTRAINT task_expected_outputs_shape;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='core.tasks'::regclass AND conname='task_redo_original') THEN
    ALTER TABLE core.tasks ADD CONSTRAINT task_redo_original
      FOREIGN KEY (redo_of) REFERENCES core.tasks(id) NOT VALID;
  END IF;
  ALTER TABLE core.tasks VALIDATE CONSTRAINT task_redo_original;
END;
$migration$;
-- Small core task table; lock_timeout bounds the index creation lock wait.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_redo ON core.tasks(redo_of) WHERE redo_of IS NOT NULL;

CREATE OR REPLACE FUNCTION core.guard_task_delivery_input()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  original core.tasks%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.expected_outputs,NEW.redo_of) IS DISTINCT FROM ROW(OLD.expected_outputs,OLD.redo_of) THEN
      RAISE EXCEPTION 'task delivery input immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.redo_of IS NOT NULL THEN
    SELECT * INTO original FROM core.tasks WHERE id=NEW.redo_of FOR UPDATE;
    IF NOT FOUND OR original.redo_of IS NOT NULL OR original.state NOT IN ('done','failed','stopped') THEN
      RAISE EXCEPTION 'task redo requires terminal original' USING ERRCODE='23514';
    END IF;
    IF NEW.expected_outputs IS DISTINCT FROM original.expected_outputs THEN
      RAISE EXCEPTION 'task redo must preserve expected outputs' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.state='done' AND EXISTS (
    SELECT 1 FROM unnest(NEW.expected_outputs) name WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.seal_receipt->'manifest'->'objects') object
      WHERE object->>'name'=name AND object->>'mark' IN ('result','artifact')
    )
  ) THEN
    RAISE EXCEPTION 'task expected output missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_delivery_input BEFORE INSERT OR UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_delivery_input();
REVOKE EXECUTE ON FUNCTION core.guard_task_delivery_input() FROM PUBLIC;
-- migrate:down
