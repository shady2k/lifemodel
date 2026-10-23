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

const allocation = { id: 'receipt-1', space: 'space-1', effectKey: 'launch:allocate' };
const templateHash = 'b'.repeat(64);

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
      allocationReceipt: null,
      templateHash: null,
      cleanupPending: false,
      softStopRequestedAt: null,
    });
    expect(await registry.readAccessIntent(accepted[0].id)).toBeNull();
  });

  it('cancels an owned checked-out SQL client without destroying an unrelated shared-pool client', async () => {
    const controller = new AbortController();
    const cancellable = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch: 1,
      settings,
      signal: controller.signal,
    });
    const unrelated = await stores.postgres.connect();
    try {
      await unrelated.query('BEGIN; LOCK TABLE core.tasks IN ACCESS EXCLUSIVE MODE');
      const outcome = cancellable.listLaunchWork().catch((error: unknown) => error);
      await expect
        .poll(async () => {
          const waiting = await stores.postgres
            .query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%t.accepted_order>%';`);
          return waiting.rows[0].n;
        })
        .toBe(1);
      controller.abort();
      expect(await outcome).toMatchObject({ code: 'storage_error' });
      expect((await unrelated.query('SELECT 42 AS value')).rows[0].value).toBe(42);
      await expect(cancellable.list()).rejects.toMatchObject({ code: 'storage_error' });
    } finally {
      await unrelated.query('ROLLBACK');
      unrelated.release();
    }
    expect(await registry.list()).toEqual([]);
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
    await expect(
      stores.postgres.query('UPDATE core.tasks SET request_image_revision=$2 WHERE id=$1', [
        task.id,
        `sha256:${'b'.repeat(64)}`,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('enforces launch-key uniqueness independently of the adapter', async () => {
    const task = await registry.accept(request('sql-unique'));
    await expect(
      stores.postgres.query(
        `INSERT INTO core.tasks
      (id, launch_key, briefing, profile, image_revision, harness, settings_revision, wrap_grace_seconds, request_image_revision)
      SELECT 'other-task', launch_key, briefing, profile, image_revision, harness, settings_revision, wrap_grace_seconds, request_image_revision
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
      () => registry.read(task.id),
      () => registry.readByJobName(task.jobName),
      () => registry.listLaunchWork(),
      () => registry.recordAllocation(task.id, task.launchId, allocation),
      () => registry.bindJob(task.id, task.launchId, 'job-uid', templateHash),
      () => registry.tombstoneLaunch(task.id, task.launchId),
      () => registry.completeLaunchCleanup(task.id, task.launchId),
      () => registry.recordSoftStop(task.id, task.launchId),
      () => registry.advanceAccessIntent(task.id, { ...intent!, mode: 'revoked' }),
    ])
      await expect(operation()).rejects.toBeInstanceOf(StalePostgresEpochError);
    const current = makeRegistry(2);
    expect(await current.list()).toHaveLength(1);
    expect(await current.read(task.id)).toMatchObject({ state: 'starting', slotReserved: true });
    expect(await current.readAccessIntent(task.id)).toEqual(intent);
  });

  it('pages only active launch or cleanup work and looks up exact deterministic names under the fence', async () => {
    const queued = await registry.accept(request('page-queued'));
    const active = await registry.accept(request('page-active'));
    const pending = await registry.accept(request('page-cleanup'));
    // The first row deliberately stays queued while later rows need launch work.
    await registry.recordSoftStop(queued.id, queued.launchId);
    expect(await registry.admitNext()).toMatchObject({ id: active.id });
    await registry.tombstoneLaunch(pending.id, pending.launchId);
    const first = await registry.listLaunchWork(undefined, 1);
    expect(first.map((task) => task.id)).toEqual([active.id]);
    const second = await makeRegistry().listLaunchWork(first[0].acceptedOrder, 1);
    expect(second.map((task) => task.id)).toEqual([pending.id]);
    expect(await registry.listLaunchWork(second[0].acceptedOrder)).toEqual([]);
    expect((await registry.listLaunchWork()).map((task) => task.id)).toEqual([
      active.id,
      pending.id,
    ]);
    await registry.completeLaunchCleanup(pending.id, pending.launchId);
    expect((await registry.listLaunchWork()).map((task) => task.id)).toEqual([active.id]);
    expect(await registry.readByJobName(queued.jobName)).toEqual(await registry.read(queued.id));
    expect(await registry.readByJobName('task-absent')).toBeNull();
    for (const [cursor, limit] of [
      ['-1', 1],
      ['1;select', 1],
      ['9223372036854775808', 1],
      ['0', 101],
      ['0', 0],
    ] as const)
      await expect(registry.listLaunchWork(cursor, limit)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    await expect(registry.readByJobName('../canary')).rejects.toMatchObject({
      code: 'invalid_input',
    });
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

  it('rechecks a lowered cap after a waiting admission reaches the serialized decision', async () => {
    const base = await settings.read();
    let snapshot = base;
    const currentSettings = { read: async () => snapshot };
    const dynamic = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch: 1,
      settings: currentSettings,
    });
    const first = await dynamic.accept(request('cap-race-first'));
    const second = await dynamic.accept(request('cap-race-second'));
    const reachedAcquisition = Promise.withResolvers<void>();
    const resumeAcquisition = Promise.withResolvers<void>();
    const delayedPool = new Proxy(stores.postgres, {
      get(target, property) {
        if (property === 'connect')
          return async () => {
            reachedAcquisition.resolve();
            await resumeAcquisition.promise;
            return target.connect();
          };
        return Reflect.get(target, property, target);
      },
    });
    const waiting = createPostgresTaskRegistry({
      pool: delayedPool,
      epoch: 1,
      settings: currentSettings,
    }).admitNext();
    try {
      // Before the fix A has already read cap 2 here. After the fix it cannot
      // read the cap until it owns the admission lock, after this barrier.
      await reachedAcquisition.promise;
      snapshot = { ...base, revision: 1, values: { ...base.values, 'tasks.concurrency': 1 } };
      expect(await dynamic.admitNext()).toMatchObject({ id: first.id, slotReserved: true });
    } finally {
      resumeAcquisition.resolve();
    }
    expect(await waiting).toBeNull();
    expect(await dynamic.read(second.id)).toMatchObject({ state: 'queued', slotReserved: false });
    expect(await dynamic.read(first.id)).toMatchObject({ state: 'starting', slotReserved: true });
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
    const locker = await stores.postgres.connect();
    const reader = await stores.postgres.connect();
    const pending: Promise<unknown>[] = [];
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT * FROM task_access.intents WHERE task_id=$1 FOR UPDATE', [
        task.id,
      ]);
      const advancing = registry.advanceAccessIntent(task.id, { ...first, mode: 'wrapping' });
      pending.push(advancing);
      await expect
        .poll(async () => {
          const result = await stores.postgres.query(
            `SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query=$1`,
            ['SELECT * FROM task_access.intents WHERE task_id=$1 FOR UPDATE']
          );
          return result.rows[0].waiting;
        })
        .toBe(1);
      const pid = await reader.query('SELECT pg_backend_pid() AS pid');
      // This statement targets the old tuple, behind the queued writer. An
      // UPDATE lets it follow the tuple to revision 1; DELETE+INSERT loses it.
      const reading = reader.query(
        'SELECT task_id, attempt_id, launch_id, revision, mode FROM task_access.intents WHERE task_id=$1 FOR SHARE',
        [task.id]
      );
      pending.push(reading);
      await expect
        .poll(async () => {
          const result = await stores.postgres.query(
            'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
            [pid.rows[0].pid]
          );
          return result.rows[0].blocked;
        })
        .toBe(true);
      await locker.query('ROLLBACK');
      const second = await advancing;
      expect(second.revision).toBe('1');
      expect((await reading).rows).toEqual([
        {
          task_id: task.id,
          attempt_id: task.attemptId,
          launch_id: task.launchId,
          revision: '1',
          mode: 'wrapping',
        },
      ]);
      const after = await stores.postgres.query(
        'SELECT task_id, attempt_id, launch_id FROM task_access.intents'
      );
      expect(after.rows).toEqual(before.rows);
      expect(after.rowCount).toBe(1);
      expect(second.softDueAt).toEqual(first.softDueAt);
    } finally {
      await locker.query('ROLLBACK');
      await Promise.allSettled(pending);
      locker.release();
      reader.release();
    }
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

  it('persists the complete allocation receipt before an exact UID/template binding and replays after restart', async () => {
    const task = await registry.accept(request('allocation-binding'));
    await expect(
      registry.recordAllocation(task.id, task.launchId, allocation)
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await registry.admitNext();
    await expect(
      registry.bindJob(task.id, task.launchId, 'job-uid', templateHash)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const allocated = await registry.recordAllocation(task.id, task.launchId, allocation);
    expect(allocated).toMatchObject({
      allocationReceipt: allocation,
      jobUid: null,
      slotReserved: true,
    });
    expect(
      await makeRegistry().recordAllocation(task.id, task.launchId, { ...allocation })
    ).toEqual(allocated);
    for (const changed of [
      { ...allocation, id: 'receipt-2' },
      { ...allocation, space: 'space-2' },
      { ...allocation, effectKey: 'other-effect' },
    ])
      await expect(
        registry.recordAllocation(task.id, task.launchId, changed)
      ).rejects.toMatchObject({ code: 'intent_conflict' });
    const bound = await registry.bindJob(task.id, task.launchId, 'job-uid', templateHash);
    expect(bound).toMatchObject({
      allocationReceipt: allocation,
      jobUid: 'job-uid',
      templateHash,
      slotReserved: true,
    });
    expect(await makeRegistry().bindJob(task.id, task.launchId, 'job-uid', templateHash)).toEqual(
      bound
    );
    for (const [uid, hash] of [
      ['other-job', templateHash],
      ['job-uid', 'c'.repeat(64)],
    ])
      await expect(registry.bindJob(task.id, task.launchId, uid, hash)).rejects.toMatchObject({
        code: 'intent_conflict',
      });
    expect(await registry.read(task.id)).toEqual(bound);
  });

  it('keeps irreversible exact-UID cleanup intent through restart and completion without releasing a slot', async () => {
    const task = await registry.accept(request('known-cleanup'));
    await registry.admitNext();
    await registry.recordAllocation(task.id, task.launchId, allocation);
    await registry.bindJob(task.id, task.launchId, 'exact-job-uid', templateHash);
    await expect(registry.completeLaunchCleanup(task.id, task.launchId)).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    const stopped = await registry.tombstoneLaunch(task.id, task.launchId);
    expect(stopped).toMatchObject({
      jobUid: 'exact-job-uid',
      templateHash,
      cleanupPending: true,
      slotReserved: true,
      tombstonedAt: expect.any(Date),
    });
    expect(await makeRegistry().read(task.id)).toEqual(stopped);
    expect(await registry.tombstoneLaunch(task.id, task.launchId)).toEqual(stopped);
    await expect(
      registry.bindJob(task.id, task.launchId, 'exact-job-uid', templateHash)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await registry.completeLaunchCleanup(task.id, task.launchId);
    await makeRegistry().completeLaunchCleanup(task.id, task.launchId);
    expect(await registry.read(task.id)).toMatchObject({
      jobUid: 'exact-job-uid',
      templateHash,
      tombstonedAt: stopped.tombstonedAt,
      cleanupPending: false,
      slotReserved: true,
    });
    // A late stale CREATE observation must be able to re-arm durable deletion work.
    expect(await makeRegistry().tombstoneLaunch(task.id, task.launchId)).toMatchObject({
      tombstonedAt: stopped.tombstonedAt,
      cleanupPending: true,
      slotReserved: true,
    });
    for (const assignment of [
      'tombstoned_at=NULL',
      "job_uid='replacement'",
      'template_hash=NULL',
      'allocation_receipt=NULL',
    ])
      await expect(
        stores.postgres.query(`UPDATE core.task_launches SET ${assignment} WHERE task_id=$1`, [
          task.id,
        ])
      ).rejects.toMatchObject({ code: '23514' });
  });

  it('tombstones an unknown create response without inventing a Job UID or freeing its reservation', async () => {
    const task = await registry.accept(request('unknown-cleanup'));
    await registry.admitNext();
    await registry.recordAllocation(task.id, task.launchId, allocation);
    const stopped = await registry.tombstoneLaunch(task.id, task.launchId);
    expect(stopped).toMatchObject({ jobUid: null, templateHash: null, cleanupPending: true });
    expect(await registry.recordAllocation(task.id, task.launchId, allocation)).toEqual(stopped);
    await expect(
      registry.bindJob(task.id, task.launchId, 'late-job', templateHash)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await registry.completeLaunchCleanup(task.id, task.launchId);
    expect(await makeRegistry().read(task.id)).toMatchObject({
      jobUid: null,
      cleanupPending: false,
      tombstonedAt: stopped.tombstonedAt,
      slotReserved: true,
    });
  });

  it('validates launch identity on every mutation and keeps soft-stop requests durable and one-way', async () => {
    const task = await registry.accept(request('soft-stop'));
    for (const operation of [
      () => registry.recordAllocation(task.id, 'other-launch', allocation),
      () => registry.bindJob(task.id, 'other-launch', 'job-uid', templateHash),
      () => registry.tombstoneLaunch(task.id, 'other-launch'),
      () => registry.completeLaunchCleanup(task.id, 'other-launch'),
      () => registry.recordSoftStop(task.id, 'other-launch'),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'intent_conflict' });
    await registry.recordSoftStop(task.id, task.launchId);
    const stopped = (await registry.read(task.id))!;
    expect(stopped.softStopRequestedAt).toBeInstanceOf(Date);
    await makeRegistry().recordSoftStop(task.id, task.launchId);
    expect(await registry.read(task.id)).toEqual(stopped);
    expect(await registry.admitNext()).toBeNull();
    await expect(
      registry.recordAllocation(task.id, task.launchId, allocation)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    await expect(
      stores.postgres.query(
        'UPDATE core.task_launches SET soft_stop_requested_at=NULL WHERE task_id=$1',
        [task.id]
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a new allocation after a pre-allocation tombstone', async () => {
    const task = await registry.accept(request('pre-allocation-stop'));
    await registry.admitNext();
    await registry.tombstoneLaunch(task.id, task.launchId);
    await expect(
      registry.recordAllocation(task.id, task.launchId, allocation)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await registry.read(task.id)).toMatchObject({
      allocationReceipt: null,
      slotReserved: true,
    });
  });

  it('rejects invalid receipt and binding shape without exposing input', async () => {
    const task = await registry.accept(request('invalid-launch'));
    await registry.admitNext();
    for (const receipt of [
      { ...allocation, id: '' },
      { ...allocation, space: '../private-canary' },
      { ...allocation, effectKey: '' },
      { ...allocation, effectKey: 'x'.repeat(513) },
    ])
      await expect(
        registry.recordAllocation(task.id, task.launchId, receipt)
      ).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.not.stringContaining('canary'),
      });
    for (const [uid, hash] of [
      ['', templateHash],
      ['job-uid', 'mutable-hash'],
    ])
      await expect(registry.bindJob(task.id, task.launchId, uid, hash)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    for (const operation of [
      () => registry.recordAllocation('missing-task', task.launchId, allocation),
      () => registry.bindJob('missing-task', task.launchId, 'job-uid', templateHash),
      () => registry.tombstoneLaunch('missing-task', task.launchId),
      () => registry.completeLaunchCleanup('missing-task', task.launchId),
      () => registry.recordSoftStop('missing-task', task.launchId),
    ])
      await expect(operation()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('serializes conflicting concurrent bindings and Stop against binding without changing the winning UID', async () => {
    const task = await registry.accept(request('binding-race'));
    await registry.admitNext();
    await registry.recordAllocation(task.id, task.launchId, allocation);
    const bindings = await Promise.allSettled([
      registry.bindJob(task.id, task.launchId, 'job-a', templateHash),
      makeRegistry().bindJob(task.id, task.launchId, 'job-b', templateHash),
    ]);
    expect(bindings.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = bindings.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({ reason: { code: 'intent_conflict' } });
    const bound = (await registry.read(task.id))!;
    const stopping = await Promise.allSettled([
      registry.tombstoneLaunch(task.id, task.launchId),
      makeRegistry().bindJob(task.id, task.launchId, bound.jobUid!, templateHash),
    ]);
    expect(stopping[0].status).toBe('fulfilled');
    await expect(
      makeRegistry().bindJob(task.id, task.launchId, bound.jobUid!, templateHash)
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(await registry.read(task.id)).toMatchObject({
      jobUid: bound.jobUid,
      templateHash,
      cleanupPending: true,
      slotReserved: true,
    });
  });

  it('SQL independently protects allocation receipts, template hashes and cleanup shape', async () => {
    const task = await registry.accept(request('receipt-sql-guards'));
    await registry.admitNext();
    await registry.recordAllocation(task.id, task.launchId, allocation);
    await registry.bindJob(task.id, task.launchId, 'job-uid', templateHash);
    for (const assignment of [
      `allocation_receipt='{"id":"replacement","space":"space-1","effectKey":"launch:allocate"}'::jsonb`,
      `template_hash='${'c'.repeat(64)}'`,
      'cleanup_pending=true',
    ])
      await expect(
        stores.postgres.query(`UPDATE core.task_launches SET ${assignment} WHERE task_id=$1`, [
          task.id,
        ])
      ).rejects.toMatchObject({ code: '23514' });
    expect(await registry.read(task.id)).toMatchObject({
      allocationReceipt: allocation,
      jobUid: 'job-uid',
      templateHash,
      cleanupPending: false,
    });
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
