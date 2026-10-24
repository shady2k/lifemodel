-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE core.tasks
  ADD COLUMN IF NOT EXISTS terminal_summary text,
  ADD COLUMN IF NOT EXISTS candidate_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finalization_failure_code text,
  ADD COLUMN IF NOT EXISTS seal_request jsonb,
  ADD COLUMN IF NOT EXISTS seal_receipt jsonb;
ALTER TABLE core.task_launches
  ADD COLUMN IF NOT EXISTS termination_confirmed_at timestamptz;
CREATE TABLE IF NOT EXISTS core.task_outcomes (
  outcome_key text PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES core.tasks(id),
  launch_id text NOT NULL UNIQUE REFERENCES core.task_launches(launch_id),
  event jsonb NOT NULL CHECK (jsonb_typeof(event)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  signalled_at timestamptz,
  CHECK (outcome_key='outcome_' || launch_id),
  CHECK (event->>'taskId'=task_id AND event->>'outcomeKey'=outcome_key
    AND event->>'state' IN ('done','failed','stopped'))
);
-- New empty table, created in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS task_outcomes_unsignalled
  ON core.task_outcomes(created_at,outcome_key) WHERE signalled_at IS NULL;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='core.tasks'::regclass AND conname='task_finalization_shape') THEN
    ALTER TABLE core.tasks ADD CONSTRAINT task_finalization_shape CHECK (
      candidate_revision >= 0
      AND (terminal_summary IS NULL OR length(terminal_summary)<=60000)
      AND (finalization_failure_code IS NULL OR finalization_failure_code ~ '^[a-z][a-z0-9_]{0,63}$')
      AND (seal_request IS NULL OR (jsonb_typeof(seal_request)='object'
        AND seal_request ?& ARRAY['space','effectKey','expectedRevision','intentRevision','outcome','candidateRevision']
        AND seal_request->>'outcome' IN ('completed','failed','stopped')))
      AND (seal_receipt IS NULL OR (jsonb_typeof(seal_receipt)='object'
        AND seal_receipt->>'state'='sealed' AND seal_request IS NOT NULL
        AND seal_receipt->>'space'=seal_request->>'space'
        AND seal_receipt->>'effectKey'=seal_request->>'effectKey'
        AND seal_receipt->>'outcome'=seal_request->>'outcome'
        AND jsonb_typeof(seal_receipt->'manifest')='object'
        AND jsonb_typeof(seal_receipt->'manifest'->'objects')='array'))
    ) NOT VALID;
  END IF;
  ALTER TABLE core.tasks VALIDATE CONSTRAINT task_finalization_shape;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='core.task_launches'::regclass AND conname='task_termination_shape') THEN
    ALTER TABLE core.task_launches ADD CONSTRAINT task_termination_shape CHECK (
      termination_confirmed_at IS NULL OR (isfinite(termination_confirmed_at) AND tombstoned_at IS NOT NULL)
    ) NOT VALID;
  END IF;
  ALTER TABLE core.task_launches VALIDATE CONSTRAINT task_termination_shape;
END;
$migration$;
-- Preserve the original acceptance/terminal guards; semantic terminal reports may
-- arrive while the public state still says starting (Job status is not authority).
CREATE OR REPLACE FUNCTION core.guard_task_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.id,NEW.launch_key,NEW.briefing,NEW.profile,NEW.settings_revision,NEW.harness,NEW.image_revision,NEW.wrap_grace_seconds,NEW.accepted_order,NEW.accepted_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.launch_key,OLD.briefing,OLD.profile,OLD.settings_revision,OLD.harness,OLD.image_revision,OLD.wrap_grace_seconds,OLD.accepted_order,OLD.accepted_at)
     OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'task immutable input' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('done','failed','stopped') AND
     ROW(NEW.state,NEW.terminal_candidate,NEW.terminal_reason_code,NEW.terminal_at,NEW.finalization_pending)
     IS DISTINCT FROM ROW(OLD.state,OLD.terminal_candidate,OLD.terminal_reason_code,OLD.terminal_at,OLD.finalization_pending) THEN
    RAISE EXCEPTION 'task terminal immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state='queued' AND NEW.state IN ('starting','failed','stopped')) OR
    (OLD.state='starting' AND NEW.state IN ('running','wrapping-up','done','failed','stopped')) OR
    (OLD.state='running' AND NEW.state IN ('wrapping-up','done','failed','stopped')) OR
    (OLD.state='wrapping-up' AND NEW.state IN ('done','failed','stopped'))
  ) THEN
    RAISE EXCEPTION 'task invalid transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION core.guard_task_update() FROM PUBLIC;
