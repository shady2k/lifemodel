import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import {
  adminDatabaseUrl,
  createTestStores,
  dropTestDatabase,
  hasCreatedTestDatabase,
  testDatabaseName,
  workerDatabaseUrl,
} from '../helpers/test-stores.js';
import { registerTestStoreCleanup, testStoreCleanup } from '../setup/test-store-cleanup.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Read back from the store itself: the database is gone, not merely dropped from a cache. */
async function databaseExists(name: string): Promise<boolean> {
  const admin = new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
  try {
    const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await admin.end();
  }
}

async function closeStores(stores: Awaited<ReturnType<typeof createTestStores>>): Promise<void> {
  await stores.postgres.end();
  await stores.redis.quit();
}

describe('the test worker database (lifemodel-653.7.10)', () => {
  it('is dropped for the file it served, with the tables the file wrote', async () => {
    const name = testDatabaseName();
    expect(workerDatabaseUrl()).toContain(`/${name}`);
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_probe (value integer NOT NULL)');
    await stores.postgres.query('INSERT INTO cleanup_probe (value) VALUES (1)');
    await closeStores(stores);
    expect(await databaseExists(name)).toBe(true);

    expect(await dropTestDatabase()).toBe('dropped');

    expect(await databaseExists(name)).toBe(false);
    expect(await dropTestDatabase()).toBe('absent');
    // A later file in the same worker gets an empty database, never the last
    // file's tables or rows.
    const fresh = await createTestStores();
    try {
      const probe = await fresh.postgres.query(
        "SELECT to_regclass('public.cleanup_probe') AS probe"
      );
      expect(probe.rows[0]?.probe).toBeNull();
    } finally {
      await closeStores(fresh);
      await dropTestDatabase();
    }
  });

  it('is dropped by the hook every test file registers when its own pools are closed', async () => {
    const name = testDatabaseName();
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_hook_probe (value integer NOT NULL)');
    await closeStores(stores);
    expect(await databaseExists(name)).toBe(true);

    // The registered drop is the real one this file runs at teardown; only the
    // registrar is replaced, so this checks the wiring, not a test double.
    expect(testStoreCleanup.drop).toBe(dropTestDatabase);
    expect(testStoreCleanup.created).toBe(hasCreatedTestDatabase);
    const hooks: Array<() => Promise<void>> = [];
    registerTestStoreCleanup({ ...testStoreCleanup, afterAll: (hook) => hooks.push(hook) });
    expect(hooks).toHaveLength(1);

    await hooks[0]!();

    expect(await databaseExists(name)).toBe(false);
  });

  it('drops nothing for a file that never created a database', async () => {
    const hooks: Array<() => Promise<void>> = [];
    const drops: string[] = [];
    registerTestStoreCleanup({
      afterAll: (hook) => hooks.push(hook),
      drop: async () => {
        drops.push('drop');
        return 'absent';
      },
      created: () => false,
    });
    expect(hooks).toHaveLength(1);

    await hooks[0]!();

    expect(drops).toEqual([]);
  });

  it('stays dropped even when a failing test left a client connected', async () => {
    const name = testDatabaseName();
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_leak_probe (value integer NOT NULL)');
    // One client stays open on purpose: after text draws the file's own afterAll
    // could not close it, and a database kept per such file refills the volume.
    const leaked = new Pool({
      connectionString: stores.postgres.options.connectionString,
      max: 1,
    });
    // The forced drop terminates this client; an unhandled idle-client error
    // would fail the worker instead of the drop.
    leaked.on('error', () => undefined);
    await leaked.query('SELECT 1');
    await closeStores(stores);
    expect(await databaseExists(name)).toBe(true);
    try {
      expect(await dropTestDatabase()).toBe('dropped');
      expect(await databaseExists(name)).toBe(false);
    } finally {
      await leaked.end();
    }
  }, 30_000);

  it('is registered in the vitest configuration for every test file', () => {
    const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/setupFiles: \[[^\]]*'tests\/setup\/test-store-cleanup\.ts'/);
  });
});
