import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { Redis } from 'iovalkey';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerAsync, type Container } from '../../src/core/container.js';
import { createTaskChannel } from '../../src/core/task-channel.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import type {
  TaskBriefing,
  TaskChannelProof,
  TaskTraceFrame,
} from '../../src/ports/task-channel.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createStorageCertificate } from '../helpers/storage-certificate.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestStores, workerDatabaseUrl } from '../helpers/test-stores.js';

const captured = vi.hoisted(() => ({
  channel: undefined as Parameters<typeof createTaskChannel>[0] | undefined,
}));
vi.mock('../../src/core/task-channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/task-channel.js')>();
  return {
    ...actual,
    createTaskChannel: (options: Parameters<typeof actual.createTaskChannel>[0]) => {
      captured.channel = options;
      return actual.createTaskChannel(options);
    },
  };
});
vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', allowLocalModels: true, allowRemoteModels: true },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));

const envKeys = [
  'LIFEMODEL_DATABASE_URL',
  'LIFEMODEL_VALKEY_URL',
  'NODE_ENV',
  'MOTOR_CORTEX_ENABLED',
  'LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE',
  'LIFEMODEL_STORAGE_CONTROL_CA_FILE',
  'LIFEMODEL_TASK_CHANNEL_TLS_DIR',
  'LIFEMODEL_TASK_CHANNEL_PORT',
  'LIFEMODEL_CORE_STOP_DEADLINE_MS',
  'LIFEMODEL_ENTRYPOINT_AUTOSTART',
] as const;

