import { describe, expect, it } from 'vitest';

import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

describe('core Postgres migrations', () => {
  it('applies to an empty database and is idempotent', async () => {
    const stores = await createTestStores();
    try {
      const before = await stores.postgres.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core') AS core,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector
      `);
      expect(before.rows[0]).toEqual({ core: false, vector: false });

      await applyTestMigrations(stores.postgres);
      const afterFirst = await stores.postgres.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core') AS core,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector
      `);
      expect(afterFirst.rows[0]).toEqual({ core: true, vector: true });
      const versionsAfterFirst = await stores.postgres.query('SELECT version, applied_at FROM public.schema_migrations ORDER BY version');

      await expect(applyTestMigrations(stores.postgres)).resolves.toBeUndefined();
      const versionsAfterSecond = await stores.postgres.query('SELECT version, applied_at FROM public.schema_migrations ORDER BY version');
      expect(versionsAfterSecond.rows).toEqual(versionsAfterFirst.rows);
      const afterSecond = await stores.postgres.query(`
        SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'core') AS core,
               EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector
      `);
      expect(afterSecond.rows).toEqual(afterFirst.rows);
    } finally {
      await stores.postgres.end();
      await stores.redis.quit();
    }
  });
});
