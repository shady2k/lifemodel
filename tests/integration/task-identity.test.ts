import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpsServer, Agent, request, type Server } from 'node:https';
import {
  createServer as createHttpServer,
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import {
  renderTaskJob,
  TASK_TEMPLATE_HASH,
  TASK_LAUNCH_LABEL,
} from '../../src/core/kubernetes-task-executor.js';
import { createTaskKubernetesIdentity } from '../../loader/src/task-kubernetes-identity.js';
import { createTaskKubernetesIdentity as createCoreTaskKubernetesIdentity } from '../../src/core/task-kubernetes-identity.js';
import { createTaskIdentity } from '../../loader/src/task-identity.js';
import { createTaskModelGateway } from '../../loader/src/task-model-gateway.js';
import { createModelGateway } from '../../loader/src/model-gateway-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import type { ModelSlotName, ModelSlot, SlotRead } from '../../loader/src/model.js';

// All authorization below uses migrated, isolated Postgres and real TLS requests.
// Kubernetes and the model provider are simulated only at their HTTP boundaries.
describe('task identity and model listener (real Postgres, TLS Kubernetes)', () => {
  let stores: TestStores;
  let certificate: TestStorageCertificate;
  let directory: string;
  let tokenFile: string;
  let caFile: string;
  let api: Server;
  let origin: string;
  let client: Agent;
  let registry: TaskRegistry;
  let access: ReturnType<typeof createTaskIdentity>;
  let identity: ReturnType<typeof createTaskKubernetesIdentity>;
  let expectedApiToken: string;
  let apiStatus: number;
  let holdReview: (() => Promise<void>) | undefined;
  let reviews: { token: string; audiences: string[] }[];
  let wireErrors: string[];
  let podGets: number;
  let jobGets: number;
  const sockets = new Set<Socket>();
  const clientSockets = new WeakSet<Socket>();
  const cleanup: (() => void | Promise<void>)[] = [];
  const pods = new Map<string, any>();
  const jobs = new Map<string, any>();
  const tokens = new Map<
    string,
    {
      podName: string;
      podUid: string;
      audience?: string;
      username?: string;
      bound?: boolean;
      authenticated?: boolean;
    }
  >();
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/missing-task-identity-settings',
  });
  const MODEL_AUDIENCE = 'lifemodel-task-model';
  const STORAGE_AUDIENCE = 'lifemodel-task-storage';
  const MODULE_TOKEN = 'MODULE-BEARER-PRIVATE-CANARY';
  const MODEL_KEY = 'MODEL-KEY-PRIVATE-CANARY';
  const HARNESS_KEY = 'HARNESS-PLACEHOLDER-PRIVATE-CANARY';
  const PROMPT = 'PROMPT-PRIVATE-CANARY';
  const CALLER = 'SPOOFED-CALLER-PRIVATE-CANARY';

  beforeAll(async () => {
    stores = await createTestStores();
    stores.postgres.on('error', () => undefined);
    stores.postgres.on('connect', (connection) => connection.on('error', () => undefined));
    await applyTestMigrations(stores.postgres);
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-identity-'));
    tokenFile = join(directory, 'token');
    caFile = join(directory, 'ca');
    await writeFile(caFile, certificate.ca);
    client = new Agent({ keepAlive: true, ca: certificate.ca, maxSockets: 32 });
    client.on('error', () => undefined);
    api = createHttpsServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const part of req) chunks.push(Buffer.from(part));
        const path = req.url ?? '';
        const send = (status: number, body: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.headers.authorization !== `Bearer ${expectedApiToken}`) {
          wireErrors.push('wrong API service-account bearer');
          send(401, {});
          return;
        }
        if (apiStatus !== 200) {
          send(apiStatus, {});
          return;
        }
        if (path === '/apis/authentication.k8s.io/v1/tokenreviews') {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const token = String(body.spec?.token);
          const audience = token.startsWith('STORAGE-') ? STORAGE_AUDIENCE : MODEL_AUDIENCE;
          // Compare structurally: JSON object member order is not a wire contract.
          try {
            expect(req.method).toBe('POST');
            expect(body).toEqual({
              apiVersion: 'authentication.k8s.io/v1',
              kind: 'TokenReview',
              spec: { token, audiences: [audience] },
            });
          } catch {
            wireErrors.push('invalid TokenReview body');
            send(400, {});
            return;
          }
          reviews.push({ token, audiences: body.spec.audiences });
          await holdReview?.();
          const bound = tokens.get(token);
          if (!bound) {
            send(200, { status: { authenticated: false } });
            return;
          }
          send(200, {
            status: {
              authenticated: bound.authenticated ?? true,
              audiences: [bound.audience ?? audience],
              user: {
                uid: 'task-service-account-uid',
                username: bound.username ?? 'system:serviceaccount:lifemodel-motor:task',
                extra:
                  bound.bound === false
                    ? {}
                    : {
                        'authentication.kubernetes.io/pod-name': [bound.podName],
                        'authentication.kubernetes.io/pod-uid': [bound.podUid],
                      },
              },
            },
          });
          return;
        }
        if (req.method !== 'GET' || chunks.length) {
          wireErrors.push('invalid resource GET');
          send(400, {});
          return;
        }
        if (path.startsWith('/api/v1/namespaces/lifemodel-motor/pods/')) {
          podGets++;
          const pod = pods.get(decodeURIComponent(path.split('/').at(-1)!));
          send(pod ? 200 : 404, pod ?? {});
          return;
        }
        if (path.startsWith('/apis/batch/v1/namespaces/lifemodel-motor/jobs/')) {
          jobGets++;
          const job = jobs.get(decodeURIComponent(path.split('/').at(-1)!));
          send(job ? 200 : 404, job ?? {});
          return;
        }
        wireErrors.push('unexpected Kubernetes API path');
        send(404, {});
      })().catch(() => {
        wireErrors.push('fake Kubernetes handler failed');
        res.destroy();
      });
    });
    api.on('error', () => undefined);
    api.on('tlsClientError', () => undefined);
    api.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    origin = await listen(api);
  });
  beforeEach(async () => {
    await stores.postgres.query(
      'TRUNCATE task_access.projections, task_access.intents, task_access.start_claims'
    );
    await stores.postgres.query('TRUNCATE core.tasks CASCADE');
    await stores.postgres.query('TRUNCATE storage.spaces CASCADE');
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,1) ON CONFLICT(id) DO UPDATE SET epoch=1'
    );
    registry = createPostgresTaskRegistry({ pool: stores.postgres, epoch: 1, settings });
    pods.clear();
    jobs.clear();
    tokens.clear();
    reviews = [];
    wireErrors = [];
    podGets = 0;
    jobGets = 0;
    apiStatus = 200;
    holdReview = undefined;
    expectedApiToken = MODULE_TOKEN;
    await writeFile(tokenFile, expectedApiToken);
    identity = createTaskKubernetesIdentity({
      apiServer: origin,
      tokenFile,
      caFile,
      timeoutMs: 500,
    });
    access = createTaskIdentity({ connectionString: workerDatabaseUrl(), identity });
    cleanup.push(
      () => identity.close(),
      () => access.close()
    );
  });
  afterEach(async () => {
    holdReview = undefined;
    for (const close of cleanup.splice(0).reverse()) await close();
    expect(wireErrors).toEqual([]);
  });
  afterAll(async () => {
    client?.destroy();
    for (const socket of sockets) socket.destroy();
    if (api) await new Promise<void>((resolve) => api.close(() => resolve()));
    certificate?.cleanup();
    if (directory) await rm(directory, { recursive: true, force: true });
    if (stores) await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });

  async function listen(server: Server): Promise<string> {
    server.on('error', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test listener');
    return `https://localhost:${address.port}`;
  }
  function registerPod(task: TaskRecord, suffix: string) {
    const podName = `${task.jobName}-${suffix}`;
    const podUid = `pod-${suffix}-${task.id}`;
    pods.set(podName, {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: 'lifemodel-motor',
        uid: podUid,
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: task.jobName,
            uid: task.jobUid,
            controller: true,
          },
        ],
      },
      spec: structuredClone(jobs.get(task.jobName).spec.template.spec),
      status: { phase: 'Running' },
    });
    const token = `MODEL-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    const storageToken = `STORAGE-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    tokens.set(token, { podName, podUid });
    tokens.set(storageToken, { podName, podUid });
    return { token, storageToken, podName, podUid };
  }
  async function fixture(key = 'one', initialize = true, startedAt?: Date) {
    let task = await registry.accept({
      launchKey: key,
      briefing: PROMPT,
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    });
    expect((await registry.admitNext())?.id).toBe(task.id);
    const space = `space-${key}`;
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [space]);
    await stores.postgres.query(
      'INSERT INTO storage.allocations(task_id,launch_id,space_id,retention_revision) VALUES($1,$2,$3,$4)',
      [task.id, task.launchId, space, String(task.settingsRevision)]
    );
    task = await registry.recordAllocation(task.id, task.launchId, {
      id: `receipt-${key}`,
      space,
      effectKey: `${task.launchId}:allocate`,
    });
    const job = renderTaskJob({
      task,
      spaceId: space,
      workbenchImage: `zot.lifemodel-system.svc:5001/lifemodel/workbench@${task.imageRevision}`,
    });
    job.metadata.uid = `job-${key}`;
    job.metadata.resourceVersion = '1';
    const clock =
      startedAt ??
      (await stores.postgres.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at;
    job.status = { startTime: clock.toISOString(), active: 1 };
    jobs.set(task.jobName, job);
    task = await registry.bindJob(
      task.id,
      task.launchId,
      job.metadata.uid,
      job.metadata.annotations![TASK_TEMPLATE_HASH] as string
    );
    if (initialize) await registry.initializeAccessIntent(task.id, clock);
    const pod = registerPod(task, key);
    return { task, job, space, startedAt: clock, ...pod };
  }
  const startBody = (task: TaskRecord, bootNonce = randomUUID()) => ({
    taskId: task.id,
    attemptId: task.attemptId,
    launchId: task.launchId,
    bootNonce,
  });
  async function projection(taskId: string) {
    return (
      await stores.postgres.query('SELECT * FROM task_access.projections WHERE task_id=$1', [
        taskId,
      ])
    ).rows;
  }
  async function changeIntent(task: TaskRecord, mode: 'wrapping' | 'revoked', expired = false) {
    const current = (await registry.readAccessIntent(task.id))!;
    const before = new Date(
      (
        await stores.postgres.query<{ at: Date }>(
          "SELECT clock_timestamp()-interval '1 second' AS at"
        )
      ).rows[0]!.at
    );
    return registry.advanceAccessIntent(task.id, {
      mode,
      softDueAt: expired ? before : current.softDueAt,
      hardStopAt: expired ? before : current.hardStopAt,
    });
  }
  async function call(base: string, path: string, headers: Record<string, string>, body?: unknown) {
    return new Promise<{ status: number; body: any; text: string; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        const data = body === undefined ? undefined : JSON.stringify(body);
        const url = new URL(path, base);
        const requestFn = url.protocol === 'https:' ? request : httpRequest;
        const req = requestFn(
          url,
          {
            method: data === undefined ? 'GET' : 'POST',
            agent: url.protocol === 'https:' ? client : false,
            signal: AbortSignal.timeout(10000),
            headers: {
              ...headers,
              ...(data === undefined ? {} : { 'content-type': 'application/json' }),
            },
          },
          (res) => {
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('response aborted')));
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString();
              try {
                resolve({
                  status: res.statusCode!,
                  body: text ? JSON.parse(text) : null,
                  text,
                  headers: res.headers,
                });
              } catch {
                reject(new Error('invalid listener response'));
              }
            });
          }
        );
        req.on('error', reject);
        req.on('socket', (socket) => {
          if (!clientSockets.has(socket)) {
            clientSockets.add(socket);
            socket.on('error', () => undefined);
          }
        });
        req.end(data);
      }
    );
  }
  async function gateway() {
    const attempts: {
      body: Record<string, unknown>;
      headers: IncomingHttpHeaders;
      path: string;
    }[] = [];
    let primaryFailure = false;
    let holdUpstream: (() => Promise<void>) | undefined;
    const logs: RecordedLine[] = [];
    const logger = createRecordingLogger(logs);
    const address = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find(
        (entry) =>
          entry.family === 'IPv4' &&
          !entry.internal &&
          /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(entry.address)
      )?.address;
    if (!address) throw new Error('no private isolated test address');
    const upstream = createHttpServer((req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        attempts.push({ body, headers: req.headers, path: req.url ?? '' });
        await holdUpstream?.();
        if (primaryFailure && req.headers.authorization === `Bearer ${MODEL_KEY}`) {
          res.writeHead(503).end(
            JSON.stringify({
              error: { message: 'Capacity exhausted' },
              private: 'PRIVATE-UPSTREAM-FAILURE-CANARY',
            })
          );
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            req.method === 'GET'
              ? { object: 'list', data: [{ id: 'upstream-model', object: 'model' }] }
              : {
                  id: 'completion',
                  object: 'chat.completion',
                  model: 'upstream-model',
                  choices: [
                    {
                      index: 0,
                      message: { role: 'assistant', content: 'OK' },
                      finish_reason: 'stop',
                    },
                  ],
                }
          )
        );
      })().catch(() => res.destroy());
    });
    upstream.on('error', () => undefined);
    upstream.on('connection', (socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve));
    cleanup.push(async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('no upstream');
    const slots = new Map<ModelSlotName, ModelSlot>(
      ['primary', 'reserve'].map((name) => [
        name as ModelSlotName,
        {
          kind: 'openai',
          baseUrl: `http://${address}:${upstreamAddress.port}/v1`,
          model: `${name}-model`,
          key: name === 'primary' ? MODEL_KEY : 'RESERVE-KEY-PRIVATE-CANARY',
          headers: [{ name: 'x-task-session', value: '{session}' }],
        },
      ])
    );
    const app = createModelGateway({
      logger,
      slots: {
        read: async (name): Promise<SlotRead> => ({
          state: 'present',
          slot: slots.get(name)!,
          version: 1,
        }),
        identity: async () => ({ version: 1 }),
        invalidate: () => undefined,
        keys: () => [...slots.values()].map((slot) => slot.key!),
      },
      timeouts: { connect: 5000, firstByte: 8000, overall: 9000 },
    });
    const authorized = Promise.withResolvers<void>();
    const observedAccess = {
      ...access,
      authorize: async (...args: Parameters<typeof access.authorize>) => {
        const result = await access.authorize(...args);
        authorized.resolve();
        return result;
      },
    };
    const listener = createTaskModelGateway({
      gateway: app,
      access: observedAccess,
      tls: { cert: certificate.cert, key: certificate.key },
      logger,
    });
    const url = await listen(listener.server);
    const httpUrls: string[] = [];
    for (const server of [app.api, app.status]) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no gateway listener');
      httpUrls.push(`http://127.0.0.1:${address.port}`);
      cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
    }
    cleanup.push(async () => {
      await listener.close();
      app.close();
    });
    return {
      url,
      coreModel: () => call(httpUrls[0]!, '/v1/models', {}),
      status: async () => (await call(httpUrls[1]!, '/status', {})).body,
      holdUpstream: (hold: () => Promise<void>) => {
        holdUpstream = hold;
      },
      attempts,
      logs,
      authorized: authorized.promise,
      failPrimary: () => {
        primaryFailure = true;
      },
      start: (task: TaskRecord, token: string, nonce?: string) =>
        call(url, '/task/start', { authorization: `Bearer ${token}` }, startBody(task, nonce)),
      model: (token?: string, extra: Record<string, unknown> = {}) =>
        call(
          url,
          '/v1/chat/completions',
          {
            authorization: `Bearer ${HARNESS_KEY}`,
            'x-lifemodel-session': CALLER,
            ...(token ? { 'x-lifemodel-task-token': token } : {}),
          },
          {
            model: 'default',
            messages: [{ role: 'user', content: PROMPT }],
            user: CALLER,
            session: CALLER,
            taskId: CALLER,
            ...extra,
          }
        ),
    };
  }

  it('binds two task UIDs only to their own launch and allocation with Job-time deadline snapshots', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    await expect(access.start(startBody(b.task), a.token)).rejects.toMatchObject({ status: 403 });
    expect(await projection(b.task.id)).toEqual([]);
    for (const f of [a, b]) {
      const intent = (await registry.readAccessIntent(f.task.id))!;
      expect(await access.start(startBody(f.task), f.token)).toMatchObject({
        start: true,
        taskId: f.task.id,
        attemptId: f.task.attemptId,
        launchId: f.task.launchId,
        space: f.space,
      });
      const rows = await projection(f.task.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        job_uid: f.task.jobUid,
        pod_uid: f.podUid,
        space_id: f.space,
        pod_name: f.podName,
        job_name: f.task.jobName,
        mode: 'active',
        soft_due_at: intent.softDueAt,
        hard_stop_at: intent.hardStopAt,
      });
      expect((await registry.read(f.task.id))?.startedAt).toEqual(f.startedAt);
      expect(await access.authorize(f.token)).toEqual({
        taskId: f.task.id,
        traceId: f.task.traceId,
        parentSpanId: f.task.parentSpanId,
      });
    }
  });

  describe.each([
    ['loader', createTaskKubernetesIdentity],
    ['core', createCoreTaskKubernetesIdentity],
  ] as const)('%s live execution image proof', (_copy, createIdentity) => {
    function verifier() {
      const result = createIdentity({
        apiServer: origin,
        tokenFile,
        caFile,
        timeoutMs: 500,
        audience: 'lifemodel-task-model',
      });
      cleanup.push(() => result.close());
      return result;
    }
    it('accepts the template images with API-defaulted live Pod fields', async () => {
      const f = await fixture();
      const pod = pods.get(f.podName);
      Object.assign(pod.spec, { nodeName: 'scheduled-node', schedulerName: 'default-scheduler' });
      Object.assign(pod.spec.containers[0], {
        imagePullPolicy: 'IfNotPresent',
        terminationMessagePath: '/dev/termination-log',
        terminationMessagePolicy: 'File',
      });
      pod.spec.initContainers = [];
      pod.spec.ephemeralContainers = [];
      await expect(verifier().verify(f.token)).resolves.toMatchObject({ podUid: f.podUid });
    });
    it.each([
      'changed-image',
      'missing-image',
      'missing-containers',
      'empty-containers',
      'renamed-container',
      'extra-container',
      'init-container',
      'ephemeral-container',
    ] as const)('denies %s in the live Pod despite the intact canonical Job', async (fault) => {
      const f = await fixture();
      const pod = pods.get(f.podName);
      const container = pod.spec.containers[0];
      if (fault === 'changed-image')
        container.image = `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'b'.repeat(64)}`;
      if (fault === 'missing-image') delete container.image;
      if (fault === 'missing-containers') delete pod.spec.containers;
      if (fault === 'empty-containers') pod.spec.containers = [];
      if (fault === 'renamed-container') container.name = 'other';
      if (fault === 'extra-container') pod.spec.containers.push({ ...container, name: 'other' });
      if (fault === 'init-container') pod.spec.initContainers = [{ ...container, name: 'init' }];
      if (fault === 'ephemeral-container')
        pod.spec.ephemeralContainers = [{ ...container, name: 'debug' }];
      await expect(verifier().verify(f.token)).rejects.toMatchObject({ status: 403 });
    });
  });

  it('verifies an executor Job after API defaulting, quantity canonicalization and generated ownership fields', async () => {
    const f = await fixture();
    const job = f.job as any;
    Object.assign(job.metadata, {
      generation: 1,
      creationTimestamp: f.startedAt.toISOString(),
      managedFields: [],
    });
    Object.assign(job.spec, {
      selector: { matchLabels: { 'batch.kubernetes.io/controller-uid': f.task.jobUid } },
      suspend: false,
      manualSelector: false,
      completionMode: 'NonIndexed',
    });
    const template = job.spec.template;
    template.metadata.creationTimestamp = null;
    Object.assign(template.metadata.labels, {
      'batch.kubernetes.io/controller-uid': f.task.jobUid,
      'controller-uid': f.task.jobUid,
      'batch.kubernetes.io/job-name': f.task.jobName,
      'job-name': f.task.jobName,
    });
    Object.assign(template.spec, {
      schedulerName: 'default-scheduler',
      serviceAccount: 'task',
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      preemptionPolicy: 'PreemptLowerPriority',
      priority: 0,
    });
    const container = template.spec.containers[0];
    Object.assign(container, {
      terminationMessagePath: '/dev/termination-log',
      terminationMessagePolicy: 'File',
      resources: {
        requests: { cpu: '0.5', memory: '512Mi' },
        limits: { cpu: '0.5', memory: '512Mi' },
      },
    });
    const claim = template.spec.volumes.find((v: any) => v.ephemeral).ephemeral.volumeClaimTemplate;
    claim.metadata = { creationTimestamp: null };
    claim.spec.volumeMode = 'Filesystem';
    claim.spec.resources.requests.storage = '10Gi';
    expect(await access.start(startBody(f.task), f.token)).toMatchObject({ start: true });
    expect(await access.authorize(f.token)).toEqual({
      taskId: f.task.id,
      traceId: f.task.traceId,
      parentSpanId: f.task.parentSpanId,
    });
    expect((await projection(f.task.id))[0]).toMatchObject({
      job_uid: f.task.jobUid,
      pod_uid: f.podUid,
    });
    // Generated ownership is ignored by hashing only after identity validation.
    template.metadata.labels['batch.kubernetes.io/controller-uid'] = 'foreign-job';
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    'audience',
    'service-account',
    'sa-only',
    'unauthenticated',
    'owner',
    'pod-deleting',
    'job-deleting',
    'pod-uid',
    'job-uid',
    'launch-label',
    'hash-annotation',
    'actual-template',
    'job-start-time',
  ] as const)('refuses %s before any claim or projection', async (fault) => {
    const f = await fixture();
    const review = tokens.get(f.token)!;
    const pod = pods.get(f.podName);
    if (fault === 'audience') review.audience = STORAGE_AUDIENCE;
    if (fault === 'service-account')
      review.username = 'system:serviceaccount:lifemodel-motor:other';
    if (fault === 'sa-only') review.bound = false;
    if (fault === 'unauthenticated') review.authenticated = false;
    if (fault === 'owner') pod.metadata.ownerReferences[0].uid = 'wrong-controller';
    if (fault === 'pod-deleting') pod.metadata.deletionTimestamp = new Date().toISOString();
    if (fault === 'job-deleting') f.job.metadata.deletionTimestamp = new Date().toISOString();
    if (fault === 'pod-uid') pod.metadata.uid = 'wrong-pod-uid';
    if (fault === 'job-uid') {
      f.job.metadata.uid = 'replacement-job';
      pod.metadata.ownerReferences[0].uid = 'replacement-job';
    }
    if (fault === 'launch-label') f.job.metadata.labels![TASK_LAUNCH_LABEL] = 'a'.repeat(58);
    if (fault === 'hash-annotation')
      f.job.metadata.annotations![TASK_TEMPLATE_HASH] = 'b'.repeat(64);
    if (fault === 'actual-template')
      (f.job.spec['template'] as any).spec.containers[0].image =
        `zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:${'b'.repeat(64)}`;
    if (fault === 'job-start-time')
      f.job.status!.startTime = new Date(f.startedAt.getTime() + 1000).toISOString();
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
    expect(await projection(f.task.id)).toEqual([]);
    expect((await registry.read(f.task.id))?.podUid).toBeNull();
  });

  it('denies a missing canonical intent rather than inventing one from the live Job', async () => {
    const f = await fixture('missing', false);
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
    expect(await projection(f.task.id)).toEqual([]);
    expect(await registry.readAccessIntent(f.task.id)).toBeNull();
  });
  it.each(['taskId', 'attemptId', 'launchId'] as const)(
    'does not trust caller-supplied %s',
    async (field) => {
      const a = await fixture('a');
      const b = await fixture('b');
      const input = startBody(a.task);
      input[field] = field === 'taskId' ? b.task.id : b.task[field];
      await expect(access.start(input, a.token)).rejects.toMatchObject({ status: 403 });
      expect(await projection(a.task.id)).toEqual([]);
      expect(await projection(b.task.id)).toEqual([]);
    }
  );
  it('atomically admits exactly one candidate Pod; repeats, replacement and fresh process nonce stay inert across restart', async () => {
    const f = await fixture();
    const replacement = registerPod(f.task, 'replacement');
    const first = startBody(f.task);
    const second = startBody(f.task);
    const candidates = [
      { input: first, token: f.token, podUid: f.podUid },
      { input: second, token: replacement.token, podUid: replacement.podUid },
    ];
    const results = await Promise.allSettled(
      candidates.map((candidate) => access.start(candidate.input, candidate.token))
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = candidates[results.findIndex((result) => result.status === 'fulfilled')]!;
    expect((await projection(f.task.id))[0].pod_uid).toBe(winner.podUid);
    // The committed ACK is deliberately discarded: a restarted launcher cannot
    // distinguish a lost reply from a consumed permit and must remain inert.
    const restarted = createTaskIdentity({ connectionString: workerDatabaseUrl(), identity });
    cleanup.push(() => restarted.close());
    await expect(restarted.start(winner.input, winner.token)).rejects.toMatchObject({
      status: 409,
      code: 'start_consumed',
    });
    await expect(restarted.start(startBody(f.task), winner.token)).rejects.toMatchObject({
      status: 409,
      code: 'start_consumed',
    });
    const loser = candidates.find((candidate) => candidate !== winner)!;
    await expect(restarted.start(startBody(f.task), loser.token)).rejects.toMatchObject({
      status: expect.any(Number),
    });
    await expect(restarted.authorize(loser.token)).rejects.toMatchObject({ status: 403 });
    expect(await restarted.authorize(winner.token)).toEqual({
      taskId: f.task.id,
      traceId: f.task.traceId,
      parentSpanId: f.task.parentSpanId,
    });
  });
  it('rolls the once-only claim back when writing its projection fails, then grants the same launch once after repair', async () => {
    const f = await fixture();
    const intent = (await registry.readAccessIntent(f.task.id))!;
    await stores.postgres.query(
      `INSERT INTO task_access.projections
      (task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at)
      VALUES('conflicting-task','conflicting-attempt','conflicting-launch','conflicting-job','conflicting-pod',
      'conflicting-pod','conflicting-job',$1,0,0,'active',$2,$3)`,
      [f.space, intent.softDueAt, intent.hardStopAt]
    );
    const input = startBody(f.task);
    await expect(access.start(input, f.token)).rejects.toMatchObject({ status: 503 });
    expect(
      (
        await stores.postgres.query('SELECT 1 FROM task_access.start_claims WHERE launch_id=$1', [
          f.task.launchId,
        ])
      ).rows
    ).toEqual([]);
    await stores.postgres.query(
      "DELETE FROM task_access.projections WHERE task_id='conflicting-task'"
    );
    expect(await access.start(input, f.token)).toMatchObject({ start: true });
    await expect(access.start(input, f.token)).rejects.toMatchObject({
      status: 409,
      code: 'start_consumed',
    });
  });
  it('rechecks TokenReview, Pod and Job on every call, including revoked tokens and deleting resources', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    for (let index = 0; index < 3; index++)
      expect(await access.authorize(f.token)).toEqual({
        taskId: f.task.id,
        traceId: f.task.traceId,
        parentSpanId: f.task.parentSpanId,
      });
    expect(reviews).toHaveLength(4);
    expect(podGets).toBe(4);
    expect(jobGets).toBe(4);
    tokens.get(f.token)!.authenticated = false;
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    tokens.get(f.token)!.authenticated = true;
    pods.get(f.podName).metadata.deletionTimestamp = new Date().toISOString();
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    delete pods.get(f.podName).metadata.deletionTimestamp;
    f.job.metadata.deletionTimestamp = new Date().toISOString();
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
  });
  it('rotates both task and gateway service-account tokens without a cached positive proof', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    const rotated = `MODEL-ROTATED-PRIVATE-CANARY-${f.task.id}`;
    tokens.set(rotated, { ...tokens.get(f.token)! });
    tokens.delete(f.token);
    expectedApiToken = 'MODULE-ROTATED-PRIVATE-CANARY';
    await writeFile(tokenFile, expectedApiToken);
    expect(await access.authorize(rotated)).toEqual({
      taskId: f.task.id,
      traceId: f.task.traceId,
      parentSpanId: f.task.parentSpanId,
    });
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    expect(reviews.map((review) => review.token)).toEqual([f.token, rotated, f.token]);
  });
  it('requires a won start claim for model access and refuses starts in wrapping mode', async () => {
    const f = await fixture();
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    await changeIntent(f.task, 'wrapping');
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
    expect(await projection(f.task.id)).toEqual([]);
  });
  it('uses canonical intent over a lagging active projection, permits wrapping, then denies revoke immediately', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    await changeIntent(f.task, 'wrapping');
    expect((await projection(f.task.id))[0].mode).toBe('active');
    expect(await access.authorize(f.token)).toEqual({
      taskId: f.task.id,
      traceId: f.task.traceId,
      parentSpanId: f.task.parentSpanId,
    });
    await changeIntent(f.task, 'revoked');
    expect((await projection(f.task.id))[0].mode).toBe('active');
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
  });
  it('does not authorize when canonical intent is removed after the binding was written', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    await stores.postgres.query('DELETE FROM task_access.intents WHERE task_id=$1', [f.task.id]);
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
  });
  it('denies shortened hard deadlines at database time even when the projection remains active and unexpired', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    await changeIntent(f.task, 'wrapping', true);
    expect((await projection(f.task.id))[0].hard_stop_at.getTime()).toBeGreaterThan(Date.now());
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 403 });
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
  });
  it('evaluates the database deadline after a canonical-intent lock wait, not at request or transaction start', async () => {
    const f = await fixture();
    await access.start(startBody(f.task), f.token);
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT 1 FROM task_access.intents WHERE task_id=$1 FOR UPDATE', [
      f.task.id,
    ]);
    const pending = access.authorize(f.token).catch((error: unknown) => error);
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await stores.postgres.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='lifemodel-task-identity' AND wait_event_type='Lock'`)
            ).rows[0].n
          )
        )
        .toBe(1);
      await locker.query(
        `UPDATE task_access.intents SET revision=revision+1,
        soft_due_at=clock_timestamp()-interval '1 second',hard_stop_at=clock_timestamp()-interval '1 second' WHERE task_id=$1`,
        [f.task.id]
      );
      await locker.query('COMMIT');
      expect(await pending).toMatchObject({ status: 403 });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pending;
    }
  });
  it('rechecks database time after waiting for the allocation space lock before consuming the claim', async () => {
    const f = await fixture();
    const deadline = (
      await stores.postgres.query<{ at: Date }>(
        "SELECT clock_timestamp()+interval '2 seconds' AS at"
      )
    ).rows[0]!.at;
    await registry.advanceAccessIntent(f.task.id, {
      mode: 'active',
      softDueAt: deadline,
      hardStopAt: deadline,
    });
    const locker = await stores.postgres.connect();
    await locker.query('BEGIN');
    await locker.query('SELECT id FROM storage.spaces WHERE id=$1 FOR UPDATE', [f.space]);
    const pending = access.start(startBody(f.task), f.token).catch((error: unknown) => error);
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await stores.postgres.query(`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname=current_database() AND application_name='lifemodel-task-identity'
        AND wait_event_type='Lock' AND query LIKE '%FROM storage.allocations%'`)
            ).rows[0].n
          )
        )
        .toBe(1);
      // Wait on the fact under test: the database clock crossed the deadline.
      await expect
        .poll(
          async () =>
            (
              await stores.postgres.query<{ expired: boolean }>(
                'SELECT clock_timestamp()>=$1::timestamptz AS expired',
                [deadline]
              )
            ).rows[0]!.expired,
          { timeout: 4000 }
        )
        .toBe(true);
      await locker.query('COMMIT');
      expect(await pending).toMatchObject({ status: 403 });
      expect(await projection(f.task.id)).toEqual([]);
      expect(
        (
          await stores.postgres.query('SELECT 1 FROM task_access.start_claims WHERE launch_id=$1', [
            f.task.launchId,
          ])
        ).rows
      ).toEqual([]);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pending;
    }
  }, 10000);
  it('refuses an already-expired Job without extending its original start or deadlines to handshake time', async () => {
    const clock = (
      await stores.postgres.query<{ at: Date }>("SELECT clock_timestamp()-interval '2 hours' AS at")
    ).rows[0]!.at;
    const f = await fixture('expired', true, clock);
    const original = await registry.readAccessIntent(f.task.id);
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 403 });
    expect(await registry.readAccessIntent(f.task.id)).toEqual(original);
    expect(await projection(f.task.id)).toEqual([]);
  });
  it('rechecks canonical revoke after a delayed Kubernetes reply, before consuming a start', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    holdReview = async () => {
      entered.resolve();
      await release.promise;
    };
    const pending = access.start(startBody(f.task), f.token).catch((error: unknown) => error);
    try {
      await entered.promise;
      await changeIntent(f.task, 'revoked');
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ status: 403 });
    expect(await projection(f.task.id)).toEqual([]);
  });
  it('fails closed on Kubernetes outage and on SQL outage without consuming a claim', async () => {
    const f = await fixture();
    apiStatus = 503;
    await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 503 });
    expect(await projection(f.task.id)).toEqual([]);
    apiStatus = 200;
    const unavailableUrl = new URL(workerDatabaseUrl());
    unavailableUrl.hostname = '127.0.0.1';
    unavailableUrl.port = '1';
    const unavailable = createTaskIdentity({
      connectionString: unavailableUrl.toString(),
      identity,
    });
    cleanup.push(() => unavailable.close());
    await expect(unavailable.start(startBody(f.task), f.token)).rejects.toMatchObject({
      status: 503,
    });
    expect(await projection(f.task.id)).toEqual([]);
    await access.start(startBody(f.task), f.token);
    apiStatus = 503;
    await expect(access.authorize(f.token)).rejects.toMatchObject({ status: 503 });
    apiStatus = 200;
    await expect(unavailable.authorize(f.token)).rejects.toMatchObject({ status: 503 });
  });
  it('bounds a hung Kubernetes API and respects caller abort without granting a fallback start', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    holdReview = async () => {
      entered.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const aborted = access
      .start(startBody(f.task), f.token, controller.signal)
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort();
      expect(await aborted).toMatchObject({ status: expect.any(Number) });
      await expect(access.start(startBody(f.task), f.token)).rejects.toMatchObject({ status: 503 });
      expect(await projection(f.task.id)).toEqual([]);
    } finally {
      release.resolve();
    }
  });
  it('writes a projection the storage module independently reads for exactly the verified task and space', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    await access.start(startBody(a.task), a.token);
    await access.start(startBody(b.task), b.token);
    const storageIdentity = createKubernetesStorageIdentity({
      apiServer: origin,
      tokenFile,
      caFile,
      timeoutMs: 500,
    });
    const storage = createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: storageIdentity,
    });
    cleanup.push(
      () => storageIdentity.close(),
      () => storage.close()
    );
    await storageIdentity.verifyBinding({
      podName: a.podName,
      podUid: a.podUid,
      jobName: a.task.jobName,
      jobUid: a.task.jobUid!,
    });
    const own = storage.openTaskStream({ token: a.storageToken, space: a.space });
    const other = storage.openTaskStream({ token: a.storageToken, space: b.space });
    const dispatched: string[] = [];
    try {
      await own.chunk(1, (decision) => {
        dispatched.push(decision.space);
      });
      await expect(other.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
      expect(dispatched).toEqual([a.space]);
      await changeIntent(a.task, 'revoked');
      await expect(own.chunk(1, () => undefined)).rejects.toMatchObject({ status: 403 });
    } finally {
      await own.close();
      await other.close();
    }
  });
  it('serves TLS start once and models only with the dedicated task token; never forwards caller identity or keys', async () => {
    const f = await fixture();
    const g = await gateway();
    expect((await g.model(f.token)).status).toBe(403);
    const nonce = randomUUID();
    const ack = await g.start(f.task, f.token, nonce);
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ start: true, taskId: f.task.id, space: f.space });
    const replay = await g.start(f.task, f.token, nonce);
    expect(replay.status).toBe(409);
    expect(replay.text).toContain('start_consumed');
    expect((await g.model()).status).toBe(403);
    const response = await g.model(f.token);
    expect(response.status).toBe(200);
    expect(g.attempts).toHaveLength(1);
    expect(g.attempts[0]!.body.user).toBe(f.task.id);
    expect(g.attempts[0]!.headers['x-task-session']).toBe(f.task.id);
    expect(g.attempts[0]!.headers.authorization).toBe(`Bearer ${MODEL_KEY}`);
    const forwarded = JSON.stringify(g.attempts[0]);
    for (const value of [CALLER, HARNESS_KEY, f.token, MODULE_TOKEN])
      expect(forwarded).not.toContain(value);
    const models = await call(g.url, '/v1/models', {
      authorization: `Bearer ${HARNESS_KEY}`,
      'x-lifemodel-task-token': f.token,
    });
    expect(models.status).toBe(200);
    expect(models.body.data[0].id).toBe('upstream-model');
    expect(g.attempts[1]!.headers['x-task-session']).toBe(f.task.id);
    for (const value of [MODEL_KEY, HARNESS_KEY, f.token, MODULE_TOKEN, PROMPT, CALLER]) {
      expect(JSON.stringify(g.logs)).not.toContain(value);
      expect(response.text).not.toContain(value);
      expect(ack.text).not.toContain(value);
    }
  });
  it.each([
    ['task', false],
    ['another-harness-model', false],
    ['task', true],
    ['another-harness-model', true],
  ] as const)(
    'uses the configured slot model for task model %s (primary failure: %s)',
    async (model, failPrimary) => {
      const f = await fixture();
      const g = await gateway();
      expect((await g.start(f.task, f.token)).status).toBe(200);
      if (failPrimary) g.failPrimary();
      const response = await g.model(f.token, { model });
      expect(response.status).toBe(200);
      expect(g.attempts.map((attempt) => attempt.body.model)).toEqual(
        failPrimary ? ['primary-model', 'reserve-model'] : ['primary-model']
      );
      for (const attempt of g.attempts) {
        expect(attempt.body.user).toBe(f.task.id);
        expect(attempt.headers['x-task-session']).toBe(f.task.id);
      }
      if (failPrimary) {
        expect(g.logs).toContainEqual({
          level: 'warn',
          message: 'Model gateway upstream failed',
          fields: {
            code: 'upstream_503',
            status: 503,
            modelRoute: 'primary',
            slot: 'primary',
            reason: undefined,
            errorExcerpt: 'Capacity exhausted',
            taskId: f.task.id,
            traceId: f.task.traceId,
          },
        });
        expect(JSON.stringify(g.logs)).not.toContain('CANARY');
      }
    }
  );
  it.each([undefined, '', 42])(
    'rejects invalid task model %s before slot selection',
    async (model) => {
      const f = await fixture();
      const g = await gateway();
      expect((await g.start(f.task, f.token)).status).toBe(200);
      const response = await g.model(f.token, { model });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: { type: 'gateway_error', code: 'invalid_request' } });
      expect(g.attempts).toEqual([]);
      expect(g.logs).toContainEqual({
        level: 'warn',
        message: 'Task model gateway request refused',
        fields: {
          code: 'invalid_request',
          status: 400,
          modelRoute: 'primary',
          taskId: f.task.id,
          traceId: f.task.traceId,
        },
      });
    }
  );
  it.each(['revoke', 'deadline'] as const)(
    'rechecks %s after a model body held across the initial authorization',
    async (change) => {
      const f = await fixture();
      const g = await gateway();
      expect((await g.start(f.task, f.token)).status).toBe(200);
      expect((await g.coreModel()).status).toBe(200);
      const before = await g.status();
      expect(before.state).toBe('ok');
      const attemptsBefore = [...g.attempts];
      const payload = JSON.stringify({
        model: 'default',
        messages: [{ role: 'user', content: PROMPT }],
      });
      let finish: (() => void) | undefined;
      const response = new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(
          new URL('/v1/chat/completions', g.url),
          {
            method: 'POST',
            agent: client,
            signal: AbortSignal.timeout(5000),
            headers: {
              authorization: `Bearer ${HARNESS_KEY}`,
              'x-lifemodel-task-token': f.token,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('held-body response aborted')));
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
              resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString() })
            );
          }
        );
        req.on('error', reject);
        req.on('socket', (socket) => {
          if (!clientSockets.has(socket)) {
            clientSockets.add(socket);
            socket.on('error', () => undefined);
          }
        });
        finish = () => {
          req.end(payload.slice(-1));
        };
        req.write(payload.slice(0, -1));
      });
      void response.catch(() => undefined);
      try {
        await g.authorized;
        await changeIntent(
          f.task,
          change === 'revoke' ? 'revoked' : 'wrapping',
          change === 'deadline'
        );
      } finally {
        finish?.();
      }
      const refused = await response;
      expect(refused.status).toBe(403);
      expect(g.attempts).toEqual(attemptsBefore);
      expect(await g.status()).toEqual(before);
      for (const secret of [MODEL_KEY, HARNESS_KEY, MODULE_TOKEN, f.token, PROMPT]) {
        expect(refused.text).not.toContain(secret);
        expect(JSON.stringify(g.logs)).not.toContain(secret);
      }
    }
  );
  it.each(['revoke', 'deadline'] as const)(
    'rechecks %s after the shared HTTP agent queues a task behind 16 core requests',
    async (change) => {
      const f = await fixture();
      const g = await gateway();
      expect((await g.start(f.task, f.token)).status).toBe(200);
      const full = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      g.holdUpstream(async () => {
        if (g.attempts.length === 16) full.resolve();
        await release.promise;
      });
      const core = Array.from({ length: 16 }, () => g.coreModel());
      void Promise.all(core).catch(() => undefined);
      await full.promise;
      const queued = Promise.withResolvers<void>();
      const addRequest = HttpAgent.prototype.addRequest;
      const spy = vi.spyOn(HttpAgent.prototype, 'addRequest').mockImplementation(function (
        ...args
      ) {
        Reflect.apply(addRequest, this, args);
        if (Object.values(this.requests).flat().includes(args[0])) queued.resolve();
      });
      let taskRequest: ReturnType<typeof g.model> | undefined;
      try {
        let deadline: Date | undefined;
        if (change === 'deadline') {
          deadline = (
            await stores.postgres.query<{ at: Date }>(
              "SELECT clock_timestamp()+interval '2 seconds' AS at"
            )
          ).rows[0]!.at;
          await registry.advanceAccessIntent(f.task.id, {
            mode: 'active',
            softDueAt: deadline,
            hardStopAt: deadline,
          });
        }
        taskRequest = g.model(f.token);
        void taskRequest.catch(() => undefined);
        await queued.promise; // Real Agent.addRequest pending queue, not a timer or inferred tick.
        expect(g.attempts).toHaveLength(16);
        if (change === 'revoke') await changeIntent(f.task, 'revoked');
        else
          await expect
            .poll(
              async () =>
                (
                  await stores.postgres.query<{ expired: boolean }>(
                    'SELECT clock_timestamp()>=$1::timestamptz AS expired',
                    [deadline]
                  )
                ).rows[0]!.expired,
              { timeout: 4000 }
            )
            .toBe(true);
        release.resolve();
        expect((await taskRequest).status).toBe(403);
        expect((await Promise.all(core)).map((response) => response.status)).toEqual(
          Array(16).fill(200)
        );
        expect(g.attempts).toHaveLength(16);
      } finally {
        release.resolve();
        spy.mockRestore();
        await Promise.allSettled([...core, ...(taskRequest ? [taskRequest] : [])]);
      }
    },
    15000
  );

  it('keeps two model callers isolated, rotates the task token and refuses both routes immediately after canonical revoke', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    const g = await gateway();
    expect((await g.start(a.task, a.token)).status).toBe(200);
    expect((await g.start(b.task, b.token)).status).toBe(200);
    expect(
      (await g.model(a.token, { taskId: b.task.id, user: b.task.id, session: b.task.id })).status
    ).toBe(200);
    expect(g.attempts.at(-1)!.body.user).toBe(a.task.id);
    expect(g.attempts.at(-1)!.headers['x-task-session']).toBe(a.task.id);
    expect((await g.model(b.token, { taskId: a.task.id, user: a.task.id })).status).toBe(200);
    expect(g.attempts.at(-1)!.body.user).toBe(b.task.id);
    const rotated = `MODEL-ROTATED-PRIVATE-CANARY-${a.task.id}`;
    tokens.set(rotated, { ...tokens.get(a.token)! });
    tokens.delete(a.token);
    expect((await g.model(rotated)).status).toBe(200);
    expect((await g.model(a.token)).status).toBe(403);
    await changeIntent(a.task, 'revoked');
    const count = g.attempts.length;
    expect((await g.model(rotated)).status).toBe(403);
    expect((await g.start(a.task, rotated)).status).toBe(403);
    expect((await call(g.url, '/v1/models', { 'x-lifemodel-task-token': rotated })).status).toBe(
      403
    );
    expect(g.attempts).toHaveLength(count);
    expect((await g.model(b.token)).status).toBe(200);
  });
  it('uses existing primary/reserve failover and fails closed at the task listener on API outage', async () => {
    const f = await fixture();
    const g = await gateway();
    expect((await g.start(f.task, f.token)).status).toBe(200);
    g.failPrimary();
    const response = await g.model(f.token);
    expect(response.status).toBe(200);
    expect(response.headers['x-lifemodel-slot']).toBe('reserve');
    expect(g.attempts).toHaveLength(2);
    expect(g.attempts.map((attempt) => attempt.headers['x-task-session'])).toEqual([
      f.task.id,
      f.task.id,
    ]);
    apiStatus = 503;
    expect((await g.model(f.token)).status).toBe(503);
    expect(g.attempts).toHaveLength(2);
    for (const secret of [
      MODEL_KEY,
      'RESERVE-KEY-PRIVATE-CANARY',
      'PRIVATE-UPSTREAM-FAILURE-CANARY',
      f.token,
      PROMPT,
    ])
      expect(JSON.stringify(g.logs)).not.toContain(secret);
  });
});
