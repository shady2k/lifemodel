-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Availability records byte diagnostics even after deliberate deletion. Only
-- live objects can block a clean restore release or count as backup loss.
CREATE OR REPLACE VIEW storage.unavailable_versions AS
SELECT a.object_id,a.generation,a.status,a.checked_at
FROM storage.version_availability a
WHERE a.status<>'available'
  AND NOT EXISTS(SELECT 1 FROM storage.object_tombstones t WHERE t.object_id=a.object_id)
  AND NOT EXISTS(SELECT 1 FROM storage.retention_tombstones t WHERE t.object_id=a.object_id);
-- migrate:down
