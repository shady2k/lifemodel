import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';

const accessInstances = new Set<ReturnType<typeof createStorageAccess>>();
const identityInstances = new Set<ReturnType<typeof createKubernetesStorageIdentity>>();
function trackedAccess(options: Parameters<typeof createStorageAccess>[0]) {
  const access = createStorageAccess(options);
  accessInstances.add(access);
  return access;
}
function trackedIdentity() {
  const identity = createKubernetesStorageIdentity();
  identityInstances.add(identity);
  return identity;
}
async function closeAccess() {
  await Promise.all([...accessInstances].map((access) => access.close()));
  accessInstances.clear();
  for (const identity of identityInstances) identity.close();
  identityInstances.clear();
}
/**
 * The catalog check against a dropped connection (ADR-015 S-D7).
 *
 * A database outage is not only a refused connection: an established TCP
 * connection can die while the catalog read is waiting for the server. The
 * module must keep running with unavailable readiness until the database
 * answers again - a check that lets that error escape kills the process that
 * reports the outage.
 *
 * The drop is real: a local TCP proxy carries the module's connection to the
 * test Postgres, another session holds an ACCESS EXCLUSIVE lock on the catalog
 * table so the read waits on the server, and both proxy sockets are destroyed
 * once the server reports that backend waiting on the lock.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageModule, type StorageModule } from '../../loader/src/storage-module-app.js';
import { STORAGE_BUCKET } from '../../loader/src/storage-custody.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

let stores: TestStores;
let certificate: TestStorageCertificate;
let module: StorageModule;
let proxy: Server;
let releaseLock: (() => Promise<void>) | undefined;
const sockets = new Set<Socket>();

beforeAll(async () => {
  stores = await createTestStores();
  certificate = await createStorageCertificate();
  await applyTestMigrations(stores.postgres);
  const target = new URL(workerDatabaseUrl());
  // The proxy is the drop point: the module connects here, never to Postgres.
  proxy = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('proxy not listening');
  const throughProxy = new URL(workerDatabaseUrl());
  throughProxy.hostname = '127.0.0.1';
  throughProxy.port = String(address.port);
  module = createStorageModule({
    access: trackedAccess({
      connectionString: workerDatabaseUrl(),
      identity: trackedIdentity(),
    }),
    bucket: STORAGE_BUCKET,
    catalog: createCatalog({ connectionString: throughProxy.toString() }),
    custody: {
      read: () => Promise.resolve({ accessKey: 'A1B2C3D4E5F60718293A', secretKey: 'x'.repeat(40) }),
    },
    check: () => Promise.resolve({ ok: true }),
    logger: createRecordingLogger([]),
    tls: {
      cert: certificate.cert,
      key: certificate.key,
      read: () => Promise.resolve({ cert: certificate.cert, key: certificate.key }),
      timers: { set: () => ({}) as ReturnType<typeof setTimeout>, clear: () => undefined },
    },
    health: { cacheMs: 0, boundMs: 5_000 },
  });
  await new Promise<void>((resolve) => module.status.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  // A failed assertion must not leave the catalog locked for the next check.
  await releaseLock?.();
  releaseLock = undefined;
});

afterAll(async () => {
  await closeAccess();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  module.task.close();
  module.status.closeAllConnections();
  await new Promise<void>((resolve) => module.status.close(() => resolve()));
  certificate.cleanup();
  await stores.postgres.end();
  await stores.redis.quit();
});

/** The module's own status listener: `/status` is readiness and `/livez` the process. */
function baseUrl(): string {
  const address = module.status.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function readStatus(): Promise<{ status: number; body: Record<string, unknown> }> {
  const answer = await fetch(`${baseUrl()}/status`);
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
}

async function livez(): Promise<number> {
  return (await fetch(`${baseUrl()}/livez`)).status;
}

/** Hold the catalog table so the module's read waits on the server itself. */
async function holdCatalog(): Promise<() => Promise<void>> {
  const client = await stores.postgres.connect();
  await client.query('BEGIN');
  await client.query('LOCK TABLE storage.spaces IN ACCESS EXCLUSIVE MODE');
  return async () => {
    await client.query('ROLLBACK');
    client.release();
  };
}

/** Wait until the server reports the module's backend waiting on that lock. */
async function waitForBlockedReader(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = await stores.postgres.query(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE application_name = 'lifemodel-storage-module' AND wait_event_type = 'Lock'`
    );
    if ((waiting.rows[0] as { waiting: number }).waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the catalog read never reached its lock wait');
}

describe('the storage catalog check over a dropped connection', () => {
  it('survives the drop, reports unavailable and recovers', async () => {
    // A first answer proves the proxy carries the module to its catalog.
    expect((await readStatus()).status).toBe(200);
    expect(await livez()).toBe(200);

    releaseLock = await holdCatalog();
    // Readiness starts a check that the server will hold on the lock.
    const pending = readStatus();
    await waitForBlockedReader();
    // The outage: the connection dies under the running read.
    for (const socket of sockets) socket.destroy();
    sockets.clear();

    const dropped = await pending;
    expect(dropped.status).toBe(503);
    expect(dropped.body).toMatchObject({
      state: 'down',
      lastErrorCode: 'catalog_unavailable',
    });

    // The process is still here to report the outage...
    expect(await livez()).toBe(200);
    // ...and a later check answers again once the database returns.
    await releaseLock();
    releaseLock = undefined;
    expect((await readStatus()).status).toBe(200);
    expect(await livez()).toBe(200);
  });
});
