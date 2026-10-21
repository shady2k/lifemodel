-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
CREATE TABLE IF NOT EXISTS storage.space_quota (
  space_id text PRIMARY KEY REFERENCES storage.spaces(id) ON DELETE CASCADE,
  limit_bytes bigint NOT NULL DEFAULT 20000000000 CHECK (limit_bytes BETWEEN 0 AND 20000000000),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  charged_bytes bigint NOT NULL DEFAULT 0 CHECK (charged_bytes >= 0),
  CHECK (reserved_bytes + charged_bytes <= limit_bytes)
);
CREATE TABLE IF NOT EXISTS storage.upload_intents (
  space_id text NOT NULL REFERENCES storage.spaces(id) ON DELETE CASCADE,
  upload_id text NOT NULL CHECK (upload_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'),
  object_id uuid NOT NULL UNIQUE,
  name text NOT NULL,
  size bigint NOT NULL CHECK (size BETWEEN 0 AND 20000000000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed')),
  reserved boolean NOT NULL DEFAULT true,
  lease_expires_at timestamptz NOT NULL,
  PRIMARY KEY (space_id, upload_id)
);
CREATE TABLE IF NOT EXISTS storage.upload_attempts (
  id uuid PRIMARY KEY,
  space_id text NOT NULL,
  upload_id text NOT NULL,
  s3_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (space_id,upload_id) REFERENCES storage.upload_intents(space_id,upload_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES storage.spaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mark text CHECK (mark IN ('artifact','result','log')),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  UNIQUE (space_id,id)
);
-- An object ID names one completed immutable version, never a mutable name slot.
CREATE TABLE IF NOT EXISTS storage.object_versions (
  object_id uuid PRIMARY KEY REFERENCES storage.objects(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL UNIQUE REFERENCES storage.upload_attempts(id),
  receipt jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- The table is created empty in this same transaction; no preexisting writes can block.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS storage_objects_space_sequence ON storage.objects(space_id,sequence);
-- New empty table, same expanding migration transaction.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS storage_upload_expiry ON storage.upload_intents(lease_expires_at) WHERE state='pending';
-- All quota transitions lock the quota row before the intent, including cancel
-- and retry. Released intents keep immutable metadata but no longer hold quota.
CREATE OR REPLACE FUNCTION storage.reserve_upload(p_space text,p_upload text,p_object uuid,p_name text,p_size bigint,p_hash text,p_lease integer)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE quota storage.space_quota%ROWTYPE;
        intent storage.upload_intents%ROWTYPE;
BEGIN
  INSERT INTO storage.space_quota(space_id) VALUES(p_space) ON CONFLICT DO NOTHING;
  SELECT * INTO quota FROM storage.space_quota WHERE space_id=p_space FOR UPDATE;
  SELECT * INTO intent FROM storage.upload_intents WHERE space_id=p_space AND upload_id=p_upload FOR UPDATE;
  IF FOUND THEN
    -- Check immutable metadata before re-reserving a previously released ID.
    IF intent.name<>p_name OR intent.size<>p_size OR intent.sha256<>p_hash THEN RETURN; END IF;
    IF intent.state='completed' OR intent.reserved THEN RETURN; END IF;
    IF quota.reserved_bytes + quota.charged_bytes + p_size > quota.limit_bytes THEN RETURN; END IF;
    UPDATE storage.upload_intents SET reserved=true,lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease)
      WHERE space_id=p_space AND upload_id=p_upload;
  ELSE
    IF quota.reserved_bytes + quota.charged_bytes + p_size > quota.limit_bytes THEN RETURN; END IF;
    INSERT INTO storage.upload_intents(space_id,upload_id,object_id,name,size,sha256,lease_expires_at)
      VALUES(p_space,p_upload,p_object,p_name,p_size,p_hash,clock_timestamp()+make_interval(secs=>p_lease));
  END IF;
  UPDATE storage.space_quota SET reserved_bytes=reserved_bytes+p_size WHERE space_id=p_space;
END $$;
-- Cancellation is pending-only and idempotent. It cannot undo a published charge.
CREATE OR REPLACE FUNCTION storage.release_upload(p_space text,p_upload text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE intent storage.upload_intents%ROWTYPE;
BEGIN
  PERFORM 1 FROM storage.space_quota WHERE space_id=p_space FOR UPDATE;
  SELECT * INTO intent FROM storage.upload_intents WHERE space_id=p_space AND upload_id=p_upload FOR UPDATE;
  IF NOT FOUND OR intent.state<>'pending' OR NOT intent.reserved THEN RETURN; END IF;
  UPDATE storage.upload_intents SET reserved=false WHERE space_id=p_space AND upload_id=p_upload;
  UPDATE storage.space_quota SET reserved_bytes=reserved_bytes-intent.size WHERE space_id=p_space;
END $$;
-- Publication alone changes visibility and charging; SQL cannot run until the
-- module has verified the private backend write. Concurrent attempts choose one.
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
-- The module currently uses the migration owner's login (lifemodel-2t5 will
-- split roles). Ownership retains EXECUTE without granting it to every login.
REVOKE EXECUTE ON FUNCTION storage.reserve_upload(text,text,uuid,text,bigint,text,integer),
  storage.release_upload(text,text),storage.complete_upload(text,text,uuid) FROM PUBLIC;
-- migrate:down
