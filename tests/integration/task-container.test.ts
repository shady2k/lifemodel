import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerAsync, type Container } from '../../src/core/container.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import type { AcceptTask } from '../../src/ports/tasks.js';

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', allowLocalModels: true, allowRemoteModels: true },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));
vi.mock('../../src/core/storage-retention.js', () => ({
  createStorageRetentionReconciler: () => ({ start() {}, stop() {} }),
}));
vi.mock('../../src/core/kubernetes-task-executor.js', () => ({
  createKubernetesTaskExecutor: () => ({
    listJobs: async () => [],
    waitForChange: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        if (signal.aborted) resolve();
      }),
    close() {},
  }),
}));

const imageA = `sha256:${'a'.repeat(64)}`;
const imageB = `sha256:${'b'.repeat(64)}`;
const input: AcceptTask = {
  launchKey: 'container-replay',
  briefing: 'private task',
  imageRevision: imageA,
  profile: {
    id: 'small',
    revision: '1',
    timeoutSeconds: 60,
    cpuMillis: 500,
    memoryBytes: 536870912,
  },
};
const envKeys = [
  'LIFEMODEL_DATABASE_URL',
  'LIFEMODEL_VALKEY_URL',
  'NODE_ENV',
  'MOTOR_CORTEX_ENABLED',
  'LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE',
  'LIFEMODEL_STORAGE_CONTROL_CA_FILE',
  'LIFEMODEL_TASK_WORKBENCH_IMAGE',
];

