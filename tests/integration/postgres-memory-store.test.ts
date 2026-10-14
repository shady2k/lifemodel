import { describe, expect, it } from 'vitest';
import { createEmbedder } from '../../src/storage/embedder.js';
import {
  PostgresGraphStore,
  PostgresVectorStore,
} from '../../src/storage/postgres-memory-store.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';
import { createTestLogger } from '../helpers/test-logger.js';

describe('Postgres memory stores', () => {
  it('stores embedded memories and retrieves the nearest result through the memory search path', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const embedder = createEmbedder();
      const store = new PostgresVectorStore(createTestLogger(), stores.postgres, embedder);
      await store.save({
        id: 'memory-near',
        type: 'fact',
        content: 'I enjoy drinking coffee each morning',
        timestamp: new Date(),
        confidence: 0.9,
      });
      await store.save({
        id: 'memory-far',
        type: 'fact',
        content: 'The moon orbits the earth',
        timestamp: new Date(),
        confidence: 0.9,
      });
      const results = await store.search({ query: 'coffee in the morning', limit: 2 });
      expect(results[0]?.entry.id).toBe('memory-near');
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  }, 120_000);

  it('reads graph entities and relations from Postgres after a store restart', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const graph = new PostgresGraphStore(stores.postgres, createTestLogger());
      await graph.upsertEntity({
        id: 'ent_a',
        name: 'Ada',
        aliases: ['A'],
        type: 'person',
        lastActivated: new Date().toISOString(),
        sourceMemoryIds: ['m1'],
      });
      await graph.upsertEntity({
        id: 'ent_b',
        name: 'Analytical Engine',
        aliases: [],
        type: 'thing',
        lastActivated: new Date().toISOString(),
        sourceMemoryIds: ['m1'],
      });
      await graph.upsertRelation({
        id: 'rel_a_b',
        fromId: 'ent_a',
        toId: 'ent_b',
        type: 'created',
        strength: 0.9,
        confidence: 0.8,
        lastActivated: new Date().toISOString(),
        sourceMemoryIds: ['m1'],
      });
      const restarted = new PostgresGraphStore(stores.postgres, createTestLogger());
      expect((await restarted.findEntity('A'))?.name).toBe('Ada');
      expect((await restarted.getRelations('ent_a'))[0]).toMatchObject({
        id: 'rel_a_b',
        toId: 'ent_b',
      });
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