describe('production task trace container wiring', { timeout: 30_000 }, () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let certificate: Awaited<ReturnType<typeof createStorageCertificate>>;
  let directory: string;
  let active: Container | undefined;
  let blocker: PoolClient | undefined;
  const previous = new Map<string, string | undefined>();

  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-trace-container-'));
    await writeFile(join(directory, 'tls.crt'), certificate.cert);
    await writeFile(join(directory, 'tls.key'), certificate.key);
  });
  beforeEach(async () => {
    for (const key of envKeys) previous.set(key, process.env[key]);
    captured.channel = undefined;
    process.env['LIFEMODEL_DATABASE_URL'] = workerDatabaseUrl(stores.workerId);
    const redis = new URL(process.env['LIFEMODEL_TEST_VALKEY_URL']!);
    redis.pathname = '/0';
    process.env['LIFEMODEL_VALKEY_URL'] = redis.toString();
    process.env['NODE_ENV'] = 'production';
    process.env['MOTOR_CORTEX_ENABLED'] = 'false';
    // Enable the actual task listener, without unrelated Kubernetes launch workers.
    delete process.env['LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE'];
    delete process.env['LIFEMODEL_STORAGE_CONTROL_CA_FILE'];
    process.env['LIFEMODEL_TASK_CHANNEL_TLS_DIR'] = directory;
    process.env['LIFEMODEL_TASK_CHANNEL_PORT'] = '8447';
    await stores.postgres.query('TRUNCATE core.tasks CASCADE');
    await stores.postgres.query(
      'TRUNCATE task_access.projections, task_access.start_claims, task_access.intents'
    );
    await stores.postgres.query('TRUNCATE storage.spaces CASCADE');
    await stores.postgres.query('TRUNCATE observability.trace_spans, observability.trace_events');
  });
  async function releaseBlocker() {
    if (!blocker) return;
    const client = blocker;
    blocker = undefined;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
  afterEach(async () => {
    // Always release the real SQL lock before awaiting shutdown, even on red code.
    await releaseBlocker();
    await active?.shutdown();
    active = undefined;
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    certificate?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
    await stores.postgres.end();
    await stores.redis.quit();
  });

  async function liveTask() {
    const epoch = (
      await stores.postgres.query<{ epoch: string }>(
        'SELECT epoch FROM core.active_holder WHERE id'
      )
    ).rows[0]!.epoch;
    const registry = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch: Number(epoch),
      settings: createPlatformSettingsReader({ logger: createTestLogger() }),
    });
    let task = await registry.accept({
      launchKey: 'trace-container-authority',
      briefing: 'private task briefing',
      imageRevision: `sha256:${'a'.repeat(64)}`,
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
    });
    expect((await registry.admitNext())?.id).toBe(task.id);
    const space = 'trace-container-space';
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [space]);
    await stores.postgres.query(
      'INSERT INTO storage.allocations(task_id,launch_id,space_id,retention_revision) VALUES($1,$2,$3,$4)',
      [task.id, task.launchId, space, String(task.settingsRevision)]
    );
    task = await registry.recordAllocation(task.id, task.launchId, {
      id: 'trace-container-allocation',
      space,
      effectKey: `${task.launchId}:allocate`,
    });
    task = await registry.bindJob(task.id, task.launchId, 'trace-container-job', 'b'.repeat(64));
    // JS round-trips milliseconds, as the real Kubernetes start timestamp does.
    const startedAt = new Date();
    const intent = await registry.initializeAccessIntent(task.id, startedAt);
    const podUid = 'trace-container-pod-uid';
    const podName = 'trace-container-pod';
    await stores.postgres.query(
      `INSERT INTO task_access.projections
       (task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at,pod_name,job_name)
       VALUES($1,$2,$3,$4,$5,$6,0,0,'active',$7,$8,$9,$10)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        task.jobUid,
        podUid,
        space,
        intent.softDueAt,
        intent.hardStopAt,
        podName,
        task.jobName,
      ]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.start_claims
       (task_id,attempt_id,launch_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        podUid,
        task.jobUid,
        'trace-container-boot-nonce',
        startedAt,
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
    const proof: TaskChannelProof = {
      podUid,
      podName,
      jobUid: task.jobUid!,
      jobName: task.jobName,
      launchLabel: task.launchId.slice(7, 65),
      templateHash: task.templateHash!,
      startedAt: startedAt.toISOString(),
    };
    return { task, proof };
  }

  it('uses nonexclusive trace authority in the actual container while task and launch rows are locked', async () => {
    active = await createContainerAsync({ logLevel: 'error', logToFile: false });
    const { task, proof } = await liveTask();
    expect(captured.channel?.readTraceAuthority).toBeTypeOf('function');
    blocker = await stores.postgres.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [task.id]);
    await blocker.query('SELECT launch_id FROM core.task_launches WHERE task_id=$1 FOR UPDATE', [
      task.id,
    ]);
    // Call the callback supplied by createContainerAsync, not a fixture mailbox.
    // Old wiring calls readBriefing and fails on the independent UPDATE locks.
    const authority = await captured.channel!.readTraceAuthority!(proof, AbortSignal.timeout(750));
    expect(authority).toMatchObject({ taskId: task.id, traceId: task.traceId, briefing: '' });
    expect((await blocker.query('SELECT 42 AS value')).rows[0].value).toBe(42);
  });

  it('stops through the real coordinator without hard exit and closes state stores despite held trace SQL', async () => {
    const budget = 400;
    process.env['LIFEMODEL_CORE_STOP_DEADLINE_MS'] = String(budget);
    active = await createContainerAsync({
      logLevel: 'error',
      logToFile: false,
      coreLoop: { shutdownDrainTimeoutMs: budget },
    });
    expect(active.coreLoop.getStopDrainTimeoutMs()).toBe(budget);
    blocker = await stores.postgres.connect();
    await blocker.query('BEGIN; LOCK TABLE observability.trace_spans IN ACCESS EXCLUSIVE MODE');
    const at = new Date().toISOString();
    const briefing: TaskBriefing = {
      taskId: 'trace-stop-task',
      attemptId: 'trace-stop-attempt',
      launchId: 'trace-stop-launch',
      traceId: 'trace-stop-trace',
      parentSpanId: null,
      briefing: '',
      harness: 'prime-agent',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
    };
    const frame: TaskTraceFrame = {
      taskId: briefing.taskId,
      attemptId: briefing.attemptId,
      launchId: briefing.launchId,
      span: {
        traceId: briefing.traceId,
        spanId: 'trace-stop-span',
        parentSpanId: null,
        component: 'task',
        startedAt: at,
        endedAt: at,
        status: 'ok',
        attrs: {},
      },
    };
    expect(captured.channel?.onTrace).toBeTypeOf('function');
    captured.channel!.onTrace!(frame, briefing);
    await expect
      .poll(async () => {
        const result = await stores.postgres.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname=current_database() AND application_name='lifemodel-observability'
         AND wait_event_type='Lock' AND query LIKE '%INSERT INTO observability.trace_spans%'`
        );
        return result.rows[0]!.n;
      })
      .toBe(1);

    process.env['LIFEMODEL_ENTRYPOINT_AUTOSTART'] = '0';
    const { runStopSequence } = await import('../../src/index.js');
    const exits: number[] = [];
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exits.push(Number(code));
      return undefined as never;
    });
    const cleanup: string[] = [];
    const originalEnd = Pool.prototype.end;
    vi.spyOn(Pool.prototype, 'end').mockImplementation(async function (this: Pool) {
      await originalEnd.call(this);
      if (!this.options.application_name) cleanup.push('state-postgres-closed');
    });
    const originalQuit = Redis.prototype.quit;
    vi.spyOn(Redis.prototype, 'quit').mockImplementation(async function (this: Redis) {
      const result = await originalQuit.call(this);
      cleanup.push('state-valkey-closed');
      return result;
    });
    const shutdownCall = vi.spyOn(active, 'shutdown');
    const loopStop = vi.spyOn(active.coreLoop, 'stop');
    const started = performance.now();
    const wallStarted = Date.now();
    const stopping = runStopSequence({ reason: 'trace shutdown test', code: 0, container: active });
    const wallAfter = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stoppedBeforeRescue: boolean;
    let elapsed: number;
    try {
      stoppedBeforeRescue = await Promise.race([
        stopping.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), budget + 250);
        }),
      ]);
      elapsed = performance.now() - started;
    } finally {
      clearTimeout(timer);
      // Regression cleanup comes before assertions: old tracePool.end() waits
      // for this lock, so a failing test must not strand shutdown or its pools.
      await releaseBlocker();
      await stopping;
      active = undefined;
    }
    expect(stoppedBeforeRescue).toBe(true);
    expect(exits).toEqual([0]); // The same recorder sees the real hard-exit path (code 1).
    expect(cleanup).toEqual(['state-valkey-closed', 'state-postgres-closed']);
    const deadline = (shutdownCall.mock.calls as unknown[][])[0]?.[0];
    expect(deadline).toBeTypeOf('number');
    expect(Number(deadline)).toBeGreaterThanOrEqual(wallStarted + budget);
    expect(Number(deadline)).toBeLessThanOrEqual(wallAfter + budget);
    expect(loopStop).toHaveBeenCalledWith(deadline);
    expect(elapsed).toBeLessThan(budget);
    await expect
      .poll(async () => {
        const result = await stores.postgres.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname=current_database() AND application_name IN ('lifemodel-observability','lifemodel-trace-authority','lifemodel-task-channel')`
        );
        return result.rows[0]!.n;
      })
      .toBe(0);
  });
});
