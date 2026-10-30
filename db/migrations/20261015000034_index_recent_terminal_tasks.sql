-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Small core task table; lock_timeout bounds the index creation lock wait.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS tasks_recent_terminal ON core.tasks (terminal_at DESC,id DESC)
  WHERE state IN ('done','failed','stopped');
-- migrate:down
