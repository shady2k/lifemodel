-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS core.tasks (
  id text PRIMARY KEY,
  launch_key text NOT NULL UNIQUE CHECK (launch_key <> ''),
  briefing text NOT NULL CHECK (briefing <> ''),
  profile jsonb NOT NULL CHECK (jsonb_typeof(profile) = 'object'),
  settings_revision bigint NOT NULL CHECK (settings_revision >= 0),
  harness text NOT NULL CHECK (harness IN ('opencode', 'prime-agent')),
  image_revision text NOT NULL CHECK (image_revision ~ '^sha256:[0-9a-f]{64}$'),
  wrap_grace_seconds double precision NOT NULL CHECK (wrap_grace_seconds BETWEEN 30 AND 3600),
  accepted_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  urgent boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','starting','running','wrapping-up','done','failed','stopped')),
  terminal_candidate text CHECK (terminal_candidate IN ('done','failed','stopped')),
  terminal_reason_code text CHECK (terminal_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  finalization_pending boolean NOT NULL DEFAULT false,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz CHECK (isfinite(started_at)),
  terminal_at timestamptz CHECK (isfinite(terminal_at)),
  CHECK ((terminal_candidate IS NULL) = (terminal_reason_code IS NULL)),
  CHECK (NOT finalization_pending OR terminal_candidate IS NOT NULL),
  CHECK ((state IN ('done','failed','stopped')) = (terminal_at IS NOT NULL)),
  CHECK (state NOT IN ('done','failed','stopped') OR (terminal_candidate IS NOT NULL AND terminal_candidate = state AND NOT finalization_pending))
);
-- One initial attempt per accepted task. No hidden retry/replacement execution.
CREATE TABLE IF NOT EXISTS core.task_launches (
  task_id text PRIMARY KEY REFERENCES core.tasks(id),
  attempt_id text NOT NULL UNIQUE,
  launch_id text NOT NULL UNIQUE,
  job_name text NOT NULL UNIQUE CHECK (length(job_name) <= 63 AND job_name ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$'),
  job_uid text CHECK (job_uid <> ''),
  pod_uid text UNIQUE CHECK (pod_uid <> ''),
  tombstoned_at timestamptz CHECK (isfinite(tombstoned_at)),
  slot_reserved boolean NOT NULL DEFAULT false,
  CHECK (pod_uid IS NULL OR job_uid IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS core.task_admission (
  id boolean PRIMARY KEY DEFAULT true CHECK (id)
);
INSERT INTO core.task_admission(id) VALUES(true) ON CONFLICT DO NOTHING;
-- New empty task table, created in this transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS tasks_queued_order ON core.tasks(accepted_order) WHERE state='queued';

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
    (OLD.state='starting' AND NEW.state IN ('running','wrapping-up','failed','stopped')) OR
    (OLD.state='running' AND NEW.state IN ('wrapping-up','done','failed','stopped')) OR
    (OLD.state='wrapping-up' AND NEW.state IN ('done','failed','stopped'))
  ) THEN
    RAISE EXCEPTION 'task invalid transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_update BEFORE UPDATE ON core.tasks
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_update() FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.guard_task_launch_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF ROW(NEW.task_id,NEW.attempt_id,NEW.launch_id,NEW.job_name)
     IS DISTINCT FROM ROW(OLD.task_id,OLD.attempt_id,OLD.launch_id,OLD.job_name)
     OR (OLD.job_uid IS NOT NULL AND NEW.job_uid IS DISTINCT FROM OLD.job_uid)
     OR (OLD.pod_uid IS NOT NULL AND NEW.pod_uid IS DISTINCT FROM OLD.pod_uid)
     OR (OLD.tombstoned_at IS NOT NULL AND NEW.tombstoned_at IS DISTINCT FROM OLD.tombstoned_at)
     OR (OLD.tombstoned_at IS NOT NULL AND ROW(NEW.job_uid,NEW.pod_uid) IS DISTINCT FROM ROW(OLD.job_uid,OLD.pod_uid)) THEN
    RAISE EXCEPTION 'launch immutable identity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER guard_task_launch_update BEFORE UPDATE ON core.task_launches
  FOR EACH ROW EXECUTE FUNCTION core.guard_task_launch_update();
REVOKE EXECUTE ON FUNCTION core.guard_task_launch_update() FROM PUBLIC;
-- migrate:down
