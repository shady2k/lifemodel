/** Real pressure boundary: isolated PostgreSQL, SigV4 S3, TLS Kubernetes API. */
import { createServer, connect, type Socket } from 'node:net';
import { request, type ClientRequest } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { createTestStores, workerDatabaseUrl } from './test-stores.js';
import { applyTestMigrations } from './apply-test-migrations.js';
import { createSealIdentity } from './storage-seal-identity.js';
import { createSealS3 } from './storage-seal-s3.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import {
  createStorageAdmission,
  type StorageAdmissionSettings,
} from '../../loader/src/storage-admission.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { checkS3Bucket } from '../../loader/src/storage-s3.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

export const CHUNK = 4 * 1024 * 1024;
export const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Counts actual connections, not a mocked Agent/Pool method. */
async function countedProxy(target: URL) {
  const sockets = new Set<Socket>();
  let connections = 0;
  let blocked = false;
  const server = createServer((front) => {
    connections++;
    front.on('error', () => undefined);
    if (blocked) {
      front.destroy();
      return;
    }
    const back = connect({ host: target.hostname, port: Number(target.port || 5432) });
    for (const socket of [front, back]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => {
        sockets.delete(socket);
        front.destroy();
        back.destroy();
      });
    }
    front.pipe(back);
    back.pipe(front);
  });
  server.on('error', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('pressure proxy unavailable');
  const url = new URL(target);
  url.hostname = 'localhost';
  url.port = String(address.port);
  return {
    url: url.toString(),
    get connections() {
      return connections;
    },
    drop() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      blocked = false;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export interface PressureReply {
  status: number;
  body: Buffer;
  json: any;
  retryAfter: string | undefined;
  elapsed: number;
}
export async function createPressureHarness(settings: Partial<StorageAdmissionSettings> = {}) {
  const stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  stores.postgres.on('connect', (client) => client.on('error', () => undefined));
  await applyTestMigrations(stores.postgres);
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  const api = await createSealIdentity();
  const tlsProxy = await countedProxy(new URL(api.options.apiServer));
  const sqlProxy = await countedProxy(new URL(workerDatabaseUrl()));
  const backend = await createSealS3({ bucket: 'task-output' });
  backend.hooks.beforeBucketCheck = () => ({ status: 200 });
  const identity = createKubernetesStorageIdentity({ ...api.options, apiServer: tlsProxy.url });
  const access = createStorageAccess({ connectionString: sqlProxy.url, identity });
  const admission = createStorageAdmission(settings);
  const s3 = createStorageObjectS3({
    endpoint: backend.endpoint,
    bucket: 'task-output',
    custody: { read: async () => backend.credentials },
  });
  const objects = createStorageObjects({ connectionString: sqlProxy.url, s3, admission });
  const seal = createStorageSeal({ connectionString: sqlProxy.url, s3, access });
  const logs: Parameters<typeof createRecordingLogger>[0] = [];
  const app = createStorageModule({
    bucket: 'task-output',
    access,
    admission,
    objects,
    seal,
    catalog: createCatalog({ connectionString: sqlProxy.url }),
    custody: { read: async () => backend.credentials },
    check: (credentials, signal) =>
      checkS3Bucket({ endpoint: backend.endpoint, bucket: 'task-output', credentials, signal }),
    health: { cacheMs: 0, boundMs: 1000 },
    logger: createRecordingLogger(logs),
    tls: { ...api.certificate, read: async () => api.certificate },
  });
  const ports = {} as Record<'task' | 'control' | 'read', number>;
  for (const role of ['task', 'control', 'read'] as const) {
    await new Promise<void>((resolve) => app[role].server.listen(0, '127.0.0.1', resolve));
    const address = app[role].server.address();
    if (!address || typeof address === 'string') throw Error('pressure listener unavailable');
    ports[role] = address.port;
  }
  for (const space of ['a', 'b', 'reader'])
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [space]);
  for (const task of ['a', 'b']) {
    await stores.postgres.query(
      "INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at) VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')",
      [task]
    );
    await stores.postgres.query(
      "INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) SELECT task_id,attempt_id,launch_id,$2,$3,$1,0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1",
      [task, `job-${task}`, `pod-${task}`]
    );
  }
  // Publish a genuine immutable catalog version. Only the fixture owns this SQL.
  const readBytes = Buffer.alloc(CHUNK, 114);
  const readId = randomUUID(),
    attempt = randomUUID(),
    key = `private/${attempt}`;
  await stores.postgres.query('SELECT storage.reserve_upload($1,$2,$3,$4,$5,$6,3600)', [
    'reader',
    'read-output',
    readId,
    'owner-output',
    readBytes.length,
    digest(readBytes),
  ]);
  await stores.postgres.query(
    'INSERT INTO storage.upload_attempts(id,space_id,upload_id,s3_key) VALUES($1,$2,$3,$4)',
    [attempt, 'reader', 'read-output', key]
  );
  await stores.postgres.query('SELECT storage.complete_upload($1,$2,$3)', [
    'reader',
    'read-output',
    attempt,
  ]);
  await stores.postgres.query("UPDATE storage.objects SET mark='result' WHERE id=$1", [readId]);
  await stores.postgres.query("UPDATE storage.spaces SET mode='sealed' WHERE id='reader'");
  backend.objects.set(key, { bytes: readBytes, sha256: digest(readBytes) });
  const requests = new Set<ClientRequest>();
  function begin(
    role: keyof typeof ports,
    method: string,
    path: string,
    value?: Buffer | Record<string, unknown>,
    token = role === 'control' ? 'core' : role === 'read' ? 'coreRead' : 'a',
    headers: Record<string, string> = {},
    partial = false
  ) {
    const started = performance.now();
    const body = Buffer.isBuffer(value)
      ? value
      : value === undefined
        ? undefined
        : Buffer.from(JSON.stringify(value));
    let req!: ClientRequest;
    const settled = new Promise<PressureReply | null>((resolve, reject) => {
      req = request(
        {
          hostname: 'localhost',
          port: ports[role],
          method,
          path,
          ca: api.certificate.ca,
          agent: false,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { 'content-length': String(body.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          res.on('error', reject);
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks);
            let json: any;
            try {
              json = JSON.parse(bytes.toString());
            } catch {
              /* immutable bytes */
            }
            resolve({
              status: res.statusCode!,
              body: bytes,
              json,
              retryAfter: res.headers['retry-after'],
              elapsed: performance.now() - started,
            });
          });
        }
      );
      req.on('socket', (socket) => socket.on('error', () => undefined));
      req.on('error', () => (partial ? resolve(null) : reject(Error('pressure HTTP failed'))));
      req.setTimeout(partial ? 12_000 : 5000, () => req.destroy(Error('pressure HTTP deadline')));
      requests.add(req);
      req.once('close', () => requests.delete(req));
      if (partial) req.write(Buffer.from('x'));
      else req.end(body);
    });
    // Every client rejection has a handler before a test can abort it.
    void settled.catch(() => undefined);
    const closed = new Promise<void>((resolve) => req.once('close', () => resolve()));
    return { settled, closed, abort: () => req.destroy(), request: req };
  }
  async function call(...args: Parameters<typeof begin>) {
    const reply = await begin(...args).settled;
    if (!reply) throw Error('pressure request aborted');
    return reply;
  }
  function stall(space: 'a' | 'b', id: string, length = CHUNK) {
    return begin(
      'task',
      'PUT',
      `/spaces/${space}/objects/${id}`,
      undefined,
      space,
      {
        'content-length': String(length),
        'x-storage-name': Buffer.from(`${id}.txt`).toString('base64url'),
        'x-storage-length': String(length),
        'x-storage-sha256': digest(Buffer.alloc(length, 120)),
      },
      true
    );
  }
  async function close() {
    for (const req of requests) req.destroy();
    app.task.close();
    app.control.close();
    app.read.close();
    await objects.close();
    await seal.close();
    s3.close();
    await access.close();
    identity.close();
    await tlsProxy.close();
    await sqlProxy.close();
    await backend.close();
    await api.close();
    await stores.postgres.end();
    await stores.redis.quit();
  }
  return {
    stores,
    api,
    tlsProxy,
    sqlProxy,
    backend,
    access,
    admission,
    app,
    logs,
    readId,
    readBytes,
    call,
    begin,
    stall,
    close,
  };
}
