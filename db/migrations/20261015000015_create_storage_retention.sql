-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- One decimal 20 GB instance ceiling. Quota holds both accepted bytes and
-- outstanding reservations; separately discovered orphan bytes share this row.
CREATE TABLE IF NOT EXISTS storage.instance_ledger (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  limit_bytes bigint NOT NULL DEFAULT 20000000000 CHECK (limit_bytes = 20000000000),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);
-- Block quota writers until both the backfill and accounting triggers exist.
-- The migration is transactional: no unaccounted reservation can slip between.
LOCK TABLE storage.space_quota IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO storage.instance_ledger(id,used_bytes)
  SELECT true,COALESCE(sum(reserved_bytes + charged_bytes),0)::bigint
  FROM storage.space_quota
  ON CONFLICT (id) DO NOTHING;
CREATE OR REPLACE FUNCTION storage.account_instance_quota()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE delta bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    delta := NEW.reserved_bytes + NEW.charged_bytes;
  ELSIF TG_OP='DELETE' THEN
    delta := -(OLD.reserved_bytes + OLD.charged_bytes);
  ELSE
    delta := NEW.reserved_bytes + NEW.charged_bytes - OLD.reserved_bytes - OLD.charged_bytes;
  END IF;
  IF delta=0 THEN RETURN NULL; END IF;
  -- UPDATE acquires the singleton lock, then rechecks the predicate against the
  -- latest committed row. Cross-space reservations cannot both spend one byte.
  -- Late backend completion can create discovered orphan debt above the admission
  -- ceiling. Account that truthfully; never admit growth while overfull, but
  -- always permit confirmed deletion/release to reduce even an overfull total.
  UPDATE storage.instance_ledger SET used_bytes=used_bytes+delta
    WHERE id AND used_bytes+delta>=0 AND (delta<=0 OR used_bytes+delta<=limit_bytes);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instance capacity unavailable' USING ERRCODE='53000';
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER storage_account_instance_quota
  AFTER INSERT OR UPDATE OR DELETE ON storage.space_quota
  FOR EACH ROW EXECUTE FUNCTION storage.account_instance_quota();
-- TRUNCATE skips row triggers. Subtract only old quota, not separately charged
-- orphan bytes. BEFORE sees the old rows even when spaces CASCADE caused it.
CREATE OR REPLACE FUNCTION storage.truncate_instance_quota()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE released bigint;
BEGIN
  SELECT COALESCE(sum(reserved_bytes + charged_bytes),0)::bigint INTO released
    FROM storage.space_quota;
  UPDATE storage.instance_ledger SET used_bytes=used_bytes-released WHERE id;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER storage_truncate_instance_quota
  BEFORE TRUNCATE ON storage.space_quota
  FOR EACH STATEMENT EXECUTE FUNCTION storage.truncate_instance_quota();
REVOKE EXECUTE ON FUNCTION storage.account_instance_quota(),storage.truncate_instance_quota() FROM PUBLIC;

