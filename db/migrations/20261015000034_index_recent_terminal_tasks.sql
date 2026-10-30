-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE INDEX IF NOT EXISTS tasks_recent_terminal ON core.tasks (terminal_at DESC,id DESC)
  WHERE state IN ('done','failed','stopped');
-- migrate:down
