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

  it('selects the nearest vector from beyond the SQL candidate window with pagination', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      await vectorStore.clear();
      const query = 'quasar nebula distinctive';
      for (let i = 0; i < 15; i++)
        await vectorStore.save({
          ...entry(`candidate-far-${i}`, `unrelated token${i}`),
          timestamp: new Date(0),
        });
      await vectorStore.save({ ...entry('candidate-nearest', query), timestamp: new Date(0) });
      await vectorStore.save({
        ...entry('candidate-second', 'quasar nebula'),
        timestamp: new Date(0),
      });
      const results = await vectorStore.search({ query, limit: 1, offset: 1 });
      expect(results[0]?.entry.id).toBe('candidate-second');
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('atomically upserts concurrent facts with one natural key', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      await vectorStore.clear();
      const fact = (id: string, content: string): MemoryEntry => ({
        ...entry(id, content),
        type: 'fact',
        metadata: { subject: 'Ada', attribute: 'occupation' },
      });
      await Promise.all([
        vectorStore.save(fact('natural-a', 'mathematician')),
        vectorStore.save(fact('natural-b', 'writer')),
      ]);
      const result = await stores.postgres.query(
        `SELECT id, content FROM core.memories WHERE type='fact' AND metadata->>'subject'='Ada' AND metadata->>'attribute'='occupation'`
      );
      expect(result.rowCount).toBe(1);
      expect(['mathematician', 'writer']).toContain(result.rows[0]?.['content']);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('updates an existing natural-key fact by id when its subject or attribute is renamed', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(logger(), stores.postgres, createTestEmbedder());
      await vectorStore.clear();
      const fact = (content: string, subject: string, attribute: string): MemoryEntry => ({
        ...entry('renamed-natural-fact', content),
        type: 'fact',
        metadata: { subject, attribute },
      });
      await vectorStore.save(fact('Ada is a mathematician', 'Ada', 'occupation'));
      await vectorStore.save(fact('Ada is an engineer', 'Ada', 'profession'));
      await vectorStore.save(fact('Augusta is an engineer', 'Augusta', 'profession'));

      const saved = await vectorStore.getById('renamed-natural-fact');
      expect(saved).toMatchObject({
        id: 'renamed-natural-fact',
        content: 'Augusta is an engineer',
        metadata: { subject: 'Augusta', attribute: 'profession' },
      });
      expect(await vectorStore.count({ types: ['fact'] })).toBe(1);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('enforces protected-reflection expiry and total retention in Postgres', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const vectorStore = new PostgresVectorStore(
        logger(),
        stores.postgres,
        createTestEmbedder(),
        20
      );
      await vectorStore.clear();
      for (let i = 0; i < 12; i++)
        await vectorStore.save({
          ...entry(`retained-protected-${i}`, `protected ${i}`),
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
          timestamp: new Date(i * 1000),
        });
      for (let i = 0; i < 10; i++)
        await vectorStore.save({
          ...entry(`retained-filler-${i}`, `filler ${i}`),
          timestamp: new Date(20000 + i),
        });
      const rows = await stores.postgres.query(
        `SELECT tags FROM core.memories WHERE id LIKE 'retained-%'`
      );
      expect(rows.rowCount).toBeLessThanOrEqual(20);
      const unresolved = rows.rows.filter((row) =>
        (row['tags'] as string[] | null)?.includes('state:unresolved')
      );
      const expired = rows.rows.filter((row) =>
        (row['tags'] as string[] | null)?.includes('state:expired')
      );
      expect(unresolved.length).toBeLessThanOrEqual(10);
      expect(unresolved.length + expired.length).toBeGreaterThanOrEqual(10);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('runs the existing soul retention scenarios against Postgres', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const save = async (
        vectorStore: PostgresVectorStore,
        id: string,
        timestamp: number,
        overrides: Partial<MemoryEntry> = {}
      ) => vectorStore.save({ ...entry(id, id), timestamp: new Date(timestamp), ...overrides });

      const protectedStore = new PostgresVectorStore(
        logger(),
        stores.postgres,
        createTestEmbedder(),
        5
      );
      await protectedStore.clear();
      await save(protectedStore, 'scenario-protected', 1, {
        type: 'thought',
        tags: ['soul:reflection', 'state:unresolved'],
      });
      for (let i = 0; i < 6; i++) await save(protectedStore, `scenario-regular-${i}`, i + 10);
      expect(
        (await protectedStore.getAll()).some((memory) => memory.id === 'scenario-protected')
      ).toBe(true);

      await protectedStore.clear();
      await save(protectedStore, 'scenario-resolved', 1, {
        type: 'thought',
        tags: ['soul:reflection', 'state:resolved'],
      });
      for (let i = 0; i < 6; i++) await save(protectedStore, `scenario-resolved-fill-${i}`, i + 10);
      expect(
        (await protectedStore.getAll()).some((memory) => memory.id === 'scenario-resolved')
      ).toBe(false);

      const typeStore = new PostgresVectorStore(
        logger(),
        stores.postgres,
        createTestEmbedder(),
        10
      );
      await typeStore.clear();
      await save(typeStore, 'scenario-reflection', 1, {
        type: 'thought',
        tags: ['soul:reflection', 'state:unresolved'],
      });
      await save(typeStore, 'scenario-question', 2, {
        type: 'thought',
        tags: ['soul:question', 'state:unresolved'],
      });
      for (let i = 0; i < 10; i++) await save(typeStore, `scenario-type-fill-${i}`, i + 10);
      expect((await typeStore.getAll()).some((memory) => memory.id === 'scenario-reflection')).toBe(
        true
      );

      const oldestStore = new PostgresVectorStore(
        logger(),
        stores.postgres,
        createTestEmbedder(),
        3
      );
      await oldestStore.clear();
      for (const [id, time] of [
        ['scenario-oldest', 1],
        ['scenario-middle', 2],
        ['scenario-newest', 3],
        ['scenario-trigger', 4],
      ] as const)
        await save(oldestStore, id, time);
      const oldestEntries = await oldestStore.getAll();
      expect(oldestEntries.some((memory) => memory.id === 'scenario-oldest')).toBe(false);
      expect(oldestEntries.some((memory) => memory.id === 'scenario-newest')).toBe(true);
      expect(oldestEntries.some((memory) => memory.id === 'scenario-trigger')).toBe(true);

      const boundedStore = new PostgresVectorStore(
        logger(),
        stores.postgres,
        createTestEmbedder(),
        20
      );
      await boundedStore.clear();
      for (let i = 0; i < 3; i++)
        await save(boundedStore, `scenario-bound-protected-${i}`, i, {
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
        });
      for (let i = 0; i < 20; i++) await save(boundedStore, `scenario-bound-regular-${i}`, i + 10);
      expect(await boundedStore.count()).toBeLessThanOrEqual(20);
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
