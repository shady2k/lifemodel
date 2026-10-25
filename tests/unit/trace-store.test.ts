import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { EventEmitter } from 'node:events';
import type { TraceRecord, TraceSpan } from '../../src/ports/observability.js';
import {
  createPostgresTraceStore,
  scrubTraceRecord,
  type PostgresTraceStore,
} from '../../src/storage/postgres-trace-store.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

const startedAt = '2026-01-01T00:00:00.000Z';
function span(traceId: string, spanId = 'root', attrs: Record<string, unknown> = {}): TraceRecord {
  return {
    kind: 'span',
    span: {
      traceId,
      spanId,
      parentSpanId: null,
      component: 'task',
      startedAt,
      endedAt: '2026-01-01T00:00:01.000Z',
      status: 'ok',
      attrs,
    },
  };
}
function openSpan(traceId: string): TraceRecord {
  const record = span(traceId);
  if (record.kind === 'span') {
    record.span.endedAt = null;
    record.span.status = null;
  }
  return record;
}
const noRetention = { maxAgeDays: null, maxTraces: null, maxBytes: null };

describe('bounded disposable trace queue', () => {
  it('counts full and closed drops synchronously without consulting Postgres', async () => {
    const connect = vi.fn().mockRejectedValue(new Error('unavailable'));
    const writer = createPostgresTraceStore({ pool: { connect } as unknown as Pool, maxQueue: 1 });
    expect(writer.enqueue(span('one'))).toBe(true);
    expect(writer.enqueue(span('two'))).toBe(false);
    expect(writer.droppedCount).toBe(1);
    expect(connect).not.toHaveBeenCalled();
    await expect(writer.flush()).resolves.toBeUndefined();
    expect(writer.droppedCount).toBe(2);
    await writer.close();
    expect(writer.enqueue(span('closed'))).toBe(false);
    expect(writer.droppedCount).toBe(3);
  });

  it('bounds in-flight records too and lets deadline shutdown return', async () => {
    let rejectConnect!: (reason: Error) => void;
    const connect = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectConnect = reject;
        })
    );
    const writer = createPostgresTraceStore({ pool: { connect } as unknown as Pool, maxQueue: 1 });
    writer.enqueue(span('one'));
    const flushing = writer.flush();
    expect(writer.enqueue(span('two'))).toBe(false);
    await writer.close(Date.now());
    rejectConnect(new Error('offline'));
    await flushing;
    expect(writer.droppedCount).toBe(2);
  });

  it('absorbs a checked-out client disconnect and continues writing later batches', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    let unhandledError = false;
    client.query.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          queueMicrotask(() => {
            try {
              client.emit('error', new Error('socket disconnected between statements'));
            } catch {
              unhandledError = true;
            }
            reject(new Error('connection closed'));
          });
        })
    );
    const store = createPostgresTraceStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      batchSize: 1,
    });
    store.enqueue(span('lost'));
    store.enqueue(span('later'));
    await expect(store.flush()).resolves.toBeUndefined();
    expect(unhandledError).toBe(false);
    expect(store.droppedCount).toBe(1);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO observability.trace_spans'),
      expect.arrayContaining(['later'])
    );
    // Reusing the same pool client must not accumulate listeners per batch.
    expect(client.listenerCount('error')).toBe(1);
    expect(client.release).toHaveBeenCalledTimes(2);
    await store.close();
  });

  it('scrubs canaries in every nested value and key without mutating callers', () => {
    const secret = 'canary-known-secret-0123456789';
    const record = span('trace', 'root', {
      command: `echo ${secret}`,
      nested: [{ [secret]: `Bearer opaque-credential` }],
      output: 'sk-abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
      url: 'https://username:private@host.example/path',
      password: 'arbitrary',
    });
    const text = JSON.stringify(scrubTraceRecord(record, [secret]));
    for (const canary of [
      secret,
      'opaque-credential',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'eyJhbGciOiJIUzI1NiJ9',
      'username:private',
      'arbitrary',
    ])
      expect(text).not.toContain(canary);
    expect(JSON.stringify(record)).toContain(secret);
    expect(text).toContain('[REDACTED]');
  });
});

