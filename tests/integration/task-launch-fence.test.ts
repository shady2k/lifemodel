import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { Socket } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { evaluateTaskAdmission } from '../helpers/task-admission.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { createStorageControlClient } from '../../src/core/storage-control-client.js';
import {
  createKubernetesTaskExecutor,
  renderTaskJob,
} from '../../src/core/kubernetes-task-executor.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { createTaskKubernetesClient } from '../../src/core/task-kubernetes-client.js';
import {
  createTaskLaunchReconciler,
  allocationEffectKey,
  taskWorkbenchImage,
} from '../../src/core/task-launch.js';
import type { TaskExecutor, TaskLaunch } from '../../src/core/task-executor.js';
import { createWorkbenchTaskService } from '../../src/core/task-workbench.js';

// Kubernetes is deliberately simulated at its wire boundary. Postgres and its
// active holder, receipt persistence and migration guards are real isolated stores.
describe('task launch fence (real Postgres, HTTPS Kubernetes API)', () => {
  let stores: TestStores;
  let cert: TestStorageCertificate;
  let server: Server;
  let root: string;
  let tokenFile: string;
  let caFile: string;
  let origin: string;
  let expectedToken = 'epoch-one-token';
  let raceJobName = '';
  let watchSeen: ReturnType<typeof Promise.withResolvers<void>>;
  let watchEnded: ReturnType<typeof Promise.withResolvers<void>>;
  let watchResponse: import('node:http').ServerResponse | undefined;
  let registry: TaskRegistry;
  let jobs: Map<string, any>;
  let requests: { method: string; path: string; body: any }[];
  let allocations: Map<string, any>;
  let mode: 'normal' | 'drop-create' | 'conflict-create' | 'allocation-failure';
  let storageCalls: number;
  let creates: number;
  let allocationBeforeCreates: boolean[];
  let createSeen: ReturnType<typeof Promise.withResolvers<void>>;
  let releaseCreate: ReturnType<typeof Promise.withResolvers<void>>;
  const sockets = new Set<Socket>();
  const closers: (() => void)[] = [];
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/missing-task-settings',
  });
  const makeRegistry = (epoch = 1) =>
    createPostgresTaskRegistry({ pool: stores.postgres, epoch, settings });
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    cert = await createStorageCertificate(['localhost']);
    root = await mkdtemp(join(tmpdir(), 'task-launch-'));
    tokenFile = join(root, 'token');
    caFile = join(root, 'ca');
    await writeFile(caFile, cert.ca);
    server = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${expectedToken}`) {
          res.writeHead(401).end('{}');
          return;
        }
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const path = new URL(req.url!, 'https://localhost').pathname;
        requests.push({ method: req.method!, path, body });
        const send = (code: number, value: unknown) =>
          res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(value));
        if (path === '/allocate') {
          storageCalls++;
          if (mode === 'allocation-failure') {
            send(503, {});
            return;
          }
          expect(Object.keys(body).sort()).toEqual(
            ['taskId', 'launchId', 'effectKey', 'retentionRevision'].sort()
          );
          const receipt = allocations.get(body.effectKey) ?? {
            id: 'allocation-1',
            space: 'space-1',
            effectKey: body.effectKey,
          };
          allocations.set(body.effectKey, receipt);
          send(200, receipt);
          return;
        }
        const name = path.split('/').at(-1)!;
        if (new URL(req.url!, 'https://localhost').searchParams.get('watch') === '1') {
          expect(req.method).toBe('GET');
          watchResponse = res;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.flushHeaders();
          res.on('close', () => {
            watchEnded.resolve();
          });
          watchSeen.resolve();
          return;
        }
        if (req.method === 'GET' && ['pods', 'persistentvolumeclaims'].includes(name)) {
          send(200, { items: [], metadata: { resourceVersion: '1' } });
          return;
        }
        if (req.method === 'GET' && name === 'jobs') {
          send(200, { items: [...jobs.values()], metadata: {} });
          return;
        }
        if (req.method === 'GET') {
          send(jobs.has(name) ? 200 : 404, jobs.get(name) ?? {});
          return;
        }
        if (req.method === 'POST') {
          creates++;
          allocationBeforeCreates.push(allocations.size > 0);
          const job = structuredClone(body);
          job.metadata.uid = 'job-uid-1';
          job.metadata.resourceVersion = '1';
          // Simulate a competing CREATE winning after the caller's absent GET.
          if (mode === 'conflict-create' && !jobs.has(job.metadata.name))
            jobs.set(job.metadata.name, job);
          if (jobs.has(job.metadata.name)) {
            send(409, {
              apiVersion: 'v1',
              kind: 'Status',
              status: 'Failure',
              reason: 'AlreadyExists',
              code: 409,
              details: { name: job.metadata.name, group: 'batch', kind: 'jobs' },
            });
            return;
          }
          jobs.set(job.metadata.name, job);
          if (job.metadata.name === raceJobName) {
            createSeen.resolve();
            void releaseCreate.promise.then(() => send(201, job));
            return;
          }
          if (mode === 'drop-create') {
            req.socket.destroy();
            return;
          }
          send(201, job);
          return;
        }
        if (req.method === 'DELETE') {
          const job = jobs.get(name);
          expect(body.preconditions).toEqual({
            uid: job.metadata.uid,
            resourceVersion: job.metadata.resourceVersion,
          });
          expect(body.gracePeriodSeconds).toBe(0);
          jobs.delete(name);
          send(200, { kind: 'Status', status: 'Success' });
          return;
        }
        send(405, {});
      });
    });
    server.on('error', () => undefined);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    origin = `https://localhost:${address.port}`;
  });
  beforeEach(async () => {
    await stores.postgres.query('TRUNCATE core.tasks CASCADE');
    await stores.postgres.query('TRUNCATE task_access.intents');
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,1) ON CONFLICT(id) DO UPDATE SET epoch=1'
    );
    registry = makeRegistry();
    jobs = new Map();
    requests = [];
    allocations = new Map();
    mode = 'normal';
    storageCalls = 0;
    creates = 0;
    allocationBeforeCreates = [];
    expectedToken = 'epoch-one-token';
    raceJobName = '';
    watchSeen = Promise.withResolvers<void>();
    watchEnded = Promise.withResolvers<void>();
    watchResponse = undefined;
    createSeen = Promise.withResolvers<void>();
    releaseCreate = Promise.withResolvers<void>();
    await writeFile(tokenFile, expectedToken);
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    vi.useRealTimers();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cert.cleanup();
    await rm(root, { recursive: true, force: true });
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });
  async function accepted(key = 'launch'): Promise<TaskRecord> {
    return registry.accept({
      launchKey: key,
      briefing: 'private-briefing-canary',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    });
  }
  async function admitted(key = 'launch') {
    await accepted(key);
    return (await registry.admitNext())!;
  }
  const launch = (task: TaskRecord): TaskLaunch => ({
    task,
    spaceId: 'space-1',
    workbenchImage: `zot.lifemodel-system.svc:5001/lifemodel/workbench@${task.imageRevision}`,
  });
  function executor() {
    const value = createKubernetesTaskExecutor({
      origin,
      tokenFile,
      caFile,
      requestTimeoutMs: 3000,
    });
    closers.push(() => value.close());
    return value;
  }
  function component(r = registry) {
    const exec = executor();
    const storage = createStorageControlClient({ origin, tokenFile, caFile });
    const result = createTaskLaunchReconciler({
      registry: r,
      executor: exec,
      storage,
      logger: createTestLogger(),
      closeExecutor: () => exec.close(),
      scanJobs: async (signal) =>
        (await exec.listJobs(signal)).map((job) => ({
          name: job.name,
          uid: job.uid,
          launchLabel: job.launchLabel,
          remove: (s: AbortSignal) => exec.deleteJob(job, s),
        })),
    });
    closers.push(result.stop);
    return result;
  }

  it('refuses an unavailable workbench before accepting any row or creating a Job, then launches after import', async () => {
    let ready = false;
    const runtime = component();
    const service = createWorkbenchTaskService({
      service: registry,
      imageRevision: `sha256:${'a'.repeat(64)}`,
      ready: async () => ready,
      onAccepted: () => undefined,
    });
    const input = {
      launchKey: 'readiness-refusal',
      briefing: 'private-briefing-canary',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    };
    await expect(service.accept(input)).rejects.toMatchObject({ code: 'workbench_unavailable' });
    expect(await registry.list()).toEqual([]);
    expect(await runtime.runOnce()).toBe(true);
    expect(creates).toBe(0);
    expect(storageCalls).toBe(0);
    ready = true;
    const task = await service.accept(input);
    expect(await runtime.resync()).toBe(true);
    expect(creates).toBe(1);
    expect(await registry.read(task.id)).toMatchObject({ jobUid: 'job-uid-1' });
  });

  it.each(['drop-create', 'conflict-create'] as const)(
    'GET/adopts one exact Job on %s and replay',
    async (failure) => {
      const task = await admitted();
      mode = failure;
      expect(await component().runOnce()).toBe(true);
      expect(await registry.read(task.id)).toMatchObject({
        jobUid: 'job-uid-1',
        allocationReceipt: { space: 'space-1', effectKey: allocationEffectKey(task) },
      });
      expect(jobs.size).toBe(1);
      expect(creates).toBe(1);
      const createIndex = requests.findIndex(
        (r) => r.method === 'POST' && r.path.endsWith('/jobs')
      );
      expect(requests.slice(createIndex + 1)).toContainEqual(
        expect.objectContaining({ method: 'GET', path: expect.stringContaining(task.jobName) })
      );
      expect(await component().runOnce()).toBe(true);
      expect(creates).toBe(1);
      expect(storageCalls).toBe(1);
    }
  );
  it('returns AlreadyExists without overwriting an existing Job on duplicate CREATE', async () => {
    const task = await admitted('duplicate-create');
    const api = executor();
    await api.ensureStarted(launch(task));
    const original = structuredClone(jobs.get(task.jobName));
    const client = createTaskKubernetesClient({ apiServer: origin, tokenFile, caFile });
    closers.push(client.close);
    const duplicate = renderTaskJob(launch(task));
    duplicate.spec['backoffLimit'] = 99;
    const response = await client.request(
      'POST',
      '/apis/batch/v1/namespaces/lifemodel-motor/jobs',
      duplicate
    );
    expect(response).toMatchObject({
      status: 409,
      body: { kind: 'Status', status: 'Failure', reason: 'AlreadyExists', code: 409 },
    });
    expect(jobs.get(task.jobName)).toEqual(original);
    expect(jobs.size).toBe(1);
    expect(await api.observe(launch(task))).toMatchObject({ jobUid: 'job-uid-1' });
  });
  it.each(['observe', 'deleteNow'] as const)(
    'refuses %s for a same-template replacement of an already-bound Job UID',
    async (operation) => {
      const task = await admitted('bound-uid-replacement');
      expect(await component().runOnce()).toBe(true);
      const boundTask = (await registry.read(task.id))!;
      expect(boundTask.jobUid).toBe('job-uid-1');
      const replacement = structuredClone(jobs.get(task.jobName));
      replacement.metadata.uid = 'replacement-uid';
      replacement.metadata.resourceVersion = '2';
      jobs.set(task.jobName, replacement);
      const api = executor();
      // Only immutable API identity differs: labels, template and hash still match.
      await expect(api[operation](launch(boundTask))).rejects.toMatchObject({
        code: 'identity_mismatch',
      });
      expect(requests.filter((request) => request.method === 'DELETE')).toEqual([]);
      expect(jobs.get(task.jobName)).toEqual(replacement);
      expect((await registry.read(task.id))?.jobUid).toBe('job-uid-1');
    }
  );
  it.each(['hash', 'label'] as const)(
    'fails visibly on existing Job %s mismatch without creating another',
    async (field) => {
      const task = await admitted();
      const api = executor();
      // Seed with a real valid template then alter just the relevant identity.
      allocations.set('seed', {});
      await api.ensureStarted(launch(task));
      const existing = jobs.get(task.jobName);
      if (field === 'hash')
        existing.spec.template.spec.containers[0].image = `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'b'.repeat(64)}`;
      else existing.metadata.labels['lifemodel.dev/launch-id'] = 'wrong-launch';
      await expect(executor().ensureStarted(launch(task))).rejects.toBeInstanceOf(Error);
      expect(await component().runOnce()).toBe(false);
      expect(creates).toBe(1);
      expect(jobs.size).toBe(1);
    }
  );
  it('fences a stale core while current epoch adopts one Job, without stale row writes', async () => {
    const task = await admitted();
    await stores.postgres.query('UPDATE core.active_holder SET epoch=2');
    const fresh = makeRegistry(2);
    const outcomes = await Promise.all([component().runOnce(), component(fresh).runOnce()]);
    expect(outcomes).toEqual([false, true]);
    expect(creates).toBe(1);
    expect(await fresh.read(task.id)).toMatchObject({ jobUid: 'job-uid-1' });
  });
  it('never creates after tombstone, and removes a late unknown labelled Job with exact UID', async () => {
    const task = await admitted();
    await registry.tombstoneLaunch(task.id, task.launchId);
    expect(await component().runOnce()).toBe(true);
    expect(creates).toBe(0);
    const unknown: any = structuredClone(renderTaskJob(launch(task)));
    unknown.metadata.name = 'task-orphan';
    unknown.metadata.uid = 'orphan-uid';
    unknown.metadata.resourceVersion = '4';
    jobs.set('task-orphan', unknown);
    expect(await component().resync()).toBe(true);
    expect(jobs.size).toBe(0);
    expect(creates).toBe(0);
    expect(requests.find((r) => r.method === 'DELETE')?.body.preconditions).toEqual({
      uid: 'orphan-uid',
      resourceVersion: '4',
    });
  });
  it('allocates before create, saves replay receipt, and retries infrastructure failure with same launch', async () => {
    const task = await admitted();
    mode = 'allocation-failure';
    expect(await component().runOnce()).toBe(false);
    expect(creates).toBe(0);
    mode = 'normal';
    expect(await component().resync()).toBe(true);
    expect(storageCalls).toBe(2);
    expect(creates).toBe(1);
    expect(allocationBeforeCreates).toEqual([true]);
    expect(requests.findIndex((r) => r.path === '/allocate')).toBeLessThan(
      requests.findIndex((r) => r.path.endsWith('/jobs') && r.method === 'POST')
    );
    expect(await component().runOnce()).toBe(true);
    expect(storageCalls).toBe(2);
    expect(await registry.list()).toHaveLength(1);
    expect(await registry.read(task.id)).toMatchObject({
      allocationReceipt: allocations.get(allocationEffectKey(task)),
    });
  });
  it('replays storage allocation after crash before receipt write and initializes observed Job clock before binding authority', async () => {
    const task = await admitted();
    const control = createStorageControlClient({ origin, tokenFile, caFile });
    closers.push(control.close);
    const receipt = await control.allocate({
      taskId: task.id,
      launchId: task.launchId,
      effectKey: allocationEffectKey(task),
      retentionRevision: String(task.settingsRevision),
    });
    expect(await component().runOnce()).toBe(true);
    expect(storageCalls).toBe(2);
    expect(allocations.size).toBe(1);
    expect((await registry.read(task.id))?.allocationReceipt).toEqual(receipt);
    jobs.get(task.jobName).status = { startTime: '2026-10-23T12:00:00Z' };
    expect(await component().resync()).toBe(true);
    expect(await registry.readAccessIntent(task.id)).toMatchObject({
      softDueAt: new Date('2026-10-23T12:10:00Z'),
      hardStopAt: new Date('2026-10-23T12:15:00Z'),
    });
    expect((await registry.read(task.id))?.podUid).toBeNull();
  });
  it('adopts through takeover while the old epoch loses its in-flight create response', async () => {
    const task = await admitted('epoch-race');
    raceJobName = task.jobName;
    const current = component();
    const pending = current.runOnce();
    // The test API barrier is the accepted CREATE itself, not elapsed time.
    await createSeen.promise;
    await stores.postgres.query('UPDATE core.active_holder SET epoch=2');
    const fresh = makeRegistry(2);
    expect(await component(fresh).runOnce()).toBe(true);
    releaseCreate.resolve();
    expect(await pending).toBe(false);
    expect(creates).toBe(1);
    expect(jobs.size).toBe(1);
    expect(await fresh.read(task.id)).toMatchObject({ jobUid: 'job-uid-1' });
  });

  it('cleans a CREATE stopped while its response is held, retaining reservation and tombstone', async () => {
    const task = await admitted('stop-create');
    raceJobName = task.jobName;
    const pending = component().runOnce();
    await createSeen.promise;
    await registry.recordSoftStop(task.id, task.launchId);
    releaseCreate.resolve();
    expect(await pending).toBe(false);
    expect(await component().resync()).toBe(true);
    expect(jobs.size).toBe(0);
    expect(await registry.read(task.id)).toMatchObject({
      cleanupPending: true,
      slotReserved: true,
    });
    expect((await registry.read(task.id))?.tombstonedAt).not.toBeNull();
  });
  it('rechecks launchability after saving allocation, before any CREATE', async () => {
    const task = await admitted('stop-after-allocation');
    const stopped = new Proxy(registry, {
      get(target, key) {
        if (key === 'recordAllocation')
          return async (...args: Parameters<TaskRegistry['recordAllocation']>) => {
            const saved = await target.recordAllocation(...args);
            await target.recordSoftStop(task.id, task.launchId);
            return saved;
          };
        return Reflect.get(target, key, target);
      },
    });
    expect(await component(stopped).runOnce()).toBe(true);
    expect(creates).toBe(0);
    expect(storageCalls).toBe(1);
  });
  it('start/resync wakes an idle watch and retries allocation failure with backoff without another event', async () => {
    const api = executor();
    const storage = createStorageControlClient({ origin, tokenFile, caFile });
    const watching = Promise.withResolvers<void>();
    const retried = Promise.withResolvers<void>();
    let watchSignal: AbortSignal | undefined;
    const result = createTaskLaunchReconciler({
      registry,
      executor: api,
      storage: {
        ...storage,
        allocate: async (request, signal) => {
          const receipt = await storage.allocate(request, signal);
          retried.resolve();
          return receipt;
        },
      },
      logger: createTestLogger(),
      retryMs: 1,
      closeExecutor: () => {
        api.close();
      },
      waitForChange: async (signal) => {
        watchSignal = signal;
        watching.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              resolve();
            },
            { once: true }
          );
          if (signal.aborted) resolve();
        });
      },
    });
    closers.push(result.stop);
    result.start();
    await watching.promise;
    await accepted('wake-watch');
    mode = 'allocation-failure';
    expect(await result.resync()).toBe(false);
    expect(watchSignal?.aborted).toBe(true);
    mode = 'normal';
    await retried.promise;
    result.stop();
    expect(storageCalls).toBeGreaterThanOrEqual(2);
  });
  it('uses a bounded wire watch and stop closes it without waiting for a response', async () => {
    const api = executor();
    const controller = new AbortController();
    const pending = api.waitForChange(controller.signal);
    await watchSeen.promise;
    watchResponse!.write(JSON.stringify({ type: 'MODIFIED', object: {} }) + '\n');
    await pending;
    await watchEnded.promise;
    watchSeen = Promise.withResolvers<void>();
    watchEnded = Promise.withResolvers<void>();
    const stopped = api.waitForChange().catch((error: unknown) => error);
    await watchSeen.promise;
    api.close();
    expect(await stopped).toBeInstanceOf(Error);
    await watchEnded.promise;
  });
  it('captures watch LIST before GET so a new Job start cannot be consumed without initializing intent', async () => {
    const task = await admitted('watch-origin');
    expect(await component().runOnce()).toBe(true);
    const api = executor();
    const storage = createStorageControlClient({ origin, tokenFile, caFile });
    const result = createTaskLaunchReconciler({
      registry,
      executor: api,
      storage,
      logger: createTestLogger(),
      scanJobs: async (signal) => {
        const list = await api.listJobs(signal);
        // Mutation happens exactly at the LIST->GET seam, not after a timer.
        jobs.get(task.jobName).status = { startTime: '2026-10-23T12:00:00Z' };
        return list.map((job) => ({
          name: job.name,
          uid: job.uid,
          launchLabel: job.launchLabel,
          remove: (s: AbortSignal) => api.deleteJob(job, s),
        }));
      },
    });
    closers.push(result.stop);
    expect(await result.runOnce()).toBe(true);
    expect(await registry.readAccessIntent(task.id)).not.toBeNull();
  });
  it('renders every native restriction and passes actual A0 CEL; planted policy omissions are refused', async () => {
    const task = await admitted();
    const job: any = renderTaskJob(launch(task));
    expect(evaluateTaskAdmission('Job', job)).toEqual([]);
    expect(job.spec).toMatchObject({
      parallelism: 1,
      completions: 1,
      backoffLimit: 0,
      podReplacementPolicy: 'Failed',
      activeDeadlineSeconds: 900,
    });
    expect(job.spec.template.spec).toMatchObject({
      serviceAccountName: 'task',
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    });
    expect(job.spec.template.spec.volumes.filter((v: any) => v.ephemeral)).toHaveLength(1);
    expect(JSON.stringify(job)).not.toMatch(
      /private-briefing-canary|epoch-one-token|secretKeyRef|ttlSecondsAfterFinished/
    );
    const audiences = job.spec.template.spec.volumes.flatMap(
      (v: any) => v.projected?.sources.map((s: any) => s.serviceAccountToken.audience) ?? []
    );
    expect(audiences.sort()).toEqual([
      'lifemodel-task-channel',
      'lifemodel-task-model',
      'lifemodel-task-storage',
    ]);
    for (const field of ['backoffLimit', 'podFailurePolicy', 'activeDeadlineSeconds']) {
      const mutated: any = structuredClone(job);
      delete mutated.spec[field];
      expect(evaluateTaskAdmission('Job', mutated).length).toBeGreaterThan(0);
    }
    const fourth: any = structuredClone(job);
    fourth.spec.template.spec.volumes
      .find((v: any) => v.projected)
      .projected.sources.push({ serviceAccountToken: { audience: 'api', path: 'fourth' } });
    expect(evaluateTaskAdmission('Job', fourth).length).toBeGreaterThan(0);
  });
  it('rereads rotated bearer token for every call, keeps errors private and stop aborts new dispatch', async () => {
    const task = await admitted();
    const api = executor();
    allocations.set('seed', {});
    await api.ensureStarted(launch(task));
    expectedToken = 'rotated-token';
    await writeFile(tokenFile, expectedToken);
    expect(await api.observe(launch(task))).toMatchObject({ jobUid: 'job-uid-1' });
    const stopped = component();
    stopped.stop();
    expect(await stopped.runOnce()).toBe(false);
  });
  it('accepts legitimate API defaulting and rejects a forged hash annotation over changed spec', async () => {
    const task = await admitted('defaults');
    allocations.set('seed', {});
    const api = executor();
    await api.ensureStarted(launch(task));
    const job = jobs.get(task.jobName);
    job.spec.selector = { matchLabels: { 'batch.kubernetes.io/controller-uid': 'job-uid-1' } };
    Object.assign(job.spec, {
      suspend: false,
      manualSelector: false,
      completionMode: 'NonIndexed',
    });
    Object.assign(job.spec.template.metadata.labels, {
      'batch.kubernetes.io/controller-uid': 'job-uid-1',
      'batch.kubernetes.io/job-name': task.jobName,
    });
    Object.assign(job.spec.template.spec, {
      schedulerName: 'default-scheduler',
      serviceAccount: 'task',
    });
    Object.assign(job.spec.template.spec.containers[0], {
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
    });
    expect(await api.ensureStarted(launch(task))).toMatchObject({ jobUid: 'job-uid-1' });
    job.spec.backoffLimit = 1;
    await expect(api.ensureStarted(launch(task))).rejects.toMatchObject({
      code: 'template_mismatch',
    });
    expect(creates).toBe(1);
  });
  it('uses fractional accepted wrap grace without extending the native hard bound', async () => {
    const task = await admitted('fraction');
    const rendered = renderTaskJob(launch({ ...task, wrapGraceSeconds: 30.5 }));
    expect(rendered.spec['activeDeadlineSeconds']).toBe(630);
  });
  it('validates the image at startup (full repository plus lowercase digest)', () => {
    const image = `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'a'.repeat(64)}`;
    expect(taskWorkbenchImage(image)).toBe(image);
    for (const value of [
      undefined,
      '',
      'image:latest',
      `other@sha256:${'a'.repeat(64)}`,
      `ghcr.io/shady2k/lifemodel-workbench@sha256:${'a'.repeat(64)}`,
      'zot.lifemodel-system.svc:5001/lifemodel/workbench:latest',
      `zot.lifemodel-system.svc:5001/lifemodel/other@sha256:${'a'.repeat(64)}`,
      `other.example:5001/lifemodel/workbench@sha256:${'a'.repeat(64)}`,
      `${image}\n`,
      `${image}\r\n`,
      image.toUpperCase(),
    ])
      expect(() => taskWorkbenchImage(value)).toThrow('TaskExecutorError: invalid_launch');
  });

  describe.each(['kubernetes', 'fake'] as const)(
    'caller contract: %s executor',
    (implementation) => {
      let api: TaskExecutor;
      let task: TaskRecord;
      beforeEach(async () => {
        task = await admitted('contract');
        allocations.set('contract', {});
        api = implementation === 'kubernetes' ? executor() : createFakeTaskExecutor();
      });
      it('ensures and observes one immutable identity on repeated calls, records soft-stop intent, deletes idempotently', async () => {
        const first = await api.ensureStarted(launch(task));
        expect(await api.ensureStarted(launch(task))).toEqual(first);
        expect(await api.observe(launch(task))).toEqual(first);
        expect(await api.requestSoftStop(launch(task))).toMatchObject({
          taskId: task.id,
          launchId: task.launchId,
          intent: 'soft-stop',
        });
        const bound = launch({ ...task, jobUid: first.jobUid });
        expect(await api.confirmTerminated(bound)).toBe(false);
        expect(await api.confirmCleanup(bound)).toBe(false);
        await api.deleteNow(bound);
        await api.deleteNow(bound);
        expect(await api.observe(bound)).toBeNull();
        expect(await api.confirmTerminated(bound)).toBe(true);
        expect(await api.confirmCleanup(bound)).toBe(true);
      });
      it('refuses tombstone or missing already-bound compute rather than inventing replacement', async () => {
        await expect(
          api.ensureStarted(launch({ ...task, tombstonedAt: new Date() }))
        ).rejects.toBeInstanceOf(Error);
        await expect(
          api.ensureStarted(launch({ ...task, jobUid: 'lost-uid' }))
        ).rejects.toBeInstanceOf(Error);
      });
    }
  );
});
