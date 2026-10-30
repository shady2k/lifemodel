-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Sequence tombstones survive row eviction, with no personal content.
CREATE TABLE IF NOT EXISTS core.task_transcript_horizons (
  task_id text NOT NULL REFERENCES core.tasks(id) ON DELETE CASCADE,
  attempt_id text NOT NULL,
  evicted_through bigint NOT NULL,
  PRIMARY KEY(task_id,attempt_id)
);
-- migrate:down
