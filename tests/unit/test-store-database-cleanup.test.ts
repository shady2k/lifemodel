import { describe, expect, it } from 'vitest';
import type { TestModule } from 'vitest/node';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import {
  adminDatabaseUrl,
  createTestStores,
  dropTestDatabases,
  reclaimTestDatabases,
  testDatabaseName,
  workerDatabaseUrl,
} from '../helpers/test-stores.js';
import { currentTestFile, pendingTestDatabases } from '../helpers/test-store-database-registry.js';
import { leftoverTestDatabases } from '../helpers/test-store-audit.js';
import { TestStoreFinalizer } from '../setup/test-store-finalizer.js';
import { registerTestStoreCleanup, testStoreCleanup } from '../setup/test-store-cleanup.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Read back from the store itself: the database is gone, not dropped from a cache. */
async function databaseExists(name: string): Promise<boolean> {
  const admin = new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
  try {
    const result = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return (result.rowCount ?? 0) > 0;
  } finally {
    await admin.end();
  }
}

type Stores = Awaited<ReturnType<typeof createTestStores>>;

async function closeStores(stores: Stores): Promise<void> {
  await stores.postgres.end();
  await stores.redis.quit();
}

/** The module end the main process reports for this test file. */
function moduleEnd(state: 'failed' | 'passed', moduleId = currentTestFile()): TestModule {
  return { state: () => state, moduleId } as unknown as TestModule;
}

describe('the test databases of a file (lifemodel-653.7.10)', () => {
  it('are reclaimed by the finalizer when a file teardown threw before the hook', async () => {
    const name = testDatabaseName();
    expect(workerDatabaseUrl()).toContain(`/${name}`);
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_probe (value integer NOT NULL)');
    await stores.postgres.query('INSERT INTO cleanup_probe (value) VALUES (1)');
    expect(pendingTestDatabases(currentTestFile())?.databases).toEqual([name]);

    // The file's own teardown closes its pools and then fails. Vitest runs the
    // file's hooks before the setup's, stops at the first one that throws, and
    // abandons the rest - so the store hook never reclaims anything.
    const fileTeardown = async (): Promise<void> => {
      await closeStores(stores);
      throw new Error('file teardown failed');
    };
    const hooks = [fileTeardown, async () => testStoreCleanup.drop()];
    for (const hook of hooks) {
      try {
        await hook();
      } catch {
        break; // the runner's hook loop ends here
      }
    }
    expect(await databaseExists(name)).toBe(true);
    expect(pendingTestDatabases(currentTestFile())?.databases).toEqual([name]);

    await new TestStoreFinalizer().onTestModuleEnd(moduleEnd('failed'));

    expect(await databaseExists(name)).toBe(false);
    expect(pendingTestDatabases(currentTestFile())).toBeUndefined();
  });

  it('belong to the file hook, not the finalizer, when the file passed', async () => {
    const name = testDatabaseName();
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_pass_probe (value integer NOT NULL)');
    await closeStores(stores);

    await new TestStoreFinalizer().onTestModuleEnd(moduleEnd('passed'));

    // A passing file must reclaim its own databases: that is what fails the run
    // when the setup file stops registering the hook.
    expect(await databaseExists(name)).toBe(true);
    expect(await dropTestDatabases()).toEqual([{ database: name, outcome: 'dropped' }]);
    expect(await databaseExists(name)).toBe(false);
    expect(pendingTestDatabases(currentTestFile())).toBeUndefined();
  });

  it('are dropped without ending a session once the file closed its pools', async () => {
    const name = testDatabaseName();
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_order_probe (value integer NOT NULL)');
    await closeStores(stores);

    // 'dropped' is the plain DROP: nothing was connected, so the file's own
    // teardown ran before this hook. 'forced' would mean a session was open.
    expect(await dropTestDatabases()).toEqual([{ database: name, outcome: 'dropped' }]);
  });

  it('include a database a test created with an explicit worker id', async () => {
    const explicit = testDatabaseName('424242');
    const own = testDatabaseName();
    const stores = await createTestStores('424242');
    await closeStores(stores);
    expect(await databaseExists(explicit)).toBe(true);
    expect(pendingTestDatabases(currentTestFile())?.databases).toEqual([explicit]);

    expect(await dropTestDatabases()).toEqual([{ database: explicit, outcome: 'dropped' }]);

    expect(await databaseExists(explicit)).toBe(false);
    // Reclaiming what this file created never touches another id's database.
    expect(await databaseExists(own)).toBe(false);
    expect(pendingTestDatabases(currentTestFile())).toBeUndefined();
  });

  it('are still reclaimed when a failing test left a client connected', async () => {
    const name = testDatabaseName();
    const stores = await createTestStores();
    await stores.postgres.query('CREATE TABLE cleanup_leak_probe (value integer NOT NULL)');
    // One client stays open on purpose, like a pool a failing test never ended.
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
      expect(await reclaimTestDatabases([name])).toEqual([{ database: name, outcome: 'forced' }]);
      expect(await databaseExists(name)).toBe(false);
    } finally {
      await leaked.end();
    }
  }, 30_000);

  it('are reported by the audit while they survive their file', async () => {
    const stray = testDatabaseName('434343');
    const stores = await createTestStores('434343');
    await closeStores(stores);
    try {
      expect(await leftoverTestDatabases()).toContain(stray);
    } finally {
      expect(await reclaimTestDatabases([stray])).toEqual([
        { database: stray, outcome: 'dropped' },
      ]);
    }
    expect(await leftoverTestDatabases()).not.toContain(stray);
    // The record still lists it for this file's hook, which then finds it gone.
    expect(pendingTestDatabases(currentTestFile())?.databases).toContain(stray);
  });

  it('are registered by the setup file, the finalizer and the global audit', () => {
    // The setup module registers its hooks as it loads; a test cannot see them
    // run, only that the load-time registration happened.
    expect(testStoreCleanup.registered).toBe(true);
    const hooks: Array<() => Promise<void>> = [];
    const capture: typeof testStoreCleanup = {
      ...testStoreCleanup,
      beforeAll: () => undefined,
      afterAll: (hook) => {
        hooks.push(async () => hook());
      },
    };
    registerTestStoreCleanup(capture);
    expect(hooks).toHaveLength(1);

    const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/setupFiles: \[[^\]]*'tests\/setup\/test-store-cleanup\.ts'/);
    expect(config).toMatch(/globalSetup: \['tests\/setup\/global-test-store-audit\.ts'\]/);
    expect(config).toContain('new TestStoreFinalizer()');
  });
});
