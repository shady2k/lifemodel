import { describe, expect, it, vi } from 'vitest';
import { MemoryProviderImpl } from '../../src/storage/memory-provider.js';
import { MemoryConsolidator } from '../../src/storage/memory-consolidator.js';
import {
  PostgresGraphStore,
  PostgresVectorStore,
} from '../../src/storage/postgres-memory-store.js';
import type { EntityExtractor, ExtractionResult } from '../../src/storage/entity-extractor.js';
import type { MemoryEntry } from '../../src/layers/cognition/tools/registry.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestStores } from '../helpers/test-stores.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createTestEmbedder } from '../helpers/test-embedder.js';

const logger = () => createTestLogger();
const entry = (id: string, content: string): MemoryEntry => ({
  id,
  type: 'fact',
  content,
  timestamp: new Date(),
  confidence: 0.9,
});

describe('Postgres memory stores', () => {
  it('stores embedded memories and finds the nearest through the memory provider search path', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      await vectorStore.clear();
      const memory = new MemoryProviderImpl(logger(), { vectorStore });
      await memory.save(entry('pgv-near', 'I enjoy drinking coffee each morning'));
      await memory.save(entry('pgv-far', 'The moon orbits the earth'));
      const results = await memory.search('coffee in the morning', { limit: 2 });
      expect(results.entries[0]?.id).toBe('pgv-near');
      expect(results.metadata.totalMatched).toBe(2);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('persists entities and relations written by the consolidator across a store restart', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      const graphStore = new PostgresGraphStore(stores.postgres, logger());
      await vectorStore.clear();
      await graphStore.clear();
      const memory = new MemoryProviderImpl(logger(), { vectorStore, graphStore });
      await memory.save(entry('pggraph-success', 'Ada created the Analytical Engine'));
      const extractor = fixedExtractor({
        entities: [
          {
            name: 'Ada',
            type: 'person',
            aliases: [],
            confidence: 0.9,
            sourceMemoryIds: ['pggraph-success'],
          },
          {
            name: 'Analytical Engine',
            type: 'thing',
            aliases: [],
            confidence: 0.9,
            sourceMemoryIds: ['pggraph-success'],
          },
        ],
        relations: [
          {
            fromName: 'Ada',
            toName: 'Analytical Engine',
            type: 'created',
            strength: 0.9,
            confidence: 0.8,
            sourceMemoryIds: ['pggraph-success'],
          },
        ],
      });
      const consolidator = new MemoryConsolidator(
        logger(),
        {},
        { entityExtractor: extractor, graphStore }
      );
      const result = await consolidator.consolidate(memory);
      expect(result.entitiesExtracted).toBe(2);
      expect(result.relationsExtracted).toBe(1);

      const restarted = new PostgresGraphStore(stores.postgres, logger());
      expect((await restarted.findEntity('Ada'))?.name).toBe('Ada');
      expect(await restarted.getAllRelations()).toMatchObject([
        { fromId: expect.any(String), type: 'created', sourceMemoryIds: ['pggraph-success'] },
      ]);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('rolls back all graph writes when consolidation fails midway through entity writes', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      const graphStore = new PostgresGraphStore(stores.postgres, logger());
      await vectorStore.clear();
      await graphStore.clear();
      const memory = new MemoryProviderImpl(logger(), { vectorStore, graphStore });
      await memory.save(entry('pggraph-rollback', 'Ada and ada appear in this text'));
      await stores.postgres.query(
        'ALTER TABLE core.memory_relations ADD CONSTRAINT fail_graph_write CHECK (strength < 0)'
      );
      const extractor = fixedExtractor({
        entities: [
          {
            name: 'Ada',
            type: 'person',
            aliases: [],
            confidence: 0.9,
            sourceMemoryIds: ['pggraph-rollback'],
          },
          {
            name: 'Analytical Engine',
            type: 'thing',
            aliases: [],
            confidence: 0.9,
            sourceMemoryIds: ['pggraph-rollback'],
          },
        ],
        relations: [
          {
            fromName: 'Ada',
            toName: 'Analytical Engine',
            type: 'created',
            strength: 0.9,
            confidence: 0.8,
            sourceMemoryIds: ['pggraph-rollback'],
          },
        ],
      });
      const consolidator = new MemoryConsolidator(
        logger(),
        {},
        { entityExtractor: extractor, graphStore }
      );
      await consolidator.consolidate(memory);
      await stores.postgres.query(
        'ALTER TABLE core.memory_relations DROP CONSTRAINT fail_graph_write'
      );
      expect(await graphStore.getAllEntities()).toEqual([]);
      expect(await graphStore.getAllRelations()).toEqual([]);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});

function fixedExtractor(result: ExtractionResult): EntityExtractor {
  return { extract: vi.fn(async () => result) };
}
