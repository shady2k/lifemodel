/**
 * Drops the test file's Postgres database when the file finishes
 * (lifemodel-653.7.10).
 *
 * A test file runs in its own Vitest worker process and creates a full-schema
 * database (~9 MiB) on demand; nothing dropped them, so a full suite left 470 MiB
 * of databases on the 512 MiB store volume and failed creating the next one.
 * Vitest runs the hooks of a setup file after the hooks of the file it set up,
 * so the file's own pools are closed first. Most files never touch the store,
 * and one that created nothing pays nothing.
 */
import { afterAll } from 'vitest';
import { dropTestDatabase, hasCreatedTestDatabase } from '../helpers/test-stores.js';

export interface TestStoreCleanup {
  afterAll: (hook: () => Promise<void>) => void;
  drop: () => Promise<'dropped' | 'absent'>;
  created: () => boolean;
}

/** What this file registers for every test file; exported so a test can check it. */
export const testStoreCleanup: TestStoreCleanup = {
  afterAll,
  drop: dropTestDatabase,
  created: hasCreatedTestDatabase,
};

export function registerTestStoreCleanup(cleanup: TestStoreCleanup = testStoreCleanup): void {
  cleanup.afterAll(async () => {
    if (!cleanup.created()) return;
    await cleanup.drop();
  });
}

registerTestStoreCleanup();
