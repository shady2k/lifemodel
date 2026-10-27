import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContainerAsync } from '../../src/core/container.js';
import { createServer as createHttpServer } from 'node:http';
import Redis from 'iovalkey';
import { Agent, createServer, request, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTaskCommandIntake } from '../../loader/src/task-command-intake.js';
import { TaskSteeringJournal } from '../../loader/src/task-steering-journal.js';
import {
  createTestStores,
  workerDatabaseUrl,
  testStoreUrls,
  type TestStores,
} from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { finalizeTaskFixture } from '../helpers/finalized-task.js';
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
import { OwnerMessageIntake } from '../../src/storage/owner-message-intake.js';
import { createPostgresTraceStore } from '../../src/storage/postgres-trace-store.js';
import { AcpTurn } from '../../loader/src/task-acp.js';
import { credentialNameCases } from '../helpers/trace-credential-names.js';
import { createTaskTraceChannel } from '../../loader/src/task-trace-channel.js';
import { ScriptedTaskHarness, type TaskHarnessEvent } from '../../loader/src/task-harness.js';
import { createTaskChannel } from '../../src/core/task-channel.js';
import { createTaskChannelReplay } from '../../src/core/task-channel-replay.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { createTaskKubernetesIdentity } from '../../src/core/task-kubernetes-identity.js';
import { createTaskKubernetesIdentity as createModelIdentity } from '../../loader/src/task-kubernetes-identity.js';
import { createTaskIdentity } from '../../loader/src/task-identity.js';
import { renderTaskJob, TASK_TEMPLATE_HASH } from '../../src/core/kubernetes-task-executor.js';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import { TaskChannelError } from '../../src/ports/task-channel.js';
import type {
  TaskChannelFrame,
  TaskCommandMailbox,
  TaskCommandInput,
  TaskMailbox,
  TaskTraceFrame,
} from '../../src/ports/task-channel.js';

vi.mock('@huggingface/transformers', () => ({
  env: { cacheDir: '', allowLocalModels: true, allowRemoteModels: true },
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.1) }),
}));

