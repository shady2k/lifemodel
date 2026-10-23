import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import type { TaskChannelFrame, TaskChannelProof } from '../../src/ports/task-channel.js';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';
import { createPostgresTaskMailbox } from '../../src/storage/postgres-task-mailbox.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { StalePostgresEpochError } from '../../src/storage/fenced-postgres.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';

describe('durable fenced task mailbox', () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let identity: TaskChannelProof & { taskId: string; attemptId: string; launchId: string };
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/nonexistent-task-settings',
  });
  const mailbox = (epoch = 1) => createPostgresTaskMailbox({ pool: stores.postgres, epoch });
  const frame = (messageId = 'message-1', sequence = 1): TaskChannelFrame => ({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    direction: 'task_to_core',
    messageId,
    sequence,
    kind: 'step',
    payload: { line: 'private step canary' },
  });
  const terminal = (): TaskChannelFrame => ({
    ...frame('terminal-1', 20),
    kind: 'terminal',
    payload: {
      outcome: 'succeeded',
      summary: 'Finished',
      resultObjectId: 'result_1',
      logObjectId: 'log_1',
      artifactObjectIds: ['artifact_1'],
    },
  });
  async function seed(
    key: string
  ): Promise<TaskChannelProof & { taskId: string; attemptId: string; launchId: string }> {
    const registry = createPostgresTaskRegistry({ pool: stores.postgres, epoch: 1, settings });
    const task = await registry.accept({
      launchKey: key,
      briefing: 'mailbox fixture',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    });
    await registry.admitNext();
    await registry.recordAllocation(task.id, task.launchId, {
      id: 'receipt-1',
      space: `space-${key}`,
      effectKey: `${key}:allocate`,
    });
    await registry.bindJob(task.id, task.launchId, `job-${key}`, 'b'.repeat(64));
    const startedAt = new Date().toISOString();
    await registry.initializeAccessIntent(task.id, new Date(startedAt));
    const result = {
      taskId: task.id,
      attemptId: task.attemptId,
      launchId: task.launchId,
      podUid: `pod-${key}`,
      podName: `pod-${key}`,
      jobUid: `job-${key}`,
      jobName: task.jobName,
      launchLabel: task.launchId.slice(7, 65),
      templateHash: 'b'.repeat(64),
      startedAt,
    };
    await stores.postgres.query(
      'UPDATE core.task_launches SET pod_uid=$2,job_uid=$3 WHERE task_id=$1',
      [task.id, result.podUid, result.jobUid]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.start_claims(launch_id,task_id,attempt_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,'abcdefghijklmnop',$6,$6::timestamptz+interval '10 minutes',$6::timestamptz+interval '15 minutes')`,
      [task.launchId, task.id, task.attemptId, result.podUid, result.jobUid, result.startedAt]
    );
    const intent = (await registry.readAccessIntent(task.id))!;
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,'active',$9,$10)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        result.jobUid,
        result.podUid,
        result.podName,
        result.jobName,
        `space-${key}`,
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
    return result;
  }
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    await stores.postgres.query(
      'TRUNCATE core.tasks CASCADE; TRUNCATE task_access.start_claims, task_access.projections, task_access.intents'
    );
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,1) ON CONFLICT(id) DO UPDATE SET epoch=1'
    );
    identity = await seed('first');
  });
  afterAll(async () => {
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });

  it('commits before ACK, replays exact ACK, accepts gaps and out-of-order without a contiguous cursor', async () => {
    const first = await mailbox().append(frame('message-9', 9), identity);
    const stored = await stores.postgres.query(
      'SELECT message_id FROM core.task_mailbox WHERE task_id=$1',
      [identity.taskId]
    );
    expect(stored.rows).toEqual([{ message_id: 'message-9' }]);
    await mailbox().append(frame('message-2', 2), identity);
    expect(await mailbox().append(frame('message-9', 9), identity)).toEqual(first);
    expect(await mailbox().readCursor(identity.taskId, 'task_to_core')).toMatchObject({
      receivedCount: '2',
      lastReceivedMessageId: 'message-2',
    });
    expect((await mailbox().listUnsignalled()).map((row) => row.frame.messageId)).toEqual([
      'message-9',
      'message-2',
    ]);
  });

  it('serializes duplicate inserts and refuses immutable message or sequence conflicts', async () => {
    const acks = await Promise.all(
      Array.from({ length: 4 }, () => mailbox().append(frame(), identity))
    );
    expect(acks.every((ack) => JSON.stringify(ack) === JSON.stringify(acks[0]))).toBe(true);
    for (const changed of [
      { ...frame(), sequence: 2 },
      { ...frame(), payload: { line: 'different private canary' } },
    ])
      await expect(mailbox().append(changed, identity)).rejects.toMatchObject({
        code: 'message_conflict',
      });
    await expect(mailbox().append(frame('message-2', 1), identity)).rejects.toMatchObject({
      code: 'sequence_conflict',
    });
    expect(await mailbox().listUnsignalled()).toHaveLength(1);
  });

  it('stores only one terminal report, blocks new frames but permits exact duplicates after terminal finalization', async () => {
    const step = frame();
    const ack = await mailbox().append(step, identity);
    const report = terminal();
    const terminalAck = await mailbox().append(report, identity);
    expect(await mailbox().readTerminal(identity.taskId, identity.attemptId)).toMatchObject({
      frame: report,
      ack: terminalAck,
    });
    await expect(mailbox().append(frame('later', 21), identity)).rejects.toMatchObject({
      code: 'terminal_attempt',
    });
    await expect(
      mailbox().append({ ...report, messageId: 'other-terminal', sequence: 22 }, identity)
    ).rejects.toMatchObject({ code: 'terminal_attempt' });
    await stores.postgres.query(
      `UPDATE core.tasks SET state='stopped',terminal_candidate='stopped',terminal_reason_code='owner_stop',terminal_at=now() WHERE id=$1`,
      [identity.taskId]
    );
    expect(await mailbox().append(step, identity)).toEqual(ack);
    expect(await mailbox().append(report, identity)).toEqual(terminalAck);
  });

  it('requires current attempt and exact durable won claim even for already stored frames', async () => {
    await expect(
      mailbox().append({ ...frame(), attemptId: 'attempt-wrong' }, identity)
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    for (const changed of [
      { ...identity, podUid: 'pod-wrong' },
      { ...identity, jobUid: 'job-wrong' },
      { ...identity, launchLabel: 'a'.repeat(58) },
    ])
      await expect(mailbox().append(frame(), changed)).rejects.toMatchObject({
        code: 'identity_mismatch',
      });
    await mailbox().append(frame(), identity);
    await stores.postgres.query('DELETE FROM task_access.start_claims WHERE task_id=$1', [
      identity.taskId,
    ]);
    await expect(mailbox().append(frame(), identity)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
  });

  it('denies a live proof with a different template hash from the saved binding', async () => {
    await expect(
      mailbox().append(frame(), { ...identity, templateHash: 'c'.repeat(64) })
    ).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(await mailbox().listUnsignalled()).toEqual([]);
    expect(await mailbox().readCursor(identity.taskId, 'task_to_core')).toBeNull();
  });

  it('replays durable pending rows across restart and marks exact message IDs idempotently', async () => {
    await mailbox().append(frame('a', 99), identity);
    await mailbox().append(frame('b', 2), identity);
    const restarted = mailbox();
    expect(await restarted.listUnsignalled(1)).toHaveLength(1);
    await restarted.markSignalled(identity.taskId, 'task_to_core', 'b');
    await restarted.markSignalled(identity.taskId, 'task_to_core', 'b');
    expect((await mailbox().listUnsignalled()).map((row) => row.frame.messageId)).toEqual(['a']);
    await restarted.markSignalled(identity.taskId, 'task_to_core', 'a');
    expect(await mailbox().listUnsignalled()).toEqual([]);
    expect(await mailbox().readCursor(identity.taskId, 'task_to_core')).toMatchObject({
      receivedCount: '2',
      signalledCount: '2',
    });
  });

  it('does not skip a late-committing earlier insert when later task rows were already signalled', async () => {
    const secondIdentity = await seed('second');
    let held: PoolClient | undefined;
    const inserted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const delayedPool = new Proxy(stores.postgres, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            held = await target.connect();
            return new Proxy(held, {
              get(client, key) {
                if (key === 'query')
                  return async (...args: unknown[]) => {
                    const result = await Reflect.apply(client.query, client, args);
                    if (
                      typeof args[0] === 'string' &&
                      args[0].trim().startsWith('INSERT INTO core.task_mailbox(')
                    ) {
                      inserted.resolve();
                      await resume.promise;
                    }
                    return result;
                  };
                const value = Reflect.get(client, key, client) as unknown;
                return typeof value === 'function' ? value.bind(client) : value;
              },
            });
          };
        return Reflect.get(target, property, target);
      },
    });
    const pending = createPostgresTaskMailbox({ pool: delayedPool, epoch: 1 }).append(
      frame('late', 1),
      identity
    );
    try {
      await inserted.promise;
      const secondFrame = {
        ...frame('early', 1),
        taskId: secondIdentity.taskId,
        attemptId: secondIdentity.attemptId,
      };
      await mailbox().append(secondFrame, secondIdentity);
      await mailbox().markSignalled(secondIdentity.taskId, 'task_to_core', 'early');
    } finally {
      resume.resolve();
    }
    await pending;
    expect((await mailbox().listUnsignalled()).map((row) => row.frame.messageId)).toEqual(['late']);
  });

  it('reconciles an ambiguous COMMIT only after its task lock is released', async () => {
    const committing = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const held = await stores.postgres.connect();
    let intercepted = false;
    let releaseHeld = false;
    const ambiguousPool = new Proxy(stores.postgres, {
      get(target, property) {
        if (property === 'connect' && !intercepted) {
          intercepted = true;
          return async () =>
            new Proxy(held, {
              get(client, key) {
                if (key === 'query')
                  return async (...args: unknown[]) => {
                    if (args[0] === 'COMMIT') {
                      committing.resolve();
                      throw new Error('simulated lost COMMIT reply');
                    }
                    // The server-side transaction remains in progress after the
                    // simulated lost reply, until the fixture explicitly commits.
                    if (args[0] === 'ROLLBACK') return { rows: [], rowCount: 0 };
                    return Reflect.apply(client.query, client, args);
                  };
                if (key === 'release')
                  return () => {
                    releaseHeld = true;
                  };
                const value = Reflect.get(client, key, client) as unknown;
                return typeof value === 'function' ? value.bind(client) : value;
              },
            });
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const current = createPostgresTaskMailbox({
      pool: ambiguousPool,
      epoch: 1,
      onAppendSettled: () => settled.resolve(),
    });
    let scan: Promise<unknown> | undefined;
    try {
      await expect(current.append(frame(), identity)).rejects.toMatchObject({
        code: 'storage_error',
      });
      await committing.promise;
      await settled.promise;
      expect(releaseHeld).toBe(true);
      scan = current.listUnsignalled();
      await expect
        .poll(async () => {
          const waiting = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM core.tasks WHERE id=ANY%'`
          );
          return waiting.rows[0].n;
        })
        .toBe(1);
      await held.query('COMMIT');
      expect(await scan).toMatchObject([{ frame: frame() }]);
    } finally {
      await held.query('ROLLBACK');
      held.release();
      await scan;
      current.stop();
    }
  });

  it('fences reads and writes and never includes private data in errors', async () => {
    await mailbox().append(frame(), identity);
    await stores.postgres.query('UPDATE core.active_holder SET epoch=2');
    for (const operation of [
      () => mailbox().append(frame(), identity),
      () => mailbox().listUnsignalled(),
      () => mailbox().markSignalled(identity.taskId, 'task_to_core', 'message-1'),
      () => mailbox().readTerminal(identity.taskId, identity.attemptId),
      () => mailbox().readCursor(identity.taskId, 'task_to_core'),
    ])
      await expect(operation()).rejects.toBeInstanceOf(StalePostgresEpochError);
    expect(await mailbox(2).listUnsignalled()).toHaveLength(1);
  });

  it('cancels a blocked owned SQL client, preserves unrelated clients, and rejects calls after stop', async () => {
    const blocker = await stores.postgres.connect();
    const controller = new AbortController();
    const current = mailbox();
    try {
      await blocker.query('BEGIN; LOCK TABLE core.task_mailbox IN ACCESS EXCLUSIVE MODE');
      const result = current
        .append(frame(), identity, controller.signal)
        .catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const rows = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM core.task_mailbox WHERE%'`
          );
          return rows.rows[0].n;
        })
        .toBe(1);
      controller.abort();
      expect(await result).toMatchObject({ code: 'cancelled' });
      await expect
        .poll(async () => {
          const rows = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM core.task_mailbox WHERE%'`
          );
          return rows.rows[0].n;
        })
        .toBe(0);
      expect((await blocker.query('SELECT 42 AS n')).rows[0].n).toBe(42);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    current.stop();
    await expect(current.append(frame(), identity)).rejects.toMatchObject({ code: 'stopped' });
    expect(await mailbox().listUnsignalled()).toEqual([]);
  });

  it('denies revoked canonical intent and rechecks database time after an intent lock wait', async () => {
    const locker = await stores.postgres.connect();
    let operation: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM task_access.intents WHERE task_id=$1 FOR UPDATE', [
        identity.taskId,
      ]);
      operation = mailbox()
        .append(frame(), identity)
        .catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const waiting = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM task_access.intents%'`
          );
          return waiting.rows[0].n;
        })
        .toBe(1);
      await locker.query(
        `UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second' WHERE task_id=$1`,
        [identity.taskId]
      );
      await locker.query('COMMIT');
      expect(await operation).toMatchObject({ code: 'identity_mismatch' });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await operation;
    }
    expect(await mailbox().listUnsignalled()).toEqual([]);
    await stores.postgres.query(
      `UPDATE task_access.intents SET mode='revoked',hard_stop_at=clock_timestamp()+interval '1 minute' WHERE task_id=$1`,
      [identity.taskId]
    );
    await expect(mailbox().append(frame(), identity)).rejects.toMatchObject({
      code: 'identity_mismatch',
    });
  });

  it('guards receipt immutability and terminal uniqueness independently of adapter replay', async () => {
    await mailbox().append(terminal(), identity);
    await expect(
      stores.postgres.query(
        `UPDATE core.task_mailbox SET payload='{"summary":"changed private canary"}'::jsonb`
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stores.postgres.query(
        `INSERT INTO core.task_mailbox(task_id,attempt_id,direction,sequence,message_id,kind,payload) SELECT task_id,attempt_id,direction,999,'other-terminal',kind,payload FROM core.task_mailbox`
      )
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      mailbox().append({ ...frame(), payload: { line: 'private canary\nsecond line' } }, identity)
    ).rejects.toMatchObject({
      code: 'invalid_frame',
      message: expect.not.stringContaining('canary'),
    });
  });

  it('strictly validates bounded short lines, semantic terminals, IDs only, and unknown fields', () => {
    expect(validateTaskChannelFrame(frame())).toEqual(frame());
    expect(validateTaskChannelFrame(terminal())).toEqual(terminal());
    const invalid = [
      null,
      { ...frame(), sequence: 0 },
      { ...frame(), sequence: 1.5 },
      { ...frame(), direction: 'core_to_task' },
      { ...frame(), extra: 'secret' },
      { ...frame(), payload: { line: 'x'.repeat(1025) } },
      { ...frame(), payload: { line: 'one\ntwo' } },
      {
        ...terminal(),
        payload: { ...(terminal().payload as Record<string, unknown>), outcome: 'failed' },
      },
      {
        ...terminal(),
        payload: {
          ...(terminal().payload as Record<string, unknown>),
          resultObjectId: 'https://private.invalid/result',
        },
      },
      {
        ...terminal(),
        payload: { ...(terminal().payload as Record<string, unknown>), bytes: 'private canary' },
      },
    ];
    for (const value of invalid)
      expect(() => validateTaskChannelFrame(value)).toThrow(
        expect.objectContaining({
          code: 'invalid_frame',
          message: expect.not.stringContaining('canary'),
        })
      );
  });
});
