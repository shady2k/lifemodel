import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPersistentRecipientRegistry } from '../../src/core/recipient-registry.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestStores } from '../helpers/test-stores.js';

function intercept(
  pool: Pool,
  options: { failConnect?: () => boolean; failSql?: (sql: string) => boolean }
): Pool {
  return new Proxy(pool, {
    get(target, property) {
      if (property === 'connect')
        return async () => {
          if (options.failConnect?.()) throw new Error('injected connect failure');
          const client = await target.connect();
          return new Proxy(client, {
            get(c, key) {
              if (key === 'query')
                return (sql: string, values?: unknown[]) => {
                  if (options.failSql?.(sql)) throw new Error('injected statement failure');
                  return c.query(sql, values);
                };
              const value = Reflect.get(c, key, c);
              return typeof value === 'function' ? value.bind(c) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('Postgres recipient registry retries', () => {
  it('retains remove, clear, and dirty batches after statement and connection failures', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      let failConnect = false;
      let failDelete = false;
      const pool = intercept(stores.postgres, {
        failConnect: () => failConnect,
        failSql: (sql) => failDelete && sql.startsWith('DELETE FROM core.recipient_registry'),
      });
      const registry = createPersistentRecipientRegistry(pool, createTestLogger(), {
        saveDebounceMs: 60_000,
      });
      await registry.init();
      const removed = registry.getOrCreate('web', 'remove-target');
      await registry.flush();
      registry.remove(removed);
      failDelete = true;
      await expect(registry.flush()).rejects.toThrow('injected statement failure');
      failDelete = false;
      await registry.flush();
      expect(
        (
          await stores.postgres.query(
            'SELECT 1 FROM core.recipient_registry WHERE recipient_id = $1',
            [removed]
          )
        ).rowCount
      ).toBe(0);

      const cleared = registry.getOrCreate('web', 'clear-target');
      await registry.flush();
      await registry.clear();
      expect(
        (
          await stores.postgres.query(
            'SELECT 1 FROM core.recipient_registry WHERE recipient_id = $1',
            [cleared]
          )
        ).rowCount
      ).toBe(0);

      const pending = registry.getOrCreate('web', 'connect-target');
      failConnect = true;
      await expect(registry.flush()).rejects.toThrow('injected connect failure');
      failConnect = false;
      await registry.flush();
      expect(
        (
          await stores.postgres.query(
            'SELECT 1 FROM core.recipient_registry WHERE recipient_id = $1',
            [pending]
          )
        ).rowCount
      ).toBe(1);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
