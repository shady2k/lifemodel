import { Pool } from 'pg';

import { applyMigrations } from '../../scripts/apply-migrations.js';
import { adminDatabaseUrl } from './test-stores.js';

/** Roles are cluster-global, so role-lifecycle tests need a maintenance-DB lock.
 * Ordinary migrations share it and still run concurrently across worker DBs.
 */
export async function lockTestMigrationRoles(exclusive = false): Promise<() => Promise<void>> {
  const lock = new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
  const suffix = exclusive ? '' : '_shared';
  await lock.query(`SELECT pg_advisory_lock${suffix}(hashtext('test-capture-role-lifecycle'))`);
  return async () => {
    try {
      await lock.query(
        `SELECT pg_advisory_unlock${suffix}(hashtext('test-capture-role-lifecycle'))`
      );
    } finally {
      await lock.end();
    }
  };
}

export async function applyTestMigrations(database: Pool, migrationsDir?: string): Promise<void> {
  const unlock = await lockTestMigrationRoles();
  try {
    await applyMigrations(database, migrationsDir);
  } finally {
    await unlock();
  }
}
