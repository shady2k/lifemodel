import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
/**
 * The storage module's status listener (ADR-015 S-D1, S-D7).
 *
 * `/status` is readiness: the module's Postgres catalog must be readable and
 * SeaweedFS must answer with valid auth. `/livez` is the process. A missing
 * catalog, a refused credential, a stopped store and an unreadable custody
 * record each make the module unready with their own reason, and its log never
 * carries the credential or a store body.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import type { Catalog, CatalogCheck } from '../../loader/src/storage-catalog.js';
import {
  STORAGE_BUCKET,
  StorageCustodyError,
  type StorageS3Credentials,
} from '../../loader/src/storage-custody.js';
import type { S3Check } from '../../loader/src/storage-s3.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

const credentials: StorageS3Credentials = {
  accessKey: 'A1B2C3D4E5F60718293A',
  secretKey: 'c2VjcmV0LWtleS1mb3ItdGhlLXN0b3JhZ2UtbW9kdWxl',
};
const servers: Server[] = [];
let certificate: TestStorageCertificate;
let stores: TestStores;
beforeAll(async () => {
  stores = await createTestStores();
  await applyTestMigrations(stores.postgres);
  certificate = await createStorageCertificate();
});
afterAll(async () => {
  certificate.cleanup();
  await stores.postgres.end();
  await stores.redis.quit();
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A reload timer that never fires: these checks are about readiness. */
function pausedTimers() {
  const timer = {} as ReturnType<typeof setTimeout>;
  return { set: () => timer, clear: () => undefined };
}

async function fixture(
  options: {
    custody?: () => Promise<StorageS3Credentials>;
    check?: () => Promise<S3Check>;
    catalog?: () => Promise<CatalogCheck>;
  } = {}
) {
  const lines: RecordedLine[] = [];
  const seen: StorageS3Credentials[] = [];
  let catalogReads = 0;
  const catalog: Catalog = {
    check: async () => {
      catalogReads += 1;
      return options.catalog ? options.catalog() : { ok: true };
    },
  };
  const app = createStorageModule({
    access: createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: createKubernetesStorageIdentity(),
    }),
    bucket: STORAGE_BUCKET,
    catalog,
    custody: {
      read: options.custody ?? (() => Promise.resolve(credentials)),
    },
    check: async (given) => {
      seen.push(given);
      return options.check ? options.check() : { ok: true };
    },
    tls: {
      cert: certificate.cert,
      key: certificate.key,
      read: () => Promise.resolve({ cert: certificate.cert, key: certificate.key }),
      reloadMs: 60_000,
      timers: pausedTimers(),
    },
    logger: createRecordingLogger(lines),
    health: { cacheMs: 0, boundMs: 200 },
  });
  servers.push(app.status);
  await new Promise<void>((resolve) => app.status.listen(0, '127.0.0.1', resolve));
  const address = app.status.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  const base = `http://127.0.0.1:${String(address.port)}`;
  return {
    lines,
    seen,
    base,
    catalogReads: () => catalogReads,
    module: app,
    get: async (path: string) => {
      const response = await fetch(`${base}${path}`, { method: 'GET' });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text };
    },
  };
}

