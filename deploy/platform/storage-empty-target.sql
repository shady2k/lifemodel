-- Restore precondition, not a cleanup command. Stop all module/lifecycle writers
-- before running this exact file with psql -X -v ON_ERROR_STOP=1.
-- A normal boot leaves owner heartbeats behind even after graceful shutdown.
-- They are operational identities only: every upload/attempt/catalog table
-- must still be empty. This does not attest the separate Seaweed PVC history.
DO $$
DECLARE
  relation record;
  populated boolean;
BEGIN
  FOR relation IN
    SELECT tablename FROM pg_catalog.pg_tables
    WHERE schemaname='storage'
      AND tablename NOT IN ('maintenance','instance_ledger','upload_owners')
  LOOP
    EXECUTE pg_catalog.format('SELECT EXISTS(SELECT 1 FROM storage.%I)',relation.tablename)
      INTO populated;
    IF populated THEN RAISE EXCEPTION 'destination_not_empty'; END IF;
  END LOOP;

  -- The only permitted singleton is the completed destination backup hold.
  -- Missing identity/cut fields are not proof that begin successfully drained.
  IF (SELECT count(*) FROM storage.maintenance)<>1
     OR NOT EXISTS (
       SELECT 1 FROM storage.maintenance
       WHERE id AND state='held' AND purpose='backup'
         AND generation IS NOT NULL
         AND generation::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         AND effect_key ~ '^[A-Za-z0-9_-]{1,128}$'
         AND pg_catalog.isfinite(cut_at)
         AND cut_at>'1970-01-01'::timestamptz AND cut_at<=pg_catalog.clock_timestamp()
     )
     OR (SELECT count(*) FROM storage.instance_ledger)<>1
     OR NOT EXISTS (
       SELECT 1 FROM storage.instance_ledger
       WHERE id AND used_bytes=0 AND limit_bytes=20000000000
     )
     OR EXISTS (
       SELECT 1 FROM storage.upload_owners
       WHERE boot_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         OR NOT pg_catalog.isfinite(heartbeat_at)
         OR heartbeat_at<='1970-01-01'::timestamptz
         OR heartbeat_at>pg_catalog.clock_timestamp()
     )
  THEN RAISE EXCEPTION 'destination_not_pristine'; END IF;
END $$;
