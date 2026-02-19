/**
 * Tests for entity extraction during consolidation.
 *
 * Covers: entities/relations populated, entries marked extracted, idempotent re-runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryConsolidator } from '../../../src/storage/memory-consolidator.js';
import { createJsonMemoryProvider } from '../../../src/storage/memory-provider.js';
import { JsonGraphStore } from '../../../src/storage/graph-store.js';
import type { EntityExtractor, ExtractionResult } from '../../../src/storage/entity-extractor.js';
import type { MemoryEntry } from '../../../src/layers/cognition/tools/registry.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockStorage() {
  const data = new Map<string, unknown>();
  return {
    load: vi.fn(async (key: string) => data.get(key) ?? null),
    save: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    exists: vi.fn(async (key: string) => data.has(key)),
  };
}

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as import('../../../src/types/logger.js').Logger;
}

function createMockExtractor(result: ExtractionResult): EntityExtractor {
  return {
    extract: vi.fn().mockResolvedValue(result),
  };
}

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    type: 'fact',
    timestamp: new Date(),
    confidence: 0.8,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MemoryConsolidator with entity extraction', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let logger: ReturnType<typeof createMockLogger>;
  let graphStore: JsonGraphStore;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    graphStore = new JsonGraphStore(logger, { storage, storageKey: 'graph' });
  });

  it('extracts entities and populates graph during consolidation', async () => {
    const extractor = createMockExtractor({
      entities: [
        { name: 'John', type: 'person', aliases: [], confidence: 0.9, sourceMemoryIds: ['e1'] },
        { name: 'Google', type: 'organization', aliases: [], confidence: 0.8, sourceMemoryIds: ['e1'] },
      ],
      relations: [
        { fromName: 'John', toName: 'Google', type: 'works_at', strength: 0.8, confidence: 0.85, sourceMemoryIds: ['e1'] },
      ],
    });

    const consolidator = new MemoryConsolidator(logger, {}, { entityExtractor: extractor, graphStore });
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(makeEntry({ id: 'e1', content: 'John works at Google' }));

    const result = await consolidator.consolidate(memoryProvider);

    expect(result.entitiesExtracted).toBe(2);
    expect(result.relationsExtracted).toBe(1);

    // Verify graph was populated
    const entities = await graphStore.getAllEntities();
    expect(entities).toHaveLength(2);

    const relations = await graphStore.getAllRelations();
    expect(relations).toHaveLength(1);
  });

  it('marks entries as graphExtracted after processing', async () => {
    const extractor = createMockExtractor({ entities: [], relations: [] });
    const consolidator = new MemoryConsolidator(logger, {}, { entityExtractor: extractor, graphStore });
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(makeEntry({ id: 'e1', content: 'test content' }));
    await consolidator.consolidate(memoryProvider);

    // Entry should now have graphExtracted metadata
    const entry = await memoryProvider.getById('e1');
    expect(entry?.metadata?.['graphExtracted']).toBe(true);
  });

  it('skips already-extracted entries (idempotent)', async () => {
    const extractor = createMockExtractor({ entities: [], relations: [] });
    const consolidator = new MemoryConsolidator(logger, {}, { entityExtractor: extractor, graphStore });
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(
      makeEntry({
        id: 'e1',
        content: 'already extracted',
        metadata: { graphExtracted: true },
      })
    );

    await consolidator.consolidate(memoryProvider);

    // Extractor should not have been called (no unextracted entries)
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  it('skips extraction when no entityExtractor is provided', async () => {
    const consolidator = new MemoryConsolidator(logger);
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(makeEntry({ id: 'e1', content: 'test' }));

    const result = await consolidator.consolidate(memoryProvider);
    expect(result.entitiesExtracted).toBe(0);
    expect(result.relationsExtracted).toBe(0);
  });

  it('merges entities with existing graph entities', async () => {
    // Pre-populate graph with an existing "John" entity
    await graphStore.upsertEntity({
      id: 'ent_existing',
      name: 'John',
      type: 'person',
      aliases: [],
      lastActivated: new Date().toISOString(),
      sourceMemoryIds: ['old_mem'],
    });

    const extractor = createMockExtractor({
      entities: [
        { name: 'John', type: 'person', aliases: ['Johnny'], confidence: 0.9, sourceMemoryIds: ['e1'] },
      ],
      relations: [],
    });

    const consolidator = new MemoryConsolidator(logger, {}, { entityExtractor: extractor, graphStore });
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(makeEntry({ id: 'e1', content: 'John went to the store' }));
    await consolidator.consolidate(memoryProvider);

    // Should still be one John entity, but with merged data
    const entities = await graphStore.getAllEntities();
    const johns = entities.filter((e) => e.name === 'John');
    expect(johns).toHaveLength(1);
    expect(johns[0]!.aliases).toContain('Johnny');
    expect(johns[0]!.sourceMemoryIds).toContain('old_mem');
    expect(johns[0]!.sourceMemoryIds).toContain('e1');
  });

  it('handles extraction errors gracefully', async () => {
    const extractor: EntityExtractor = {
      extract: vi.fn().mockRejectedValue(new Error('LLM failed')),
    };

    const consolidator = new MemoryConsolidator(logger, {}, { entityExtractor: extractor, graphStore });
    const memoryProvider = createJsonMemoryProvider(logger, { storage, storageKey: 'memory', maxEntries: 10000 });

    await memoryProvider.save(makeEntry({ id: 'e1', content: 'test' }));

    // Should not throw — errors are logged and swallowed
    const result = await consolidator.consolidate(memoryProvider);
    expect(result.entitiesExtracted).toBe(0);
    expect(result.relationsExtracted).toBe(0);
  });
});
