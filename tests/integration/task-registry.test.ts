import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AcceptTask, TaskRegistry, TaskRecord } from '../../src/ports/tasks.js';
import { TaskRegistryError } from '../../src/ports/tasks.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { StalePostgresEpochError } from '../../src/storage/fenced-postgres.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';

const request = (launchKey: string): AcceptTask => ({
  launchKey,
  briefing: 'private briefing canary',
  profile: {
    id: 'small',
    revision: 'p1',
    timeoutSeconds: 600,
    cpuMillis: 500,
    memoryBytes: 536870912,
  },
  imageRevision: `sha256:${'a'.repeat(64)}`,
});

describe('fenced durable task registry', () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let registry: TaskRegistry;
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/nonexistent-task-settings',
  });
  const makeRegistry = (epoch = 1) =>
    createPostgresTaskRegistry({ pool: stores.postgres, epoch, settings });
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    // Catalog lookup allows the first red run to reach each behaviour before DDL exists.
    const exists = await stores.postgres.query("SELECT to_regclass('core.tasks') AS table_name");
    if (exists.rows[0].table_name) await stores.postgres.query('TRUNCATE core.tasks CASCADE');
    await stores.postgres.query('TRUNCATE task_access.intents');
    await stores.postgres.query(
      `INSERT INTO core.active_holder VALUES (true, 1) ON CONFLICT (id) DO UPDATE SET epoch=1`
    );
    registry = makeRegistry();
  });
  afterAll(async () => {
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });

  it('replays the launch key after adapter restart and concurrent acceptance with identical IDs', async () => {
    const accepted = await Promise.all([
      registry.accept(request('turn:1:task:0')),
      makeRegistry().accept(request('turn:1:task:0')),
    ]);
    expect(accepted[0]).toEqual(accepted[1]);
    expect(await makeRegistry().accept(request('turn:1:task:0'))).toEqual(accepted[0]);
    expect(await registry.read(accepted[0].id)).toEqual(accepted[0]);
    expect(await registry.list()).toHaveLength(1);
    expect(accepted[0].jobName).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(accepted[0].jobName.length).toBeLessThanOrEqual(63);
    expect(accepted[0]).toMatchObject({
      state: 'queued',
      urgent: false,
      slotReserved: false,
      jobUid: null,
      podUid: null,
    });
    expect(await registry.readAccessIntent(accepted[0].id)).toBeNull();
  });

  it('conflicts on a changed payload without leaking private input', async () => {
    const task = await registry.accept(request('conflict'));
    for (const changed of [
      { ...request('conflict'), briefing: 'changed private canary' },
      { ...request('conflict'), imageRevision: `sha256:${'b'.repeat(64)}` },
      { ...request('conflict'), profile: { ...request('conflict').profile, timeoutSeconds: 300 } },
    ]) {
      await expect(registry.accept(changed)).rejects.toMatchObject({
        taskId: task.id,
        code: 'launch_key_conflict',
        message: expect.not.stringContaining('canary'),
      });
    }
    expect(await registry.list()).toHaveLength(1);
  });

  it('enforces launch-key uniqueness independently of the adapter', async () => {
    const task = await registry.accept(request('sql-unique'));
    await expect(
      stores.postgres.query(
        `INSERT INTO core.tasks
      (id, launch_key, briefing, profile, image_revision, harness, settings_revision, wrap_grace_seconds)
      SELECT 'other-task', launch_key, briefing, profile, image_revision, harness, settings_revision, wrap_grace_seconds
      FROM core.tasks WHERE id=$1`,
        [task.id]
      )
    ).rejects.toMatchObject({ code: '23505' });
    expect(await registry.list()).toHaveLength(1);
  });

  it('refuses every stale write without changing task, slot or intent rows', async () => {
    const task = await registry.accept(request('fenced'));
    await registry.admitNext();
    const intent = await registry.initializeAccessIntent(task.id, new Date());
    await stores.postgres.query('UPDATE core.active_holder SET epoch=2');
    for (const operation of [
      () => registry.accept(request('stale-new')),
      () => registry.accept(request('fenced')),
      () => registry.admitNext(),
      () => registry.initializeAccessIntent(task.id, new Date()),
      () => registry.releaseSlot(task.id),
      () => registry.advanceAccessIntent(task.id, { ...intent!, mode: 'revoked' }),
    ])
      await expect(operation()).rejects.toBeInstanceOf(StalePostgresEpochError);
    const current = makeRegistry(2);
    expect(await current.list()).toHaveLength(1);
    expect(await current.read(task.id)).toMatchObject({ state: 'starting', slotReserved: true });
    expect(await current.readAccessIntent(task.id)).toEqual(intent);
  });

  it('reserves under cap 2 across concurrent contenders in FIFO order, then releases explicitly', async () => {
    const tasks = [];
    for (const key of ['first', 'second', 'third']) tasks.push(await registry.accept(request(key)));
    const admitted = await Promise.all([
      registry.admitNext(),
      makeRegistry().admitNext(),
      makeRegistry().admitNext(),
    ]);
    expect(
      admitted
        .filter(Boolean)
        .map((t) => t!.id)
        .sort()
    ).toEqual(
      tasks
        .slice(0, 2)
        .map((t) => t.id)
        .sort()
    );
    expect((await registry.list()).map((t) => [t.id, t.state, t.slotReserved])).toEqual([
      [tasks[0].id, 'starting', true],
      [tasks[1].id, 'starting', true],
      [tasks[2].id, 'queued', false],
    ]);
    await registry.releaseSlot(tasks[0].id);
    await registry.releaseSlot(tasks[0].id);
    expect(await makeRegistry().admitNext()).toMatchObject({
      id: tasks[2].id,
      state: 'starting',
      slotReserved: true,
    });
  });

  it('snapshots settings at acceptance but reads the current platform cap at admission', async () => {
    const base = await settings.read();
    let snapshot = base;
    const dynamic = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch: 1,
      settings: { read: async () => snapshot },
    });
    const task = await dynamic.accept(request('snapshot'));
    snapshot = {
      revision: 7,
      values: {
        ...base.values,
        'tasks.concurrency': 1,
        'tasks.harness': 'prime-agent',
        'tasks.wrapGraceSeconds': 30,
      },
    };
    expect(await dynamic.accept(request('snapshot'))).toEqual(task);
    const second = await dynamic.accept(request('snapshot-2'));
    expect(second).toMatchObject({
      settingsRevision: 7,
      harness: 'prime-agent',
      wrapGraceSeconds: 30,
    });
    expect(await dynamic.admitNext()).toMatchObject({ id: task.id });
    expect(await dynamic.admitNext()).toBeNull();
    await dynamic.releaseSlot(task.id);
    expect(await dynamic.admitNext()).toMatchObject({ id: second.id });
  });

  const starting = async (): Promise<TaskRecord> => {
    await registry.accept(request('intent'));
    const task = (await registry.admitNext())!;
    await registry.initializeAccessIntent(task.id, new Date('2026-10-23T12:00:00Z'));
    return task;
  };

  it('initializes finite revision-0 access from observed Job start before binding and updates the same primary-key row in place', async () => {
    const task = await starting();
    const first = (await registry.readAccessIntent(task.id))!;
    expect(first).toMatchObject({
      taskId: task.id,
      attemptId: task.attemptId,
      launchId: task.launchId,
      revision: '0',
      mode: 'active',
    });
    expect(first.hardStopAt.getTime() - first.softDueAt.getTime()).toBe(300000);
    const before = await stores.postgres.query(
      'SELECT task_id, attempt_id, launch_id FROM task_access.intents'
    );
    const second = await registry.advanceAccessIntent(task.id, { ...first, mode: 'wrapping' });
    expect(second.revision).toBe('1');
    const after = await stores.postgres.query(
      'SELECT task_id, attempt_id, launch_id FROM task_access.intents'
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rowCount).toBe(1);
    expect(second.softDueAt).toEqual(first.softDueAt);
  });

  it('initializes once from observed Job start, replay never resets or extends it', async () => {
    const task = await starting();
    const at = new Date('2026-10-23T12:00:00Z');
    const first = (await registry.readAccessIntent(task.id))!;
    expect(first.softDueAt.toISOString()).toBe('2026-10-23T12:10:00.000Z');
    expect(await registry.initializeAccessIntent(task.id, at)).toEqual(first);
    await registry.advanceAccessIntent(task.id, { ...first, mode: 'revoked' });
    expect(await registry.initializeAccessIntent(task.id, at)).toMatchObject({
      revision: '1',
      mode: 'revoked',
    });
    await expect(
      registry.initializeAccessIntent(task.id, new Date(at.getTime() + 1000))
    ).rejects.toMatchObject({ code: 'intent_conflict' });
  });

  it('never reopens revoked access', async () => {
    const task = await starting();
    const intent = (await registry.readAccessIntent(task.id))!;
    await registry.advanceAccessIntent(task.id, { ...intent, mode: 'revoked' });
    for (const mode of ['active', 'wrapping'] as const) {
      await expect(
        registry.advanceAccessIntent(task.id, { ...intent, mode })
      ).rejects.toMatchObject({ taskId: task.id, code: 'intent_conflict' });
    }
    expect(await registry.readAccessIntent(task.id)).toMatchObject({
      revision: '1',
      mode: 'revoked',
    });
  });

  it('refuses extensions of either deadline and nonfinite timestamps', async () => {
    const task = await starting();
    const first = (await registry.readAccessIntent(task.id))!;
    for (const field of ['softDueAt', 'hardStopAt'] as const) {
      await expect(
        registry.advanceAccessIntent(task.id, {
          ...first,
          [field]: new Date(first[field].getTime() + 1000),
        })
      ).rejects.toMatchObject({ taskId: task.id, code: 'intent_conflict' });
    }
    await expect(
      registry.advanceAccessIntent(task.id, { ...first, softDueAt: new Date(NaN) })
    ).rejects.toBeInstanceOf(TaskRegistryError);
    const shorter = await registry.advanceAccessIntent(task.id, {
      ...first,
      softDueAt: new Date(first.softDueAt.getTime() - 1000),
      hardStopAt: new Date(first.hardStopAt.getTime() - 1000),
    });
    expect(shorter.revision).toBe('1');
  });

  it('enforces state edges and cannot change a committed terminal state or candidate', async () => {
    const task = await registry.accept(request('terminal'));
    await expect(
      stores.postgres.query("UPDATE core.tasks SET state='running' WHERE id=$1", [task.id])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      stores.postgres.query(
        "UPDATE core.tasks SET state='failed', terminal_at=clock_timestamp() WHERE id=$1",
        [task.id]
      )
    ).rejects.toMatchObject({ code: '23514' });
    await stores.postgres.query(
      "UPDATE core.tasks SET terminal_candidate='stopped', terminal_reason_code='owner_stop', finalization_pending=true WHERE id=$1",
      [task.id]
    );
    expect(await registry.read(task.id)).toMatchObject({
      state: 'queued',
      terminalCandidate: 'stopped',
      finalizationPending: true,
    });
    await stores.postgres.query(
      "UPDATE core.tasks SET state='stopped', terminal_at=clock_timestamp(), finalization_pending=false WHERE id=$1",
      [task.id]
    );
    for (const assignment of [
      "state='done'",
      "state='queued'",
      "terminal_candidate='failed'",
      "terminal_reason_code='different'",
    ]) {
      await expect(
        stores.postgres.query(`UPDATE core.tasks SET ${assignment} WHERE id=$1`, [task.id])
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await registry.read(task.id)).toMatchObject({ state: 'stopped' });
  });

  it('rejects missing/invalid input without including the briefing', async () => {
    for (const invalid of [
      { ...request('bad'), launchKey: '' },
      { ...request('bad'), briefing: '' },
      { ...request('bad'), profile: { ...request('bad').profile, timeoutSeconds: 0 } },
      {
        ...request('bad'),
        profile: { ...request('bad').profile, timeoutSeconds: Number.MAX_SAFE_INTEGER },
      },
      { ...request('bad'), imageRevision: '' },
    ])
      await expect(registry.accept(invalid)).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.not.stringContaining('canary'),
      });
    expect(await registry.list()).toEqual([]);
  });

  it('bounds pool exhaustion and releases a late acquired client', async () => {
    const pool = new Pool({ ...stores.postgres.options, max: 1 });
    const held = await pool.connect();
    const bounded = createPostgresTaskRegistry({
      pool,
      epoch: 1,
      settings,
      operationTimeoutMs: 100,
    });
    try {
      await expect(bounded.accept(request('pool-bound'))).rejects.toMatchObject({
        code: 'storage_error',
      });
      held.release();
      expect(await bounded.list()).toEqual([]);
    } finally {
      await pool.end();
    }
  });

  it('bounds a holder lock wait before fenced BEGIN and leaves no mutation', async () => {
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT * FROM core.active_holder FOR UPDATE');
    const bounded = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch: 1,
      settings,
      operationTimeoutMs: 100,
    });
    try {
      await expect(bounded.accept(request('holder-bound'))).rejects.toMatchObject({
        code: 'storage_error',
      });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await registry.list()).toEqual([]);
  });

  it('serializes competing revocation and active intent updates without reopening', async () => {
    const task = await starting();
    const intent = (await registry.readAccessIntent(task.id))!;
    const outcomes = await Promise.allSettled([
      registry.advanceAccessIntent(task.id, { ...intent, mode: 'revoked' }),
      makeRegistry().advanceAccessIntent(task.id, { ...intent, mode: 'active' }),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(await registry.readAccessIntent(task.id)).toMatchObject({ mode: 'revoked' });
  });

  it('needs no writable DATA_PATH and survives a fresh service instance', async () => {
    const original = process.env.DATA_PATH;
    process.env.DATA_PATH = '/proc/lifemodel-read-only';
    try {
      const task = await registry.accept(request('readonly'));
      await registry.admitNext();
      expect(await makeRegistry().read(task.id)).toMatchObject({ id: task.id, state: 'starting' });
    } finally {
      if (original === undefined) delete process.env.DATA_PATH;
      else process.env.DATA_PATH = original;
    }
  });
});