describe('platform task container wiring', { timeout: 30_000 }, () => {
  let stores: Awaited<ReturnType<typeof createTestStores>>;
  let active: Container | undefined;
  let blocker: Awaited<ReturnType<Pool['connect']>> | undefined;
  const availableWorkbenchDigests = new Set<string>();
  const workbenchChecks: string[] = [];
  const previous = new Map<string, string | undefined>();
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    for (const key of envKeys) previous.set(key, process.env[key]);
    availableWorkbenchDigests.clear();
    availableWorkbenchDigests.add(imageA);
    availableWorkbenchDigests.add(imageB);
    workbenchChecks.length = 0;
    // Keep the real readiness gate. Only replace its fixed zot wire boundary;
    // no cluster DNS or registry is available in the isolated test network.
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((resource, init) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.origin === 'http://zot.lifemodel-system.svc:5001') {
        expect(init?.method).toBe('HEAD');
        expect(init?.credentials).toBe('omit');
        expect(init?.redirect).toBe('manual');
        const prefix = '/v2/lifemodel/workbench/manifests/';
        expect(url.pathname.startsWith(prefix)).toBe(true);
        const digest = url.pathname.slice(prefix.length);
        workbenchChecks.push(digest);
        return Promise.resolve(
          new Response(null, {
            status: availableWorkbenchDigests.has(digest) ? 200 : 404,
            headers: { 'docker-content-digest': digest },
          })
        );
      }
      return nativeFetch(resource, init);
    });
    const db = new URL(process.env['LIFEMODEL_TEST_DATABASE_URL']!);
    db.pathname = `/lifemodel_test_worker_${stores.workerId}`;
    process.env['LIFEMODEL_DATABASE_URL'] = db.toString();
    const redis = new URL(process.env['LIFEMODEL_TEST_VALKEY_URL']!);
    redis.pathname = '/0';
    process.env['LIFEMODEL_VALKEY_URL'] = redis.toString();
    process.env['NODE_ENV'] = 'production';
    process.env['MOTOR_CORTEX_ENABLED'] = 'false';
    process.env['LIFEMODEL_STORAGE_CONTROL_TOKEN_FILE'] = '/nonexistent-task-token';
    process.env['LIFEMODEL_STORAGE_CONTROL_CA_FILE'] = '/nonexistent-task-ca';
    process.env['LIFEMODEL_TASK_WORKBENCH_IMAGE'] =
      `zot.lifemodel-system.svc:5001/lifemodel/workbench@${imageA}`;
    await stores.postgres.query('TRUNCATE core.tasks CASCADE');
  });
  afterEach(async () => {
    if (blocker) {
      await blocker.query('ROLLBACK');
      blocker.release();
      blocker = undefined;
    }
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
    await stores.postgres.end();
    await stores.redis.quit();
  });

  it('replays the original request and selected image across a deployment change, but rejects changed payloads', async () => {
    active = await createContainerAsync({ logLevel: 'error', logToFile: false });
    const accepted = await active.taskService!.accept(input);
    await active.shutdown();
    active = undefined;
    process.env['LIFEMODEL_TASK_WORKBENCH_IMAGE'] =
      `zot.lifemodel-system.svc:5001/lifemodel/workbench@${imageB}`;
    active = await createContainerAsync({ logLevel: 'error', logToFile: false });
    // Replaying an accepted effect is not a new launch: a rollout's not-yet
    // imported image must not hide its receipt or change conflict validation.
    availableWorkbenchDigests.delete(imageB);
    const checksBeforeReplay = workbenchChecks.length;
    const replayed = await active.taskService!.accept(input);
    expect(replayed.id).toBe(accepted.id);
    expect(replayed.imageRevision).toBe(imageA);
    for (const changed of [
      { ...input, briefing: 'changed' },
      { ...input, imageRevision: imageB },
      { ...input, profile: { ...input.profile, timeoutSeconds: 90 } },
    ])
      await expect(active.taskService!.accept(changed)).rejects.toMatchObject({
        code: 'launch_key_conflict',
      });
    expect(workbenchChecks).toHaveLength(checksBeforeReplay);
    const freshInput = { ...input, launchKey: 'new-after-deployment' };
    await expect(active.taskService!.accept(freshInput)).rejects.toMatchObject({
      code: 'workbench_unavailable',
    });
    availableWorkbenchDigests.add(imageB);
    const fresh = await active.taskService!.accept(freshInput);
    expect(fresh.imageRevision).toBe(imageB);
    expect((await active.taskService!.accept(freshInput)).id).toBe(fresh.id);
    expect(workbenchChecks).toContain(imageA);
    expect(workbenchChecks).toContain(imageB);
  });

  it('refuses a new task through the real container readiness gate before any registry row', async () => {
    availableWorkbenchDigests.delete(imageA);
    active = await createContainerAsync({ logLevel: 'error', logToFile: false });
    await expect(active.taskService!.accept(input)).rejects.toMatchObject({
      code: 'workbench_unavailable',
    });
    expect(await active.taskService!.list()).toEqual([]);
    expect(workbenchChecks).toEqual([imageA]);
  });

  it('cancels only reconciler SQL and drains it before pool close within the shared stop budget', async () => {
    // ACCESS EXCLUSIVE makes the startup reconciler's SELECT wait inside real SQL.
    blocker = await stores.postgres.connect();
    await blocker.query('BEGIN; LOCK TABLE core.tasks IN ACCESS EXCLUSIVE MODE');
    const budget = 1500;
    active = await createContainerAsync({
      logLevel: 'error',
      logToFile: false,
      coreLoop: { shutdownDrainTimeoutMs: budget },
    });
    await expect
      .poll(async () => {
        const waiting = await stores.postgres.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%t.accepted_order>%';`);
        return waiting.rows[0].n;
      })
      .toBe(1);
    const started = Date.now();
    await active.shutdown();
    expect(Date.now() - started).toBeLessThan(budget);
    active = undefined;
    // The unrelated checked-out client/transaction survived worker cancellation.
    expect((await blocker.query('SELECT 42 AS value')).rows[0].value).toBe(42);
    // Backend notices the destroyed socket asynchronously; do not mistake
    // pg_stat_activity visibility for the pool retaining a checked-out client.
    await expect
      .poll(
        async () => {
          const waiting = await stores.postgres
            .query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE '%t.accepted_order>%';`);
          return waiting.rows[0].n;
        },
        { timeout: 6000 }
      )
      .toBe(0);
  });
});
