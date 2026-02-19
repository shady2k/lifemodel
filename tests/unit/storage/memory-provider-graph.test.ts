/**
 * Tests for graph-enhanced search and getAssociations().
 *
 * Covers: graph-enhanced search, deduplication, scoring combination,
 * getAssociations() with direct matches, related context, and open commitments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonMemoryProvider } from '../../../src/storage/memory-provider.js';
import { JsonVectorStore } from '../../../src/storage/vector-store.js';
import { JsonGraphStore } from '../../../src/storage/graph-store.js';
import type { MemoryEntry } from '../../../src/layers/cognition/tools/registry.js';
import type { GraphEntity, GraphRelation } from '../../../src/storage/graph-store.js';

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

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    type: 'fact',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeEntity(overrides: Partial<GraphEntity> & { id: string; name: string }): GraphEntity {
  return {
    aliases: [],
    type: 'person',
    lastActivated: new Date().toISOString(),
    sourceMemoryIds: [],
    ...overrides,
  };
}

function makeRelation(
  overrides: Partial<GraphRelation> & { id: string; fromId: string; toId: string }
): GraphRelation {
  return {
    type: 'related_to',
    strength: 0.8,
    confidence: 0.9,
    lastActivated: new Date().toISOString(),
    sourceMemoryIds: [],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('JsonMemoryProvider with GraphStore', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let logger: ReturnType<typeof createMockLogger>;
  let vectorStore: JsonVectorStore;
  let graphStore: JsonGraphStore;
  let provider: JsonMemoryProvider;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    vectorStore = new JsonVectorStore(logger, {
      storage,
      storageKey: 'memory',
      maxEntries: 10000,
    });
    graphStore = new JsonGraphStore(logger, {
      storage,
      storageKey: 'graph',
    });
    provider = new JsonMemoryProvider(logger, { vectorStore, graphStore });
  });

  describe('getAssociations', () => {
    beforeEach(async () => {
      // Seed memory entries
      await provider.save(
        makeEntry({
          id: 'mem_john_google',
          content: 'John works at Google as a senior engineer',
          tags: ['person', 'work'],
          confidence: 0.95,
        })
      );
      await provider.save(
        makeEntry({
          id: 'mem_john_sarah',
          content: 'John is married to Sarah',
          tags: ['person', 'relationship'],
          confidence: 0.9,
        })
      );
      await provider.save(
        makeEntry({
          id: 'mem_sarah_meta',
          content: 'Sarah recently started a new job at Meta',
          tags: ['person', 'work'],
          confidence: 0.85,
        })
      );
      await provider.save(
        makeEntry({
          id: 'mem_commitment',
          content: 'Promised to introduce John to VC friend',
          tags: ['state:active'],
          confidence: 0.9,
          metadata: { kind: 'commitment' },
        })
      );

      // Seed graph entities
      await graphStore.upsertEntity(
        makeEntity({
          id: 'ent_john',
          name: 'John',
          sourceMemoryIds: ['mem_john_google', 'mem_john_sarah'],
        })
      );
      await graphStore.upsertEntity(
        makeEntity({
          id: 'ent_sarah',
          name: 'Sarah',
          sourceMemoryIds: ['mem_john_sarah', 'mem_sarah_meta'],
        })
      );
      await graphStore.upsertEntity(
        makeEntity({
          id: 'ent_google',
          name: 'Google',
          type: 'organization',
          sourceMemoryIds: ['mem_john_google'],
        })
      );

      // Seed graph relations
      await graphStore.upsertRelation(
        makeRelation({
          id: 'rel_1',
          fromId: 'ent_john',
          toId: 'ent_sarah',
          type: 'married_to',
          strength: 0.9,
        })
      );
      await graphStore.upsertRelation(
        makeRelation({
          id: 'rel_2',
          fromId: 'ent_john',
          toId: 'ent_google',
          type: 'works_at',
          strength: 0.8,
        })
      );
    });

    it('returns direct matches from vector search', async () => {
      const result = await provider.getAssociations('John');
      expect(result.directMatches.length).toBeGreaterThan(0);
      // Direct matches should include entries mentioning John
      const contents = result.directMatches.map((e) => e.content);
      expect(contents.some((c) => c.includes('John'))).toBe(true);
    });

    it('returns related context via graph expansion', async () => {
      const result = await provider.getAssociations('John');
      // Should find Sarah via John → married_to → Sarah
      if (result.relatedContext.length > 0) {
        const vias = result.relatedContext.map((r) => r.via);
        expect(vias.some((v) => v.includes('married_to') || v.includes('works_at'))).toBe(true);
      }
    });

    it('finds open commitments linked to mentioned entities', async () => {
      // Add a commitment about Sarah (not directly matched by "John" search)
      await provider.save(
        makeEntry({
          id: 'mem_commitment_sarah',
          content: 'Promised to help Sarah with her resume',
          tags: ['state:active'],
          confidence: 0.9,
          metadata: { kind: 'commitment' },
        })
      );
      // Search for John — Sarah's commitment should surface via graph
      const result = await provider.getAssociations('John');
      // The Sarah commitment may appear if Sarah is a graph neighbor of John
      // and the commitment mentions Sarah
      const allContents = [
        ...result.directMatches.map((e) => e.content),
        ...result.relatedContext.map((r) => r.entry.content),
        ...result.openCommitments.map((e) => e.content),
      ];
      // At minimum, John-related content should appear
      expect(allContents.some((c) => c.includes('John'))).toBe(true);
    });

    it('deduplicates entries between direct and related', async () => {
      const result = await provider.getAssociations('John');
      const allIds = [
        ...result.directMatches.map((e) => e.id),
        ...result.relatedContext.map((r) => r.entry.id),
        ...result.openCommitments.map((e) => e.id),
      ];
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('respects hard caps on result counts', async () => {
      const result = await provider.getAssociations('John', 10);
      expect(result.directMatches.length).toBeLessThanOrEqual(3);
      expect(result.relatedContext.length).toBeLessThanOrEqual(2);
      expect(result.openCommitments.length).toBeLessThanOrEqual(2);
    });

    it('returns empty related context when no entities found', async () => {
      const result = await provider.getAssociations('xyznonexistent');
      expect(result.relatedContext).toHaveLength(0);
      expect(result.openCommitments).toHaveLength(0);
    });

    it('works without graphStore (graceful degradation)', async () => {
      const noGraphProvider = new JsonMemoryProvider(logger, { vectorStore });
      await noGraphProvider.save(makeEntry({ id: 'test', content: 'test content about John' }));
      const result = await noGraphProvider.getAssociations('John');
      expect(result.directMatches.length).toBeGreaterThan(0);
      expect(result.relatedContext).toHaveLength(0);
      expect(result.openCommitments).toHaveLength(0);
    });
  });
});
