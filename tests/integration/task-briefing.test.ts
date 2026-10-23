import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createServer, request, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createTestLogger, recordingLogger, type RecordedLog } from '../helpers/test-logger.js';
import {
  createPlatformSettingsReader,
  type PlatformSettingsValues,
} from '../../src/config/platform-settings.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPostgresTaskMailbox } from '../../src/storage/postgres-task-mailbox.js';
import { createTaskChannel } from '../../src/core/task-channel.js';
import { createTaskKubernetesIdentity } from '../../src/core/task-kubernetes-identity.js';
import { createTaskKubernetesIdentity as createModelIdentity } from '../../loader/src/task-kubernetes-identity.js';
import { createTaskIdentity } from '../../loader/src/task-identity.js';
import { renderTaskJob, TASK_TEMPLATE_HASH } from '../../src/core/kubernetes-task-executor.js';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import type { TaskMailbox } from '../../src/ports/task-channel.js';

describe('task launcher identity and briefing (real stores and live TLS identity)', () => {
  let stores: TestStores;
  let certificate: TestStorageCertificate;
  let directory: string;
  let tokenFile: string;
  let caFile: string;
  let api: Server;
  let origin: string;
  let client: Agent;
  let registry: TaskRegistry;
  let mailbox: TaskMailbox;
  let identity: ReturnType<typeof createTaskKubernetesIdentity>;
  let access: ReturnType<typeof createTaskIdentity>;
  let apiStatus: number;
  let values: PlatformSettingsValues;
  let reviews: string[][];
  let wireErrors: string[];
  let logs: RecordedLog[];
  const sockets = new Set<Socket>();
  const clientSockets = new WeakSet<Socket>();
  const cleanup: (() => void | Promise<void>)[] = [];
  const pods = new Map<string, any>();
  const jobs = new Map<string, any>();
  const tokens = new Map<
    string,
    { podName: string; podUid: string; audience?: string; bound?: boolean; authenticated?: boolean }
  >();
  const MODULE_TOKEN = 'TASK-CHANNEL-MODULE-TOKEN-PRIVATE-CANARY';
  const PAYLOAD = 'TASK-CHANNEL-PAYLOAD-PRIVATE-CANARY';
  const URL_CANARY = 'TASK-BRIEFING-URL-PRIVATE-CANARY';
  const AUDIENCE = 'lifemodel-task-channel';
  const settings = createPlatformSettingsReader({
    logger: createTestLogger(),
    dir: '/missing-channel-settings',
  });

  beforeAll(async () => {
    stores = await createTestStores();
    stores.postgres.on('error', () => undefined);
    stores.postgres.on('connect', (connection) => connection.on('error', () => undefined));
    stores.redis.on('error', () => undefined);
    await applyTestMigrations(stores.postgres);
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-channel-'));
    tokenFile = join(directory, 'token');
    caFile = join(directory, 'ca');
    await writeFile(tokenFile, MODULE_TOKEN);
    await writeFile(caFile, certificate.ca);
    client = new Agent({ keepAlive: true, ca: certificate.ca, maxSockets: 32 });
    client.on('error', () => undefined);
    api = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const send = (status: number, body: unknown) =>
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
        if (req.headers.authorization !== `Bearer ${MODULE_TOKEN}`) {
          wireErrors.push('invalid Kubernetes bearer');
          send(401, {});
          return;
        }
        if (apiStatus !== 200) {
          send(apiStatus, {});
          return;
        }
        const path = req.url ?? '';
        if (path === '/apis/authentication.k8s.io/v1/tokenreviews') {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          const token = String(body.spec?.token);
          const expected = token.startsWith('MODEL-') ? 'lifemodel-task-model' : AUDIENCE;
          if (
            req.method !== 'POST' ||
            JSON.stringify(body.spec?.audiences) !== JSON.stringify([expected])
          ) {
            wireErrors.push('invalid TokenReview audience');
            send(400, {});
            return;
          }
          reviews.push(body.spec.audiences);
          const bound = tokens.get(token);
          send(200, {
            status: bound
              ? {
                  authenticated: bound.authenticated ?? true,
                  audiences: [bound.audience ?? expected],
                  user: {
                    uid: 'task-sa-uid',
                    username: 'system:serviceaccount:lifemodel-motor:task',
                    extra:
                      bound.bound === false
                        ? {}
                        : {
                            'authentication.kubernetes.io/pod-name': [bound.podName],
                            'authentication.kubernetes.io/pod-uid': [bound.podUid],
                          },
                  },
                }
              : { authenticated: false },
          });
          return;
        }
        if (req.method !== 'GET' || chunks.length) {
          wireErrors.push('invalid resource GET');
          send(400, {});
          return;
        }
        if (path.startsWith('/api/v1/namespaces/lifemodel-motor/pods/')) {
          const pod = pods.get(decodeURIComponent(path.split('/').at(-1)!));
          send(pod ? 200 : 404, pod ?? {});
          return;
        }
        if (path.startsWith('/apis/batch/v1/namespaces/lifemodel-motor/jobs/')) {
          const job = jobs.get(decodeURIComponent(path.split('/').at(-1)!));
          send(job ? 200 : 404, job ?? {});
          return;
        }
        wireErrors.push('unexpected Kubernetes path');
        send(404, {});
      })().catch(() => {
        wireErrors.push('Kubernetes handler failed');
        res.destroy();
      });
    });
    api.on('error', () => undefined);
    api.on('tlsClientError', () => undefined);
    api.on('connection', (socket) => {
      socket.on('error', () => undefined);
      sockets.add(socket);
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
    mailbox = createPostgresTaskMailbox({
      pool: stores.postgres,
      epoch: 1,
      operationTimeoutMs: 1000,
    });
    values = { ...(await settings.read()).values };
    pods.clear();
    jobs.clear();
    tokens.clear();
    reviews = [];
    wireErrors = [];
    logs = [];
    apiStatus = 200;
    identity = createTaskKubernetesIdentity({
      apiServer: origin,
      tokenFile,
      caFile,
      timeoutMs: 500,
    });
    const modelIdentity = createModelIdentity({
      apiServer: origin,
      tokenFile,
      caFile,
      timeoutMs: 500,
    });
    access = createTaskIdentity({ connectionString: workerDatabaseUrl(), identity: modelIdentity });
    cleanup.push(
      () => mailbox.stop(),
      () => identity.close(),
      () => modelIdentity.close(),
      () => access.close()
    );
  });
  afterEach(async () => {
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

  async function listen(server: Server) {
    server.on('error', () => undefined);
    server.on('tlsClientError', () => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('listener address missing');
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
      spec: { serviceAccountName: 'task' },
      status: { phase: 'Running' },
    });
    const token = `CHANNEL-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    const modelToken = `MODEL-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    tokens.set(token, { podName, podUid });
    tokens.set(modelToken, { podName, podUid });
    return { token, modelToken, podName, podUid };
  }
  async function fixture(key = 'one', started = true, briefing = PAYLOAD) {
    let task = await registry.accept({
      launchKey: key,
      briefing,
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
      workbenchImage: `ghcr.io/shady2k/lifemodel-workbench@${task.imageRevision}`,
    });
    job.metadata.uid = `job-${key}`;
    job.metadata.resourceVersion = '1';
    const at = (await stores.postgres.query<{ at: Date }>('SELECT clock_timestamp() AS at'))
      .rows[0]!.at;
    job.status = { startTime: at.toISOString(), active: 1 };
    jobs.set(task.jobName, job);
    task = await registry.bindJob(
      task.id,
      task.launchId,
      job.metadata.uid,
      job.metadata.annotations![TASK_TEMPLATE_HASH] as string
    );
    await registry.initializeAccessIntent(task.id, at);
    const pod = registerPod(task, key);
    if (started)
      await access.start(
        {
          taskId: task.id,
          attemptId: task.attemptId,
          launchId: task.launchId,
          bootNonce: randomUUID(),
        },
        pod.modelToken
      );
    return { task, job, ...pod };
  }
  async function listener() {
    const channel = createTaskChannel({
      tls: { cert: certificate.cert, key: certificate.key },
      mailbox,
      identity,
      settings: values,
      logger: recordingLogger(createTestLogger('silent'), logs),
    });
    const url = await listen(channel.server);
    cleanup.push(() => channel.stop(Date.now() + 1000));
    return { ...channel, url };
  }
  async function get(url: string, token: string, path = '/task/briefing') {
    return new Promise<{ status: number; body: any; text: string; headers: IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = request(
          new URL(path, url),
          {
            method: 'GET',
            agent: client,
            signal: AbortSignal.timeout(5000),
            headers: { authorization: `Bearer ${token}` },
          },
          (res) => {
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('briefing response aborted')));
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString();
              resolve({
                status: res.statusCode!,
                body: JSON.parse(text),
                text,
                headers: res.headers,
              });
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
        req.end();
      }
    );
  }
  const ids = (task: TaskRecord) => ({
    taskId: task.id,
    attemptId: task.attemptId,
    launchId: task.launchId,
  });

  it('discovers only authenticated IDs before start and releases briefing only after the one-use start', async () => {
    const f = await fixture('one', false);
    const channel = await listener();
    const found = await get(channel.url, f.token, '/task/identity');
    expect(found.status).toBe(200);
    expect(found.body).toEqual(ids(f.task));
    expect(found.text).not.toContain(PAYLOAD);
    expect(found.headers['cache-control']).toBe('no-store');
    expect((await get(channel.url, f.token)).status).toBe(403);
    expect((await stores.postgres.query('SELECT * FROM task_access.start_claims')).rows).toEqual(
      []
    );
    await access.start({ ...ids(f.task), bootNonce: randomUUID() }, f.modelToken);
    const briefing = await get(channel.url, f.token);
    expect(briefing.status).toBe(200);
    expect(briefing.body).toEqual({ ...ids(f.task), briefing: PAYLOAD, profile: f.task.profile });
    expect(briefing.headers['cache-control']).toBe('no-store');
    expect((await get(channel.url, f.token)).body).toEqual(briefing.body);
    expect(reviews.every((audiences) => audiences.length === 1)).toBe(true);
    expect(reviews.at(-1)).toEqual([AUDIENCE]);
    await expect(
      access.start({ ...ids(f.task), bootNonce: randomUUID() }, f.modelToken)
    ).rejects.toMatchObject({ code: 'start_consumed' });
    expect((await stores.postgres.query('SELECT * FROM core.task_mailbox')).rows).toEqual([]);
  });

  it.each([
    'wrong-audience',
    'unbound',
    'unclaimed',
    'loser-pod',
    'missing-projection',
    'revoked',
    'expired',
    'tombstoned',
    'terminal',
    'missing-allocation',
    'wrong-job',
    'wrong-template',
    'wrong-start',
  ] as const)('refuses briefing for %s without exposing content', async (fault) => {
    const f = await fixture('one', fault !== 'unclaimed');
    let token = f.token;
    if (fault === 'wrong-audience') tokens.get(token)!.audience = 'lifemodel-task-model';
    if (fault === 'unbound') tokens.get(token)!.bound = false;
    if (fault === 'loser-pod') token = registerPod(f.task, 'loser').token;
    if (fault === 'missing-projection')
      await stores.postgres.query('DELETE FROM task_access.projections');
    if (fault === 'revoked')
      await stores.postgres.query("UPDATE task_access.intents SET mode='revoked'");
    if (fault === 'expired')
      await stores.postgres.query(
        "UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second'"
      );
    if (fault === 'tombstoned') await registry.tombstoneLaunch(f.task.id, f.task.launchId);
    if (fault === 'terminal')
      await stores.postgres.query(
        "UPDATE core.tasks SET state='failed',terminal_candidate='failed',terminal_reason_code='failed',terminal_at=clock_timestamp() WHERE id=$1",
        [f.task.id]
      );
    if (fault === 'missing-allocation')
      await stores.postgres.query('DELETE FROM storage.allocations');
    if (fault === 'wrong-job') jobs.get(f.task.jobName).metadata.uid = 'different-job';
    if (fault === 'wrong-template')
      jobs.get(f.task.jobName).spec.template.spec.containers[0].image = 'tampered';
    if (fault === 'wrong-start')
      jobs.get(f.task.jobName).status.startTime = new Date(0).toISOString();
    const channel = await listener();
    const response = await get(channel.url, token);
    expect([403, 409]).toContain(response.status);
    expect(response.text).not.toContain(PAYLOAD);
    expect(Object.keys(response.body)).toEqual(['code']);
  });

  it.each([
    'missing-allocation',
    'revoked',
    'soft-stop',
    'no-intent',
    'wrong-audience',
    'deleted-pod',
  ] as const)('denies prestart discovery for %s', async (fault) => {
    const f = await fixture('one', false);
    if (fault === 'missing-allocation')
      await stores.postgres.query('DELETE FROM storage.allocations');
    if (fault === 'revoked')
      await stores.postgres.query("UPDATE task_access.intents SET mode='revoked'");
    if (fault === 'soft-stop') await registry.recordSoftStop(f.task.id, f.task.launchId);
    if (fault === 'no-intent') await stores.postgres.query('DELETE FROM task_access.intents');
    if (fault === 'wrong-audience') tokens.get(f.token)!.audience = 'lifemodel-task-model';
    if (fault === 'deleted-pod')
      pods.get(f.podName).metadata.deletionTimestamp = new Date().toISOString();
    const channel = await listener();
    expect((await get(channel.url, f.token, '/task/identity')).status).toBe(403);
    expect((await stores.postgres.query('SELECT * FROM task_access.start_claims')).rows).toEqual(
      []
    );
  });

  it('checks token rotation, fresh liveness, outages and safe logging on keep-alive reads', async () => {
    const f = await fixture();
    const channel = await listener();
    expect((await get(channel.url, f.token)).status).toBe(200);
    const rotated = 'ROTATED-TASK-BRIEFING-TOKEN-CANARY';
    tokens.set(rotated, { ...tokens.get(f.token)! });
    tokens.delete(f.token);
    expect((await get(channel.url, f.token)).status).toBe(403);
    expect((await get(channel.url, rotated)).status).toBe(200);
    pods.get(f.podName).metadata.deletionTimestamp = new Date().toISOString();
    expect((await get(channel.url, rotated)).status).toBe(403);
    delete pods.get(f.podName).metadata.deletionTimestamp;
    apiStatus = 503;
    expect((await get(channel.url, rotated)).status).toBe(503);
    expect((await get(channel.url, rotated, `/task/briefing?${URL_CANARY}`)).status).toBe(404);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PAYLOAD, f.token, f.modelToken, rotated, MODULE_TOKEN, URL_CANARY])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('allows the won claim to read briefing while wrapping but grants no prestart discovery', async () => {
    const f = await fixture();
    await stores.postgres.query("UPDATE task_access.intents SET mode='wrapping'");
    const channel = await listener();
    expect((await get(channel.url, f.token)).body).toEqual({
      ...ids(f.task),
      briefing: PAYLOAD,
      profile: f.task.profile,
    });
    expect((await get(channel.url, f.token, '/task/identity')).status).toBe(403);
  });

  it('bounds SQL lock waits and cancels only the briefing operation', async () => {
    const f = await fixture();
    const channel = await listener();
    const locker = await stores.postgres.connect();
    locker.on('error', () => undefined);
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [f.task.id]);
      const response = await get(channel.url, f.token);
      expect(response.status).toBe(503);
      expect(response.text).not.toContain(PAYLOAD);
      expect((await locker.query('SELECT 42 AS n')).rows[0].n).toBe(42);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect((await get(channel.url, f.token)).status).toBe(200);
  });

  it('rechecks intent wall time after a lock wait before returning briefing', async () => {
    const f = await fixture();
    const channel = await listener();
    const locker = await stores.postgres.connect();
    locker.on('error', () => undefined);
    let pending: ReturnType<typeof get> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT 1 FROM task_access.intents WHERE task_id=$1 FOR UPDATE', [
        f.task.id,
      ]);
      pending = get(channel.url, f.token);
      await expect
        .poll(
          async () =>
            (
              await stores.postgres.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT 1 FROM task_access.intents%'"
              )
            ).rows[0].n
        )
        .toBe(1);
      await locker.query(
        "UPDATE task_access.intents SET soft_due_at=clock_timestamp()-interval '2 seconds',hard_stop_at=clock_timestamp()-interval '1 second'"
      );
      await locker.query('COMMIT');
      const response = await pending;
      expect(response.status).toBe(403);
      expect(response.text).not.toContain(PAYLOAD);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pending;
    }
  });

  it('refuses oversized briefing before sending content and respects read byte reservations', async () => {
    const f = await fixture('large', true, 'x'.repeat(1_048_576));
    const channel = await listener();
    const response = await get(channel.url, f.token);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'channel_unavailable' });
    values['tasks.channel.maxUnackedBytes'] = 128;
    const small = await listener();
    expect((await get(small.url, f.token, '/task/identity')).status).toBe(503);
  });

  it('fences and cancels briefing reads without exposing SQL causes', async () => {
    const f = await fixture();
    const channel = await listener();
    await stores.postgres.query('UPDATE core.active_holder SET epoch=2');
    const response = await get(channel.url, f.token);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'channel_unavailable' });
    mailbox.stop();
    expect((await get(channel.url, f.token)).status).toBe(503);
  });
});
