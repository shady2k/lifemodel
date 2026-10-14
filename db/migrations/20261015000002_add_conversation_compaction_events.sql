-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Kept as a stable migration version; the fresh schema includes compaction.
SELECT 1;
-- migrate:down