describe('the storage module status listener', () => {
  it('answers ready only when the catalog and the store answered', async () => {
    const f = await fixture();
    const answer = await f.get('/status');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/json');
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(answer.body)).toMatchObject({ state: 'ok', store: 'seaweedfs' });
    // The check used the custody credentials and nothing else.
    expect(f.seen).toEqual([credentials]);
    expect(f.catalogReads()).toBe(1);
    expect(JSON.stringify(f.lines)).not.toContain(credentials.secretKey);
  });

  it.each([
    ['unreachable', 503],
    ['auth_denied', 503],
    ['bucket_missing', 503],
    ['unexpected', 503],
  ] as const)('is unready when the store says %s', async (code) => {
    const f = await fixture({ check: () => Promise.resolve({ ok: false, code, status: 403 }) });
    const answer = await f.get('/status');
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({ state: 'down', lastErrorCode: code });
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([
      { level: 'warn', fields: { code }, message: expect.any(String) },
    ]);
  });

  it.each([
    ['unreachable', 503],
    ['auth_failed', 503],
    ['schema_missing', 503],
    ['forbidden', 503],
  ] as const)('is unready with catalog_unavailable when the catalog says %s', async (cause) => {
    let failing = true;
    const f = await fixture({
      catalog: () =>
        Promise.resolve(failing ? { ok: false, cause } : ({ ok: true } as CatalogCheck)),
    });
    const refused = await f.get('/status');
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({
      state: 'down',
      lastErrorCode: 'catalog_unavailable',
    });
    // No store read and no custody read: the catalog comes first.
    expect(f.seen).toEqual([]);
    // One line per change, carrying the repair and never a body.
    expect(f.lines.filter((line) => line.level === 'warn')).toEqual([
      {
        level: 'warn',
        fields: { code: 'catalog_unavailable', cause },
        message: expect.any(String),
      },
    ]);

    // The catalog returning is what makes the module ready again.
    failing = false;
    const recovered = await f.get('/status');
    expect(recovered.status).toBe(200);
    expect(f.seen).toEqual([credentials]);
  });

  it('is unready when its custody record cannot be read, and never calls the store', async () => {
    let fail = true;
    const f = await fixture({
      custody: () =>
        fail ? Promise.reject(new StorageCustodyError('denied')) : Promise.resolve(credentials),
    });
    const refused = await f.get('/status');
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body)).toMatchObject({
      state: 'down',
      lastErrorCode: 'credentials_unavailable',
    });
    expect(f.seen).toEqual([]);
    expect(JSON.stringify(f.lines)).toContain('denied');
    expect(JSON.stringify(f.lines)).not.toContain(credentials.secretKey);

    // A store that comes back, with credentials that can be read again, is ready.
    fail = false;
    const recovered = await f.get('/status');
    expect(recovered.status).toBe(200);
    expect(f.seen).toEqual([credentials]);
  });

  it('is unready, with the deadline as the reason, when the store stops answering', async () => {
    const held: Array<() => void> = [];
    let stalled = false;
    const lines: RecordedLine[] = [];
    const app = createStorageModule({
      access: createStorageAccess({
        connectionString: workerDatabaseUrl(),
        identity: createKubernetesStorageIdentity(),
      }),
      bucket: STORAGE_BUCKET,
      catalog: { check: () => Promise.resolve({ ok: true }) },
      custody: { read: () => Promise.resolve(credentials) },
      check: (given) => {
        void given;
        if (!stalled) return Promise.resolve({ ok: true });
        return new Promise<S3Check>((resolve) => {
          held.push(() => {
            resolve({ ok: true });
          });
        });
      },
      tls: {
        cert: certificate.cert,
        key: certificate.key,
        read: () => Promise.resolve({ cert: certificate.cert, key: certificate.key }),
        timers: pausedTimers(),
      },
      logger: createRecordingLogger(lines),
      health: { cacheMs: 0, boundMs: 20 },
    });
    servers.push(app.status);
    await new Promise<void>((resolve) => app.status.listen(0, '127.0.0.1', resolve));
    const address = app.status.address();
    if (!address || typeof address === 'string') throw new Error('not listening');
    const base = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(`${base}/status`)).status).toBe(200);
    stalled = true;
    const stalledAnswer = await fetch(`${base}/status`);
    expect(stalledAnswer.status).toBe(503);
    expect(JSON.parse(await stalledAnswer.text())).toMatchObject({
      state: 'down',
      lastErrorCode: 'timeout',
    });
    // The late answer from the check that missed its deadline changes nothing.
    stalled = false;
    for (const settle of held.splice(0)) settle();
    expect(app.health.body()).toMatchObject({ state: 'down', lastErrorCode: 'timeout' });
    expect((await fetch(`${base}/status`)).status).toBe(200);
  });

  it('serves liveness for the process whatever the catalog and the store do', async () => {
    const f = await fixture({
      check: () => Promise.resolve({ ok: false, code: 'unreachable' }),
      catalog: () => Promise.resolve({ ok: false, cause: 'unreachable' }),
    });
    const live = await f.get('/livez');
    expect(live.status).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ state: 'live' });
    expect((await f.get('/status')).status).toBe(503);
  });

  it('answers nothing else, and only for GET', async () => {
    const f = await fixture();
    expect((await f.get('/')).status).toBe(404);
    expect((await f.get('/status/extra')).status).toBe(404);
    const posted = await fetch(`${f.base}/status`, { method: 'POST' });
    expect(posted.status).toBe(404);
    expect(await posted.text()).toBe('');
  });
});
