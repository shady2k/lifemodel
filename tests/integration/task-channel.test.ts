import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Agent, createServer, request, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import { connect, type TLSSocket } from 'node:tls';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
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
import { createTaskTraceChannel } from '../../loader/src/task-trace-channel.js';
import type { TaskHarnessEvent } from '../../loader/src/task-harness.js';
import { createTaskChannel } from '../../src/core/task-channel.js';
import { createTaskKubernetesIdentity } from '../../src/core/task-kubernetes-identity.js';
import { createTaskKubernetesIdentity as createModelIdentity } from '../../loader/src/task-kubernetes-identity.js';
import { createTaskIdentity } from '../../loader/src/task-identity.js';
import { renderTaskJob, TASK_TEMPLATE_HASH } from '../../src/core/kubernetes-task-executor.js';
import type { TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';
import type {
  TaskChannelFrame,
  TaskMailbox,
  TaskTraceFrame,
} from '../../src/ports/task-channel.js';

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
      mailbox?: TaskMailbox;
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
  function ownerId() {
    const time = Date.now().toString(16).padStart(12, '0');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(0, 3)}-8${randomUUID().slice(0, 3)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  }

  it('persists an ACP failed/successful tool tree without mailbox rows and names the culprit', async () => {
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
    turn.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Finished after probing' },
    });
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await Promise.resolve(); // detached trace callbacks, not a timer/tick guess
    expect(result).toMatchObject({
      outcome: 'failed',
      reasonCode: 'required_tool_failed',
      failureSpanId: expect.any(String),
    });
    const now = new Date().toISOString();
    const spans = [
      {
        spanId: f.task.launchId,
        parentSpanId: f.task.parentSpanId,
        component: 'task',
        startedAt: now,
        endedAt: now,
        status: 'failed' as const,
        attrs: {
          taskId: f.task.id,
          launchId: f.task.launchId,
          failureSpanId: `${f.task.launchId}_${result.failureSpanId}`,
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
    expect(tools).toHaveLength(2);
    expect(tools.find((row) => row.attrs.exitCode === 7)).toMatchObject({ status: 'failed' });
    expect(tools.find((row) => row.attrs.exitCode === 0)).toMatchObject({ status: 'ok' });
    const root = persisted.find((row) => row.component === 'task');
    expect(root.attrs.failureSpanId).toBe(tools.find((row) => row.attrs.exitCode === 7).span_id);
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
