import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
/**
 * The storage module's readiness against its real catalog (ADR-015 S-D7).
 *
 * The module is unready while its catalog is missing, refuses a login the
 * database rejects and a server it cannot reach, and becomes ready once
 * `db/migrations` has created `storage.spaces` and the real login connects.
 * Nothing here is a fake database: the schema, the login and the SQLSTATE
 * answers come from the test store.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageModule, type StorageModule } from '../../loader/src/storage-module-app.js';
import { STORAGE_BUCKET } from '../../loader/src/storage-custody.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

const STORAGE_MIGRATION = '20261015000011';
let stores: TestStores;
let certificate: TestStorageCertificate;
const servers: Server[] = [];
const modules: StorageModule[] = [];

beforeAll(async () => {
  stores = await createTestStores();
  certificate = await createStorageCertificate();
});
afterAll(async () => {
  certificate.cleanup();
  await stores.postgres.end();
  await stores.redis.quit();
});
afterEach(() => {
  for (const module of modules.splice(0)) module.task.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

/** Points the module at one connection string and serves its status listener. */
async function startModule(connectionString: string, lines: RecordedLine[]) {
  const module = createStorageModule({
    access: createStorageAccess({
      connectionString: workerDatabaseUrl(),
      identity: createKubernetesStorageIdentity(),
    }),
    bucket: STORAGE_BUCKET,
    catalog: createCatalog({ connectionString }),
    custody: {
      // The store is a separate boundary, covered by its own checks; this
      // fixture is about the catalog the module reads from Postgres.
      read: () => Promise.resolve({ accessKey: 'A1B2C3D4E5F60718293A', secretKey: 'x'.repeat(40) }),
    },
    check: () => Promise.resolve({ ok: true }),
    logger: createRecordingLogger(lines),
    tls: {
      cert: certificate.cert,
      key: certificate.key,
      read: () => Promise.resolve({ cert: certificate.cert, key: certificate.key }),
      timers: { set: () => ({}) as ReturnType<typeof setTimeout>, clear: () => undefined },
    },
    health: { cacheMs: 0, boundMs: 5_000 },
  });
  modules.push(module);
  servers.push(module.status);
  await new Promise<void>((resolve) => module.status.listen(0, '127.0.0.1', resolve));
  const address = module.status.address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return {
    get: async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      const answer = await fetch(`http://127.0.0.1:${String(address.port)}/status`);
      return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
    },
  };
}

/** A login the real database must refuse, and one for a server that is not there. */
function withUser(connectionString: string, username: string): string {
  const url = new URL(connectionString);
  url.username = username;
  return url.toString();
}

function unreachable(source: string): string {
  const url = new URL(source);
  url.hostname = '127.0.0.1';
  url.port = '1';
  return url.toString();
}

const causes = (lines: RecordedLine[]): unknown[] =>
  lines.filter((line) => line.level === 'warn').map((line) => line.fields['cause']);

describe('the storage module readiness with a real catalog', () => {
  it('is unready while the storage schema is missing and ready once it is applied', async () => {
    const databaseUrl = workerDatabaseUrl();
    // A fresh catalog state: no storage schema and no record of its migration.
    await stores.postgres.query('DROP SCHEMA IF EXISTS storage CASCADE');
    await stores.postgres.query('DROP SCHEMA IF EXISTS task_access CASCADE');
    const migrated = await stores.postgres.query(
      "SELECT to_regclass('public.schema_migrations') AS table"
    );
    if (migrated.rows[0]?.table !== null)
      await stores.postgres.query('DELETE FROM public.schema_migrations WHERE version IN ($1,$2)', [
        STORAGE_MIGRATION,
        '20261015000012',
      ]);
    const lines: RecordedLine[] = [];
    const module = await startModule(databaseUrl, lines);

    const missing = await module.get();
    expect(missing.status).toBe(503);
    expect(missing.body).toMatchObject({
      state: 'down',
      lastErrorCode: 'catalog_unavailable',
    });
    expect(causes(lines)).toEqual(['schema_missing']);
    // The login is never part of the module's own output.
    expect(JSON.stringify(lines)).not.toContain(new URL(databaseUrl).password);

    const beforeRecovery = lines.length;
    await applyTestMigrations(stores.postgres);
    const ready = await module.get();
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ state: 'ok', lastErrorCode: null });
    // The migration is the only change, and the recovery is one info line.
    const recovered = lines.slice(beforeRecovery);
    expect(recovered.filter((line) => line.level === 'warn')).toEqual([]);
    expect(recovered.filter((line) => line.level === 'info')).toHaveLength(1);
  });

  it('is unready when the database refuses the login, and ready again when it accepts it', async () => {
    const databaseUrl = workerDatabaseUrl();
    // The test store authenticates any password for a role that exists, so the
    // refused login is a role that does not: the server answers 28000.
    const refusedName = `lifemodel_missing_${String(Date.now())}`;
    const lines: RecordedLine[] = [];
    const refused = await startModule(withUser(databaseUrl, refusedName), lines);
    const answer = await refused.get();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ lastErrorCode: 'catalog_unavailable' });
    expect(causes(lines)).toEqual(['auth_failed']);
    expect(JSON.stringify(lines)).not.toContain(refusedName);

    // The real login, and a catalog that exists: ready.
    await applyTestMigrations(stores.postgres);
    const accepted = await startModule(databaseUrl, []);
    expect((await accepted.get()).status).toBe(200);
  });

  it('is unready when the server cannot be reached', async () => {
    const lines: RecordedLine[] = [];
    const module = await startModule(unreachable(workerDatabaseUrl()), lines);
    const answer = await module.get();
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ lastErrorCode: 'catalog_unavailable' });
    expect(causes(lines)).toEqual(['unreachable']);
  });
});
