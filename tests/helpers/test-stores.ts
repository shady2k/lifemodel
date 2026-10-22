import Redis from 'iovalkey';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  currentTestFile,
  forgetTestDatabases,
  pendingTestDatabases,
  recordTestDatabase,
} from './test-store-database-registry.js';

export interface TestStores {
  redis: Redis;
  postgres: Pool;
  workerId: string;
}

export type ReclaimOutcome = 'dropped' | 'forced' | 'absent';

export interface ReclaimedDatabase {
  database: string;
  outcome: ReclaimOutcome;
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

/** The SQLSTATE of a Postgres error, for logs that must not carry the message. */
export function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

/** The Valkey handle of a worker: one logical database, namespaced by worker and handle. */
export function createTestValkey(workerId = process.env.VITEST_WORKER_ID): Redis {
  const { valkeyUrl } = testStoreUrls();
  if (!workerId || !/^\d+$/.test(workerId))
    throw new Error('VITEST_WORKER_ID must identify the current test worker');
  const url = new URL(valkeyUrl);
  url.pathname = '/0';
  return new Redis(url.toString(), { keyPrefix: `lifemodel:test:${workerId}:${randomUUID()}:` });
}

export async function createTestStores(
  workerId = process.env.VITEST_WORKER_ID
): Promise<TestStores> {
  const { databaseUrl } = testStoreUrls();
  const file = currentTestFile();
  const databaseName = testDatabaseName(workerId);
  const admin = maintenancePool();
  try {
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    } catch (error) {
      if (postgresErrorCode(error) !== '42P04') throw error;
    }
    // Recorded before anything can fail: a teardown that never runs must still
    // leave a record the main process can reclaim from.
    recordTestDatabase(file, databaseName);
  } finally {
    await admin.end();
  }
  const workerUrl = new URL(databaseUrl);
  workerUrl.pathname = `/${databaseName}`;
  return {
    workerId,
    postgres: new Pool({ connectionString: workerUrl.toString() }),
    redis: createTestValkey(workerId),
  };
}

/**
 * Drops the named test databases (lifemodel-653.7.10).
 *
 * A migrated database is ~9 MiB and each Vitest test file runs in its own worker
 * process, so a database left behind per file fills the 512 MiB store volume
 * before a full suite ends. The normal path is the file's own afterAll hook
 * (`tests/setup/test-store-cleanup.ts`), which runs after the file closed its
 * pools: `dropped` means nothing was connected. `forced` is the last resort for
 * a file that left a session open (a leaked pool or a killed child process).
 */
export async function reclaimTestDatabases(
  databases: readonly string[]
): Promise<ReclaimedDatabase[]> {
  const reclaimed: ReclaimedDatabase[] = [];
  if (!databases.length) return reclaimed;
  const admin = maintenancePool();
  try {
    for (const database of databases) {
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        database,
      ]);
      if (!existing.rowCount) {
        reclaimed.push({ database, outcome: 'absent' });
        continue;
      }
      try {
        await admin.query(`DROP DATABASE "${database}"`);
        reclaimed.push({ database, outcome: 'dropped' });
      } catch (error) {
        // Another reclaimer dropped it between the check and the drop.
        if (postgresErrorCode(error) === '3D000') {
          reclaimed.push({ database, outcome: 'absent' });
          continue;
        }
        if (postgresErrorCode(error) !== '55006') throw error;
        const terminated = await admin.query(
          `SELECT count(pg_terminate_backend(pid))::int AS count
             FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database]
        );
        console.warn(
          `test stores: ${database} had ${terminated.rows[0].count} open connection(s) at teardown; forcing the drop`
        );
        await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
        reclaimed.push({ database, outcome: 'forced' });
      }
    }
  } finally {
    await admin.end();
  }
  return reclaimed;
}

/** Whether this test file created a database that is still waiting for reclamation. */
export function hasPendingTestDatabases(file = currentTestFile()): boolean {
  return (pendingTestDatabases(file)?.databases.length ?? 0) > 0;
}

/** Reclaims every database the current test file created (its afterAll hook). */
export async function dropTestDatabases(file = currentTestFile()): Promise<ReclaimedDatabase[]> {
  const pending = pendingTestDatabases(file);
  if (!pending?.databases.length) return [];
  const reclaimed = await reclaimTestDatabases(pending.databases);
  forgetTestDatabases(file);
  return reclaimed;
}
