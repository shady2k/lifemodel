import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { createTaskChannelReplay } from '../../src/core/task-channel-replay.js';
import type { TaskChannelFrame, TaskChannelProof } from '../../src/ports/task-channel.js';
import { createPostgresTaskMailbox } from '../../src/storage/postgres-task-mailbox.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createSignal } from '../../src/types/signal.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';

describe('durable task channel signal replay', () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let identity: TaskChannelProof & { taskId: string; attemptId: string; launchId: string };
  const logger = createTestLogger();
  const settings = createPlatformSettingsReader({ logger, dir: '/nonexistent-task-settings' });
  const mailbox = () => createPostgresTaskMailbox({ pool: stores.postgres, epoch: 1 });
  const frame = (messageId: string, sequence: number): TaskChannelFrame => ({
    taskId: identity.taskId,
    attemptId: identity.attemptId,
    direction: 'task_to_core',
    messageId,
    sequence,
    kind: 'step',
    payload: { line: 'private replay payload canary' },
  });
  const bus = () => createBusSignalStream(stores.redis, `task-replay:${randomUUID()}:`);
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    await stores.postgres.query(
      'TRUNCATE core.tasks CASCADE; TRUNCATE task_access.projections, task_access.intents, task_access.start_claims'
    );
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,1) ON CONFLICT(id) DO UPDATE SET epoch=1'
    );
    const registry = createPostgresTaskRegistry({ pool: stores.postgres, epoch: 1, settings });
    const task = await registry.accept({
      launchKey: randomUUID(),
      briefing: 'replay fixture',
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
      space: 'space-1',
      effectKey: 'replay:allocate',
    });
    await registry.bindJob(task.id, task.launchId, 'job-replay', 'b'.repeat(64));
    const startedAt = new Date().toISOString();
    await registry.initializeAccessIntent(task.id, new Date(startedAt));
    identity = {
      taskId: task.id,
      attemptId: task.attemptId,
      launchId: task.launchId,
      podUid: 'pod-replay',
      podName: 'pod-replay',
      jobUid: 'job-replay',
      jobName: task.jobName,
      launchLabel: task.launchId.slice(7, 65),
      templateHash: 'b'.repeat(64),
      startedAt,
    };
    await stores.postgres.query(
      'UPDATE core.task_launches SET pod_uid=$2,job_uid=$3 WHERE task_id=$1',
      [task.id, identity.podUid, identity.jobUid]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.start_claims(launch_id,task_id,attempt_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,'abcdefghijklmnop',$6,$6::timestamptz+interval '10 minutes',$6::timestamptz+interval '15 minutes')`,
      [task.launchId, task.id, task.attemptId, identity.podUid, identity.jobUid, startedAt]
    );
    const intent = (await registry.readAccessIntent(task.id))!;
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,0,'active',$9,$10)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        identity.jobUid,
        identity.podUid,
        identity.podName,
        identity.jobName,
        'space-1',
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
  });
  afterAll(async () => {
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });

  it('recovers insert-before-signal crashes at startup with IDs only and no expiry', async () => {
    await mailbox().append(frame('stored-before-crash', 90), identity);
    const stream = bus();
    const replay = createTaskChannelReplay({ mailbox: mailbox(), bus: stream, logger });
    try {
      await replay.start();
      const entries = await stream.readAfter('0-0', 10);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.signal).toMatchObject({
        type: 'task_report',
        source: 'task.channel',
        data: {
          kind: 'task_report',
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          messageId: 'stored-before-crash',
          eventKind: 'step',
        },
      });
      expect(Object.keys(entries[0]!.signal.data!).sort()).toEqual([
        'attemptId',
        'eventKind',
        'kind',
        'messageId',
        'taskId',
      ]);
      expect(entries[0]!.signal.expiresAt).toBeUndefined();
      expect(JSON.stringify(entries)).not.toContain('canary');
      expect(await mailbox().listUnsignalled()).toEqual([]);
    } finally {
      await replay.stop(Date.now() + 1000);
    }
  });

  it('deduplicates append-before-mark crashes across worker restart even after bus trimming', async () => {
    await mailbox().append(frame('append-before-mark', 7), identity);
    const prefix = `task-crash:${randomUUID()}:`;
    const stream = createBusSignalStream(stores.redis, prefix);
    let markAttempts = 0;
    const crashingMailbox = new Proxy(mailbox(), {
      get(target, property) {
        if (property === 'markSignalled')
          return async () => {
            markAttempts++;
            throw new Error('private failure canary');
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const first = createTaskChannelReplay({
      mailbox: crashingMailbox,
      bus: stream,
      logger,
      retryDelayMs: 1000,
    });
    await first.start();
    await first.stop(Date.now() + 1000);
    expect(markAttempts).toBe(1);
    const [entry] = await stream.readAfter('0-0', 10);
    expect(entry).toBeDefined();
    expect(await mailbox().listUnsignalled()).toHaveLength(1);
    // The core can finish and trim the signal before the mailbox mark succeeds.
    await stores.redis.xdel(`${prefix}bus`, entry!.id);
    const restartedStream = createBusSignalStream(stores.redis, prefix);
    const second = createTaskChannelReplay({ mailbox: mailbox(), bus: restartedStream, logger });
    try {
      await second.start();
      expect(await restartedStream.readAfter('0-0', 10)).toEqual([]);
      expect(await mailbox().listUnsignalled()).toEqual([]);
    } finally {
      await second.stop(Date.now() + 1000);
    }
  });

  it('signals gaps and out-of-order IDs once, including terminal reports and onStored resync', async () => {
    const current = mailbox();
    await current.append(frame('message-9', 9), identity);
    await current.append(frame('message-2', 2), identity);
    await current.append(frame('message-9', 9), identity);
    const stream = bus();
    const replay = createTaskChannelReplay({ mailbox: current, bus: stream, logger, batchSize: 1 });
    try {
      await replay.start();
      await current.append(
        {
          ...frame('terminal-30', 30),
          kind: 'terminal',
          payload: {
            outcome: 'aborted',
            summary: 'Stopped',
            resultObjectId: null,
            artifactObjectIds: [],
          },
        },
        identity
      );
      await Promise.all([replay.resync(), replay.resync(), replay.resync()]);
      await expect.poll(async () => (await current.listUnsignalled()).length).toBe(0);
      const entries = await stream.readAfter('0-0', 10);
      expect(entries.map(({ signal }) => signal.data)).toEqual([
        {
          kind: 'task_report',
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          messageId: 'message-9',
          eventKind: 'step',
        },
        {
          kind: 'task_report',
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          messageId: 'message-2',
          eventKind: 'step',
        },
        {
          kind: 'task_report',
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          messageId: 'terminal-30',
          eventKind: 'terminal',
        },
      ]);
      expect(await current.listUnsignalled()).toEqual([]);
    } finally {
      await replay.stop(Date.now() + 1000);
    }
  });

  it('retries a failed append with a bounded timer, without waiting for another stored event', async () => {
    await mailbox().append(frame('retry-without-event', 1), identity);
    const stream = bus();
    let attempts = 0;
    const replay = createTaskChannelReplay({
      mailbox: mailbox(),
      logger,
      retryDelayMs: 5,
      bus: {
        appendTaskSignal: async (signal, key) => {
          attempts++;
          if (attempts === 1) throw new Error('private Valkey failure canary');
          return stream.appendTaskSignal(signal, key);
        },
      },
    });
    try {
      await replay.start();
      await expect.poll(async () => (await mailbox().listUnsignalled()).length).toBe(0);
      expect(attempts).toBe(2);
      expect(await stream.readAfter('0-0', 10)).toHaveLength(1);
    } finally {
      await replay.stop(Date.now() + 1000);
    }
  });

  it('stops blocked mailbox SQL by deadline and never marks a late append', async () => {
    await mailbox().append(frame('stop-in-flight', 1), identity);
    const appended = Promise.withResolvers<void>();
    const finishAppend = Promise.withResolvers<string>();
    const replay = createTaskChannelReplay({
      mailbox: mailbox(),
      logger,
      bus: {
        appendTaskSignal: async () => {
          appended.resolve();
          return finishAppend.promise;
        },
      },
    });
    const starting = replay.start();
    await appended.promise;
    try {
      await replay.stop(Date.now() + 20);
      finishAppend.resolve('1-0');
      await starting;
      expect(await mailbox().listUnsignalled()).toHaveLength(1);
      await replay.resync();
      expect(await mailbox().listUnsignalled()).toHaveLength(1);
    } finally {
      finishAppend.resolve('1-0');
      await replay.stop(Date.now() + 1000);
    }
  });

  it('bounds a startup pass during Valkey outage and preserves rows for retry', async () => {
    await mailbox().append(frame('stalled-valkey', 1), identity);
    const attempted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    let appendCalls = 0;
    const replay = createTaskChannelReplay({
      mailbox: mailbox(),
      logger,
      operationTimeoutMs: 500,
      retryDelayMs: 1000,
      bus: {
        appendTaskSignal: async () => {
          appendCalls++;
          attempted.resolve();
          return release.promise;
        },
      },
    });
    const starting = replay.start();
    try {
      await attempted.promise;
      await starting;
      await Promise.all(Array.from({ length: 20 }, () => replay.resync()));
      expect(appendCalls).toBe(1);
      expect(await mailbox().listUnsignalled()).toHaveLength(1);
    } finally {
      await replay.stop(Date.now() + 1000);
      release.resolve('1-0');
    }
  });

  it('cancels replay SQL without retaining a blocked pool client at shutdown', async () => {
    const blocker = await stores.postgres.connect();
    const replay = createTaskChannelReplay({ mailbox: mailbox(), bus: bus(), logger });
    try {
      await blocker.query('BEGIN; LOCK TABLE core.task_mailbox IN ACCESS EXCLUSIVE MODE');
      const starting = replay.start();
      await expect
        .poll(async () => {
          const rows = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM core.task_mailbox%signalled_at%'`
          );
          return rows.rows[0].n;
        })
        .toBe(1);
      await replay.stop(Date.now() + 1000);
      await starting;
      await expect
        .poll(async () => {
          const rows = await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM core.task_mailbox%signalled_at%'`
          );
          return rows.rows[0].n;
        })
        .toBe(0);
      expect((await blocker.query('SELECT 42 AS n')).rows[0].n).toBe(42);
    } finally {
      await replay.stop(Date.now() + 1000);
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  });

  it('deduplicates task bus appends atomically while ordinary appends keep normal behavior', async () => {
    const stream = bus();
    const signal = createSignal(
      'task_report',
      'task.channel',
      { value: 1 },
      {
        data: {
          kind: 'task_report',
          taskId: identity.taskId,
          attemptId: identity.attemptId,
          messageId: 'message-id',
          eventKind: 'step',
        },
      }
    );
    const key = JSON.stringify([identity.taskId, 'task_to_core', 'message-id']);
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => stream.appendTaskSignal(signal, key))
    );
    expect(new Set(ids).size).toBe(1);
    expect(await stream.readAfter('0-0', 20)).toHaveLength(1);
    await stream.append(signal);
    await stream.append(signal);
    expect(await stream.readAfter('0-0', 20)).toHaveLength(3);
    await stream.appendTaskSignal(
      signal,
      JSON.stringify(['other-task', 'task_to_core', 'message-id'])
    );
    await stream.appendTaskSignal(
      signal,
      JSON.stringify([identity.taskId, 'core_to_task', 'message-id'])
    );
    expect(await stream.readAfter('0-0', 20)).toHaveLength(5);
  });
});
