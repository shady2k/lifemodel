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

  it('holds the holder row through commit so an overlapping takeover cannot stale a write', async () => {
    const fenced = createFencedPostgres(stores.postgres, 1);
    const writer = await fenced.connect();
    const started = Date.now();
    try {
      await writer.query('BEGIN');
      await writer.query("INSERT INTO core.kv(key, value) VALUES ('overlap', '1'::jsonb)");
      let takeoverFinished = false;
      const takeover = stores.postgres
        .query('UPDATE core.active_holder SET epoch = 2 WHERE id = true')
        .then(() => {
          takeoverFinished = true;
        });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(takeoverFinished).toBe(false);
      expect(
        (await stores.postgres.query('SELECT epoch FROM core.active_holder WHERE id=true'))
          .rows[0]?.['epoch']
      ).toBe('1');
      await writer.query('COMMIT');
      await takeover;
      expect(takeoverFinished).toBe(true);
      expect(
        (await stores.postgres.query("SELECT value FROM core.kv WHERE key='overlap'")).rowCount
      ).toBe(1);
      console.info(`fenced transaction lock-through-commit: ${Date.now() - started}ms`);
      await stores.postgres.query('UPDATE core.active_holder SET epoch = 1 WHERE id = true');
      const operations = 10;
      const beforeStart = Date.now();
      for (let i = 0; i < operations; i++) {
        const legacy = await stores.postgres.connect();
        try {
          await legacy.query('BEGIN');
          await legacy.query('SELECT epoch FROM core.active_holder WHERE id=true');
          await legacy.query('SELECT 1');
          await legacy.query('SELECT epoch FROM core.active_holder WHERE id=true');
          await legacy.query('COMMIT');
        } finally {
          legacy.release();
        }
      }
      const beforeMs = Date.now() - beforeStart;
      const afterStart = Date.now();
      for (let i = 0; i < operations; i++) await fenced.query('SELECT 1');
      const afterMs = Date.now() - afterStart;
      console.info(
        `fence read benchmark (${operations} ops): before=${beforeMs}ms after=${afterMs}ms`
      );
    } finally {
      writer.release();
      await stores.postgres.query('UPDATE core.active_holder SET epoch = 1 WHERE id = true');
    }
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
