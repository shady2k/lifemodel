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
import { postgresErrorCode, reclaimTestDatabases } from '../helpers/test-stores.js';

/**
 * A fixed failure line: the count, the file and the SQLSTATE. Never the error
 * text, which can carry a connection string.
 */
export function reclaimFailureMessage(databases: number, moduleId: string, error: unknown): string {
  return `test stores: reclaiming ${databases} database(s) of ${basename(moduleId)} failed (code ${postgresErrorCode(error) ?? 'none'})`;
}

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
      // The run is already failing; the audit names what is still there. A fixed
      // message plus the SQLSTATE: never the error text, which may carry a
      // connection string.
      console.warn(reclaimFailureMessage(pending.databases.length, module.moduleId, error));
    }
  }
}
