import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations } from '../../scripts/apply-migrations.js';

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
      const versionsAfterFirst = await stores.postgres.query(
        'SELECT version, applied_at FROM public.schema_migrations ORDER BY version'
      );

      await expect(applyTestMigrations(stores.postgres)).resolves.toBeUndefined();
      const versionsAfterSecond = await stores.postgres.query(
        'SELECT version, applied_at FROM public.schema_migrations ORDER BY version'
      );
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

  it('applies shuffled migration files in version order and records exact versions', async () => {
    const stores = await createTestStores();
    const directory = await mkdtemp(join(tmpdir(), 'migration-order-'));
    try {
      await writeFile(
        join(directory, '20990101000002_insert_dependent_row.sql'),
        '-- migrate:up\nINSERT INTO public.migration_order_fixture (value) VALUES (42);\n-- migrate:down\n'
      );
      await writeFile(
        join(directory, '20990101000001_create_dependency.sql'),
        '-- migrate:up\nCREATE TABLE public.migration_order_fixture (value integer NOT NULL);\n-- migrate:down\n'
      );
      await applyMigrations(stores.postgres, directory);
      const rows = await stores.postgres.query('SELECT value FROM public.migration_order_fixture');
      expect(rows.rows).toEqual([{ value: 42 }]);
      const versions = await stores.postgres.query(
        `SELECT version FROM public.schema_migrations WHERE version LIKE '2099010100000%' ORDER BY version`
      );
      expect(versions.rows.map(({ version }) => version)).toEqual([
        '20990101000001',
        '20990101000002',
      ]);
    } finally {
      await stores.postgres.query('DROP TABLE IF EXISTS public.migration_order_fixture');
      await stores.postgres.query(
        "DELETE FROM public.schema_migrations WHERE version LIKE '2099010100000%'"
      );
      await rm(directory, { recursive: true, force: true });
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('drops an invalid concurrent index and rebuilds it before recording a retry', async () => {
    const stores = await createTestStores();
    const directory = await mkdtemp(join(tmpdir(), 'migration-concurrent-retry-'));
    const version = '20990301000001';
    try {
      await stores.postgres.query(
        'CREATE TABLE public.migration_retry_fixture (value integer NOT NULL)'
      );
      await stores.postgres.query('INSERT INTO public.migration_retry_fixture VALUES (1), (1)');
      await writeFile(
        join(directory, `${version}_unique_retry_index.sql`),
        `-- migrate:no-transaction\n-- migrate:up\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_retry_fixture_idx ON public.migration_retry_fixture (value);\n-- migrate:down\n`
      );

      await expect(applyMigrations(stores.postgres, directory)).rejects.toThrow();
      const failedIndex = await stores.postgres.query(
        `SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = 'public.migration_retry_fixture_idx'::regclass`
      );
      expect(failedIndex.rows).toEqual([{ indisvalid: false }]);
      const failedVersion = await stores.postgres.query(
        'SELECT 1 FROM public.schema_migrations WHERE version = $1',
        [version]
      );
      expect(failedVersion.rowCount).toBe(0);

      await stores.postgres.query('DELETE FROM public.migration_retry_fixture WHERE value = 1');
      await applyMigrations(stores.postgres, directory);
      const validIndex = await stores.postgres.query(
        `SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = 'public.migration_retry_fixture_idx'::regclass`
      );
      expect(validIndex.rows).toEqual([{ indisvalid: true }]);
      const appliedVersion = await stores.postgres.query(
        'SELECT 1 FROM public.schema_migrations WHERE version = $1',
        [version]
      );
      expect(appliedVersion.rowCount).toBe(1);
    } finally {
      await stores.postgres.query(
        'DROP INDEX CONCURRENTLY IF EXISTS public.migration_retry_fixture_idx'
      );
      await stores.postgres.query('DROP TABLE IF EXISTS public.migration_retry_fixture');
      await stores.postgres.query('DELETE FROM public.schema_migrations WHERE version = $1', [
        version,
      ]);
      await rm(directory, { recursive: true, force: true });
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('resolves invalid concurrent indexes in the target table schema', async () => {
    const stores = await createTestStores();
    const directory = await mkdtemp(join(tmpdir(), 'migration-schema-retry-'));
    const version = '20990301000002';
    try {
      await stores.postgres.query('CREATE SCHEMA IF NOT EXISTS core');
      await stores.postgres.query(
        'CREATE TABLE core.migration_schema_fixture (value integer NOT NULL)'
      );
      await stores.postgres.query(
        'CREATE TABLE public.migration_schema_fixture (value integer NOT NULL)'
      );
      await stores.postgres.query('INSERT INTO core.migration_schema_fixture VALUES (1), (1)');
      await stores.postgres.query('INSERT INTO public.migration_schema_fixture VALUES (1)');
      await stores.postgres.query(
        'CREATE UNIQUE INDEX migration_schema_fixture_idx ON public.migration_schema_fixture (value)'
      );
      await writeFile(
        join(directory, `${version}_unique_retry_index.sql`),
        `-- migrate:no-transaction\n-- migrate:up\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS migration_schema_fixture_idx ON core.migration_schema_fixture (value);\n-- migrate:down\n`
      );

      await expect(applyMigrations(stores.postgres, directory)).rejects.toThrow();
      await stores.postgres.query('DELETE FROM core.migration_schema_fixture WHERE value = 1');
      await applyMigrations(stores.postgres, directory);

      const indexes = await stores.postgres.query(`
        SELECT n.nspname AS schema, i.indisvalid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'migration_schema_fixture_idx'
        ORDER BY n.nspname
      `);
      expect(indexes.rows).toEqual([
        { schema: 'core', indisvalid: true },
        { schema: 'public', indisvalid: true },
      ]);
      const appliedVersion = await stores.postgres.query(
        'SELECT 1 FROM public.schema_migrations WHERE version = $1',
        [version]
      );
      expect(appliedVersion.rowCount).toBe(1);
    } finally {
      await stores.postgres.query(
        'DROP INDEX CONCURRENTLY IF EXISTS core.migration_schema_fixture_idx'
      );
      await stores.postgres.query(
        'DROP INDEX CONCURRENTLY IF EXISTS public.migration_schema_fixture_idx'
      );
      await stores.postgres.query('DROP TABLE IF EXISTS core.migration_schema_fixture');
      await stores.postgres.query('DROP TABLE IF EXISTS public.migration_schema_fixture');
      await stores.postgres.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          version varchar(255) NOT NULL PRIMARY KEY,
          applied_at timestamp without time zone NOT NULL DEFAULT current_timestamp
        )
      `);
      await stores.postgres.query('DELETE FROM public.schema_migrations WHERE version = $1', [
        version,
      ]);
      await rm(directory, { recursive: true, force: true });
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('rolls back a failing migration and its version while keeping earlier files applied', async () => {
    const stores = await createTestStores();
    const directory = await mkdtemp(join(tmpdir(), 'migration-rollback-'));
    try {
      await writeFile(
        join(directory, '20990201000002_failing_change.sql'),
        '-- migrate:up\nCREATE TABLE public.migration_failed_fixture (value integer);\nINSERT INTO public.migration_failed_fixture VALUES (1);\nINSERT INTO public.no_such_table VALUES (1);\n-- migrate:down\n'
      );
      await writeFile(
        join(directory, '20990201000001_prior_change.sql'),
        '-- migrate:up\nCREATE TABLE public.migration_prior_fixture (value integer);\n-- migrate:down\n'
      );
      await expect(applyMigrations(stores.postgres, directory)).rejects.toThrow();
      const objects = await stores.postgres.query(`
        SELECT to_regclass('public.migration_prior_fixture') AS prior,
               to_regclass('public.migration_failed_fixture') AS failed
      `);
      expect(objects.rows[0]).toEqual({ prior: 'migration_prior_fixture', failed: null });
      const versions = await stores.postgres.query(
        `SELECT version FROM public.schema_migrations WHERE version LIKE '2099020100000%' ORDER BY version`
      );
      expect(versions.rows.map(({ version }) => version)).toEqual(['20990201000001']);
    } finally {
      await stores.postgres.query('DROP TABLE IF EXISTS public.migration_failed_fixture');
      await stores.postgres.query('DROP TABLE IF EXISTS public.migration_prior_fixture');
      await stores.postgres.query(
        "DELETE FROM public.schema_migrations WHERE version LIKE '2099020100000%'"
      );
      await rm(directory, { recursive: true, force: true });
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
