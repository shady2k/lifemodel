-- migrate:up
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- Narrow read contract for module warning admission, not conversation access.
-- Physical rows survive conversation clear/compaction. The canonical event ID
-- binds the persisted warning to its deletion plan. The recipient join binds
-- it to core's web/owner route without exposing text or recipient details.
-- PostgreSQL has no CREATE VIEW IF NOT EXISTS, so guard the expanding DDL.
DO $migration$
BEGIN
  IF to_regclass('core.storage_owner_notices') IS NULL THEN
    CREATE VIEW core.storage_owner_notices (message_id, committed_at) AS
      SELECT m.payload->>'channelMessageId', m.created_at
      FROM core.conversation_messages AS m
      JOIN core.recipient_registry AS r
        ON r.recipient_id = m.recipient_id
        AND r.channel = 'web'
        AND r.destination = 'owner'
      WHERE m.kind = 'message'
        AND m.payload->>'role' = 'assistant'
        AND m.payload->>'channel' = 'web'
        AND jsonb_typeof(m.payload->'content') = 'string'
        AND length(btrim(m.payload->>'content')) > 0
        AND m.payload->>'channelMessageId' ~ '^storage-warning_[0-9a-f]{64}$'
        AND m.message_id = 'channel:web:' || (m.payload->>'channelMessageId');
  END IF;
END;
$migration$;
-- lifemodel-2t5 grants the module SELECT on exactly this view, never the table.
-- migrate:down