CREATE TABLE IF NOT EXISTS storage.retention_policies (
  space_id text PRIMARY KEY REFERENCES storage.spaces(id) ON DELETE CASCADE,
  retention text NOT NULL CHECK (retention IN ('90d','forever')),
  pinned boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision>=0),
  settings_revision bigint NOT NULL CHECK (settings_revision>=0),
  terminal_at timestamptz NOT NULL,
  expires_at timestamptz,
  state text NOT NULL DEFAULT 'retained' CHECK (state IN ('retained','deleting','deleted'))
);
CREATE TABLE IF NOT EXISTS storage.deletion_plans (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  reason text NOT NULL CHECK (reason IN ('age','quota')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','warned','complete')),
  -- A bounded day count (1..30), never a growing identifier.
  -- squawk-ignore prefer-bigint-over-int
  lead_days integer NOT NULL CHECK (lead_days BETWEEN 1 AND 30),
  settings_revision bigint NOT NULL CHECK (settings_revision>=0),
  exposed_at timestamptz,
  warned_at timestamptz,
  earliest_delete_at timestamptz,
  message_id text,
  warning_receipt jsonb,
  total_bytes bigint NOT NULL DEFAULT 0 CHECK (total_bytes>=0),
  CHECK ((message_id IS NULL AND warned_at IS NULL AND earliest_delete_at IS NULL AND warning_receipt IS NULL) OR (message_id IS NOT NULL AND warned_at IS NOT NULL AND earliest_delete_at IS NOT NULL AND warning_receipt IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS storage.deletion_candidates (
  plan_id text NOT NULL REFERENCES storage.deletion_plans(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES storage.retention_policies(space_id) ON DELETE CASCADE,
  policy_revision bigint NOT NULL,
  object_id uuid NOT NULL REFERENCES storage.objects(id) ON DELETE CASCADE,
  object_revision bigint NOT NULL,
  s3_key text NOT NULL,
  size bigint NOT NULL CHECK (size>=0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','deleting','deleted','removed')),
  PRIMARY KEY(plan_id,object_id)
);
-- New tables are empty in this expanding migration transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS storage_retention_live_candidate ON storage.deletion_candidates(object_id) WHERE state IN ('pending','deleting');
CREATE TABLE IF NOT EXISTS storage.retention_receipts (
  effect_key text PRIMARY KEY,
  request jsonb NOT NULL,
  receipt jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.reclaim_receipts (
  effect_key text PRIMARY KEY,
  request jsonb NOT NULL,
  receipt jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.retention_tombstones (
  object_id uuid PRIMARY KEY REFERENCES storage.objects(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES storage.spaces(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES storage.deletion_plans(id),
  state text NOT NULL CHECK (state IN ('deleting','deleted'))
);
CREATE TABLE IF NOT EXISTS storage.read_leases (
  id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES storage.spaces(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS storage.orphan_gc (
  s3_key text PRIMARY KEY,
  size bigint NOT NULL CHECK (size>=0),
  first_seen_at timestamptz NOT NULL,
  last_modified timestamptz NOT NULL,
  deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS storage.attempt_gc (
  attempt_id uuid PRIMARY KEY REFERENCES storage.upload_attempts(id) ON DELETE CASCADE,
  space_id text NOT NULL REFERENCES storage.spaces(id) ON DELETE CASCADE,
  s3_key text NOT NULL,
  size bigint NOT NULL CHECK (size>=0),
  deleted boolean NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION storage.complete_upload(p_space text,p_upload text,p_attempt uuid)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE intent storage.upload_intents%ROWTYPE;
        quota storage.space_quota%ROWTYPE;
BEGIN
  SELECT * INTO quota FROM storage.space_quota WHERE space_id=p_space FOR UPDATE;
  SELECT * INTO intent FROM storage.upload_intents WHERE space_id=p_space AND upload_id=p_upload FOR UPDATE;
  IF NOT FOUND THEN RETURN 'intent_unknown'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.upload_attempts WHERE id=p_attempt AND space_id=p_space AND upload_id=p_upload) THEN RETURN 'attempt_unknown'; END IF;
  IF intent.state='completed' THEN RETURN 'already_completed'; END IF;
  IF EXISTS(SELECT 1 FROM storage.attempt_gc WHERE attempt_id=p_attempt) THEN RETURN 'attempt_expired'; END IF;
  -- An orphan discovered after lease expiry can still be published by a valid
  -- sibling. Transfer ownership of the charge under the same intent/quota lock.
  WITH transferred AS (
    UPDATE storage.orphan_gc SET deleted=true WHERE NOT deleted
      AND s3_key=(SELECT s3_key FROM storage.upload_attempts WHERE id=p_attempt)
      RETURNING size
  ) UPDATE storage.instance_ledger SET used_bytes=used_bytes-(SELECT COALESCE(sum(size),0) FROM transferred) WHERE id;
  -- A failed sibling attempt can release this upload while valid bytes are still
  -- in flight. Re-admit under the quota lock, never subtract an absent reservation.
  IF NOT intent.reserved THEN
    IF quota.reserved_bytes + quota.charged_bytes + intent.size > quota.limit_bytes THEN
      RAISE EXCEPTION 'upload capacity unavailable' USING ERRCODE='53000';
    END IF;
    UPDATE storage.space_quota SET reserved_bytes=reserved_bytes+intent.size WHERE space_id=p_space;
  END IF;
  INSERT INTO storage.objects(id,space_id,name,size,sha256) VALUES(intent.object_id,p_space,intent.name,intent.size,intent.sha256);
  INSERT INTO storage.object_versions(object_id,attempt_id,receipt) VALUES(intent.object_id,p_attempt,
    jsonb_build_object('id',intent.object_id,'name',intent.name,'size',intent.size,'sha256',intent.sha256,'mark',NULL));
  UPDATE storage.upload_intents SET state='completed',reserved=false WHERE space_id=p_space AND upload_id=p_upload;
  UPDATE storage.space_quota SET reserved_bytes=reserved_bytes-intent.size,charged_bytes=charged_bytes+intent.size WHERE space_id=p_space;
  RETURN 'completed';
END $$;
REVOKE EXECUTE ON FUNCTION storage.complete_upload(text,text,uuid) FROM PUBLIC;
-- Ownerless attempts from before this expansion are abandoned. New runtime
-- attempts always obtain a fresh owner under the quota/intent/owner lock order.
CREATE TABLE IF NOT EXISTS storage.upload_owners (
  boot_id uuid PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL
);
ALTER TABLE storage.upload_attempts ADD COLUMN IF NOT EXISTS owner_boot_id uuid;
CREATE OR REPLACE FUNCTION storage.begin_attempt(p_id uuid,p_space text,p_upload text,p_key text,p_owner uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE intent storage.upload_intents%ROWTYPE;
        owner_heartbeat timestamptz;
BEGIN
  PERFORM 1 FROM storage.space_quota WHERE space_id=p_space FOR UPDATE;
  SELECT * INTO intent FROM storage.upload_intents WHERE space_id=p_space AND upload_id=p_upload FOR UPDATE;
  IF NOT FOUND OR intent.state<>'pending' OR NOT intent.reserved OR intent.lease_expires_at<=clock_timestamp() THEN RETURN false; END IF;
  SELECT heartbeat_at INTO owner_heartbeat FROM storage.upload_owners WHERE boot_id=p_owner FOR UPDATE;
  IF NOT FOUND OR owner_heartbeat<=clock_timestamp()-interval '60 seconds' THEN RETURN false; END IF;
  INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key,owner_boot_id) VALUES(p_id,p_space,p_upload,p_key,p_owner);
  RETURN true;
END $$;
REVOKE EXECUTE ON FUNCTION storage.begin_attempt(uuid,text,text,text,uuid) FROM PUBLIC;
-- migrate:down