CREATE OR REPLACE FUNCTION core.guard_task_finalization_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.state IN ('done','failed','stopped') AND
      ROW(NEW.terminal_summary,NEW.candidate_revision,NEW.finalization_failure_code,NEW.seal_request,NEW.seal_receipt)
      IS DISTINCT FROM ROW(OLD.terminal_summary,OLD.candidate_revision,OLD.finalization_failure_code,OLD.seal_request,OLD.seal_receipt))
    OR NEW.candidate_revision < OLD.candidate_revision
    OR (OLD.terminal_candidate='stopped' AND NEW.terminal_candidate IS DISTINCT FROM 'stopped')
    OR (OLD.seal_receipt IS NOT NULL AND NEW.seal_receipt IS DISTINCT FROM OLD.seal_receipt) THEN
    RAISE EXCEPTION 'task finalization immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state NOT IN ('done','failed','stopped') AND NEW.state IN ('done','failed','stopped') THEN
    IF NEW.seal_receipt IS NULL OR NEW.seal_receipt->>'state' IS DISTINCT FROM 'sealed'
      OR NEW.terminal_summary IS NULL
      OR NOT EXISTS (SELECT 1 FROM core.task_launches l JOIN task_access.intents i USING(task_id,attempt_id,launch_id)
        WHERE l.task_id=NEW.id AND l.termination_confirmed_at IS NOT NULL AND l.tombstoned_at IS NOT NULL AND i.mode='revoked'
          AND ((NEW.seal_request->>'candidateRevision'=NEW.candidate_revision::text AND NEW.seal_request->>'intentRevision'=i.revision::text)
            OR (NEW.state='stopped' AND NEW.seal_request->>'candidateRevision'<>NEW.candidate_revision::text)))
      OR (NEW.state='done' AND (NEW.seal_receipt->>'outcome' IS DISTINCT FROM 'completed'
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.seal_receipt->'manifest'->'objects') o WHERE o->>'mark'='result'))) THEN
      RAISE EXCEPTION 'task finalization proof required' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_finalization_update BEFORE UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_finalization_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_finalization_update() FROM PUBLIC;
-- Finalization may need to recover an allocation whose HTTP response was lost
-- before the tombstone. It never authorizes a new Job or changes an old receipt.
CREATE OR REPLACE FUNCTION core.guard_task_launch_receipts_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.allocation_receipt IS NOT NULL AND NEW.allocation_receipt IS DISTINCT FROM OLD.allocation_receipt)
     OR (OLD.template_hash IS NOT NULL AND NEW.template_hash IS DISTINCT FROM OLD.template_hash)
     OR (OLD.soft_stop_requested_at IS NOT NULL AND NEW.soft_stop_requested_at IS DISTINCT FROM OLD.soft_stop_requested_at)
     OR (OLD.tombstoned_at IS NOT NULL AND NEW.template_hash IS DISTINCT FROM OLD.template_hash
       AND NOT (OLD.template_hash IS NULL AND NEW.template_hash IS NOT NULL AND NEW.cleanup_pending
         AND NEW.termination_confirmed_at IS NULL AND EXISTS (SELECT 1 FROM core.tasks WHERE id=NEW.task_id AND terminal_candidate IS NOT NULL)))
     OR (OLD.tombstoned_at IS NOT NULL AND OLD.allocation_receipt IS NULL AND NEW.allocation_receipt IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM core.tasks WHERE id=NEW.task_id AND terminal_candidate IS NOT NULL AND state NOT IN ('done','failed','stopped'))) THEN
    RAISE EXCEPTION 'launch immutable receipt' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION core.guard_task_launch_receipts_update() FROM PUBLIC;