describe('Postgres trace persistence and whole-trace retention', () => {
  let stores: TestStores;
  const writers: PostgresTraceStore[] = [];
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    await stores.postgres.query('TRUNCATE observability.trace_events,observability.trace_spans');
  });
  afterEach(async () => {
    for (const writer of writers.splice(0)) await writer.close();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });
  function writer(retention = noRetention, extra: Record<string, unknown> = {}) {
    const result = createPostgresTraceStore({ pool: stores.postgres, retention, ...extra });
    writers.push(result);
    return result;
  }
  async function ids(): Promise<string[]> {
    return (
      await stores.postgres.query(
        'SELECT DISTINCT trace_id FROM observability.trace_spans ORDER BY trace_id'
      )
    ).rows.map((row) => row['trace_id']);
  }

  it('persists a failed then successful tool tree, events, codes and failure cause', async () => {
    const store = writer();
    const root = span('run', 'root', {
      taskId: 'task-1',
      launchId: 'launch-1',
      reasonCode: 'required_tool_failed',
      failureSpanId: 'tool-1',
    });
    if (root.kind === 'span') root.span.status = 'failed';
    const failed = span('run', 'tool-1', { command: 'false', exitCode: 1, outputTail: 'failure' });
    const recovered = span('run', 'tool-2', { command: 'true', exitCode: 0 });
    for (const record of [failed, recovered])
      if (record.kind === 'span') {
        record.span.parentSpanId = 'root';
        record.span.component = 'tool';
      }
    if (failed.kind === 'span') failed.span.status = 'failed';
    for (const record of [root, failed, recovered]) expect(store.enqueue(record)).toBe(true);
    store.enqueue({
      kind: 'event',
      event: {
        recordId: 'event-1',
        traceId: 'run',
        spanId: 'tool-1',
        event: 'tool-output',
        ts: startedAt,
        fields: { exitCode: 1 },
      },
    });
    await store.flush();
    const result = await stores.postgres.query(
      'SELECT span_id,parent_span_id,status,attrs FROM observability.trace_spans ORDER BY span_id'
    );
    expect(result.rows).toEqual([
      {
        span_id: 'root',
        parent_span_id: null,
        status: 'failed',
        attrs: {
          taskId: 'task-1',
          launchId: 'launch-1',
          reasonCode: 'required_tool_failed',
          failureSpanId: 'tool-1',
        },
      },
      {
        span_id: 'tool-1',
        parent_span_id: 'root',
        status: 'failed',
        attrs: { command: 'false', exitCode: 1, outputTail: 'failure' },
      },
      {
        span_id: 'tool-2',
        parent_span_id: 'root',
        status: 'ok',
        attrs: { command: 'true', exitCode: 0 },
      },
    ]);
    expect(
      (await stores.postgres.query('SELECT fields FROM observability.trace_events')).rows
    ).toEqual([{ fields: { exitCode: 1 } }]);
  });

  it('upserts closure, maps unknown statuses to failed and never reopens closed spans', async () => {
    const store = writer();
    store.enqueue(openSpan('trace'));
    await store.flush();
    const closed = span('trace');
    if (closed.kind === 'span') closed.span.status = 'mystery' as TraceSpan['status'];
    store.enqueue(closed);
    await store.flush();
    store.enqueue(openSpan('trace'));
    await store.flush();
    expect(
      (await stores.postgres.query('SELECT status,ended_at FROM observability.trace_spans')).rows[0]
    ).toMatchObject({ status: 'failed', ended_at: new Date('2026-01-01T00:00:01Z') });
  });

  it('scrubs known and shaped credentials before they reach database rows', async () => {
    const canary = 'private-canary-token-abcdef';
    const store = writer(noRetention, { knownSecrets: [canary] });
    store.enqueue(span('trace', 'root', { nested: { output: `${canary} Bearer canary-bearer` } }));
    store.enqueue({
      kind: 'event',
      event: {
        recordId: 'event',
        traceId: 'trace',
        spanId: 'root',
        event: 'output',
        ts: startedAt,
        fields: { text: `sk-abcdefghijklmnopqrstuvwxyz ${canary}` },
      },
    });
    await store.flush();
    const persisted = JSON.stringify(
      (
        await stores.postgres.query(
          'SELECT attrs FROM observability.trace_spans UNION ALL SELECT fields FROM observability.trace_events'
        )
      ).rows
    );
    for (const value of [canary, 'canary-bearer', 'sk-abcdefghijklmnopqrstuvwxyz'])
      expect(persisted).not.toContain(value);
    expect(persisted).toContain('[REDACTED]');
  });

  it.each([
    ['age', { maxAgeDays: 14, maxTraces: null, maxBytes: null }],
    ['count', { maxAgeDays: null, maxTraces: 1, maxBytes: null }],
    ['size', { maxAgeDays: null, maxTraces: null, maxBytes: 1 }],
  ])('retains every open trace and deletes whole closed traces by %s', async (_, retention) => {
    const store = writer(retention, { pruneEveryBatches: 1 });
    store.enqueue(openSpan('open'));
    const child = span('open', 'closed-child');
    if (child.kind === 'span') child.span.parentSpanId = 'root';
    store.enqueue(child);
    store.enqueue(span('closed', 'root'));
    store.enqueue(span('closed', 'child'));
    store.enqueue({
      kind: 'event',
      event: {
        recordId: 'closed-event',
        traceId: 'closed',
        spanId: 'child',
        event: 'output',
        ts: startedAt,
        fields: { text: 'x'.repeat(300) },
      },
    });
    await store.flush();
    expect(await ids()).toEqual(['open']);
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM observability.trace_spans'))
        .rows[0]['n']
    ).toBe(2);
    expect(
      (await stores.postgres.query('SELECT count(*)::int AS n FROM observability.trace_events'))
        .rows[0]['n']
    ).toBe(0);
  });

  it('prunes on the first batch even when the periodic cadence is not reached', async () => {
    const store = writer({ maxAgeDays: 14, maxTraces: null, maxBytes: null });
    store.enqueue(span('aged'));
    await store.flush();
    expect(await ids()).toEqual([]);
  });

  it('counts a failed SQL batch and continues with later records without raising', async () => {
    const store = writer(noRetention, { batchSize: 1 });
    const invalid = span('invalid');
    if (invalid.kind === 'span') invalid.span.startedAt = 'not-a-timestamp';
    expect(store.enqueue(invalid)).toBe(true);
    expect(store.enqueue(span('valid'))).toBe(true);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(store.droppedCount).toBe(1);
    expect(await ids()).toEqual(['valid']);
  });

  it('automatically drains a partial batch and flushes a last record during close', async () => {
    const store = writer(noRetention, { flushIntervalMs: 1 });
    store.enqueue(span('automatic'));
    await vi.waitFor(async () => expect(await ids()).toEqual(['automatic']));
    store.enqueue(span('shutdown'));
    await store.close();
    expect(await ids()).toEqual(['automatic', 'shutdown']);
  });
});
