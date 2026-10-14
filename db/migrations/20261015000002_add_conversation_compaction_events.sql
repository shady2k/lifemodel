-- migrate:up
ALTER TABLE core.conversation_messages
  DROP CONSTRAINT conversation_messages_kind_check;
ALTER TABLE core.conversation_messages
  ADD CONSTRAINT conversation_messages_kind_check
  CHECK (kind IN ('message', 'status', 'action', 'actions_clear', 'clear', 'compaction'));
-- migrate:down
