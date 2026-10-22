/**
 * The test database audit (lifemodel-653.7.10): every database a test file
 * created must be gone when the run ends.
 *
 * This is the one point in a run that is guaranteed to come after every file, so
 * it is where "the file reclaimed its database" is checked. A file whose hook was
 * removed, whose record was never written or whose reclamation failed leaves a
 * database behind and fails the run instead of quietly filling the volume.
 */
import { Pool } from 'pg';

import { adminDatabaseUrl } from './test-stores.js';

/** The names of the test databases still present. */
export async function leftoverTestDatabases(): Promise<string[]> {
  const admin = new Pool({ connectionString: adminDatabaseUrl(), max: 1 });
  try {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'lifemodel_test_worker_%' ORDER BY datname"
    );
    return rows.map(({ datname }) => datname);
  } finally {
    await admin.end();
  }
}
