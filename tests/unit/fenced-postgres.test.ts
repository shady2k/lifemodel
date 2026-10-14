import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import {
  createFencedPostgres,
  StalePostgresEpochError,
} from '../../src/storage/fenced-postgres.js';

describe('fenced core Postgres writes', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    await stores.postgres.query(`INSERT INTO core.active_holder (id, epoch) VALUES (true, 1)
      ON CONFLICT (id) DO UPDATE SET epoch = 1`);
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('allows current writes and atomically refuses a stale transaction before any row is visible', async () => {
    const current = createFencedPostgres(stores.postgres, 1);
    await current.query("INSERT INTO core.kv(key, value) VALUES ('current', '1'::jsonb)");
    await stores.postgres.query('UPDATE core.active_holder SET epoch = 2 WHERE id = true');
    const stale = createFencedPostgres(stores.postgres, 1);
    await expect(
      stale.query("INSERT INTO core.kv(key, value) VALUES ('stale', '1'::jsonb)")
    ).rejects.toBeInstanceOf(StalePostgresEpochError);
    await expect(
      stale.query('SELECT value FROM core.kv WHERE key = $1', ['stale'])
    ).rejects.toBeInstanceOf(StalePostgresEpochError);
    await expect(
      stores.postgres.query('SELECT value FROM core.kv WHERE key = $1', ['stale'])
    ).resolves.toMatchObject({ rowCount: 0 });
    const newer = createFencedPostgres(stores.postgres, 2);
    await newer.query("INSERT INTO core.kv(key, value) VALUES ('newer', '1'::jsonb)");
  });
});
