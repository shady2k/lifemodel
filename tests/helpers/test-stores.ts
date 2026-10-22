import Redis from 'iovalkey';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export interface TestStores {
  redis: Redis;
  postgres: Pool;
  workerId: string;
}

export function testStoreUrls(env: NodeJS.ProcessEnv = process.env): {
  valkeyUrl: string;
  databaseUrl: string;
} {
  const valkeyUrl = env.LIFEMODEL_TEST_VALKEY_URL;
  const databaseUrl = env.LIFEMODEL_TEST_DATABASE_URL;
  if (!valkeyUrl || !databaseUrl) {
    throw new Error(
      'LIFEMODEL_TEST_VALKEY_URL and LIFEMODEL_TEST_DATABASE_URL are required; run tests through scripts/test-isolated.mjs'
    );
  }
  return { valkeyUrl, databaseUrl };
}

/** The database of the current test worker: one per worker, created on demand. */
export function testDatabaseName(workerId = process.env.VITEST_WORKER_ID): string {
  if (!workerId || !/^\d+$/.test(workerId))
    throw new Error('VITEST_WORKER_ID must identify the current test worker');
  return `lifemodel_test_worker_${workerId}`;
}

export function workerDatabaseUrl(workerId = process.env.VITEST_WORKER_ID): string {
  const { databaseUrl } = testStoreUrls();
  const url = new URL(databaseUrl);
  url.pathname = `/${testDatabaseName(workerId)}`;
  return url.toString();
}

/** The maintenance database that owns the test databases (CREATE/DROP DATABASE). */
export function adminDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const { databaseUrl } = testStoreUrls(env);
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function maintenancePool(): Pool {
  return new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

let databaseCreated = false;

/** Whether this test file created its worker database (nothing to drop if not). */
export function hasCreatedTestDatabase(): boolean {
  return databaseCreated;
}

export async function createTestStores(
  workerId = process.env.VITEST_WORKER_ID
): Promise<TestStores> {
  const { valkeyUrl, databaseUrl } = testStoreUrls();
  const databaseName = testDatabaseName(workerId);
  const admin = maintenancePool();
  try {
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    } catch (error) {
      if (postgresErrorCode(error) !== '42P04') throw error;
    }
    databaseCreated = true;
  } finally {
    await admin.end();
  }
  const workerUrl = new URL(databaseUrl);
  workerUrl.pathname = `/${databaseName}`;
  const workerValkeyUrl = new URL(valkeyUrl);
  workerValkeyUrl.pathname = '/0';
  return {
    workerId,
    postgres: new Pool({ connectionString: workerUrl.toString() }),
    redis: new Redis(workerValkeyUrl.toString(), {
      keyPrefix: `lifemodel:test:${workerId}:${randomUUID()}:`,
    }),
  };
}

/**
 * Drops the database of the current test worker (lifemodel-653.7.10).
 *
 * A migrated database is ~9 MiB and each Vitest test file runs in its own worker
 * process, so a database left behind per file fills the 512 MiB store volume
 * before a full suite ends. tests/setup/test-store-cleanup.ts calls this when a
 * test file finishes, after that file's own pools are closed. A failing test can
 * leave a client open; then the drop closes it (`WITH (FORCE)`) rather than
 * keeping the space.
 *
 * Returns whether a database of that name existed.
 */
export async function dropTestDatabase(
  workerId = process.env.VITEST_WORKER_ID
): Promise<'dropped' | 'absent'> {
  const databaseName = testDatabaseName(workerId);
  const admin = maintenancePool();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);
    if (!existing.rowCount) return 'absent';
    try {
      await admin.query(`DROP DATABASE "${databaseName}"`);
    } catch (error) {
      if (postgresErrorCode(error) !== '55006') throw error;
      const terminated = await admin.query(
        `SELECT count(pg_terminate_backend(pid))::int AS count
           FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName]
      );
      console.warn(
        `test stores: ${databaseName} had ${terminated.rows[0].count} open connection(s) at teardown; forcing the drop`
      );
      await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    }
    return 'dropped';
  } finally {
    await admin.end();
  }
}
