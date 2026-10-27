-- migrate:no-transaction
-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS task_command_id_idx
  ON core.task_commands(command_id);
-- migrate:down
