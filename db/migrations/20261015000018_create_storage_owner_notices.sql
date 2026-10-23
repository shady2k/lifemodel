-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Narrow read contract for module warning admission, not conversation access.
-- Physical rows survive conversation clear/compaction. The canonical event ID
-- binds the persisted warning to its deletion plan without exposing its text.
-- PostgreSQL has no CREATE VIEW IF NOT EXISTS, so guard the expanding DDL.
DO $migration$
BEGIN
  IF to_regclass('core.storage_owner_notices') IS NULL THEN
    CREATE VIEW core.storage_owner_notices (message_id, committed_at) AS
      SELECT payload->>'channelMessageId', created_at
      FROM core.conversation_messages
      WHERE kind = 'message'
        AND payload->>'role' = 'assistant'
        AND payload->>'channel' = 'web'
        AND jsonb_typeof(payload->'content') = 'string'
        AND length(btrim(payload->>'content')) > 0
        AND payload->>'channelMessageId' ~ '^storage-warning_[0-9a-f]{64}$'
        AND message_id = 'channel:web:' || (payload->>'channelMessageId');
  END IF;
END;
$migration$;
-- lifemodel-2t5 grants the module SELECT on exactly this view, never the table.
-- migrate:down
