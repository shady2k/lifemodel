/**
 * Drops the test file's Postgres databases when the file finishes
 * (lifemodel-653.7.10).
 *
 * A test file runs in its own Vitest worker process and creates a full-schema
 * database (~9 MiB) on demand; nothing dropped them, so a full suite left 470 MiB
 * of databases on the 512 MiB store volume and failed creating the next one.
 * Vitest runs the hooks of a setup file after the hooks of the file it set up,
 * so the file's own pools are closed first and the drop needs no termination.
 * Most files never touch the store, and one that created nothing pays nothing.
 *
 * This hook is skipped when an earlier afterAll of the same file throws or times
 * out - Vitest abandons the rest of the hook list. `tests/setup/test-store-finalizer.ts`
 * reclaims such a file's databases from the main process, and
 * `tests/setup/global-test-store-audit.ts` fails the run if any survives.
 */
import { afterAll, beforeAll } from 'vitest';
import { setCurrentTestFile } from '../helpers/test-store-database-registry.js';
import { dropTestDatabases, hasPendingTestDatabases } from '../helpers/test-stores.js';

type BeforeAllHook = (suite: { filepath: string }) => Promise<void> | void;
type AfterAllHook = () => Promise<void> | void;

export interface TestStoreCleanup {
  beforeAll: (hook: BeforeAllHook) => void;
  afterAll: (hook: AfterAllHook) => void;
  drop: () => Promise<unknown>;
  created: () => boolean;
  registered: boolean;
}

/** What this file registers for every test file; exported so a test can check it. */
export const testStoreCleanup: TestStoreCleanup = {
  beforeAll: (hook) => {
    beforeAll((suite) => hook({ filepath: suite.filepath }));
  },
  afterAll: (hook) => {
    afterAll(hook);
  },
  drop: dropTestDatabases,
  created: hasPendingTestDatabases,
  registered: false,
};

export function registerTestStoreCleanup(cleanup: TestStoreCleanup = testStoreCleanup): void {
  cleanup.beforeAll(async (suite) => {
    setCurrentTestFile(suite.filepath);
  });
  cleanup.afterAll(async () => {
    if (!cleanup.created()) return;
    await cleanup.drop();
  });
  cleanup.registered = true;
}

registerTestStoreCleanup();
