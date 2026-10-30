-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- squawk-ignore ban-drop-constraint
ALTER TABLE core.tasks DROP CONSTRAINT IF EXISTS task_startup_phase_check;
ALTER TABLE core.tasks ADD CONSTRAINT task_startup_phase_check CHECK
  (startup_phase IN ('waiting-for-scheduling','pulling-image','image-pulled','container-started','harness-starting')) NOT VALID;
ALTER TABLE core.tasks VALIDATE CONSTRAINT task_startup_phase_check;
-- migrate:down
