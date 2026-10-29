-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Disposable, already-redacted gateway evidence. No task FKs or holder fence.
-- The optional capture role may arrive after core migrations; grants are guarded.
CREATE TABLE IF NOT EXISTS observability.model_exchanges (
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 128),
  -- Retry count, not a growing identity; a model call cannot reach 2^31 attempts.
  -- squawk-ignore prefer-bigint-over-int
  attempt integer NOT NULL CHECK (attempt > 0),
  slot text NOT NULL CHECK (length(slot) BETWEEN 1 AND 128),
  task_id text CHECK (length(task_id) <= 256),
  session_id text CHECK (length(session_id) <= 256),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  exchange jsonb NOT NULL CHECK (jsonb_typeof(exchange) = 'object'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 4194304),
  PRIMARY KEY (call_id, attempt, slot)
);
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS model_exchanges_created ON observability.model_exchanges(created_at, call_id, attempt, slot);

CREATE FUNCTION observability.prune_model_exchanges() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lifemodel-model-exchanges'));
  DELETE FROM observability.model_exchanges
    WHERE created_at < clock_timestamp() - interval '24 hours';
  -- Keep the newest suffix whose recorded payload fits in 100 MiB.
  DELETE FROM observability.model_exchanges target USING (
    SELECT call_id, attempt, slot,
      sum(size_bytes) OVER (ORDER BY created_at DESC, call_id DESC, attempt DESC, slot DESC) AS bytes
    FROM observability.model_exchanges
  ) old WHERE target.call_id=old.call_id AND target.attempt=old.attempt
      AND target.slot=old.slot AND old.bytes > 104857600;
  -- Report only existence, never conversation text, to the capture writer.
  RETURN EXISTS (SELECT 1 FROM observability.model_exchanges);
END;
$$;
CREATE FUNCTION observability.append_model_exchange(
  p_call_id text, p_attempt integer, p_slot text, p_task_id text,
  p_session_id text, p_exchange jsonb, p_expires_at timestamptz
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  payload_bytes bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('lifemodel-model-exchanges'));
  -- A row queued while enabled must not be stored after the switch expires.
  IF p_expires_at IS NULL OR NOT isfinite(p_expires_at) OR p_expires_at <= clock_timestamp() THEN
    RETURN;
  END IF;
  payload_bytes := octet_length(p_exchange::text)
    + octet_length(coalesce(p_call_id,'')) + octet_length(coalesce(p_slot,''))
    + octet_length(coalesce(p_task_id,'')) + octet_length(coalesce(p_session_id,'')) + 128;
  IF payload_bytes > 4194304 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='capture_exchange_too_large';
  END IF;
  INSERT INTO observability.model_exchanges(call_id,attempt,slot,task_id,session_id,exchange,size_bytes)
    VALUES(p_call_id,p_attempt,p_slot,p_task_id,p_session_id,p_exchange,payload_bytes)
    ON CONFLICT(call_id,attempt,slot) DO NOTHING;
  PERFORM observability.prune_model_exchanges();
END;
$$;
REVOKE ALL ON observability.model_exchanges FROM PUBLIC;
REVOKE ALL ON FUNCTION observability.append_model_exchange(text,integer,text,text,text,jsonb,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION observability.prune_model_exchanges() FROM PUBLIC;
-- Optional writer grants are reconciled after all migrations on every core migrate start.
-- migrate:down
