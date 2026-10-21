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
export function workerDatabaseUrl(workerId = process.env.VITEST_WORKER_ID): string {
  const { databaseUrl } = testStoreUrls();
  if (!workerId || !/^\d+$/.test(workerId))
    throw new Error('VITEST_WORKER_ID must identify the current test worker');
  const url = new URL(databaseUrl);
  url.pathname = `/lifemodel_test_worker_${workerId}`;
  return url.toString();
}

export async function createTestStores(
  workerId = process.env.VITEST_WORKER_ID
): Promise<TestStores> {
  const { valkeyUrl, databaseUrl } = testStoreUrls();
  if (!workerId || !/^\d+$/.test(workerId))
    throw new Error('VITEST_WORKER_ID must identify the current test worker');
  const databaseName = `lifemodel_test_worker_${workerId}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  try {
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: string }).code !== '42P04') throw error;
    }
  } finally {
    await admin.end();
  }
  const workerDatabaseUrl = new URL(databaseUrl);
  workerDatabaseUrl.pathname = `/${databaseName}`;
  const workerValkeyUrl = new URL(valkeyUrl);
  workerValkeyUrl.pathname = '/0';
  return {
    workerId,
    postgres: new Pool({ connectionString: workerDatabaseUrl.toString() }),
    redis: new Redis(workerValkeyUrl.toString(), {
      keyPrefix: `lifemodel:test:${workerId}:${randomUUID()}:`,
    }),
  };
}
