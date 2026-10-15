import { describe, expect, it } from 'vitest';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

const recipientId = 'transcript-owner-pages';
const row = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

describe('Postgres owner transcript', () => {
  it('pages visible rows directly by sequence and preserves owner history across clear and compaction', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const conversations = new PostgresConversationStore(stores.postgres);
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipientId);
      await conversations.save(`conversation:${recipientId}`, {
        messages: [
          { ...row('user', 'older question'), messageId: 'inbound:client-older' },
          { ...row('assistant', 'older answer'), messageId: 'channel:web:answer-older' },
          { ...row('assistant', null, { tool_calls: [{ id: 'call-1' }] }), messageId: 'tool-turn' },
          {
            ...row('tool', 'private tool result', { tool_call_id: 'call-1' }),
            messageId: 'tool-result',
          },
          { ...row('system', 'private status'), messageId: 'private-status' },
        ],
        compactionMarker: {
          summary: 'not visible',
          retainedMessageIds: [],
          timestamp: new Date().toISOString(),
        },
      });
      await conversations.save(`conversation:${recipientId}`, {
        messages: [
          {
            ...row('user', 'new question', {
              replyTo: { sequence: '123', role: 'assistant', excerpt: 'quoted answer' },
            }),
            messageId: 'inbound:client-new',
          },
        ],
      });
      await conversations.delete(`conversation:${recipientId}`);
      await conversations.save(`conversation:${recipientId}`, {
        messages: [
          { ...row('assistant', 'answer after clear'), messageId: 'channel:web:answer-new' },
        ],
      });

      const latest = await transcript.readTranscript({ limit: 2 });
      expect(latest.rows.map(({ text }) => text)).toEqual(['answer after clear', 'new question']);
      expect(latest.rows[1]).toMatchObject({
        clientId: 'client-new',
        role: 'user',
        replyTo: { sequence: '123', role: 'assistant', excerpt: 'quoted answer' },
      });
      expect(latest.cursor).toBe(latest.rows[0]?.sequence);
      const earlier = await transcript.readTranscript({
        before: latest.rows[1]!.sequence,
        limit: 50,
      });
      expect(earlier.rows.map(({ text }) => text)).toEqual(['older answer', 'older question']);
      expect(await transcript.readTranscript({ after: latest.cursor, limit: 50 })).toMatchObject({
        rows: [],
      });
      await expect(
        transcript.readTranscript({ before: 'not-a-sequence', limit: 50 })
      ).rejects.toThrow();
      expect((await transcript.readTranscript({ after: '999999999', limit: 50 })).rows).toEqual([]);
      await expect(transcript.readTranscript({ limit: 51 })).rejects.toThrow();
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('rejects malformed stored reply quotes instead of silently omitting them', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipientId);
      await stores.postgres.query(
        `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
         VALUES ($1, 'inbound:malformed-reply', 'message', $2::jsonb)`,
        [recipientId, JSON.stringify(row('user', 'question', { replyTo: { sequence: '12' } }))]
      );
      await expect(transcript.readTranscript({ limit: 50 })).rejects.toThrow(/replyTo/i);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('watches committed sequence order across overlapping saves, rollback and retry, with polling when hints are absent', async () => {
    const watchRecipientId = 'transcript-owner-watch';
    const stores = await createTestStores();
    const abort = new AbortController();
    try {
      await applyTestMigrations(stores.postgres);
      const transcript = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        watchRecipientId
      );
      const writer = new PostgresConversationStore(stores.postgres);
      const iterator = transcript.watchTranscript('0', abort.signal)[Symbol.asyncIterator]();
      const delayed = await stores.postgres.connect();
      await delayed.query('BEGIN');
      await delayed.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        watchRecipientId,
      ]);
      await delayed.query(
        `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
         VALUES ($1, 'inbound:rolled-back', 'message', $2::jsonb)`,
        [watchRecipientId, JSON.stringify(row('user', 'must not be visible'))]
      );
      const later = writer.save(`conversation:${watchRecipientId}`, {
        messages: [{ ...row('assistant', 'later'), messageId: 'channel:web:later' }],
      });
      const firstRow = iterator.next();
      await delayed.query('ROLLBACK');
      delayed.release();
      await later;
      expect((await firstRow).value?.text).toBe('later');
      await writer.save(`conversation:${watchRecipientId}`, {
        messages: [{ ...row('assistant', 'later replay'), messageId: 'channel:web:later' }],
      });
      await writer.save(`conversation:${watchRecipientId}`, {
        messages: [{ ...row('assistant', 'second committed'), messageId: 'channel:web:second' }],
      });
      expect((await iterator.next()).value?.text).toBe('second committed');

      await stores.postgres.query(
        `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
         VALUES ($1, 'inbound:poll-only', 'message', $2::jsonb)`,
        [watchRecipientId, JSON.stringify(row('user', 'poll-only'))]
      );
      const second = await iterator.next();
      expect(second.value?.text).toBe('poll-only');
      abort.abort();
      await iterator.return?.();
      expect((await iterator.next()).done).toBe(true);
    } finally {
      abort.abort();
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('delivers a newly saved assistant row promptly when outbound wakes the watcher', async () => {
    const promptRecipientId = 'transcript-owner-prompt';
    const stores = await createTestStores();
    const abort = new AbortController();
    try {
      await applyTestMigrations(stores.postgres);
      const transcript = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        promptRecipientId
      );
      const writer = new PostgresConversationStore(stores.postgres);
      const iterator = transcript.watchTranscript('0', abort.signal)[Symbol.asyncIterator]();
      const waiting = iterator.next();
      const insertedAt = performance.now();
      await writer.save(`conversation:${promptRecipientId}`, {
        messages: [{ ...row('assistant', 'prompt answer'), messageId: 'channel:web:prompt' }],
      });
      await stores.redis.xadd('outbound', '*', 'eventId', 'prompt-event');
      const delivered = await waiting;
      expect(delivered.value?.text).toBe('prompt answer');
      expect(performance.now() - insertedAt).toBeLessThan(2_000);
      abort.abort();
      await iterator.return?.();
    } finally {
      abort.abort();
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('keeps a 10,000-row history on bounded pages and excludes internal rows', async () => {
    const largeRecipientId = 'transcript-owner-large';
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      await stores.postgres.query(
        `INSERT INTO core.conversation_messages (recipient_id, message_id, kind, payload)
         SELECT $1, 'entry-' || n, CASE WHEN n % 10 = 0 THEN 'status' ELSE 'message' END,
           jsonb_build_object('role', CASE WHEN n % 2 = 0 THEN 'assistant' ELSE 'user' END,
                              'content', 'text-' || n)
         FROM generate_series(1, 10000) AS n`,
        [largeRecipientId]
      );
      const transcript = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        largeRecipientId
      );
      let page = await transcript.readTranscript({ limit: 50 });
      expect(page.rows).toHaveLength(50);
      expect(page.rows.every(({ text }) => text.startsWith('text-'))).toBe(true);
      const all: string[] = [];
      while (page.rows.length) {
        all.push(...page.rows.map(({ sequence }) => sequence));
        page = await transcript.readTranscript({ before: page.rows.at(-1)!.sequence, limit: 50 });
      }
      expect(all).toHaveLength(9000);
      expect(new Set(all).size).toBe(all.length);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
