/**
 * Tests for JsonVectorStore.
 *
 * Covers: save, search (TF-IDF scoring, tags, recency, confidence, salience),
 * pagination, filtering, inverted index, upsert, persist/load, golden query ranking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JsonVectorStore } from '../../../src/storage/vector-store.js';
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
    _data: data,
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('JsonVectorStore', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let logger: ReturnType<typeof createMockLogger>;
  let store: JsonVectorStore;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    store = new JsonVectorStore(logger, {
      storage,
      storageKey: 'memory',
      maxEntries: 10000,
    });
  });

  // ─── Basic CRUD ─────────────────────────────────────────────────────────

  describe('save and getById', () => {
    it('saves and retrieves an entry', async () => {
      const entry = makeEntry({ id: 'e1', content: 'hello world' });
      await store.save(entry);
      const result = await store.getById('e1');
      expect(result).toBeDefined();
      expect(result!.content).toBe('hello world');
    });

    it('upserts entry with same ID', async () => {
      const entry1 = makeEntry({ id: 'e1', content: 'version 1' });
      const entry2 = makeEntry({ id: 'e1', content: 'version 2' });
      await store.save(entry1);
      await store.save(entry2);
      const result = await store.getById('e1');
      expect(result!.content).toBe('version 2');
      expect(await store.count()).toBe(1);
    });

    it('upserts facts with same subject+attribute', async () => {
      const entry1 = makeEntry({
        id: 'e1',
        content: 'John works at Google',
        metadata: { subject: 'John', attribute: 'employer' },
      });
      const entry2 = makeEntry({
        id: 'e2',
        content: 'John works at Apple',
        metadata: { subject: 'John', attribute: 'employer' },
      });
      await store.save(entry1);
      await store.save(entry2);
      // Should upsert — still 1 entry with original ID
      expect(await store.count()).toBe(1);
      const result = await store.getById('e1');
      expect(result!.content).toBe('John works at Apple');
    });
  });

  describe('delete', () => {
    it('removes an entry', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello' }));
      expect(await store.delete('e1')).toBe(true);
      expect(await store.getById('e1')).toBeUndefined();
    });

    it('returns false for non-existent ID', async () => {
      expect(await store.delete('nope')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all entries', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'one' }));
      await store.save(makeEntry({ id: 'e2', content: 'two' }));
      await store.clear();
      expect(await store.count()).toBe(0);
    });
  });

  describe('count', () => {
    it('counts all entries', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'one' }));
      await store.save(makeEntry({ id: 'e2', content: 'two', type: 'thought' }));
      expect(await store.count()).toBe(2);
    });

    it('counts by type', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'one', type: 'fact' }));
      await store.save(makeEntry({ id: 'e2', content: 'two', type: 'thought' }));
      expect(await store.count({ types: ['fact'] })).toBe(1);
    });
  });

  // ─── Search scoring ─────────────────────────────────────────────────────

  describe('search', () => {
    it('returns empty for short query without filters', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world' }));
      const results = await store.search({ query: 'h' });
      expect(results).toHaveLength(0);
    });

    it('scores exact phrase match highest', async () => {
      await store.save(makeEntry({ id: 'exact', content: 'feeling stressed about work' }));
      await store.save(makeEntry({ id: 'partial', content: 'work is going well, no stress' }));
      const results = await store.search({ query: 'feeling stressed' });
      expect(results[0]!.entry.id).toBe('exact');
    });

    it('boosts tag matches', async () => {
      await store.save(
        makeEntry({ id: 'tagged', content: 'some content about health', tags: ['health'] })
      );
      await store.save(
        makeEntry({ id: 'untagged', content: 'some content about health topics' })
      );
      const results = await store.search({ query: 'health' });
      expect(results[0]!.entry.id).toBe('tagged');
    });

    it('boosts higher confidence entries', async () => {
      await store.save(
        makeEntry({ id: 'high', content: 'John works at Google', confidence: 0.95 })
      );
      await store.save(
        makeEntry({ id: 'low', content: 'John works at Google', confidence: 0.2 })
      );
      const results = await store.search({ query: 'John works' });
      expect(results[0]!.entry.id).toBe('high');
    });

    it('uses word boundaries for short terms', async () => {
      await store.save(makeEntry({ id: 'good', content: 'I like AI research' }));
      await store.save(makeEntry({ id: 'bad', content: 'I saw Yo-Kai Watch' }));
      const results = await store.search({ query: 'AI' });
      // "AI" should match as whole word in first entry but not in "Yo-Kai"
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('good');
    });

    it('applies recency boost', async () => {
      const recentDate = new Date();
      const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 2 weeks old
      await store.save(
        makeEntry({ id: 'recent', content: 'John likes pizza', timestamp: recentDate })
      );
      await store.save(
        makeEntry({ id: 'old', content: 'John likes pizza', timestamp: oldDate })
      );
      const results = await store.search({ query: 'John likes pizza' });
      expect(results[0]!.entry.id).toBe('recent');
    });

    it('applies salience boost', async () => {
      const entry1 = makeEntry({ id: 'salient', content: 'meeting with John tomorrow' });
      (entry1 as MemoryEntry & { salience?: number }).salience = 0.9;
      const entry2 = makeEntry({ id: 'normal', content: 'meeting with John tomorrow' });
      await store.save(entry1);
      await store.save(entry2);
      const results = await store.search({ query: 'meeting John' });
      expect(results[0]!.entry.id).toBe('salient');
    });
  });

  // ─── Filtering ────────────────────────────────────────────────────────

  describe('search filtering', () => {
    it('filters by type', async () => {
      await store.save(makeEntry({ id: 'f1', content: 'important fact', type: 'fact' }));
      await store.save(makeEntry({ id: 't1', content: 'important thought', type: 'thought' }));
      const results = await store.search({ query: 'important', types: ['fact'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('f1');
    });

    it('filters by recipientId', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world', recipientId: 'user1' }));
      await store.save(makeEntry({ id: 'e2', content: 'hello world', recipientId: 'user2' }));
      const results = await store.search({ query: 'hello world', recipientId: 'user1' });
      // Global entries (no recipientId) + user1 entries should be matched
      // user2 entries should be excluded
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('e1');
      expect(ids).not.toContain('e2');
    });

    it('filters by minConfidence', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world', confidence: 0.9 }));
      await store.save(makeEntry({ id: 'e2', content: 'hello world', confidence: 0.1 }));
      const results = await store.search({ query: 'hello world', minConfidence: 0.5 });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });

    it('filters by metadata', async () => {
      await store.save(
        makeEntry({ id: 'e1', content: 'test entry', metadata: { kind: 'reminder' } })
      );
      await store.save(
        makeEntry({ id: 'e2', content: 'test entry', metadata: { kind: 'note' } })
      );
      const results = await store.search({
        query: 'test entry',
        metadata: { kind: 'reminder' },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });

    it('filters by status', async () => {
      await store.save(
        makeEntry({
          id: 'e1',
          content: 'pending thing',
          type: 'intention',
          status: 'pending',
        })
      );
      await store.save(
        makeEntry({
          id: 'e2',
          content: 'completed thing',
          type: 'intention',
          status: 'completed',
        })
      );
      const results = await store.search({ query: 'thing', status: 'pending' });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });
  });

  // ─── Pagination ───────────────────────────────────────────────────────

  describe('pagination', () => {
    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeEntry({ id: `e${i}`, content: `test item number ${i}` }));
      }
      const page1 = await store.search({ query: 'test item', limit: 2, offset: 0 });
      const page2 = await store.search({ query: 'test item', limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // No overlap
      const page1Ids = page1.map((r) => r.entry.id);
      const page2Ids = page2.map((r) => r.entry.id);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
    });
  });

  // ─── TF-IDF / Inverted index ─────────────────────────────────────────

  describe('TF-IDF scoring', () => {
    it('ranks term-dense short docs higher than long docs with same term count', async () => {
      // Short doc with "pizza" is 1/3 of content
      await store.save(makeEntry({ id: 'short', content: 'John loves pizza' }));
      // Long doc where "pizza" is 1/10 of content
      await store.save(
        makeEntry({
          id: 'long',
          content:
            'Today we had a wonderful dinner party with many courses and pizza was just one of them',
        })
      );
      const results = await store.search({ query: 'pizza' });
      expect(results[0]!.entry.id).toBe('short');
    });

    it('penalizes very common terms via IDF', async () => {
      // Add many entries containing "the"
      for (let i = 0; i < 20; i++) {
        await store.save(
          makeEntry({ id: `common${i}`, content: `the entry number ${i} is here` })
        );
      }
      // Add one entry with a rare term
      await store.save(
        makeEntry({ id: 'rare', content: 'the quasar emission was observed last night' })
      );

      const results = await store.search({ query: 'quasar' });
      // "quasar" appears in 1 doc — should score higher than common words
      expect(results[0]!.entry.id).toBe('rare');
    });
  });

  // ─── Golden query tests ───────────────────────────────────────────────

  describe('golden query ranking', () => {
    beforeEach(async () => {
      // Seed with a corpus of facts
      const entries: Array<Partial<MemoryEntry> & { id: string; content: string }> = [
        {
          id: 'g1',
          content: 'John works at Google as a senior engineer',
          tags: ['person', 'work'],
          confidence: 0.95,
        },
        {
          id: 'g2',
          content: 'John is married to Sarah',
          tags: ['person', 'relationship'],
          confidence: 0.9,
        },
        {
          id: 'g3',
          content: "Sarah recently started a new job at Meta",
          tags: ['person', 'work'],
          confidence: 0.85,
        },
        {
          id: 'g4',
          content: "User's favorite food is sushi",
          tags: ['preferences', 'food'],
          confidence: 0.8,
        },
        {
          id: 'g5',
          content: 'Weekly team standup is every Monday at 9am',
          tags: ['schedule', 'work'],
          confidence: 0.9,
        },
        {
          id: 'g6',
          content: 'John mentioned he is feeling anxious about the product launch',
          tags: ['person', 'emotion'],
          confidence: 0.7,
        },
      ];
      for (const e of entries) {
        await store.save(makeEntry(e));
      }
    });

    it('query "John" ranks John-specific entries first', async () => {
      const results = await store.search({ query: 'John', limit: 3 });
      const topIds = results.map((r) => r.entry.id);
      // All top 3 should mention John
      expect(topIds).toContain('g1');
      expect(topIds).toContain('g2');
      expect(topIds).toContain('g6');
    });

    it('query "work" surfaces work-related entries', async () => {
      const results = await store.search({ query: 'work', limit: 3 });
      const topIds = results.map((r) => r.entry.id);
      expect(topIds).toContain('g1'); // "works at Google"
      expect(topIds).toContain('g5'); // work-tagged standup
    });

    it('query "Sarah job" ranks Sarah-specific entry highest', async () => {
      const results = await store.search({ query: 'Sarah job' });
      expect(results[0]!.entry.id).toBe('g3');
    });

    it('query "sushi" ranks food preference first', async () => {
      const results = await store.search({ query: 'sushi' });
      // All entries get some score from confidence/recency, but sushi entry should be #1
      expect(results[0]!.entry.id).toBe('g4');
    });
  });

  // ─── Persistence ──────────────────────────────────────────────────────

  describe('persist and reload', () => {
    it('round-trips entries through storage', async () => {
      const entry = makeEntry({
        id: 'e1',
        content: 'persisted entry',
        tags: ['test'],
        confidence: 0.8,
      });
      await store.save(entry);

      // Create new store with same storage
      const store2 = new JsonVectorStore(logger, {
        storage,
        storageKey: 'memory',
        maxEntries: 10000,
      });
      const result = await store2.getById('e1');
      expect(result).toBeDefined();
      expect(result!.content).toBe('persisted entry');
      expect(result!.tags).toEqual(['test']);
    });

    it('preserves salience through round-trip', async () => {
      const entry = makeEntry({ id: 'e1', content: 'salient entry' });
      (entry as MemoryEntry & { salience?: number }).salience = 0.75;
      await store.save(entry);

      const store2 = new JsonVectorStore(logger, {
        storage,
        storageKey: 'memory',
        maxEntries: 10000,
      });
      const result = await store2.getById('e1');
      expect((result as MemoryEntry & { salience?: number }).salience).toBe(0.75);
    });

    it('rebuilds inverted index on load', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'unique quasar observation' }));
      await store.save(makeEntry({ id: 'e2', content: 'another normal entry' }));

      // Create new store (forces reload and index rebuild)
      const store2 = new JsonVectorStore(logger, {
        storage,
        storageKey: 'memory',
        maxEntries: 10000,
      });
      const results = await store2.search({ query: 'quasar' });
      // Both entries get baseline scores from confidence/recency,
      // but the quasar entry should rank first due to text match
      expect(results[0]!.entry.id).toBe('e1');
    });
  });

  // ─── Pruning ──────────────────────────────────────────────────────────

  describe('pruning', () => {
    it('prunes oldest entries when over maxEntries', async () => {
      const smallStore = new JsonVectorStore(logger, {
        storage,
        storageKey: 'memory',
        maxEntries: 3,
      });

      for (let i = 0; i < 5; i++) {
        await smallStore.save(
          makeEntry({
            id: `e${i}`,
            content: `entry ${i}`,
            timestamp: new Date(Date.now() - (5 - i) * 1000), // Older entries first
          })
        );
      }

      expect(await smallStore.count()).toBeLessThanOrEqual(3);
    });

    it('protects unresolved soul:reflection thoughts from pruning', async () => {
      const smallStore = new JsonVectorStore(logger, {
        storage,
        storageKey: 'memory',
        maxEntries: 2,
      });

      // Add a protected entry (oldest)
      await smallStore.save(
        makeEntry({
          id: 'protected',
          content: 'deep reflection',
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
          timestamp: new Date(Date.now() - 10000),
        })
      );

      // Add normal entries to trigger pruning
      await smallStore.save(
        makeEntry({ id: 'normal1', content: 'normal entry 1', timestamp: new Date(Date.now() - 5000) })
      );
      await smallStore.save(
        makeEntry({ id: 'normal2', content: 'normal entry 2', timestamp: new Date() })
      );

      // Protected entry should survive
      const result = await smallStore.getById('protected');
      expect(result).toBeDefined();
    });
  });

  // ─── Browse mode (empty query + filters) ─────────────────────────────

  describe('browse mode', () => {
    it('returns results with empty query when filters are provided', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'test content', type: 'fact' }));
      await store.save(makeEntry({ id: 'e2', content: 'other content', type: 'thought' }));
      const results = await store.search({ query: '', types: ['fact'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });
  });
});
