import { describe, expect, it } from 'vitest';
import { PostgresConfigStore } from '../../src/config/postgres-config-store.js';
import { createPersistentRecipientRegistry } from '../../src/core/recipient-registry.js';
import {
  createFencedPostgres,
  StalePostgresEpochError,
} from '../../src/storage/fenced-postgres.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { PostgresStorage } from '../../src/storage/postgres-storage.js';
import {
  PostgresGraphStore,
  PostgresVectorStore,
} from '../../src/storage/postgres-memory-store.js';
import { PostgresSoulStore } from '../../src/storage/soul-provider.js';
import type { MemoryEntry } from '../../src/layers/cognition/tools/registry.js';
import type { AgentConfigFile } from '../../src/config/config-schema.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestEmbedder } from '../helpers/test-embedder.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestStores } from '../helpers/test-stores.js';
import { rmDir, startInstance, waitFor } from '../helpers/core-loop-drain-harness.js';

describe('active-holder fencing for core Postgres stores', () => {
  it('allows epoch N, refuses every stale adapter write after N+1, and stops the stale core', async () => {
    const stores = await createTestStores();
    const logger = createTestLogger();
    const suffix = `${stores.workerId}-${Date.now()}`;
    const corePath = `/tmp/lifemodel-stale-postgres-${suffix}`;
    let core: Awaited<ReturnType<typeof startInstance>> | undefined;
    try {
      await applyTestMigrations(stores.postgres);
      await stores.postgres.query('DELETE FROM core.soul');
      await stores.postgres.query('DELETE FROM core.settings');
      await stores.postgres.query(
        `INSERT INTO core.active_holder (id, epoch) VALUES (true, 1)
         ON CONFLICT (id) DO UPDATE SET epoch = 1`
      );

      const writerA = createFencedPostgres(stores.postgres, 1);
      const kvA = new PostgresStorage(writerA);
      const conversationA = new PostgresConversationStore(writerA);
      const vectorA = new PostgresVectorStore(logger, writerA, createTestEmbedder());
      const graphA = new PostgresGraphStore(writerA, logger);
      const soulA = new PostgresSoulStore(writerA);
      const registryA = createPersistentRecipientRegistry(writerA, logger, {
        saveDebounceMs: 60_000,
      });
      const settingsA = new PostgresConfigStore(writerA);
      const timestamp = new Date().toISOString();
      const memory = (id: string): MemoryEntry => ({
        id,
        type: 'fact',
        content: `fact ${id}`,
        timestamp: new Date(timestamp),
        confidence: 0.9,
      });

      await kvA.save(`before-${suffix}`, { epoch: 1 });
      await conversationA.save(`conversation:before-${suffix}`, {
        messages: [{ role: 'user', content: 'epoch one', timestamp }],
      });
      await vectorA.save(memory(`before-${suffix}`));
      await graphA.upsertEntity({
        id: `entity-before-${suffix}`,
        name: `Before ${suffix}`,
        aliases: [],
        type: 'person',
        lastActivated: timestamp,
        sourceMemoryIds: [],
      });
      await soulA.save(null, { marker: 'epoch-one' });
      await registryA.init();
      registryA.getOrCreate('fence-test', `before-${suffix}`);
      await registryA.flush();
      await settingsA.write({ marker: 'epoch-one' } as AgentConfigFile);

      await stores.postgres.query('UPDATE core.active_holder SET epoch = 2 WHERE id = true');
      const writerB = createFencedPostgres(stores.postgres, 2);
      await new PostgresStorage(writerB).save(`after-${suffix}`, { epoch: 2 });

      await expect(kvA.save(`stale-${suffix}`, { epoch: 1 })).rejects.toBeInstanceOf(
        StalePostgresEpochError
      );
      await expect(
        conversationA.save(`conversation:stale-${suffix}`, {
          messages: [{ role: 'user', content: 'stale conversation', timestamp }],
        })
      ).rejects.toBeInstanceOf(StalePostgresEpochError);
      await expect(vectorA.save(memory(`stale-${suffix}`))).rejects.toBeInstanceOf(
        StalePostgresEpochError
      );
      await expect(
        graphA.upsertEntity({
          id: `entity-stale-${suffix}`,
          name: `Stale ${suffix}`,
          aliases: [],
          type: 'person',
          lastActivated: timestamp,
          sourceMemoryIds: [],
        })
      ).rejects.toBeInstanceOf(StalePostgresEpochError);
      await expect(soulA.save(1, { marker: 'stale' })).rejects.toBeInstanceOf(
        StalePostgresEpochError
      );
      registryA.getOrCreate('fence-test', `stale-${suffix}`);
      await expect(registryA.flush()).rejects.toBeInstanceOf(StalePostgresEpochError);
      await expect(settingsA.write({ marker: 'stale' } as AgentConfigFile)).rejects.toBeInstanceOf(
        StalePostgresEpochError
      );

      const unseen = await Promise.all([
        stores.postgres.query('SELECT 1 FROM core.kv WHERE key = $1', [`stale-${suffix}`]),
        stores.postgres.query('SELECT 1 FROM core.conversation_messages WHERE recipient_id = $1', [
          `stale-${suffix}`,
        ]),
        stores.postgres.query('SELECT 1 FROM core.memories WHERE id = $1', [`stale-${suffix}`]),
        stores.postgres.query('SELECT 1 FROM core.memory_entities WHERE id = $1', [
          `entity-stale-${suffix}`,
        ]),
        stores.postgres.query(`SELECT 1 FROM core.soul WHERE document->>'marker' = 'stale'`),
        stores.postgres.query('SELECT 1 FROM core.recipient_registry WHERE destination = $1', [
          `stale-${suffix}`,
        ]),
      ]);
      expect(unseen.map((result) => result.rowCount)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(
        (
          await stores.postgres.query(
            `SELECT document FROM core.settings WHERE id = 'agent-config'`
          )
        ).rows[0]?.['document']
      ).toEqual({ marker: 'epoch-one' });

      await expect(
        writerA.query(
          `WITH candidate AS (SELECT $1::text AS key)
         INSERT INTO core.kv (key, value) SELECT key, '{"epoch":1}'::jsonb FROM candidate`,
          [`cte-stale-${suffix}`]
        )
      ).rejects.toBeInstanceOf(StalePostgresEpochError);
      expect(
        (
          await stores.postgres.query('SELECT 1 FROM core.kv WHERE key = $1', [
            `cte-stale-${suffix}`,
          ])
        ).rowCount
      ).toBe(0);

      let staleCoreError: Error | null = null;
      core = await startInstance(corePath, {
        tickIntervalMs: 5,
        commitSnapshot: async () => kvA.save(`core-loop-stale-${suffix}`, { epoch: 1 }),
        onStaleSnapshot: (error) => {
          staleCoreError = error;
        },
      });
      await waitFor(() => staleCoreError !== null, 'stale core Postgres write stops core A');
      expect(staleCoreError).toBeInstanceOf(StalePostgresEpochError);
      expect(core.coreLoop.stopReport().loopStopped).toBe(true);
      expect(
        (
          await stores.postgres.query('SELECT 1 FROM core.kv WHERE key = $1', [
            `core-loop-stale-${suffix}`,
          ])
        ).rowCount
      ).toBe(0);
    } finally {
      if (core) await core.coreLoop.stop();
      await rmDir(corePath);
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
