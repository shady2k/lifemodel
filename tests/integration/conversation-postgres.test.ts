import { describe, expect, it } from 'vitest';
import { createConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';

describe('Postgres conversation history', () => {
  it('reads append-only tool-call messages in order after manager recreation', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const first = createConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      const call = {
        id: 'call-1',
        type: 'function' as const,
        function: { name: 'core.time', arguments: '{"zone":"UTC"}' },
      };
      await first.addMessage('recipient-1', { role: 'user', content: 'What time is it?' });
      await first.addMessage(
        'recipient-1',
        { role: 'assistant', content: 'The time is 12:00.' },
        { channel: 'web', channelMessageId: 'answer-1' }
      );
      await first.addMessage(
        'recipient-1',
        { role: 'assistant', content: 'The time is 12:00.' },
        { channel: 'web', channelMessageId: 'answer-1' }
      );
      await first.addTurn('recipient-1', { content: null, tool_calls: [call] }, [
        { tool_call_id: call.id, content: '12:00' },
      ]);

      await first.setStatus('recipient-1', 'awaiting_answer');
      await first.addCompletedAction('recipient-1', {
        tool: 'core.time',
        summary: 'checked the time',
      });

      const restarted = createConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      const history = await restarted.getHistory('recipient-1');
      expect(history.map(({ role }) => role)).toEqual(['user', 'assistant', 'assistant', 'tool']);
      expect(history[2]?.tool_calls?.[0]?.id).toBe(history[3]?.tool_call_id);
      expect(history[3]?.tool_call_id).toBe('call-1');
      expect(await restarted.getStats('recipient-1')).toEqual({ messageCount: 4 });
      const keyedRows = await stores.postgres.query(
        `SELECT count(*)::integer AS count FROM core.conversation_messages
         WHERE recipient_id = 'recipient-1' AND message_id = 'channel:web:answer-1'`
      );
      expect(keyedRows.rows[0]?.count).toBe(1);
      expect((await restarted.getStatus('recipient-1')).status).toBe('awaiting_answer');
      expect(await restarted.getRecentActions('recipient-1')).toHaveLength(1);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('keeps compaction logical and uses its summary for history and later thresholds after restart', async () => {
    const stores = await createTestStores();
    const recipientId = 'recipient-compaction';
    try {
      await applyTestMigrations(stores.postgres);
      const first = createConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      for (let turn = 0; turn < 11; turn++) {
        await first.addMessage(recipientId, { role: 'user', content: `Question ${turn}` });
        await first.addMessage(recipientId, { role: 'assistant', content: `Answer ${turn}` });
      }

      expect(await first.needsCompaction(recipientId)).toBe(true);
      const { totalMessageCount } = await first.getCompactionSnapshot(recipientId);
      expect(totalMessageCount).toBe(22);
      const summary = 'The user asked about a durable project; continue from this summary.';
      expect(await first.compactMessages(recipientId, totalMessageCount, summary)).toBe(true);
      const compactedHistory = await first.getFullHistory(recipientId);
      expect(compactedHistory).toHaveLength(7);
      expect(compactedHistory[0]?.content).toBe(`Conversation summary:\n${summary}`);
      expect(compactedHistory.some(({ content }) => content === 'Question 0')).toBe(false);
      expect(await first.getMessageCount(recipientId)).toBe(6);
      expect(await first.needsCompaction(recipientId)).toBe(false);

      for (let turn = 11; turn < 13; turn++) {
        await first.addMessage(recipientId, { role: 'user', content: `Question ${turn}` });
        await first.addMessage(recipientId, { role: 'assistant', content: `Answer ${turn}` });
        expect(await first.needsCompaction(recipientId)).toBe(false);
      }

      const restarted = createConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      const history = await restarted.getFullHistory(recipientId);
      expect(history[0]).toMatchObject({
        role: 'system',
        content: `Conversation summary:\n${summary}`,
      });
      expect(history).toHaveLength(11);
      expect(history.some(({ content }) => content === 'Question 0')).toBe(false);
      expect(history.some(({ content }) => content === 'Answer 10')).toBe(true);
      expect(history.some(({ content }) => content === 'Question 12')).toBe(true);
      expect(await restarted.needsCompaction(recipientId)).toBe(false);

      const durableRows = await stores.postgres.query(
        `SELECT count(*)::integer AS count FROM core.conversation_messages
         WHERE recipient_id = $1 AND kind = 'message'`,
        [recipientId]
      );
      const markerRows = await stores.postgres.query(
        `SELECT count(*)::integer AS count FROM core.conversation_messages
         WHERE recipient_id = $1 AND kind = 'compaction'`,
        [recipientId]
      );
      expect(durableRows.rows[0]?.count).toBe(26);
      expect(markerRows.rows[0]?.count).toBe(1);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