CREATE OR REPLACE FUNCTION core.guard_task_launch_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.task_id,NEW.attempt_id,NEW.launch_id,NEW.job_name)
     IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.launch_id,OLD.job_name)
     OR (OLD.job_uid IS NOT NULL AND NEW.job_uid IS DISTINCT FROM OLD.job_uid)
     OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
     OR (OLD.tombstoned_at IS NOT NULL AND NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at)
     OR (OLD.tombstoned_at IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
     OR (OLD.tombstoned_at IS NOT NULL AND NEW.job_uid IS DISTINCT FROM OLD.job_uid
       AND NOT (OLD.job_uid IS NULL AND NEW.job_uid IS NOT NULL AND NEW.cleanup_pending
         AND NEW.termination_confirmed_at IS NULL AND EXISTS (SELECT 1 FROM core.tasks WHERE id=NEW.task_id AND terminal_candidate IS NOT NULL))) THEN
    RAISE EXCEPTION 'launch immutable identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION core.guard_task_launch_update() FROM PUBLIC;
CREATE OR REPLACE FUNCTION core.guard_task_termination_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (OLD.termination_confirmed_at IS NOT NULL AND NEW.termination_confirmed_at IS DISTINCT FROM OLD.termination_confirmed_at
      AND NOT (NEW.termination_confirmed_at IS NULL AND NEW.cleanup_pending))
    OR (OLD.slot_reserved AND NOT NEW.slot_reserved AND NEW.termination_confirmed_at IS NULL)
    OR (OLD.cleanup_pending AND NOT NEW.cleanup_pending AND NEW.termination_confirmed_at IS NULL) THEN
    RAISE EXCEPTION 'launch termination proof required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_termination_update BEFORE UPDATE ON core.task_launches
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_termination_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_termination_update() FROM PUBLIC;
CREATE OR REPLACE FUNCTION core.guard_task_outcome_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.outcome_key,NEW.task_id,NEW.launch_id,NEW.event,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.outcome_key,OLD.task_id,OLD.launch_id,OLD.event,OLD.created_at)
    OR (OLD.signalled_at IS NOT NULL AND NEW.signalled_at IS DISTINCT FROM OLD.signalled_at) THEN
    RAISE EXCEPTION 'task outcome immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_outcome_update BEFORE UPDATE ON core.task_outcomes
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_outcome_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_outcome_update() FROM PUBLIC;
-- The terminal row and outbox event must both exist when the transaction
-- commits. Deferred checks allow either statement order but forbid a half commit.
CREATE OR REPLACE FUNCTION core.check_task_terminal_outbox()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state IN ('done','failed','stopped') AND NOT EXISTS (
    SELECT 1 FROM core.task_outcomes o JOIN core.task_launches l ON l.task_id=o.task_id
    WHERE o.task_id=NEW.id AND o.launch_id=l.launch_id
      AND o.outcome_key='outcome_' || l.launch_id
      AND o.event->>'state'=NEW.state
      AND o.event->>'reasonCode'=NEW.terminal_reason_code
      AND o.event->>'summary'=NEW.terminal_summary
      AND o.event->'objects'=NEW.seal_receipt->'manifest'->'objects'
  ) THEN
    RAISE EXCEPTION 'task outcome required' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='core.tasks'::regclass AND tgname='check_task_terminal_outbox') THEN
    CREATE CONSTRAINT TRIGGER check_task_terminal_outbox AFTER UPDATE ON core.tasks
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
      WHEN (NEW.state IN ('done','failed','stopped'))
      EXECUTE FUNCTION core.check_task_terminal_outbox();
  END IF;
END;
$migration$;
REVOKE EXECUTE ON FUNCTION core.check_task_terminal_outbox() FROM PUBLIC;
-- migrate:down
