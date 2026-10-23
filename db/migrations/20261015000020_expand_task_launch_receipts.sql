-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Keep caller payload distinct from the deployment-selected image. Existing
-- acceptances used the supplied image directly, so their payload is that digest.
ALTER TABLE core.tasks ADD COLUMN IF NOT EXISTS request_image_revision text;
UPDATE core.tasks SET request_image_revision=image_revision WHERE request_image_revision IS NULL;
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'core.tasks'::regclass AND conname = 'task_request_image_shape'
  ) THEN
    ALTER TABLE core.tasks ADD CONSTRAINT task_request_image_shape CHECK (
      request_image_revision IS NOT NULL AND request_image_revision ~ '^sha256:[0-9a-f]{64}$'
    ) NOT VALID;
  END IF;
  ALTER TABLE core.tasks VALIDATE CONSTRAINT task_request_image_shape;
END;
$migration$;
CREATE OR REPLACE FUNCTION core.guard_task_request_image_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.request_image_revision IS DISTINCT FROM OLD.request_image_revision THEN
    RAISE EXCEPTION 'task immutable input' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_request_image_update BEFORE UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_request_image_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_request_image_update() FROM PUBLIC;
ALTER TABLE core.task_launches
  ADD COLUMN IF NOT EXISTS allocation_receipt jsonb,
  ADD COLUMN IF NOT EXISTS template_hash text,
  ADD COLUMN IF NOT EXISTS cleanup_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS soft_stop_requested_at timestamptz;
-- Existing rows have no receipt/binding hash and remain unbound for launch purposes.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'core.task_launches'::regclass AND conname = 'task_launch_receipts_shape'
  ) THEN
    ALTER TABLE core.task_launches ADD CONSTRAINT task_launch_receipts_shape CHECK (
      allocation_receipt IS NULL OR (
        jsonb_typeof(allocation_receipt) = 'object'
        AND allocation_receipt ?& ARRAY['id','space','effectKey']
        AND allocation_receipt - 'id' - 'space' - 'effectKey' = '{}'::jsonb
        AND jsonb_typeof(allocation_receipt->'id') = 'string'
        AND allocation_receipt->>'id' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
        AND jsonb_typeof(allocation_receipt->'space') = 'string'
        AND allocation_receipt->>'space' ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
        AND jsonb_typeof(allocation_receipt->'effectKey') = 'string'
        AND length(allocation_receipt->>'effectKey') BETWEEN 1 AND 512
      )
    ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'core.task_launches'::regclass AND conname = 'task_launch_cleanup_shape'
  ) THEN
    ALTER TABLE core.task_launches ADD CONSTRAINT task_launch_cleanup_shape CHECK (
      (template_hash IS NULL OR (template_hash ~ '^[0-9a-f]{64}$' AND job_uid IS NOT NULL AND allocation_receipt IS NOT NULL))
      AND (NOT cleanup_pending OR tombstoned_at IS NOT NULL)
      AND (soft_stop_requested_at IS NULL OR isfinite(soft_stop_requested_at))
    ) NOT VALID;
  END IF;
  ALTER TABLE core.task_launches VALIDATE CONSTRAINT task_launch_receipts_shape;
  ALTER TABLE core.task_launches VALIDATE CONSTRAINT task_launch_cleanup_shape;
END;
$migration$;

CREATE OR REPLACE FUNCTION core.guard_task_launch_receipts_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.allocation_receipt IS NOT NULL AND NEW.allocation_receipt IS DISTINCT FROM OLD.allocation_receipt)
     OR (OLD.template_hash IS NOT NULL AND NEW.template_hash IS DISTINCT FROM OLD.template_hash)
     OR (OLD.soft_stop_requested_at IS NOT NULL AND NEW.soft_stop_requested_at IS DISTINCT FROM OLD.soft_stop_requested_at)
     OR (OLD.tombstoned_at IS NOT NULL AND ROW(NEW.allocation_receipt,NEW.template_hash) IS DISTINCT FROM ROW(OLD.allocation_receipt,OLD.template_hash)) THEN
    RAISE EXCEPTION 'launch immutable receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_launch_receipts_update BEFORE UPDATE ON core.task_launches
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_launch_receipts_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_launch_receipts_update() FROM PUBLIC;
-- migrate:down
