import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { storageObjectIdentity } from '../helpers/storage-object-identity.js';
import { createFakeStorageS3 } from '../helpers/storage-s3-server.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let stores: TestStores;
let identity: Awaited<ReturnType<typeof storageObjectIdentity>>;
let backend: Awaited<ReturnType<typeof createFakeStorageS3>>;
let app: ReturnType<typeof createStorageModule>;
let objects: ReturnType<typeof createStorageObjects>;
let s3: ReturnType<typeof createStorageObjectS3>;
let access: ReturnType<typeof createStorageAccess>;
let catalog: ReturnType<typeof createCatalog>;
const chunkBytes = 4 * 1024 * 1024;
let port: number;
async function start() {
  access = createStorageAccess({
    connectionString: workerDatabaseUrl(),
    identity: identity.identity,
  });
  s3 = createStorageObjectS3({
    endpoint: backend.endpoint,
    bucket: 'task-output',
    custody: { read: async () => backend.credentials },
    timeoutMs: 10_000,
  });
  objects = createStorageObjects({ connectionString: workerDatabaseUrl(), s3, timeoutMs: 10_000 });
  catalog = createCatalog({ connectionString: workerDatabaseUrl() });
  app = createStorageModule({
    bucket: 'task-output',
    catalog,
    access,
    objects,
    custody: { read: async () => backend.credentials },
    check: async () => ({ ok: true }),
    logger: createRecordingLogger([]),
    tls: { ...identity.certificate, read: async () => identity.certificate },
  });
  await new Promise<void>((resolve) => app.task.server.listen(0, '127.0.0.1', resolve));
  const address = app.task.server.address();
  if (!address || typeof address === 'string') throw Error('no listener');
  port = address.port;
}
async function stop() {
  app.task.close();
  app.control.close();
  app.read.close();
  await objects.close();
  s3.close();
}
async function call(
  method: string,
  path: string,
  body = Buffer.alloc(0),
  headers: Record<string, string> = {},
  token = 'a'
) {
  return new Promise<{ status: number; body: Buffer; json: any }>((resolve, reject) => {
    const req = request(
      {
        hostname: 'localhost',
        port,
        method,
        path,
        ca: identity.certificate.ca,
        headers: { authorization: `Bearer ${token}`, ...headers },
      },
      (res) => {
        res.on('error', reject);
        const chunks: Buffer[] = [];
        res.on('data', (b) => chunks.push(b));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(bytes.toString());
          } catch {}
          resolve({ status: res.statusCode!, body: bytes, json });
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}
const put = (
  id: string,
  bytes: Buffer,
  name = `out/${id}.txt`,
  extra: Record<string, string> = {}
) =>
  call('PUT', `/spaces/a/objects/${id}`, bytes, {
    'x-storage-name': Buffer.from(name).toString('base64url'),
    'x-storage-length': String(bytes.length),
    'x-storage-sha256': hash(bytes),
    ...extra,
  });
const list = () => call('GET', '/spaces/a/objects?limit=100');
beforeAll(async () => {
  stores = await createTestStores();
  stores.postgres.on('error', () => undefined);
  await applyTestMigrations(stores.postgres);
  identity = await storageObjectIdentity();
  backend = await createFakeStorageS3({ bucket: 'task-output' });
});
afterAll(async () => {
  await backend.close();
  await identity.close();
  await stores.postgres.end();
  await stores.redis.quit();
  // This file owns this worker's database. Do not retain a whole migrated
  // database until suite exit: the disposable store has a finite tmpfs.
  const database = new URL(workerDatabaseUrl());
  const databaseName = database.pathname.slice(1);
  if (!/^lifemodel_test_worker_[0-9]+$/.test(databaseName)) throw Error('invalid test database');
  database.pathname = '/postgres';
  const admin = new Pool({ connectionString: database.toString(), max: 1 });
  admin.on('error', () => undefined);
  admin.on('connect', (client) => client.on('error', () => undefined));
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
});
beforeEach(async () => {
  await stores.postgres.query(
    'TRUNCATE task_access.projections,task_access.intents,storage.spaces CASCADE'
  );
  for (const id of ['a', 'b']) {
    await stores.postgres.query('INSERT INTO storage.spaces(id) VALUES($1)', [id]);
    await stores.postgres.query(
      "INSERT INTO task_access.intents(task_id,attempt_id,launch_id,revision,mode,soft_due_at,hard_stop_at) VALUES($1,$1,$1,0,'active',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 hours')",
      [id]
    );
    await stores.postgres.query(
      "INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) SELECT task_id,attempt_id,launch_id,$2,$3,$1,0,0,'active',soft_due_at,hard_stop_at FROM task_access.intents WHERE task_id=$1",
      [id, `job-${id}`, `pod-${id}`]
    );
  }
  backend.reset();
  identity.setReviewHook(undefined);
  await start();
});
import { afterEach } from 'vitest';
afterEach(stop);

describe('per-chunk storage transfer progress deadlines', () => {
  it('returns six complete GET ranges with 2.5s backend delay per range', async () => {
    const bytes = Buffer.alloc(6 * chunkBytes, 97);
    const saved = await put('slow-get', bytes);
    expect(saved.status).toBe(200);
    backend.hooks.beforeGet = async () => {
      await delay(2500);
    };
    const reply = await call('GET', `/spaces/a/objects/${saved.json.id}`);
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBe(bytes.length);
    expect(hash(reply.body)).toBe(hash(bytes));
    const ranges = backend.requests.filter((row) => row.method === 'GET');
    expect(ranges).toHaveLength(6);
    expect(ranges.every((row) => row.authorized)).toBe(true);
  }, 30_000);

  it('accepts six PUT chunks progressing every 2.5s, then verifies and publishes', async () => {
    const bytes = Buffer.alloc(6 * chunkBytes, 98);
    let sent = 0;
    const reply = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const req = request(
        {
          hostname: 'localhost',
          port,
          method: 'PUT',
          path: '/spaces/a/objects/slow-put',
          ca: identity.certificate.ca,
          headers: {
            authorization: 'Bearer a',
            'content-length': String(bytes.length),
            'x-storage-name': Buffer.from('progress.txt').toString('base64url'),
            'x-storage-length': String(bytes.length),
            'x-storage-sha256': hash(bytes),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('error', reject);
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      void (async () => {
        try {
          req.flushHeaders();
          for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
            // This is the specified slow source, not a timing-based assertion.
            await delay(2500);
            if (req.destroyed) return;
            if (!req.write(bytes.subarray(offset, offset + chunkBytes))) await once(req, 'drain');
            sent++;
          }
          req.end();
        } catch (error) {
          reject(error);
        }
      })();
    });
    expect(reply.status).toBe(200);
    expect(sent).toBe(6);
    expect(JSON.parse(reply.body.toString())).toMatchObject({
      size: bytes.length,
      sha256: hash(bytes),
    });
    expect((await list()).json.objects).toHaveLength(1);
    const persisted = [...backend.objects.values()][0]?.bytes;
    expect(persisted?.length).toBe(bytes.length);
    expect(hash(persisted!)).toBe(hash(bytes));
  }, 30_000);

  it('ends a stalled backend chunk within the 10s no-progress bound', async () => {
    const saved = await put('stalled-get', Buffer.from('bounded chunk'));
    expect(saved.status).toBe(200);
    backend.hooks.beforeGet = () => 'hang';
    const started = performance.now();
    // A socket close or a safe error response are both valid failed transfers.
    const result = await call('GET', `/spaces/a/objects/${saved.json.id}`).then(
      (reply) => ({ status: reply.status }),
      () => ({ status: 0 })
    );
    expect(backend.requests.filter((row) => row.method === 'GET')).toHaveLength(1);
    expect(result.status).not.toBe(200);
    expect(performance.now() - started).toBeLessThan(12_000);
    expect((await list()).status).toBe(200);
  }, 15_000);
});
