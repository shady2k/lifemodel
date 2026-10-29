-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
ALTER TABLE core.tasks ADD COLUMN IF NOT EXISTS startup_phase text;
ALTER TABLE core.tasks ADD COLUMN IF NOT EXISTS startup_since timestamptz;
-- squawk-ignore ban-drop-constraint
ALTER TABLE core.tasks DROP CONSTRAINT IF EXISTS task_startup_phase_check;
ALTER TABLE core.tasks ADD CONSTRAINT task_startup_phase_check CHECK
  (startup_phase IN ('waiting-for-scheduling','pulling-image','container-started','harness-starting')) NOT VALID;
ALTER TABLE core.tasks VALIDATE CONSTRAINT task_startup_phase_check;
-- squawk-ignore ban-drop-constraint
ALTER TABLE core.task_mailbox DROP CONSTRAINT IF EXISTS task_mailbox_kind_check;
ALTER TABLE core.task_mailbox ADD CONSTRAINT task_mailbox_kind_check CHECK
  (kind IN ('step','question','terminal','lifecycle')) NOT VALID;
ALTER TABLE core.task_mailbox VALIDATE CONSTRAINT task_mailbox_kind_check;
-- migrate:down
