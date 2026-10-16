import { describe, expect, it, vi } from 'vitest';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { OwnerMessageIntake, createWebPool } from '../../src/storage/owner-message-intake.js';

const recipientId = 'transcript-owner-pages';
const uuidV7 = (): string => {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-000000000000`;
};
const row = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  timestamp: new Date().toISOString(),
  ...extra,
});

describe('Postgres owner transcript', () => {
  it('server-cancels transcript queries at the web pool statement timeout', async () => {
    const stores = await createTestStores();
    try {
      const webPool = createWebPool(process.env.LIFEMODEL_TEST_DATABASE_URL!);
      const started = Date.now();
      await expect(webPool.query('SELECT pg_sleep(10)')).rejects.toMatchObject({ code: '57014' });
      expect(Date.now() - started).toBeLessThan(8_000);
      const active = await webPool.query(
        `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND query = 'SELECT pg_sleep(10)'`
      );
      expect(active.rows[0]?.count).toBe(0);
      await webPool.end();
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

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
            ...row('assistant', 'tool reasoning that must stay hidden', {
              tool_calls: [{ id: 'call-2' }],
            }),
            messageId: 'text-tool-turn',
          },
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

      const visibleRows = await transcript.readTranscript({ limit: 50 });
      expect(visibleRows.rows.map(({ text }) => text)).not.toContain(
        'tool reasoning that must stay hidden'
      );
      const hiddenTarget = await stores.postgres.query(
        `SELECT sequence::text FROM core.conversation_messages WHERE recipient_id = $1 AND message_id = 'text-tool-turn'`,
        [recipientId]
      );
      const intake = new OwnerMessageIntake(stores.redis, recipientId, { transcript });
      expect(
        await intake.acceptOwnerMessage(
          uuidV7(),
          'must not quote hidden tool text',
          hiddenTarget.rows[0]!.sequence
        )
      ).toEqual({ status: 'reply_not_found' });
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
        messages: [
          {
            ...row('assistant', 'hidden tool-call text', { tool_calls: [{ id: 'hidden-call' }] }),
            messageId: 'text-tool-call',
          },
          { ...row('assistant', 'later'), messageId: 'channel:web:later' },
        ],
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

  it('removes an aborted watcher while its shared Valkey hint is pending', async () => {
    const stores = await createTestStores();
    const abort = new AbortController();
    try {
      await applyTestMigrations(stores.postgres);
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, 'abort-watch');
      const iterator = transcript.watchTranscript('0', abort.signal)[Symbol.asyncIterator]();
      const pending = iterator.next();
      abort.abort();
      await expect(pending).resolves.toMatchObject({ done: true });
      await iterator.return?.();
    } finally {
      abort.abort();
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('shares one hint connection and disconnects it when outage watchers abort', async () => {
    let signalXreadStarted!: () => void;
    const xreadStarted = new Promise<void>((resolve) => {
      signalXreadStarted = resolve;
    });
    const disconnect = vi.fn();
    const xread = vi.fn(async () => {
      signalXreadStarted();
      throw new Error('Valkey unavailable');
    });
    const connection = { xread, disconnect };
    const duplicate = vi.fn(() => connection);
    const fakeRedis = { duplicate } as unknown as import('iovalkey').Redis;
    const fakePool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as import('pg').Pool;
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstStore = new PostgresTranscriptStore(fakePool, fakeRedis, 'outage-one');
    const secondStore = new PostgresTranscriptStore(fakePool, fakeRedis, 'outage-two');
    const first = firstStore.watchTranscript('0', firstAbort.signal)[Symbol.asyncIterator]();
    const second = secondStore.watchTranscript('0', secondAbort.signal)[Symbol.asyncIterator]();
    const firstPending = first.next();
    const secondPending = second.next();
    await xreadStarted;
    firstAbort.abort();
    await expect(firstPending).resolves.toMatchObject({ done: true });
    expect(duplicate).toHaveBeenCalledTimes(1);
    secondAbort.abort();
    await expect(secondPending).resolves.toMatchObject({ done: true });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('wakes the transcript watcher locally when the shared hint read never settles', async () => {
    const disconnect = vi.fn();
    const xread = vi.fn(() => new Promise<never>(() => {}));
    const fakeRedis = {
      duplicate: () => ({ xread, disconnect }),
    } as unknown as import('iovalkey').Redis;
    let reads = 0;
    const fakePool = {
      query: vi.fn(async () => {
        reads += 1;
        return {
          rows:
            reads === 2
              ? [
                  {
                    sequence: '1',
                    message_id: 'channel:web:row',
                    role: 'assistant',
                    text: 'fallback',
                    created_at: new Date(),
                    reply_to: null,
                    has_reply_to: false,
                    newest_sequence: '1',
                  },
                ]
              : [],
        };
      }),
    } as unknown as import('pg').Pool;
    const transcript = new PostgresTranscriptStore(fakePool, fakeRedis, 'hint-never-settles');
    const abort = new AbortController();
    try {
      const iterator = transcript.watchTranscript('0', abort.signal)[Symbol.asyncIterator]();
      const delivered = await iterator.next();
      expect(delivered.value?.text).toBe('fallback');
      expect(reads).toBe(2);
      abort.abort();
      await iterator.return?.();
    } finally {
      abort.abort();
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

  it('enforces four session stream leases across transcript-store replicas and expires crashed leases', async () => {
    const stores = await createTestStores();
    try {
      const firstReplica = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        'lease-owner'
      );
      const secondReplica = new PostgresTranscriptStore(
        stores.postgres,
        stores.redis,
        'lease-owner'
      );
      const sessions = 'signed-session-cookie';
      expect(
        await Promise.all([
          firstReplica.acquireStreamLease(sessions, Date.now() + 60_000),
          secondReplica.acquireStreamLease(sessions, Date.now() + 60_000),
          firstReplica.acquireStreamLease(sessions, Date.now() + 60_000),
          secondReplica.acquireStreamLease(sessions, Date.now() + 60_000),
          firstReplica.acquireStreamLease(sessions, Date.now() + 60_000),
        ])
      ).toEqual([true, true, true, true, false]);
      await firstReplica.releaseStreamLease(sessions);
      expect(await secondReplica.acquireStreamLease(sessions, Date.now() + 60_000)).toBe(true);
      await stores.redis.del(
        `web:stream-leases:${(await import('node:crypto')).createHash('sha256').update(sessions).digest('hex')}`
      );
      expect(await firstReplica.acquireStreamLease(sessions, Date.now() + 60_000)).toBe(true);
    } finally {
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
      await stores.postgres.query('ANALYZE core.conversation_messages');
      const querySpy = vi.spyOn(stores.postgres, 'query');
      let page = await transcript.readTranscript({ limit: 50 });
      const queryCall = querySpy.mock.calls.at(-1);
      querySpy.mockRestore();
      expect(queryCall?.[0]).toBeTypeOf('string');
      const plan = await stores.postgres.query<{ 'QUERY PLAN': { Plan: unknown }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${String(queryCall?.[0])}`,
        queryCall?.[1] as unknown[]
      );
      const planText = JSON.stringify(plan.rows[0]?.['QUERY PLAN'][0]?.Plan);
      expect(planText).toContain('Limit');
      expect(planText).toMatch(/Index (Only )?Scan/);
      expect(planText).not.toMatch(/CTE Scan|Materialize/);
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
