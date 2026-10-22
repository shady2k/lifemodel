/**
 * Reclaims the Postgres databases of a test file whose own teardown never ran
 * (lifemodel-653.7.10).
 *
 * Vitest runs the afterAll hooks of a file in reverse registration order, and it
 * stops at the first one that throws or times out: the store cleanup registered
 * by `tests/setup/test-store-cleanup.ts` (which runs last, after the file's own
 * pools are closed) is skipped whenever an earlier teardown fails. A failed file
 * then keeps its ~9 MiB database, and enough of them refill the store.
 *
 * This reporter runs in the main process and sees every module end, including a
 * failed one. The per-file record
 * (`tests/helpers/test-store-database-registry.ts`) still lists the databases
 * when the hook did not get to them; they are reclaimed here. A passing file
 * keeps its database for its own hook: that the hook ran at all is checked by
 * the global setup audit.
 */
import type { Reporter, TestModule } from 'vitest/node';
import { basename } from 'node:path';

import {
  forgetTestDatabases,
  pendingTestDatabases,
} from '../helpers/test-store-database-registry.js';
import { reclaimTestDatabases } from '../helpers/test-stores.js';

export class TestStoreFinalizer implements Reporter {
  async onTestModuleEnd(module: TestModule): Promise<void> {
    if (module.state() !== 'failed') return;
    const pending = pendingTestDatabases(module.moduleId);
    if (!pending?.databases.length) return;
    try {
      const reclaimed = await reclaimTestDatabases(pending.databases);
      forgetTestDatabases(module.moduleId);
      console.warn(
        `test stores: reclaimed ${reclaimed.length} database(s) left by the failed teardown of ${basename(module.moduleId)}`
      );
    } catch (error) {
      // The run is already failing; the audit names what is still there.
      console.warn(
        `test stores: reclaiming ${pending.databases.length} database(s) of ${basename(module.moduleId)} failed: ${(error as Error).message}`
      );
    }
  }
}
