import { createTestLogger, recordingLogger } from '../helpers/test-logger.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { EventEmitter } from 'node:events';
import type { TraceRecord, TraceSpan } from '../../src/ports/observability.js';
import {
  createPostgresTraceStore,
  scrubTraceRecord,
  type PostgresTraceStore,
} from '../../src/storage/postgres-trace-store.js';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

import { postgresKnownSecrets } from '../../src/storage/postgres-known-secrets.js';

import { credentialNameCases } from '../helpers/trace-credential-names.js';

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
function modelCallSpan(traceId: string, spanId = 'chat_1'): TraceRecord {
  const record = span(traceId, spanId);
  if (record.kind === 'span') record.span.component = 'llm';
  return record;
}
const noRetention = {
  maxAgeDays: null,
  maxTraces: null,
  maxBytes: null,
  maxModelCallTraces: null,
};

describe('bounded disposable trace queue', () => {
  it('round2: transcript retention is task-key driven', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const store = createPostgresTraceStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
    });
    store.enqueue(span('shape'));
    await store.close();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM core.task_transcript WHERE task_id IN/),
      expect.any(Array)
    );
  });

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

  it('cancels drain before its deadline and destroys a successful late connection exactly once', async () => {
    const connection = Promise.withResolvers<PoolClient>();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const store = createPostgresTraceStore({
      pool: { connect: vi.fn(() => connection.promise) } as unknown as Pool,
    });
    store.enqueue(span('late-after-cancellation'));
    const flushing = store.flush();
    const controller = new AbortController();
    const closing = store.close(Date.now() + 10_000, controller.signal);
    controller.abort();
    await closing;
    expect(store.droppedCount).toBe(1);
    connection.resolve(client as unknown as PoolClient);
    await flushing;
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(store.droppedCount).toBe(1);
  });

  it('does not count a committed batch as dropped when the close deadline expires during retention', async () => {
    const retentionEntered = Promise.withResolvers<void>();
    const releaseRetention = Promise.withResolvers<void>();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT trace_id, bool_and(closed)')) {
          retentionEntered.resolve();
          await releaseRetention.promise;
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const store = createPostgresTraceStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      retention: noRetention,
    });
    store.enqueue(span('committed-before-retention'));
    const flushing = store.flush();
    let droppedAtDeadline: number;
    try {
      await retentionEntered.promise;
      // The first COMMIT persisted the record; only disposable pruning is held.
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      await store.close(Date.now());
      droppedAtDeadline = store.droppedCount;
    } finally {
      // Resolve fake SQL before assertions so even red code leaves no pending work.
      releaseRetention.resolve();
      await flushing;
    }
    expect(droppedAtDeadline).toBe(0);
    expect(store.droppedCount).toBe(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('counts a failed batch once when the close deadline expires during its rollback', async () => {
    const rollbackEntered = Promise.withResolvers<void>();
    const releaseRollback = Promise.withResolvers<void>();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO observability.trace_spans'))
          throw new Error('disposable batch failed');
        if (sql === 'ROLLBACK') {
          rollbackEntered.resolve();
          await releaseRollback.promise;
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const store = createPostgresTraceStore({
      pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool,
      retention: noRetention,
    });
    store.enqueue(span('failed-before-rollback'));
    const flushing = store.flush();
    let droppedBeforeDeadline: number;
    let droppedAtDeadline: number;
    try {
      await rollbackEntered.promise;
      droppedBeforeDeadline = store.droppedCount;
      await store.close(Date.now());
      droppedAtDeadline = store.droppedCount;
    } finally {
      releaseRollback.resolve();
      await flushing;
    }
    expect(droppedBeforeDeadline).toBe(1);
    expect(droppedAtDeadline).toBe(1);
    expect(store.droppedCount).toBe(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
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

  it('preserves bounded backslash runs while scrubbing assignments after them', () => {
    const slashes = '\\'.repeat(4000);
    const record = span('trace', 'root', {
      command: `${slashes} Authorization: Bearer opaque-backslash-bearer\nsafe-command`,
      outputTail: `${slashes} password="opaque-backslash-password" safe-output`,
    });
    const clean = scrubTraceRecord(record);
    expect(clean.kind).toBe('span');
    if (clean.kind !== 'span') return;
    expect(clean.span.attrs).toEqual({
      command: `${slashes} Authorization: [REDACTED]\nsafe-command`,
      outputTail: `${slashes} password="[REDACTED]" safe-output`,
    });
  });

  it.each([
    ['Authorization: Token opaque-value\r\nsafe', 'Authorization: [REDACTED]\r\nsafe'],
    [
      'Authorization: Digest username="opaque", response="opaque two,three"\nsafe',
      'Authorization: [REDACTED]\nsafe',
    ],
    ['Authorization: CustomProof opaque-value', 'Authorization: [REDACTED]'],
    [
      "curl -H 'Authorization: Token opaque-value' safe",
      "curl -H 'Authorization: [REDACTED]' safe",
    ],
    [
      'curl -H "Authorization: Digest response=\\"opaque-value\\"" safe',
      'curl -H "Authorization: [REDACTED]" safe',
    ],
    [
      "curl -H 'Authorization: CustomProof opaque-value\nsafe",
      "curl -H 'Authorization: [REDACTED]\nsafe",
    ],
    ['Authorization: "CustomProof opaque-value" safe', 'Authorization: "[REDACTED]" safe'],
    [
      'Authorization: Token opaque-value\nAuthorization: ApiKey opaque-other\nsafe',
      'Authorization: [REDACTED]\nAuthorization: [REDACTED]\nsafe',
    ],
  ])(
    'redacts a complete scheme-independent header with its true boundary: %s',
    (input, expected) => {
      const record = scrubTraceRecord(
        span('header', 'root', { command: input, outputTail: input })
      );
      if (record.kind !== 'span') throw new Error('span missing');
      expect(record.span.attrs).toEqual({ command: expected, outputTail: expected });
    }
  );

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

  it('round2: transcript retention failure warns without undoing trace persistence or pruning', async () => {
    const lines: import('../helpers/test-logger.js').RecordedLog[] = [];
    const logger = recordingLogger(createTestLogger(), lines);
    const store = writer(
      { maxAgeDays: 14, maxTraces: null, maxBytes: null, maxModelCallTraces: null },
      { logger }
    );
    // Force the real PostgreSQL DELETE statement to fail, even on an empty table.
    await stores.postgres
      .query(`CREATE FUNCTION core.fail_transcript_prune() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_PRUNE_CANARY'; END $$;
      CREATE TRIGGER fail_transcript_prune BEFORE DELETE ON core.task_transcript FOR EACH STATEMENT EXECUTE FUNCTION core.fail_transcript_prune()`);
    try {
      store.enqueue(span('expired-trace'));
      await store.flush();
      expect(store.droppedCount).toBe(0);
      expect(await ids()).not.toContain('expired-trace');
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: 'warn',
            obj: { code: 'task_transcript_retention_failed' },
          }),
        ])
      );
      expect(JSON.stringify(lines)).not.toContain('PRIVATE_PRUNE_CANARY');
      store.enqueue(openSpan('persisted-open'));
      await store.flush();
      expect(await ids()).toContain('persisted-open');
    } finally {
      await stores.postgres.query(
        'DROP TRIGGER fail_transcript_prune ON core.task_transcript; DROP FUNCTION core.fail_transcript_prune()'
      );
    }
  });

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

  it('independently scrubs credential-name parts in all four fields and structured keys before persistence', async () => {
    const { canaries, attrs } = credentialNameCases('persistence');
    const store = writer();
    expect(store.enqueue(span('credential-name-parts', 'root', attrs))).toBe(true);
    await store.flush();
    expect(store.droppedCount).toBe(0);
    const rows = (
      await stores.postgres.query('SELECT attrs FROM observability.trace_spans WHERE trace_id=$1', [
        'credential-name-parts',
      ])
    ).rows;
    expect(rows).toHaveLength(1);
    for (const field of ['command', 'outputTail', 'finalText', 'model', 'structured']) {
      const text = JSON.stringify(rows[0].attrs[field]);
      for (const canary of canaries)
        expect.soft(text.includes(canary), `persisted ${field} leaked`).toBe(false);
      expect(text).toContain('[REDACTED]');
    }
    expect(rows[0].attrs.ordinary).toBe(attrs.ordinary);
  });

  it('scrubs known and shaped credentials before they reach database rows', async () => {
    const canary = 'private-canary%2Fsegment%3Aabcdef';
    const decoded = decodeURIComponent(canary);
    const store = writer(noRetention, {
      knownSecrets: postgresKnownSecrets(`postgres://core:${canary}@database.invalid/core`),
    });
    store.enqueue(
      span('trace', 'root', {
        nested: { output: `${canary} ${decoded} Bearer canary-bearer` },
      })
    );
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
    expect.soft(persisted.includes(decoded), 'persisted decoded credential leaked').toBe(false);
    for (const value of [canary, 'canary-bearer', 'sk-abcdefghijklmnopqrstuvwxyz'])
      expect.soft(persisted.includes(value), 'persisted credential leaked').toBe(false);
    expect(persisted).toContain('[REDACTED]');
  });

  it('scrubs quoted, escaped and unquoted auth credentials in command/outputTail before database persistence', async () => {
    // No knownSecrets: production cannot know credentials printed by an arbitrary tool.
    const cases = [
      ['json-password', (secret: string) => JSON.stringify({ password: secret })],
      ['json-token', (secret: string) => JSON.stringify({ token: secret })],
      ['json-api-key', (secret: string) => JSON.stringify({ 'api-key': secret })],
      ['shell-double', (secret: string) => `PASSWORD="${secret} with spaces"`],
      ['shell-single', (secret: string) => `secret='${secret} with spaces'`],
      ['escaped-json', (secret: string) => JSON.stringify(JSON.stringify({ token: secret }))],
      [
        'nested-json',
        (secret: string) => JSON.stringify({ output: JSON.stringify({ password: secret }) }),
      ],
      [
        'deep-escaped-json',
        (secret: string) => JSON.stringify(JSON.stringify(JSON.stringify({ api_key: secret }))),
      ],
      ['escaped-shell', (secret: string) => JSON.stringify(`token="${secret} with spaces"`)],
      ['authorization', (secret: string) => JSON.stringify({ Authorization: `Basic ${secret}` })],
      ['unquoted-bearer', (secret: string) => `Authorization: Bearer ${secret}`],
      ['unquoted-basic', (secret: string) => `Authorization: Basic ${secret}`],
      ['unquoted-token', (secret: string) => `Authorization: Token ${secret}`],
      ['unquoted-custom', (secret: string) => `aUtHoRiZaTiOn: CustomProof ${secret}`],
      [
        'digest',
        (secret: string) =>
          `Authorization: Digest username="${secret}", response="${secret} with spaces,commas"`,
      ],
      [
        'shell-header',
        (secret: string) => `curl -H 'Authorization: ApiKey ${secret}' safe-header-suffix`,
      ],
      [
        'nested-header',
        (secret: string) =>
          JSON.stringify(
            JSON.stringify(
              `curl -H 'Authorization: Digest response="${secret}"' safe-nested-suffix`
            )
          ),
      ],
      [
        'json-custom',
        (secret: string) => JSON.stringify({ Authorization: `CustomProof ${secret}` }),
      ],
    ] as const;
    const store = writer();
    const canaries: string[] = [];
    for (const [name, encode] of cases) {
      const canary = `opaque-CANARY-${name}-5e9d`;
      canaries.push(canary);
      const content = `safe-prefix ${encode(canary)}\nsafe-suffix`;
      expect(
        store.enqueue(span('quoted-credentials', name, { command: content, outputTail: content }))
      ).toBe(true);
    }
    await store.flush();
    expect(store.droppedCount).toBe(0);
    const rows = (
      await stores.postgres.query('SELECT attrs FROM observability.trace_spans WHERE trace_id=$1', [
        'quoted-credentials',
      ])
    ).rows;
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      for (const field of ['command', 'outputTail']) {
        for (const canary of canaries) {
          expect.soft(row.attrs[field], `${field}: ${canary}`).not.toContain(canary);
        }
        expect(row.attrs[field]).toContain('[REDACTED]');
        expect(row.attrs[field]).toContain('safe-prefix');
        expect(row.attrs[field]).toContain('safe-suffix');
      }
    }
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

  it('bounds model-call traces apart from task evidence so turns cannot evict a run', async () => {
    // Two task traces keep the whole task budget; the model-call traces have
    // their own bound, so a chatty core evicts its own calls, not a run.
    const store = writer(
      { maxAgeDays: null, maxTraces: 2, maxBytes: null, maxModelCallTraces: 2 },
      { pruneEveryBatches: 1 }
    );
    store.enqueue(span('task-a'));
    store.enqueue(span('task-b'));
    store.enqueue(modelCallSpan('call-1'));
    store.enqueue(modelCallSpan('call-2'));
    store.enqueue(modelCallSpan('call-3'));
    await store.flush();
    expect(await ids()).toEqual(['call-2', 'call-3', 'task-a', 'task-b']);
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