// All durable assertions use migrated Postgres/Valkey. Only Kubernetes is fake,
// at its real TLS boundary, including the model listener's once-only start claim.
describe('task-only TLS channel (real stores and Kubernetes identity)', () => {
  let stores: TestStores;
  let certificate: TestStorageCertificate;
  let directory: string;
  let tokenFile: string;
  let caFile: string;
  let api: Server;
  let origin: string;
  let client: Agent;
  let registry: TaskRegistry;
  let mailbox: TaskMailbox & TaskCommandMailbox;
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
  const URL_CANARY = 'TASK-CHANNEL-URL-PRIVATE-CANARY';
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
    await stores.redis.del('inbound');
    await stores.postgres.query('TRUNCATE observability.trace_spans, observability.trace_events');
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
      spec: structuredClone(jobs.get(task.jobName).spec.template.spec),
      status: { phase: 'Running' },
    });
    const token = `CHANNEL-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    const modelToken = `MODEL-TOKEN-PRIVATE-CANARY-${suffix}-${task.id}`;
    tokens.set(token, { podName, podUid });
    tokens.set(modelToken, { podName, podUid });
    return { token, modelToken, podName, podUid };
  }
  async function fixture(key = 'one', started = true) {
    let task = await registry.accept({
      launchKey: key,
      briefing: PAYLOAD,
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
  function step(task: TaskRecord, sequence = 1): TaskChannelFrame {
    return {
      taskId: task.id,
      attemptId: task.attemptId,
      direction: 'task_to_core',
      messageId: randomUUID(),
      sequence,
      kind: 'step',
      payload: { line: PAYLOAD },
    };
  }
  async function listener(
    overrides: {
      mailbox?: TaskMailbox & Partial<TaskCommandMailbox>;
      settings?: Partial<PlatformSettingsValues>;
      identity?: typeof identity;
      onTrace?: Parameters<typeof createTaskChannel>[0]['onTrace'];
    } = {}
  ) {
    const channel = createTaskChannel({
      tls: { cert: certificate.cert, key: certificate.key },
      mailbox: overrides.mailbox ?? mailbox,
      onTrace: overrides.onTrace,
      identity: overrides.identity ?? identity,
      settings: { ...values, ...overrides.settings },
      logger: recordingLogger(createTestLogger('silent'), logs),
    });
    const url = await listen(channel.server);
    cleanup.push(() => channel.stop(Date.now() + 1000));
    return { ...channel, url };
  }
  async function rows(frame: TaskChannelFrame) {
    return (
      await stores.postgres.query(
        'SELECT * FROM core.task_mailbox WHERE task_id=$1 AND direction=$2 AND message_id=$3',
        [frame.taskId, frame.direction, frame.messageId]
      )
    ).rows;
  }
  type Response = {
    status: number;
    text: string;
    body: any;
    headers: IncomingHttpHeaders;
    rowsAtReceipt?: any[];
  };
  async function call(
    url: string,
    token: string,
    frame: TaskChannelFrame,
    options: { path?: string; raw?: string; inspectRow?: boolean } = {}
  ): Promise<Response> {
    const data = options.raw ?? JSON.stringify(frame);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(options.path ?? '/task/events', url),
        {
          method: 'POST',
          agent: client,
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
          },
        },
        (res) => {
          res.on('error', reject);
          res.on('aborted', () => reject(new Error('channel response aborted')));
          // Capture the database observation at HTTP ACK headers, before consuming its body.
          const receivedRows = options.inspectRow ? rows(frame) : Promise.resolve(undefined);
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            void receivedRows
              .then((observed) => {
                const text = Buffer.concat(chunks).toString();
                resolve({
                  status: res.statusCode!,
                  headers: res.headers,
                  text,
                  body: text ? JSON.parse(text) : null,
                  rowsAtReceipt: observed,
                });
              })
              .catch(reject);
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
    });
  }
  async function rawSocket(url: string): Promise<TLSSocket> {
    const target = new URL(url);
    const socket = connect({
      host: '127.0.0.1',
      port: Number(target.port),
      servername: 'localhost',
      ca: certificate.ca,
    });
    socket.on('error', () => undefined);
    socket.setTimeout(5000, () => socket.destroy());
    cleanup.push(() => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });
    return socket;
  }
  function wire(token: string, data: string, length = Buffer.byteLength(data)) {
    return `POST /task/events HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: keep-alive\r\n\r\n${data}`;
  }
  async function bounded<T>(promise: Promise<T>, timeoutMs = 4000): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('task channel fixture deadline exceeded'));
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  function commandInput(
    task: TaskRecord,
    commandId: string,
    text = 'Please check the result'
  ): TaskCommandInput {
    return { taskId: task.id, attemptId: task.attemptId, commandId, kind: 'steer', text };
  }
  function commandCall(
    url: string,
    token: string,
    path = '/task/commands',
    body?: unknown,
    signal?: AbortSignal
  ): Promise<Response> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        new URL(path, url),
        {
          method: data === undefined ? 'GET' : 'POST',
          agent: client,
          signal: signal ?? AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${token}`,
            ...(data === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }),
          },
        },
        (res) => {
          res.on('error', reject);
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text,
              body: JSON.parse(text),
            });
          });
        }
      );
      req.on('error', reject);
      req.end(data);
    });
  }
  async function proofFor(f: Awaited<ReturnType<typeof fixture>>) {
    return identity.verify(f.token);
  }
  function commandAck(task: TaskRecord, commandId: string, disposition = 'accepted') {
    return { taskId: task.id, attemptId: task.attemptId, commandId, disposition };
  }

  it('delivers commands in committed per-task order and stores ACK before retiring, including reconnect and core restart', async () => {
    const f = await fixture();
    const first = await mailbox.enqueueCommand(commandInput(f.task, 'z-first'));
    const second = await mailbox.enqueueCommand(commandInput(f.task, 'a-second'));
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    let channel = await listener();
    const poll = () => commandCall(channel.url, f.token);
    expect((await poll()).body.command).toEqual(first);
    // Reconnect without ACK must deliver precisely the oldest outstanding row.
    expect((await poll()).body.command).toEqual(first);
    await channel.stop(Date.now() + 1000);
    mailbox.stop();
    mailbox = createPostgresTaskMailbox({ pool: stores.postgres, epoch: 1 });
    channel = await listener();
    expect((await poll()).body.command).toEqual(first);
    const ack = commandAck(f.task, first.commandId);
    expect((await commandCall(channel.url, f.token, '/task/commands/ack', ack)).status).toBe(200);
    const rows = await stores.postgres.query(
      `SELECT c.retired_at,a.disposition,a.received_at FROM core.task_commands c JOIN core.task_command_acks a USING(task_id,command_id) WHERE c.command_id=$1`,
      [first.commandId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].disposition).toBe('accepted');
    expect(rows.rows[0].retired_at.getTime()).toBeGreaterThanOrEqual(
      rows.rows[0].received_at.getTime()
    );
    expect((await commandCall(channel.url, f.token, '/task/commands/ack', ack)).status).toBe(200);
    expect((await poll()).body.command).toEqual(second);
    // A different disposition cannot rewrite the committed one.
    expect(
      (
        await commandCall(channel.url, f.token, '/task/commands/ack', {
          ...ack,
          disposition: 'rejected',
        })
      ).status
    ).toBe(409);
    // The database guard enforces the ACK-before-retire boundary too.
    await expect(
      stores.postgres.query(
        'UPDATE core.task_commands SET retired_at=clock_timestamp() WHERE command_id=$1',
        [second.commandId]
      )
    ).rejects.toMatchObject({ code: '23514' });
    const receipt = { ...commandAck(f.task, first.commandId, 'inserted'), receiptId: 'receipt-1' };
    expect(
      (await commandCall(channel.url, f.token, '/task/commands/receipt', receipt)).status
    ).toBe(200);
    expect(
      (await commandCall(channel.url, f.token, '/task/commands/receipt', receipt)).status
    ).toBe(200);
    expect(
      (
        await commandCall(channel.url, f.token, '/task/commands/receipt', {
          ...receipt,
          disposition: 'failed',
        })
      ).status
    ).toBe(409);
    expect((await stores.postgres.query('SELECT * FROM core.task_command_receipts')).rowCount).toBe(
      1
    );
  });

  it('rechecks a missed commit notification and closes a held poll on revocation', async () => {
    const f = await fixture();
    const checked = Promise.withResolvers<void>();
    const withoutNotify = {
      ...mailbox,
      subscribeCommands: () => () => undefined,
      pollCommand: async (...args: Parameters<typeof mailbox.pollCommand>) => {
        const result = await mailbox.pollCommand(...args);
        if (!result) checked.resolve();
        return result;
      },
    };
    const channel = await listener({ mailbox: withoutNotify });
    const pending = commandCall(channel.url, f.token);
    await bounded(checked.promise);
    const queued = await mailbox.enqueueCommand(commandInput(f.task, 'missed-notify'));
    expect((await bounded(pending)).body.command).toEqual(queued);
    expect(
      (
        await commandCall(
          channel.url,
          f.token,
          '/task/commands/ack',
          commandAck(f.task, queued.commandId)
        )
      ).status
    ).toBe(200);
    const waiting = Promise.withResolvers<void>();
    const other = await listener({
      mailbox: {
        ...mailbox,
        pollCommand: async (...args: Parameters<typeof mailbox.pollCommand>) => {
          const row = await mailbox.pollCommand(...args);
          if (!row) waiting.resolve();
          return row;
        },
      },
    });
    const held = commandCall(other.url, f.token);
    await bounded(waiting.promise);
    const intent = (await registry.readAccessIntent(f.task.id))!;
    await registry.advanceAccessIntent(f.task.id, {
      mode: 'revoked',
      softDueAt: intent.softDueAt,
      hardStopAt: intent.hardStopAt,
    });
    expect((await bounded(held)).status).toBe(403);
  });

  it('launcher reconnect and process recovery replay journal dispositions, prefix answers, and forward immutable receipts', async () => {
    const f = await fixture();
    const channel = await listener();
    const projected = join(directory, `launcher-command-${randomUUID()}.token`);
    await writeFile(projected, f.token);
    const journalPath = join(directory, `command-${randomUUID()}.journal`);
    let journal = await TaskSteeringJournal.open(journalPath, { capacity: 16, create: true });
    const native: string[] = [];
    const command1 = await mailbox.enqueueCommand(commandInput(f.task, 'first'));
    const proof = await proofFor(f);
    // Simulate launcher death after synced disposition but before core ACK.
    await journal.admit({ commandId: command1.commandId, text: command1.text }, async () => {
      native.push(command1.text);
      return 'accepted';
    });
    await journal.close();
    journal = await TaskSteeringJournal.open(journalPath, { capacity: 16, create: false });
    const question: TaskChannelFrame = {
      ...step(f.task, 1),
      messageId: 'q-one',
      kind: 'question',
      payload: { questionId: 'q-one', text: 'Which result?' },
    };
    await mailbox.append(question, proof);
    await mailbox.enqueueCommand({
      ...commandInput(f.task, 'answer', 'Use the second'),
      kind: 'answer',
      questionId: 'q-one',
    });
    const allAcked = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    let loseAck = true;
    const channel2 = await listener({
      mailbox: {
        ...mailbox,
        acknowledgeCommand: async (...args: Parameters<typeof mailbox.acknowledgeCommand>) => {
          if (loseAck) {
            loseAck = false;
            throw new TaskChannelError(503, 'storage_error');
          }
          await mailbox.acknowledgeCommand(...args);
          if (args[0].commandId === 'answer') allAcked.resolve();
        },
        recordCommandReceipt: async (...args: Parameters<typeof mailbox.recordCommandReceipt>) => {
          await mailbox.recordCommandReceipt(...args);
          received.resolve();
        },
      },
    });
    let intake: ReturnType<typeof createTaskCommandIntake>;
    intake = createTaskCommandIntake({
      endpoint: { endpoint: channel2.url, tokenFile: projected, caFile },
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      hardStopAt: Date.now() + 30_000,
      harness: {
        intakeReady: Promise.resolve(),
        steer: async (command) => {
          const result = await journal.admit(command, async () => {
            native.push(command.text);
            return 'accepted';
          });
          intake.receipt({
            type: 'receipt',
            commandId: command.commandId,
            disposition: 'inserted',
          });
          return result;
        },
      },
    });
    try {
      intake.start();
      await bounded(allAcked.promise);
      await bounded(received.promise);
      expect(native).toEqual(['Please check the result', '[question:q-one]\nUse the second']);
      expect((await stores.postgres.query('SELECT * FROM core.task_command_acks')).rowCount).toBe(
        2
      );
      expect(await mailbox.pollCommand(proof)).toBeNull();
    } finally {
      await intake.stop();
      await journal.close();
    }
    expect((await stores.postgres.query('SELECT * FROM core.task_command_receipts')).rowCount).toBe(
      2
    );
    await channel.stop(Date.now() + 1000);
  });

  it('leaves early commands in core until the scripted harness opens intake', async () => {
    const f = await fixture();
    const input = commandInput(f.task, 'early-instruction');
    await mailbox.enqueueCommand(input);
    const open = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const acked = Promise.withResolvers<void>();
    const channel = await listener({
      mailbox: {
        ...mailbox,
        acknowledgeCommand: async (...args) => {
          await mailbox.acknowledgeCommand(...args);
          acked.resolve();
        },
      },
    });
    const projected = join(directory, `readiness-${randomUUID()}.token`);
    await writeFile(projected, f.token);
    const harness = new ScriptedTaskHarness({
      waitForAbort: true,
      beforeIntake: open.promise,
      onEvent: () => {
        started.resolve();
      },
    });
    const execution = harness.start({ text: 'Brief', model: 'scripted' });
    await started.promise;
    const intake = createTaskCommandIntake({
      endpoint: { endpoint: channel.url, tokenFile: projected, caFile },
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      harness,
      hardStopAt: Date.now() + 30_000,
    });
    // A transport spy is an event gate: if run starts polling immediately the
    // forbidden call occurs before any readiness resolver is released.
    const { TaskJsonClient } = await import('../../loader/src/task-launcher-http.js');
    const call = vi.spyOn(TaskJsonClient.prototype, 'call');
    try {
      intake.start();
      // Queue a sentinel on the same microtask queue as run's first continuation.
      await Promise.resolve();
      expect(call).not.toHaveBeenCalled();
      expect(
        (await stores.postgres.query('SELECT retired_at FROM core.task_commands')).rows
      ).toEqual([{ retired_at: null }]);
      open.resolve();
      await bounded(acked.promise);
      expect(
        (await stores.postgres.query('SELECT disposition FROM core.task_command_acks')).rows
      ).toEqual([{ disposition: 'accepted' }]);
    } finally {
      call.mockRestore();
      open.resolve();
      await intake.stop();
      await harness.abort();
      await execution;
    }
  });

  it('ending before readiness never takes or retires an early command', async () => {
    const f = await fixture();
    await mailbox.enqueueCommand(commandInput(f.task, 'not-opened'));
    const projected = join(directory, `not-ready-${randomUUID()}.token`);
    await writeFile(projected, f.token);
    const channel = await listener();
    const harness = new ScriptedTaskHarness();
    const intake = createTaskCommandIntake({
      endpoint: { endpoint: channel.url, tokenFile: projected, caFile },
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      harness,
      hardStopAt: Date.now() + 30_000,
    });
    intake.start();
    await harness.start({ text: 'Brief', model: 'scripted' });
    await bounded(intake.stop());
    expect((await stores.postgres.query('SELECT * FROM core.task_command_acks')).rowCount).toBe(0);
  });

  it('one task flooding command writes cannot refuse another task poll or ACK', async () => {
    const a = await fixture('flood-a');
    const b = await fixture('fair-b');
    const ca = await mailbox.enqueueCommand(commandInput(a.task, 'a'));
    const cb = await mailbox.enqueueCommand(commandInput(b.task, 'b'));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let aWrites = 0;
    const channel = await listener({
      mailbox: {
        ...mailbox,
        acknowledgeCommand: async (ack, proof, signal) => {
          if (ack.taskId === a.task.id) {
            aWrites++;
            entered.resolve();
            await release.promise;
          }
          await mailbox.acknowledgeCommand(ack, proof, signal);
        },
      },
    });
    const flood = Array.from({ length: 20 }, () =>
      commandCall(channel.url, a.token, '/task/commands/ack', commandAck(a.task, ca.commandId))
    );
    try {
      await bounded(entered.promise);
      // Same global schedulers, one active share per Job. B has its own share.
      const poll = await bounded(commandCall(channel.url, b.token));
      expect(poll.status).toBe(200);
      expect(poll.body.command).toEqual(cb);
      const ack = await bounded(
        commandCall(channel.url, b.token, '/task/commands/ack', commandAck(b.task, cb.commandId))
      );
      expect(ack.status).toBe(200);
      expect(aWrites).toBe(1);
    } finally {
      release.resolve();
      await Promise.all(flood);
    }
    expect((await Promise.all(flood)).some((reply) => reply.status === 429)).toBe(true);
  });

  it('empty rechecks back off without repeating Kubernetes verification', async () => {
    const f = await fixture();
    const rechecked = Promise.withResolvers<void>();
    let reads = 0;
    const channel = await listener({
      mailbox: {
        ...mailbox,
        pollCommand: async (...args) => {
          const result = await mailbox.pollCommand(...args);
          if (++reads === 3) rechecked.resolve();
          return result;
        },
      },
    });
    const abort = new AbortController();
    const before = reviews.length;
    const held = commandCall(channel.url, f.token, '/task/commands', undefined, abort.signal);
    void held.catch(() => undefined);
    try {
      await bounded(rechecked.promise, 5000);
      expect(reviews.length - before).toBe(1);
    } finally {
      abort.abort();
      await held.catch(() => undefined);
    }
  });

  it('command commit wakes only its task listener, not another held poll', async () => {
    const a = await fixture('notify-a');
    const b = await fixture('notify-b');
    const waiting = new Map([a, b].map((f) => [f.task.id, Promise.withResolvers<void>()]));
    const wakes: string[] = [];
    const channel = await listener({
      mailbox: {
        ...mailbox,
        subscribeCommands: (taskId, wake) =>
          mailbox.subscribeCommands(taskId, () => {
            wakes.push(taskId);
            wake();
          }),
        pollCommand: async (...args) => {
          const result = await mailbox.pollCommand(...args);
          if (!result)
            waiting.get([a, b].find((f) => f.task.jobUid === args[0].jobUid)!.task.id)?.resolve();
          return result;
        },
      },
    });
    const abort = new AbortController();
    const polls = [a, b].map((f) =>
      commandCall(channel.url, f.token, '/task/commands', undefined, abort.signal)
    );
    for (const poll of polls) void poll.catch(() => undefined);
    try {
      await bounded(Promise.all([...waiting.values()].map((event) => event.promise)));
      const command = await mailbox.enqueueCommand(commandInput(a.task, 'only-a'));
      expect(wakes).toEqual([a.task.id]);
      expect((await bounded(polls[0]!)).body.command).toEqual(command);
    } finally {
      abort.abort();
      await Promise.allSettled(polls);
    }
  });

  it('settles an admitted command ACK before intake shutdown retires its writers', async () => {
    const f = await fixture();
    const channel = await listener();
    const projected = join(directory, `command-stop-${randomUUID()}.token`);
    await writeFile(projected, f.token);
    const queued = await mailbox.enqueueCommand(commandInput(f.task, 'stop-race'));
    const entered = Promise.withResolvers<void>();
    const admit = Promise.withResolvers<'accepted'>();
    const intake = createTaskCommandIntake({
      endpoint: { endpoint: channel.url, tokenFile: projected, caFile },
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      hardStopAt: Date.now() + 30_000,
      harness: {
        intakeReady: Promise.resolve(),
        steer: async () => {
          entered.resolve();
          return admit.promise;
        },
      },
    });
    intake.start();
    try {
      await bounded(entered.promise);
      const stopped = intake.stop();
      admit.resolve('accepted');
      await bounded(stopped);
      const rows = await stores.postgres.query(
        'SELECT disposition FROM core.task_command_acks WHERE task_id=$1 AND command_id=$2',
        [f.task.id, queued.commandId]
      );
      expect(rows.rows).toEqual([{ disposition: 'accepted' }]);
      expect(await mailbox.pollCommand(await proofFor(f))).toBeNull();
    } finally {
      admit.resolve('accepted');
      await intake.stop();
    }
  });

  it('replays identical command creation and conflicts on changed content under the same ID', async () => {
    const f = await fixture();
    const input = commandInput(f.task, 'same');
    const queued = await mailbox.enqueueCommand(input);
    expect(await mailbox.enqueueCommand(input)).toEqual(queued);
    for (const changed of [
      { ...input, text: 'Changed' },
      { ...input, kind: 'answer' as const, questionId: 'question-id' },
    ])
      await expect(mailbox.enqueueCommand(changed)).rejects.toMatchObject({
        code: 'message_conflict',
      });
    expect((await stores.postgres.query('SELECT * FROM core.task_commands')).rowCount).toBe(1);
  });

  it.each([
    ['revoked', 403, 'identity_mismatch'],
    ['terminal', 409, 'terminal_attempt'],
    ['wrapping', 403, 'identity_mismatch'],
    ['wrapping-state', 409, 'wrapping_attempt'],
    ['terminal-frame', 409, 'terminal_attempt'],
  ] as const)(
    'refuses new %s commands and poll, but replays exact creation',
    async (state, status, code) => {
      const f = await fixture();
      const input = commandInput(f.task, 'before');
      const queued = await mailbox.enqueueCommand(input);
      const proof = await proofFor(f);
      const intent = (await registry.readAccessIntent(f.task.id))!;
      if (state === 'revoked' || state === 'wrapping')
        await registry.advanceAccessIntent(f.task.id, {
          mode: state === 'revoked' ? 'revoked' : 'wrapping',
          softDueAt: intent.softDueAt,
          hardStopAt: intent.hardStopAt,
        });
      if (state === 'terminal')
        await registry.beginFinalization(f.task.id, f.task.launchId, {
          state: 'failed',
          reasonCode: 'harness_failed',
          summary: 'Failed',
        });
      if (state === 'wrapping-state')
        await stores.postgres.query("UPDATE core.tasks SET state='wrapping-up' WHERE id=$1", [
          f.task.id,
        ]);
      if (state === 'terminal-frame')
        await mailbox.append(
          {
            ...step(f.task),
            kind: 'terminal',
            payload: {
              outcome: 'succeeded',
              summary: 'Done',
              resultObjectId: null,
              artifactObjectIds: [],
            },
          },
          proof
        );
      await expect(mailbox.enqueueCommand(commandInput(f.task, 'after'))).rejects.toMatchObject({
        status,
        code,
      });
      expect(await mailbox.enqueueCommand(input)).toEqual(queued);
      await expect(mailbox.enqueueCommand({ ...input, text: 'Changed' })).rejects.toMatchObject({
        code: 'message_conflict',
      });
      await expect(mailbox.pollCommand(proof)).rejects.toMatchObject({ status, code });
      const channel = await listener();
      const response = await commandCall(channel.url, f.token);
      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
    }
  );

  it('accepts existing ACKs and receipts in authoritative wrapping, but denies revoked bindings', async () => {
    const f = await fixture();
    await mailbox.enqueueCommand(commandInput(f.task, 'admitted'));
    const intent = (await registry.readAccessIntent(f.task.id))!;
    await registry.advanceAccessIntent(f.task.id, {
      mode: 'wrapping',
      softDueAt: intent.softDueAt,
      hardStopAt: intent.hardStopAt,
    });
    await stores.postgres.query("UPDATE core.tasks SET state='wrapping-up' WHERE id=$1", [
      f.task.id,
    ]);
    const channel = await listener();
    const ack = commandAck(f.task, 'admitted');
    const receipt = {
      ...commandAck(f.task, 'admitted', 'inserted'),
      receiptId: 'wrapping-receipt',
    };
    for (let replay = 0; replay < 2; replay++) {
      expect((await commandCall(channel.url, f.token, '/task/commands/ack', ack)).status).toBe(200);
      expect(
        (await commandCall(channel.url, f.token, '/task/commands/receipt', receipt)).status
      ).toBe(200);
    }
    await registry.advanceAccessIntent(f.task.id, {
      mode: 'revoked',
      softDueAt: intent.softDueAt,
      hardStopAt: intent.hardStopAt,
    });
    for (const [path, body] of [
      ['ack', ack],
      ['receipt', receipt],
    ] as const) {
      const denied = await commandCall(channel.url, f.token, `/task/commands/${path}`, body);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('identity_mismatch');
    }
  });

  it('finishes existing command reports after a terminal frame while active binding is still authoritative', async () => {
    const f = await fixture();
    await mailbox.enqueueCommand(commandInput(f.task, 'late-report'));
    const proof = await proofFor(f);
    await mailbox.append(
      {
        ...step(f.task),
        kind: 'terminal',
        payload: {
          outcome: 'succeeded',
          summary: 'Done',
          resultObjectId: null,
          artifactObjectIds: [],
        },
      },
      proof
    );
    const channel = await listener();
    expect(
      (
        await commandCall(
          channel.url,
          f.token,
          '/task/commands/ack',
          commandAck(f.task, 'late-report')
        )
      ).status
    ).toBe(200);
    expect(
      (
        await commandCall(channel.url, f.token, '/task/commands/receipt', {
          ...commandAck(f.task, 'late-report', 'inserted'),
          receiptId: 'late-report',
        })
      ).status
    ).toBe(200);
  });

  it('task A cannot ACK, receipt, or poll task B commands using its own attempt ID', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    // Supply A's attempt with B's task locator. Removing only the task-ID
    // comparison reaches not_found instead of the required identity_mismatch.
    const command = commandInput(b.task, 'private-b');
    await mailbox.enqueueCommand(command);
    const channel = await listener();
    for (const [path, body] of [
      ['ack', { ...commandAck(b.task, command.commandId), attemptId: a.task.attemptId }],
      [
        'receipt',
        {
          ...commandAck(b.task, command.commandId, 'inserted'),
          attemptId: a.task.attemptId,
          receiptId: 'forged',
        },
      ],
    ] as const) {
      const denied = await commandCall(channel.url, a.token, `/task/commands/${path}`, body);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('identity_mismatch');
    }
    // Poll has no caller-selected locator: A's proof reads A, never B.
    expect(await mailbox.pollCommand(await proofFor(a))).toBeNull();
    expect((await stores.postgres.query('SELECT * FROM core.task_command_acks')).rowCount).toBe(0);
    expect((await stores.postgres.query('SELECT * FROM core.task_command_receipts')).rowCount).toBe(
      0
    );
  });

  it.each(['pod', 'job'] as const)(
    're-verifies a deleted %s before returning a command after a held wait',
    async (resource) => {
      const f = await fixture();
      const checked = Promise.withResolvers<void>();
      const channel = await listener({
        mailbox: {
          ...mailbox,
          pollCommand: async (...args) => {
            const result = await mailbox.pollCommand(...args);
            if (!result) checked.resolve();
            return result;
          },
        },
      });
      const pending = commandCall(channel.url, f.token);
      await bounded(checked.promise);
      if (resource === 'pod') pods.delete(f.podName);
      else jobs.delete(f.task.jobName);
      await mailbox.enqueueCommand(commandInput(f.task, 'after-deletion'));
      const denied = await bounded(pending);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('identity_denied');
    }
  );

  it('does not lock task or launch rows during empty command rechecks', async () => {
    const f = await fixture();
    const proof = await proofFor(f);
    const lock = await stores.postgres.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [f.task.id]);
      await lock.query('SELECT launch_id FROM core.task_launches WHERE task_id=$1 FOR UPDATE', [
        f.task.id,
      ]);
      expect(await mailbox.pollCommand(proof, AbortSignal.timeout(500))).toBeNull();
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('refuses a chunked oversized command body without verifying identity after the 413', async () => {
    const f = await fixture();
    const verify = vi.spyOn(identity, 'verify');
    const channel = await listener({ settings: { 'tasks.channel.maxFrameBytes': 128 } });
    const response = await new Promise<Response>((resolve, reject) => {
      const req = request(
        new URL('/task/commands/ack', channel.url),
        {
          method: 'POST',
          agent: client,
          signal: AbortSignal.timeout(4000),
          headers: {
            authorization: `Bearer ${f.token}`,
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text: Buffer.concat(chunks).toString(),
              body: JSON.parse(Buffer.concat(chunks).toString()),
            })
          );
        }
      );
      req.on('error', reject);
      req.end('x'.repeat(256));
    });
    expect(response.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
    verify.mockRestore();
  });

  it('bounds enqueue by the configured command response frame limit', async () => {
    const f = await fixture();
    const limited = createPostgresTaskMailbox({
      pool: stores.postgres,
      epoch: 1,
      commandFrameLimit: 1024,
    });
    cleanup.push(() => limited.stop());
    await expect(
      limited.enqueueCommand(commandInput(f.task, 'too-big', 'x'.repeat(1000)))
    ).rejects.toMatchObject({ status: 413, code: 'invalid_frame' });
    expect((await stores.postgres.query('SELECT * FROM core.task_commands')).rowCount).toBe(0);
  });

  it('database index refuses a second open question even outside the application lock', async () => {
    const f = await fixture();
    await stores.postgres.query(
      'INSERT INTO core.task_questions(task_id,question_id) VALUES($1,$2)',
      [f.task.id, 'one']
    );
    await expect(
      stores.postgres.query('INSERT INTO core.task_questions(task_id,question_id) VALUES($1,$2)', [
        f.task.id,
        'two',
      ])
    ).rejects.toMatchObject({ code: '23505', constraint: 'task_one_open_question' });
  });

  it('core refuses a second unanswered question, including concurrent hostile frames, and answer commit opens the next question', async () => {
    const f = await fixture();
    const channel = await listener();
    const question = (name: string, seq: number): TaskChannelFrame => ({
      ...step(f.task, seq),
      messageId: name,
      kind: 'question',
      payload: { questionId: name, text: 'Which result should I use?' },
    });
    const q = question('question-1', 1);
    expect((await call(channel.url, f.token, q)).status).toBe(200);
    expect((await call(channel.url, f.token, q)).status).toBe(200);
    const denied = await Promise.all([
      call(channel.url, f.token, question('question-2', 2)),
      call(channel.url, f.token, question('question-3', 3)),
    ]);
    expect(denied.map((r) => r.status)).toEqual([409, 409]);
    expect(denied.map((r) => r.body.code)).toEqual(['question_open', 'question_open']);
    const answer = {
      ...commandInput(f.task, 'answer'),
      kind: 'answer' as const,
      questionId: 'question-1',
    };
    await mailbox.enqueueCommand(answer);
    expect((await call(channel.url, f.token, question('question-2', 2))).status).toBe(200);
    await expect(
      mailbox.enqueueCommand({ ...answer, commandId: 'answer-again' })
    ).rejects.toMatchObject({ code: 'question_absent' });
    expect((await stores.postgres.query('SELECT * FROM core.task_commands')).rowCount).toBe(1);
  });

  it('shared channel pool keeps owner turns and another task event ACK progressing under held polls and a receipt flood', async () => {
    const ownerUrl = new URL('/9', testStoreUrls().valkeyUrl).toString();
    const ownerRedis = new Redis(ownerUrl);
    await ownerRedis.flushdb();
    cleanup.push(() => ownerRedis.quit().then(() => undefined));
    const ownerDirectory = await mkdtemp(join(tmpdir(), 'task-poll-owner-'));
    cleanup.push(() => rm(ownerDirectory, { recursive: true, force: true }));
    const llm = createHttpServer(async (req, res) => {
      for await (const chunk of req) {
        void chunk;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'owner-poll-reply',
          object: 'chat.completion',
          created: 1,
          model: 'stub',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Received while polls held.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => llm.close(() => resolve())));
    const address = llm.address();
    if (!address || typeof address === 'string') throw new Error('owner model did not bind');
    const env = {
      LIFEMODEL_VALKEY_URL: ownerUrl,
      LIFEMODEL_DATABASE_URL: workerDatabaseUrl(),
      MOTOR_CORTEX_ENABLED: 'false',
      DATA_PATH: ownerDirectory,
    };
    const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    // This is the actual core, in this process. Its owner pool is physically
    // independent, exactly as container.ts. No child can mask task-pool contention.
    const core = await createContainerAsync({
      logToFile: false,
      logLevel: 'error',
      prettyLogs: false,
      llm: {
        endpoint: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          fastModel: 'stub',
          smartModel: 'stub',
          motorModel: 'stub',
        },
      },
      coreLoop: { tickInterval: 25 },
    });
    cleanup.push(async () => {
      await core.shutdown();
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    core.coreLoop.start();
    const epoch = Number(
      (await stores.postgres.query('SELECT epoch FROM core.active_holder WHERE id')).rows[0].epoch
    );
    registry = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch,
      settings: {
        ...settings,
        read: async () => {
          const current = await settings.read();
          return { ...current, values: { ...current.values, 'tasks.concurrency': 8 } };
        },
      },
    });
    const a = await fixture('poll-a');
    const b = await fixture('poll-b');
    const healthy = await fixture('event-c');
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: workerDatabaseUrl(),
      max: 2,
      connectionTimeoutMillis: 1000,
    });
    pool.on('error', () => undefined);
    cleanup.push(() => pool.end());
    const shared = createPostgresTaskMailbox({ pool, epoch });
    cleanup.push(() => shared.stop());
    const replay = createTaskChannelReplay({
      mailbox: shared,
      bus: createBusSignalStream(ownerRedis),
      logger: createTestLogger('silent'),
    });
    cleanup.push(() => replay.stop(Date.now() + 1000));
    const queued = await shared.enqueueCommand(commandInput(a.task, 'receipt-source'));
    await shared.acknowledgeCommand(commandAck(a.task, queued.commandId), await proofFor(a));
    const empty = new Map([a, b].map((f) => [f.task.id, Promise.withResolvers<void>()]));
    const readCounts = new Map<string, number>();
    const allowRechecks = Promise.withResolvers<void>();
    const observed = {
      ...shared,
      pollCommand: async (...args: Parameters<typeof shared.pollCommand>) => {
        const f = [a, b].find((item) => item.task.jobUid === args[0].jobUid)!;
        if (readCounts.has(f.task.id)) await allowRechecks.promise;
        const result = await shared.pollCommand(...args);
        readCounts.set(f.task.id, (readCounts.get(f.task.id) ?? 0) + 1);
        if (!result) empty.get(f.task.id)?.resolve();
        return result;
      },
    };
    const channel = await listener({ mailbox: observed });
    const abort = new AbortController();
    let settled = 0;
    const polls = [a, b].map((f) =>
      commandCall(channel.url, f.token, '/task/commands', undefined, abort.signal).finally(() => {
        settled++;
      })
    );
    for (const poll of polls) void poll.catch(() => undefined);
    try {
      await bounded(Promise.all([...empty.values()].map((event) => event.promise)));
      // All empty reads have returned, and no writes or recheck have been released
      // yet. A retained SQL-client mutation is observed at this explicit idle gate.
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(pool.waitingCount).toBe(0);
      expect(settled).toBe(0);
      allowRechecks.resolve();
      const floodEntered = Promise.withResolvers<void>();
      const floodStop = new AbortController();
      let stored = 0;
      const flood = (async () => {
        while (!floodStop.signal.aborted) {
          const reply = await commandCall(channel.url, a.token, '/task/commands/receipt', {
            ...commandAck(a.task, queued.commandId, 'inserted'),
            receiptId: 'same-receipt',
          });
          expect(reply.status).toBe(200);
          stored++;
          floodEntered.resolve();
        }
      })();
      try {
        await bounded(floodEntered.promise);
        const recipientId = 'rcpt_5dca93478eabd318';
        const owner = new OwnerMessageIntake(ownerRedis, recipientId);
        const id = ownerId();
        expect((await owner.acceptOwnerMessage(id, 'Owner is still here')).status).toBe('accepted');
        // Event's HTTP ACK and committed row are the liveness deadline, not a
        // sampled elapsed time or a timer that guesses when a turn has ended.
        const frame = step(healthy.task);
        const event = await bounded(call(channel.url, healthy.token, frame), 4000);
        expect(event.status).toBe(200);
        expect(await rows(frame)).toHaveLength(1);
        await replay.resync();
        expect(
          (
            await stores.postgres.query(
              'SELECT signalled_at FROM core.task_mailbox WHERE message_id=$1',
              [frame.messageId]
            )
          ).rows[0].signalled_at
        ).not.toBeNull();
        await vi.waitFor(
          async () => {
            const rows = await stores.postgres.query(
              "SELECT message_id,payload->>'role' AS role,payload->>'content' AS content FROM core.conversation_messages WHERE recipient_id=$1 AND kind='message'",
              [recipientId]
            );
            expect(rows.rows.some((row) => row.message_id === `inbound:${id}`)).toBe(true);
            expect(
              rows.rows.some(
                (row) => row.role === 'assistant' && row.content === 'Received while polls held.'
              )
            ).toBe(true);
          },
          { timeout: 12000, interval: 20 }
        );
        expect(stored).toBeGreaterThan(0);
        expect(settled).toBe(0);
      } finally {
        floodStop.abort();
        await flood;
      }
      const command = await shared.enqueueCommand(commandInput(a.task, 'wake-a'));
      expect((await bounded(polls[0]!)).body.command).toEqual(command);
      expect((await commandCall(channel.url, b.token)).status).toBe(429);
    } finally {
      allowRechecks.resolve();
      abort.abort();
      await Promise.allSettled(polls);
    }
  }, 60_000);

  function ownerId() {
    const time = Date.now().toString(16).padStart(12, '0');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(0, 3)}-8${randomUUID().slice(0, 3)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  }

  it.each([false, true])(
    'persists an ACP tool tree without mailbox rows, recovered=%s',
    async (recovered) => {
      const f = await fixture();
      const writer = createPostgresTraceStore({
        pool: stores.postgres,
        knownSecrets: ['TRACE-SECRET-CANARY'],
      });
      cleanup.push(() => writer.close());
      const channel = await listener({
        onTrace: (frame) => {
          writer.enqueue({ kind: 'span', span: frame.span });
        },
      });
      const events: TaskHarnessEvent[] = [];
      const turn = new AcpTurn(
        (output) => {
          const exit = (output as any)?.metadata?.exit;
          return typeof exit === 'number' && exit !== 0;
        },
        (event) => {
          events.push(event);
        }
      );
      turn.begin('lifemodel/task');
      for (const [id, exit] of [
        ['bad', 7],
        ['good', 0],
      ] as const) {
        turn.update({
          sessionUpdate: 'tool_call',
          toolCallId: id,
          status: 'in_progress',
          kind: 'execute',
          title: `command ${id}`,
          rawInput: { command: `echo ${id}` },
        });
        turn.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          status: 'completed',
          rawOutput: { metadata: { exit }, output: 'TRACE-SECRET-CANARY output' },
        });
      }
      if (recovered)
        turn.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Finished after probing' },
        });
      else turn.update({ sessionUpdate: 'tool_call', toolCallId: 'trailing', status: 'failed' });
      const result = turn.result('end_turn');
      turn.finish(result, { stopReason: 'end_turn' });
      await Promise.resolve(); // detached trace callbacks, not a timer/tick guess
      expect(result).toMatchObject(
        recovered
          ? { outcome: 'succeeded', result: 'Finished after probing' }
          : {
              outcome: 'failed',
              reasonCode: 'required_tool_failed',
              failureSpanId: expect.any(String),
            }
      );
      const now = new Date().toISOString();
      const spans = [
        {
          spanId: f.task.launchId,
          parentSpanId: f.task.parentSpanId,
          component: 'task',
          startedAt: now,
          endedAt: now,
          status: recovered ? ('ok' as const) : ('failed' as const),
          attrs: {
            taskId: f.task.id,
            launchId: f.task.launchId,
            failureSpanId: result.failureSpanId
              ? `${f.task.launchId}_${result.failureSpanId}`
              : null,
            outcome: result.outcome,
            reasonCode: result.reasonCode,
          },
        },
        ...events.flatMap((event) =>
          event.type === 'trace'
            ? [
                {
                  ...event.span,
                  spanId: `${f.task.launchId}_${event.span.spanId}`,
                  parentSpanId: event.span.parentSpanId
                    ? `${f.task.launchId}_${event.span.parentSpanId}`
                    : f.task.launchId,
                },
              ]
            : []
        ),
      ];
      for (const span of spans) {
        const response = await call(channel.url, f.token, step(f.task), {
          path: '/task/trace',
          raw: JSON.stringify({
            taskId: f.task.id,
            attemptId: f.task.attemptId,
            launchId: f.task.launchId,
            span: { ...span, traceId: f.task.traceId },
          }),
        });
        expect(response.status).toBe(200);
      }
      await writer.flush();
      const persisted = (
        await stores.postgres.query('SELECT * FROM observability.trace_spans WHERE trace_id=$1', [
          f.task.traceId,
        ])
      ).rows;
      const tools = persisted.filter((row) => row.component === 'task.tool');
      expect(tools).toHaveLength(recovered ? 2 : 3);
      expect(tools.find((row) => row.attrs.exitCode === 7)).toMatchObject({ status: 'failed' });
      expect(tools.find((row) => row.attrs.exitCode === 0)).toMatchObject({ status: 'ok' });
      const root = persisted.find((row) => row.component === 'task');
      expect(root.status).toBe(recovered ? 'ok' : 'failed');
      expect(root.attrs.failureSpanId).toBe(
        recovered ? null : tools.find((row) => row.attrs.toolCallId === 'trailing').span_id
      );
      expect(JSON.stringify(persisted)).not.toContain('TRACE-SECRET-CANARY');
      expect((await stores.postgres.query('SELECT * FROM core.task_mailbox')).rows).toEqual([]);
      // A different trace identity cannot insert observations into another run.
      expect(
        (
          await call(channel.url, f.token, step(f.task), {
            path: '/task/trace',
            raw: JSON.stringify({
              taskId: f.task.id,
              attemptId: f.task.attemptId,
              launchId: f.task.launchId,
              span: { ...spans[0], traceId: 'other_trace' },
            }),
          })
        ).status
      ).toBe(403);
    }
  );

  it('scrubs credential-name parts in all four fields and structured keys in real transport', async () => {
    const f = await fixture('credential-name-parts');
    const sample = credentialNameCases('transport');
    const { structured, ...fields } = sample.attrs;
    // The wire schema permits only scalar attrs; exercise structured sensitive
    // keys directly in that bag, not an invalid nested transport frame.
    const attrs = { ...fields, ...structured };
    const { canaries } = sample;
    const received = Promise.withResolvers<TaskTraceFrame['span']>();
    const channel = await listener({
      onTrace: (frame) => {
        received.resolve(frame.span);
      },
    });
    const tokenFile = join(directory, `trace-token-${f.task.id}`);
    await writeFile(tokenFile, f.token);
    const transport = createTaskTraceChannel({
      endpoint: { endpoint: channel.url, tokenFile, caFile },
      env: {},
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      traceId: f.task.traceId,
    });
    cleanup.push(() => transport.close());
    transport.enqueue({
      traceId: f.task.traceId,
      spanId: `${f.task.launchId}_names`,
      parentSpanId: f.task.launchId,
      component: 'task.tool',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      status: 'ok',
      attrs,
    });
    const captured = await bounded(received.promise);
    expect(transport.droppedCount).toBe(0);
    for (const field of [
      'command',
      'outputTail',
      'finalText',
      'model',
      ...Object.keys(structured),
    ]) {
      const text = JSON.stringify(captured.attrs[field]);
      for (const canary of canaries)
        expect.soft(text.includes(canary), `transport ${field} leaked`).toBe(false);
      expect(text).toContain('[REDACTED]');
    }
    expect(captured.attrs['ordinary']).toBe(attrs.ordinary);
  });

  it('scrubs quoted and unquoted auth credentials through ACP, launcher trace transport and database rows', async () => {
    const f = await fixture('quoted-credentials');
    // These opaque credentials are not projected tokens or test-only knownSecrets.
    const canaries = [
      'opaque-CANARY-json-password-5e9d',
      'opaque-CANARY-json-token-5e9d',
      'opaque-CANARY-shell-password-5e9d',
      'opaque-CANARY-shell-secret-5e9d',
      'opaque-CANARY-escaped-json-5e9d',
      'opaque-CANARY-nested-json-5e9d',
      'opaque-CANARY-escaped-shell-5e9d',
      'opaque-CANARY-unquoted-bearer-5e9d',
      'opaque-CANARY-unquoted-basic-5e9d',
      'opaque-CANARY-token-scheme-5e9d',
      'opaque-CANARY-digest-username-5e9d',
      'opaque-CANARY-digest-response-5e9d',
      'opaque-CANARY-unknown-scheme-5e9d',
      'opaque-CANARY-quoted-header-5e9d',
      'opaque-CANARY-nested-header-5e9d',
    ];
    const content = [
      JSON.stringify({ password: canaries[0] }),
      JSON.stringify({ token: canaries[1] }),
      `password="${canaries[2]} with spaces"`,
      `secret='${canaries[3]} with spaces'`,
      JSON.stringify(JSON.stringify({ api_key: canaries[4] })),
      JSON.stringify({ output: JSON.stringify({ password: canaries[5] }) }),
      JSON.stringify(`token="${canaries[6]} with spaces"`),
      `Authorization: Bearer ${canaries[7]}`,
      `Authorization: Basic ${canaries[8]}`,
      `Authorization: Token ${canaries[9]}`,
      `Authorization: Digest username="${canaries[10]}", response="${canaries[11]} with spaces,commas"`,
      `aUtHoRiZaTiOn: CustomProof ${canaries[12]}`,
      `curl -H 'Authorization: ApiKey ${canaries[13]}' safe-header-suffix`,
      JSON.stringify(
        JSON.stringify(
          `curl -H 'Authorization: Digest response="${canaries[14]}"' safe-nested-suffix`
        )
      ),
      '', // A bare header ends at newline, not at the end of its first word.
    ].join('\n');
    const writer = createPostgresTraceStore({ pool: stores.postgres });
    cleanup.push(() => writer.close());
    const received: TaskTraceFrame['span'][] = [];
    let receivedAll!: () => void;
    const allFrames = new Promise<void>((resolve) => {
      receivedAll = resolve;
    });
    const channel = await listener({
      onTrace: (frame) => {
        received.push(frame.span);
        writer.enqueue({ kind: 'span', span: frame.span });
        // Model open, tool open, tool close and model close.
        if (received.length === 4) receivedAll();
      },
    });
    const taskTokenFile = join(directory, `trace-token-${f.task.id}`);
    await writeFile(taskTokenFile, f.token);
    const transport = createTaskTraceChannel({
      endpoint: { endpoint: channel.url, tokenFile: taskTokenFile, caFile },
      env: {},
      identity: { taskId: f.task.id, attemptId: f.task.attemptId, launchId: f.task.launchId },
      traceId: f.task.traceId,
    });
    cleanup.push(() => transport.close());
    const turn = new AcpTurn(undefined, (event) => {
      if (event.type !== 'trace') return;
      transport.enqueue({
        ...event.span,
        spanId: `${f.task.launchId}_${event.span.spanId}`,
        parentSpanId: event.span.parentSpanId
          ? `${f.task.launchId}_${event.span.parentSpanId}`
          : f.task.launchId,
      });
    });
    turn.begin('lifemodel/task');
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'quoted-credentials',
      status: 'in_progress',
      kind: 'execute',
      rawInput: { command: `safe-command-prefix ${content} safe-command-suffix` },
    });
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'quoted-credentials',
      status: 'completed',
      rawOutput: {
        metadata: { exit: 0 },
        output: `safe-output-prefix ${content} safe-output-suffix`,
      },
    });
    turn.finish(turn.result('end_turn'), { stopReason: 'end_turn' });
    await bounded(allFrames);
    await writer.flush();
    expect(transport.droppedCount).toBe(0);
    expect(writer.droppedCount).toBe(0);
    const persisted = (
      await stores.postgres.query(
        "SELECT attrs FROM observability.trace_spans WHERE trace_id=$1 AND component='task.tool'",
        [f.task.traceId]
      )
    ).rows;
    expect(persisted).toHaveLength(1);
    // Assert every field and boundary independently: safe storage must not mask
    // an unsafe launcher request, nor may a command check mask an output-tail leak.
    const receivedTool = received.find(
      (span) => span.component === 'task.tool' && span.endedAt !== null
    );
    expect(receivedTool).toBeDefined();
    for (const [boundary, attrs] of [
      ['transport', receivedTool?.attrs],
      ['database', persisted[0].attrs],
    ] as const) {
      for (const field of ['command', 'outputTail']) {
        for (const canary of canaries) {
          expect.soft(attrs?.[field], `${boundary} ${field}: ${canary}`).not.toContain(canary);
        }
      }
    }
    expect(persisted[0].attrs).toMatchObject({
      command: expect.stringContaining('safe-command-prefix'),
      outputTail: expect.stringContaining('safe-output-suffix'),
      exitCode: 0,
    });
    expect(persisted[0].attrs.command).toContain('[REDACTED]');
    expect(persisted[0].attrs.outputTail).toContain('[REDACTED]');
  });

  it('a stalled trace body cannot consume the terminal byte reservation', async () => {
    const f = await fixture();
    const frame: TaskChannelFrame = {
      ...step(f.task),
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        summary: 'ready',
        resultObjectId: null,
        artifactObjectIds: [],
      },
    };
    const budget = Buffer.byteLength(JSON.stringify(frame));
    const channel = await listener({ settings: { 'tasks.channel.maxBufferedBytes': budget } });
    const held = await rawSocket(channel.url);
    const admitted = new Promise<void>((resolve) => {
      channel.server.once('request', () => {
        resolve();
      });
    });
    held.write(
      `POST /task/trace HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${f.token}\r\nContent-Type: application/json\r\nContent-Length: ${budget}\r\n\r\n{`
    );
    await admitted; // receive() already reserved trace bytes before this listener ran
    // Send a second request after the first socket's headers/body entered intake.
    // A 429 would prove trace traffic spent the mailbox reservation.
    const response = await call(channel.url, f.token, frame);
    expect(response.status).toBe(200);
    expect(await rows(frame)).toHaveLength(1);
  });

  it('logs fixed routes and authenticated trace locators on storage refusal without content', async () => {
    const f = await fixture('trace-diagnostic');
    const channel = await listener({
      mailbox: {
        ...mailbox,
        readTraceAuthority: async () => {
          throw new TaskChannelError(503, 'storage_error');
        },
      },
    });
    const span = {
      traceId: f.task.traceId,
      spanId: f.task.launchId,
      parentSpanId: null,
      component: 'task',
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: null,
      attrs: { command: PAYLOAD },
    };
    const options = {
      path: '/task/trace',
      raw: JSON.stringify({
        taskId: f.task.id,
        attemptId: f.task.attemptId,
        launchId: f.task.launchId,
        span,
      }),
    };
    expect((await call(channel.url, 'unverified', step(f.task), options)).status).toBe(403);
    expect(logs.at(-1)?.obj).toMatchObject({ route: 'POST /task/trace', code: 'identity_denied' });
    expect(logs.at(-1)?.obj).not.toHaveProperty('taskId');
    const forged = JSON.parse(options.raw);
    forged.taskId = PAYLOAD;
    forged.span.traceId = MODULE_TOKEN;
    expect(
      (await call(channel.url, f.token, step(f.task), { ...options, raw: JSON.stringify(forged) }))
        .status
    ).toBe(503);
    expect(logs.at(-1)?.obj).not.toHaveProperty('taskId');
    expect(logs.at(-1)?.obj).not.toHaveProperty('traceId');
    expect((await call(channel.url, f.token, step(f.task), options)).status).toBe(503);
    expect(logs.at(-1)?.obj).toMatchObject({
      route: 'POST /task/trace',
      status: 503,
      code: 'storage_error',
      taskId: f.task.id,
      traceId: f.task.traceId,
    });
    expect(
      (await call(channel.url, f.token, step(f.task), { path: `/private?${URL_CANARY}` })).status
    ).toBe(404);
    expect(logs.at(-1)?.obj).toMatchObject({ route: 'unknown', code: 'route_absent' });
    for (const secret of [PAYLOAD, URL_CANARY, f.token, MODULE_TOKEN])
      expect(JSON.stringify(logs)).not.toContain(secret);
    // Disposable evidence failure did not consume the terminal channel.
    const terminal: TaskChannelFrame = {
      ...step(f.task),
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        summary: 'done',
        resultObjectId: null,
        artifactObjectIds: [],
      },
    };
    expect((await call(channel.url, f.token, terminal)).status).toBe(200);
    expect(await rows(terminal)).toHaveLength(1);
  });

  it('trace authority never waits on an exclusive task/launch row owner', async () => {
    const f = await fixture();
    const lock = await stores.postgres.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [f.task.id]);
      await lock.query('SELECT launch_id FROM core.task_launches WHERE task_id=$1 FOR UPDATE', [
        f.task.id,
      ]);
      const proof = {
        podUid: f.podUid,
        podName: f.podName,
        jobUid: f.task.jobUid!,
        jobName: f.task.jobName,
        launchLabel: f.task.launchId.slice(7, 65),
        templateHash: f.task.templateHash!,
        startedAt: f.job.status.startTime,
      };
      const authority = await mailbox.readTraceAuthority!(proof, AbortSignal.timeout(500));
      expect(authority).toMatchObject({ taskId: f.task.id, traceId: f.task.traceId, briefing: '' });
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
  });

  it('commits before ACK headers, stores replay once, and accepts gaps and lower sequences', async () => {
    const f = await fixture();
    const channel = await listener();
    const high = step(f.task, 80);
    const first = await call(channel.url, f.token, high, { inspectRow: true });
    expect(first.status).toBe(200);
    expect(first.rowsAtReceipt).toHaveLength(1);
    expect(first.rowsAtReceipt![0]).toMatchObject({
      task_id: f.task.id,
      message_id: high.messageId,
      sequence: '80',
      payload: high.payload,
    });
    const replay = await call(channel.url, f.token, high, { inspectRow: true });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.rowsAtReceipt).toHaveLength(1);
    const lower = step(f.task, 3);
    const later = step(f.task, 100);
    for (const frame of [lower, later]) {
      const response = await call(channel.url, f.token, frame, { inspectRow: true });
      expect(response.status).toBe(200);
      expect(response.rowsAtReceipt).toHaveLength(1);
    }
    expect(
      (await mailbox.listUnsignalled(10)).map((entry) => entry.frame.messageId).sort()
    ).toEqual([high.messageId, lower.messageId, later.messageId].sort());
  });

  it.each([
    'wrong-audience',
    'unbound',
    'unclaimed',
    'loser-pod',
    'terminal',
    'unknown-attempt',
  ] as const)('refuses %s without storing a frame', async (fault) => {
    const f = await fixture('one', fault !== 'unclaimed');
    let token = f.token;
    let frame = step(f.task);
    if (fault === 'wrong-audience') tokens.get(token)!.audience = 'lifemodel-task-model';
    if (fault === 'unbound') tokens.get(token)!.bound = false;
    if (fault === 'loser-pod') token = registerPod(f.task, 'loser').token;
    if (fault === 'unknown-attempt') frame = { ...frame, attemptId: randomUUID() };
    if (fault === 'terminal')
      await finalizeTaskFixture(stores.postgres, registry, f.task, {
        state: 'done',
        reasonCode: 'succeeded',
        summary: 'Completed fixture',
      });
    const channel = await listener();
    const response = await call(channel.url, token, frame);
    expect([403, 409]).toContain(response.status);
    expect(await rows(frame)).toEqual([]);
  });

  it('stores semantic terminal object IDs once and refuses a different second terminal report', async () => {
    const f = await fixture();
    const channel = await listener();
    const terminal: TaskChannelFrame = {
      ...step(f.task, 7),
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        summary: PAYLOAD,
        resultObjectId: 'object-result',
        artifactObjectIds: ['object-artifact'],
      },
    };
    const ack = await call(channel.url, f.token, terminal, { inspectRow: true });
    expect(ack.status).toBe(200);
    expect(ack.rowsAtReceipt).toHaveLength(1);
    expect(ack.rowsAtReceipt![0].payload).toEqual(terminal.payload);
    expect((await call(channel.url, f.token, terminal)).body).toEqual(ack.body);
    const other = { ...terminal, messageId: randomUUID(), sequence: 8 };
    expect((await call(channel.url, f.token, other)).status).toBe(409);
    expect(await rows(other)).toEqual([]);
  });

  it('rechecks live identity on each keep-alive request and denies Kubernetes outage', async () => {
    const f = await fixture();
    const channel = await listener();
    expect((await call(channel.url, f.token, step(f.task))).status).toBe(200);
    expect(reviews.at(-1)).toEqual([AUDIENCE]);
    tokens.get(f.token)!.authenticated = false;
    const revoked = step(f.task, 2);
    expect((await call(channel.url, f.token, revoked)).status).toBe(403);
    expect(await rows(revoked)).toEqual([]);
    tokens.get(f.token)!.authenticated = true;
    apiStatus = 503;
    const unavailable = step(f.task, 3);
    expect((await call(channel.url, f.token, unavailable)).status).toBe(503);
    expect(await rows(unavailable)).toEqual([]);
  });

  it('never logs payload, token, URL or raw identity errors', async () => {
    const f = await fixture();
    const channel = await listener();
    expect((await call(channel.url, f.token, step(f.task))).status).toBe(200);
    expect(
      (await call(channel.url, f.token, step(f.task), { path: `/task/events?${URL_CANARY}` }))
        .status
    ).toBe(404);
    tokens.get(f.token)!.authenticated = false;
    expect((await call(channel.url, f.token, step(f.task))).status).toBe(403);
    apiStatus = 503;
    await call(channel.url, f.token, step(f.task));
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [PAYLOAD, f.token, MODULE_TOKEN, URL_CANARY, origin])
      expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('a stalled task connection cannot delay 20 durable owner intakes or 20 other-task ACKs beyond 2 seconds', async () => {
    const stalled = await fixture('stalled');
    const healthy = await fixture('healthy');
    const channel = await listener();
    const socket = await rawSocket(channel.url);
    // This peer never reads ACKs. Its complete first event must still commit,
    // and its next incomplete frame reserves memory, never a control SQL worker.
    socket.pause();
    const committed = step(stalled.task);
    socket.write(wire(stalled.token, JSON.stringify(committed)));
    await expect.poll(async () => (await rows(committed)).length).toBe(1);
    const held = JSON.stringify(step(stalled.task, 2));
    const entered = Promise.withResolvers<void>();
    channel.server.once('request', () => entered.resolve());
    socket.write(wire(stalled.token, held.slice(0, -1), Buffer.byteLength(held)));
    await bounded(entered.promise);
    const owner = new OwnerMessageIntake(stores.redis, 'owner');
    const ownerRequests = Array.from({ length: 20 }, async () => {
      const start = performance.now();
      const accepted = await owner.acceptOwnerMessage(ownerId(), 'owner intake');
      expect(accepted.status).toBe('accepted');
      expect(performance.now() - start).toBeLessThanOrEqual(2000);
    });
    const taskRequests = Array.from({ length: 20 }, async (_, index) => {
      const start = performance.now();
      const response = await call(channel.url, healthy.token, step(healthy.task, index * 3 + 1));
      expect(response.status).toBe(200);
      expect(performance.now() - start).toBeLessThanOrEqual(2000);
    });
    await Promise.all([...ownerRequests, ...taskRequests]);
    expect(await stores.redis.xlen('inbound')).toBe(20);
  }, 10000);

  it('refuses an oversized frame without identity lookup or a mailbox insert', async () => {
    const f = await fixture();
    const channel = await listener();
    const frame = step(f.task);
    const before = reviews.length;
    const response = await call(channel.url, f.token, frame, {
      raw: JSON.stringify({ ...frame, payload: { line: 'x'.repeat(65536) } }),
    });
    expect(response.status).toBe(413);
    expect(reviews).toHaveLength(before);
    expect(await rows(frame)).toEqual([]);
  });

  it('returns 429 with Retry-After when held bodies fill the process buffer; owner intake remains available', async () => {
    const f = await fixture();
    const held = JSON.stringify(step(f.task));
    const channel = await listener({
      settings: {
        'tasks.channel.maxFrameBytes': 1024,
        'tasks.channel.maxBufferedBytes': Buffer.byteLength(held),
      },
    });
    const socket = await rawSocket(channel.url);
    const entered = Promise.withResolvers<void>();
    channel.server.once('request', () => entered.resolve());
    socket.write(wire(f.token, held.slice(0, -1), Buffer.byteLength(held)));
    await bounded(entered.promise);
    const refused = step(f.task, 2);
    const response = await call(channel.url, f.token, refused);
    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBeDefined();
    expect(await rows(refused)).toEqual([]);
    expect(
      (
        await new OwnerMessageIntake(stores.redis, 'owner').acceptOwnerMessage(
          ownerId(),
          'owner reserve'
        )
      ).status
    ).toBe('accepted');
  });

  it.each(['frames', 'bytes'] as const)(
    'bounds per-connection unacked %s even with HTTP pipelining',
    async (bound) => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let appends = 0;
      const gated: TaskMailbox = {
        ...mailbox,
        append: async (...args) => {
          appends++;
          if (appends === 1) {
            entered.resolve();
            await release.promise;
          }
          return mailbox.append(...args);
        },
      };
      const channel = await listener({
        mailbox: gated,
        settings: {
          'tasks.channel.maxFrameBytes': 1024,
          ...(bound === 'frames'
            ? { 'tasks.channel.maxUnackedFrames': 2 }
            : {
                'tasks.channel.maxUnackedBytes':
                  2 * Buffer.byteLength(JSON.stringify(step(f.task))),
              }),
        },
      });
      const socket = await rawSocket(channel.url);
      const frames = [step(f.task, 1), step(f.task, 2), step(f.task, 3)];
      let response = '';
      const done = Promise.withResolvers<void>();
      socket.on('data', (chunk) => {
        response += chunk.toString();
        if (response.includes('429 Too Many Requests')) done.resolve();
      });
      socket.on('close', () => done.resolve());
      let requests = 0;
      const admitted = Promise.withResolvers<void>();
      channel.server.on('request', () => {
        if (++requests === 3) admitted.resolve();
      });
      socket.write(frames.map((frame) => wire(f.token, JSON.stringify(frame))).join(''));
      try {
        await bounded(entered.promise);
        // Node sends pipelined replies in request order. Release the first ACK
        // only after all request handlers have admitted/refused the pipeline.
        await bounded(admitted.promise);
      } finally {
        release.resolve();
      }
      await bounded(done.promise);
      expect(response).toContain('429 Too Many Requests');
      expect(response.toLowerCase()).toContain('retry-after:');
      expect(await rows(frames[2]!)).toEqual([]);
      expect(appends).toBeLessThanOrEqual(2);
    }
  );

  it('bounds active SQL work separately from queued task frames and owner intake', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    const firstEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const gated: TaskMailbox = {
      ...mailbox,
      append: async (...args) => {
        active++;
        peak = Math.max(peak, active);
        firstEntered.resolve();
        try {
          await release.promise;
          return await mailbox.append(...args);
        } finally {
          active--;
        }
      },
    };
    const channel = await listener({
      mailbox: gated,
      settings: { 'tasks.channel.workers': 2, 'tasks.channel.sqlConnections': 1 },
    });
    const first = call(channel.url, a.token, step(a.task));
    void first.catch(() => undefined);
    await bounded(firstEntered.promise);
    const observedSecond = Promise.withResolvers<void>();
    channel.server.once('request', (req) => req.once('end', () => observedSecond.resolve()));
    const second = call(channel.url, b.token, step(b.task));
    void second.catch(() => undefined);
    try {
      await bounded(observedSecond.promise);
      expect(active).toBe(1);
      const started = performance.now();
      expect(
        (
          await new OwnerMessageIntake(stores.redis, 'owner').acceptOwnerMessage(
            ownerId(),
            'still accepted'
          )
        ).status
      ).toBe('accepted');
      expect(performance.now() - started).toBeLessThanOrEqual(2000);
    } finally {
      release.resolve();
    }
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(peak).toBe(1);
  });

  it('expires an unacknowledged append at the configured ACK deadline and releases its worker', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let calls = 0;
    const gated: TaskMailbox = {
      ...mailbox,
      append: async (...args) => {
        if (++calls !== 1) return mailbox.append(...args);
        const signal = args[2]!;
        entered.resolve();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => {
            cancelled.resolve();
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
        throw new Error('aborted append must not resume');
      },
    };
    const channel = await listener({
      mailbox: gated,
      settings: {
        'tasks.channel.ackTimeoutMs': 200,
        'tasks.channel.workers': 1,
        'tasks.channel.sqlConnections': 1,
      },
    });
    const frame = step(f.task);
    const socket = await rawSocket(channel.url);
    const closed = Promise.withResolvers<void>();
    socket.once('close', () => closed.resolve());
    socket.resume();
    const start = performance.now();
    socket.write(wire(f.token, JSON.stringify(frame)));
    await bounded(entered.promise);
    await bounded(cancelled.promise, 1500);
    await bounded(closed.promise, 1500);
    expect(performance.now() - start).toBeLessThanOrEqual(1500);
    expect(logs.some((line) => line.obj.code === 'ack_timeout' && line.obj.status === 504)).toBe(
      true
    );
    expect(await rows(frame)).toEqual([]);
    expect((await call(channel.url, f.token, step(f.task, 2))).status).toBe(200);
  });

  it('notifies replay when a peer disconnects after commit but before append settles', async () => {
    const f = await fixture();
    const committed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const notified = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const frame = step(f.task);
    const channel = createTaskChannel({
      tls: { cert: certificate.cert, key: certificate.key },
      mailbox: {
        append: async (...args) => {
          const ack = await mailbox.append(...args);
          committed.resolve();
          await resume.promise;
          finished.resolve();
          return ack;
        },
      },
      identity,
      settings: values,
      logger: createTestLogger(),
      onStored: () => notified.resolve(),
    });
    const url = await listen(channel.server);
    cleanup.push(() => channel.stop(Date.now() + 1000));
    const socket = await rawSocket(url);
    const closed = Promise.withResolvers<void>();
    channel.server.once('request', (_req, res) => res.once('close', () => closed.resolve()));
    socket.write(wire(f.token, JSON.stringify(frame)));
    try {
      await bounded(committed.promise);
      socket.destroy();
      await bounded(closed.promise);
    } finally {
      resume.resolve();
    }
    await bounded(finished.promise);
    await bounded(notified.promise);
    expect(await rows(frame)).toHaveLength(1);
  });

  it('reclaims partial-frame reservations when TLS peers disconnect', async () => {
    const f = await fixture();
    const channel = await listener({
      settings: { 'tasks.channel.maxFrameBytes': 1024, 'tasks.channel.maxBufferedBytes': 1024 },
    });
    for (let index = 0; index < 3; index++) {
      const socket = await rawSocket(channel.url);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      channel.server.once('request', (req, res) => {
        res.once('close', () => released.resolve());
        entered.resolve();
      });
      const held = JSON.stringify(step(f.task, index + 1));
      socket.write(wire(f.token, held.slice(0, -1), Buffer.byteLength(held)));
      await bounded(entered.promise);
      socket.destroy();
      await bounded(released.promise);
    }
    expect((await call(channel.url, f.token, step(f.task, 10))).status).toBe(200);
  });

  it.each(['tasks.channel.maxUnackedBytes', 'tasks.channel.maxBufferedBytes'] as const)(
    'admits a small fixed-length frame with a lowered %s and the default frame ceiling',
    async (key) => {
      const f = await fixture();
      const projection = join(directory, 'settings.json');
      await writeFile(
        projection,
        JSON.stringify({ version: 1, revision: 1, values: { [key]: 32_768 } })
      );
      const projected = await createPlatformSettingsReader({
        dir: directory,
        logger: createTestLogger('silent'),
      }).read();
      expect(projected.values[key]).toBe(32_768);
      expect(projected.values['tasks.channel.maxFrameBytes']).toBe(65_536);
      const channel = await listener({ settings: projected.values });
      const response = await call(channel.url, f.token, step(f.task), { inspectRow: true });
      expect(response.status).toBe(200);
      expect(response.rowsAtReceipt).toHaveLength(1);
      const before = reviews.length;
      expect(
        (await call(channel.url, f.token, step(f.task, 2), { raw: ' '.repeat(32_769) })).status
      ).toBe(413);
      expect(reviews).toHaveLength(before);
    }
  );

  it('caps pre-authentication intake at 64 pending requests even for tiny bodies', async () => {
    const f = await fixture();
    const channel = await listener();
    const sockets: TLSSocket[] = [];
    const before = reviews.length;
    let admitted = 0;
    try {
      for (let index = 0; index < 64; index++) {
        const socket = await rawSocket(channel.url);
        sockets.push(socket);
        const entered = Promise.withResolvers<void>();
        channel.server.once('request', () => {
          admitted++;
          entered.resolve();
        });
        socket.write(wire(f.token, '{', 2));
        await bounded(entered.promise);
      }
      expect(admitted).toBe(64);
      expect(reviews).toHaveLength(before);
      const response = await call(channel.url, f.token, step(f.task));
      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('1');
      expect(reviews).toHaveLength(before);
    } finally {
      for (const socket of sockets) socket.destroy();
    }
  });

  it('isolates slow pre-authentication for forged task IDs from healthy task workers', async () => {
    const noisy = await fixture('noisy');
    const healthy = await fixture('healthy');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let verifying = 0;
    let peak = 0;
    const channel = await listener({
      identity: {
        ...identity,
        verify: async (token, signal) => {
          if (token !== noisy.token) return identity.verify(token, signal);
          verifying++;
          peak = Math.max(peak, verifying);
          entered.resolve();
          try {
            await release.promise;
            return await identity.verify(token, signal);
          } finally {
            verifying--;
          }
        },
      },
    });
    const requests = Array.from({ length: 12 }, (_, index) =>
      call(channel.url, noisy.token, { ...step(noisy.task, index + 1), taskId: `forged-${index}` })
    );
    void Promise.all(requests).catch(() => undefined);
    try {
      await bounded(entered.promise);
      const started = performance.now();
      const response = await bounded(call(channel.url, healthy.token, step(healthy.task)), 1500);
      expect(response.status).toBe(200);
      expect(performance.now() - started).toBeLessThanOrEqual(1500);
      expect(peak).toBe(1);
      expect(verifying).toBe(1);
      expect(
        (await new OwnerMessageIntake(stores.redis, 'owner').acceptOwnerMessage(ownerId(), 'owner'))
          .status
      ).toBe('accepted');
    } finally {
      release.resolve();
      await Promise.all(requests);
    }
    expect((await Promise.all(requests)).every((response) => response.status === 403)).toBe(true);
  });

  it('gives one verified Job one worker share even across tokens and forged task IDs', async () => {
    const noisy = await fixture('noisy');
    const healthy = await fixture('healthy');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let active = 0;
    let peak = 0;
    const channel = await listener({
      mailbox: {
        ...mailbox,
        append: async (...args) => {
          if (args[1].jobUid !== noisy.task.jobUid) return mailbox.append(...args);
          active++;
          peak = Math.max(peak, active);
          entered.resolve();
          try {
            await release.promise;
            return await mailbox.append(...args);
          } finally {
            active--;
          }
        },
      },
    });
    const requests = Array.from({ length: 8 }, (_, index) => {
      const token = `${noisy.token}-${index}`;
      tokens.set(token, { ...tokens.get(noisy.token)! });
      return call(channel.url, token, {
        ...step(noisy.task, index + 1),
        taskId: `forged-${index}`,
      });
    });
    void Promise.all(requests).catch(() => undefined);
    try {
      await bounded(entered.promise);
      const response = await bounded(call(channel.url, healthy.token, step(healthy.task)), 1500);
      expect(response.status).toBe(200);
      expect(peak).toBe(1);
    } finally {
      release.resolve();
      await Promise.all(requests);
    }
    expect(peak).toBe(1);
    expect((await Promise.all(requests)).every((response) => response.status === 403)).toBe(true);
  });

  it('schedules one frame per task per pass rather than draining a noisy task first', async () => {
    const a = await fixture('a');
    const b = await fixture('b');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];
    const gated: TaskMailbox = {
      ...mailbox,
      append: async (...args) => {
        order.push(args[0].taskId);
        if (order.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return mailbox.append(...args);
      },
    };
    const channel = await listener({
      mailbox: gated,
      settings: {
        'tasks.channel.workers': 1,
        'tasks.channel.sqlConnections': 1,
      },
    });
    const first = call(channel.url, a.token, step(a.task, 1));
    void first.catch(() => undefined);
    await bounded(entered.promise);
    const queued = Promise.withResolvers<void>();
    let bodies = 0;
    channel.server.on('request', (req) =>
      req.once('end', () => {
        if (++bodies === 3) queued.resolve();
      })
    );
    const next = [
      call(channel.url, a.token, step(a.task, 2)),
      call(channel.url, a.token, step(a.task, 3)),
      call(channel.url, b.token, step(b.task, 1)),
    ];
    void Promise.all(next).catch(() => undefined);
    try {
      await bounded(queued.promise);
    } finally {
      release.resolve();
    }
    expect((await Promise.all([first, ...next])).map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(order).toEqual([a.task.id, b.task.id, a.task.id, a.task.id]);
  });
});
