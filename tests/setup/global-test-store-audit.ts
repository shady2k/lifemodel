/**
 * The run-level test database audit (lifemodel-653.7.10).
 *
 * Runs after every test file, in the main process, and fails the run when a test
 * database survived the file that created it.
 */
import { leftoverTestDatabases } from '../helpers/test-store-audit.js';

export async function setup(): Promise<void> {
  // Nothing to prepare: every check runs at the end of the run.
}

export async function teardown(): Promise<void> {
  const leftovers = await leftoverTestDatabases();
  if (!leftovers.length) return;
  throw new Error(
    `test stores: ${leftovers.length} test database(s) survived their test file (${leftovers.join(', ')}); the store volume fills when a file keeps its database`
  );
}
