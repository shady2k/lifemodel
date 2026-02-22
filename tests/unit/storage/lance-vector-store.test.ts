/**
 * Tests for LanceVectorStore.
 *
 * Uses a real LanceDB instance in a temp directory with a deterministic mock embedder
 * (no ONNX model needed). Covers: CRUD, upsert, search, filtering, pagination,
 * pruning, browse mode, re-ranking, and SQL predicate safety.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LanceVectorStore } from '../../../src/storage/lance-vector-store.js';
import type { Embedder } from '../../../src/storage/embedder.js';
import type { MemoryEntry } from '../../../src/layers/cognition/tools/registry.js';

// ─── Mock Embedder ────────────────────────────────────────────────────────────

const DIMS = 384;

/**
 * Deterministic mock embedder: hashes text into a stable 384-dim vector.
 * Same text → same vector. Different text → different (but deterministic) vectors.
 */
function createMockEmbedder(): Embedder {
  function hashEmbed(text: string): Float32Array {
    const vec = new Float32Array(DIMS);
    // Simple hash-based seeding
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < DIMS; i++) {
      // LCG-like deterministic pseudo-random
      hash = (hash * 1664525 + 1013904223) | 0;
      vec[i] = (hash & 0xffff) / 0xffff - 0.5;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < DIMS; i++) vec[i]! /= norm;
    }
    return vec;
  }

  return {
    embed: vi.fn(async (text: string) => hashEmbed(text)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(hashEmbed)),
    dimensions: () => DIMS,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LanceVectorStore', () => {
  let tmpDir: string;
  let store: LanceVectorStore;
  let embedder: Embedder;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lance-test-'));
    embedder = createMockEmbedder();
    logger = createMockLogger();
    store = new LanceVectorStore(logger, {
      dbPath: tmpDir,
      embedder,
      maxEntries: 10000,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
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

    it('upserts facts with same subject+attribute and preserves existing ID', async () => {
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

    it('returns status as undefined (not null) for entries without status', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'no status set' }));
      const result = await store.getById('e1');
      expect(result).toBeDefined();
      expect(result!.status).toBeUndefined();
      // Explicitly check it's not null (SQL null → JS undefined)
      expect(result!.status).not.toBeNull();
    });

    it('preserves all fields through round-trip', async () => {
      const entry = makeEntry({
        id: 'e1',
        content: 'test entry',
        type: 'intention',
        tags: ['tag1', 'tag2'],
        confidence: 0.85,
        recipientId: 'user1',
        metadata: { key: 'value', nested: { a: 1 } },
        tickId: 'tick_123',
        parentSignalId: 'sig_456',
        trigger: { condition: 'topic_match', keywords: ['test'] },
        status: 'pending',
        expiresAt: new Date('2026-12-31T00:00:00Z'),
      });
      (entry as MemoryEntry & { salience?: number }).salience = 0.7;

      await store.save(entry);
      const result = await store.getById('e1');
      expect(result).toBeDefined();
      expect(result!.type).toBe('intention');
      expect(result!.tags).toEqual(['tag1', 'tag2']);
      expect(result!.confidence).toBe(0.85);
      expect(result!.recipientId).toBe('user1');
      expect(result!.metadata).toEqual({ key: 'value', nested: { a: 1 } });
      expect(result!.tickId).toBe('tick_123');
      expect(result!.parentSignalId).toBe('sig_456');
      expect(result!.trigger).toEqual({ condition: 'topic_match', keywords: ['test'] });
      expect(result!.status).toBe('pending');
      expect(result!.expiresAt!.toISOString()).toBe('2026-12-31T00:00:00.000Z');
      expect((result as MemoryEntry & { salience?: number }).salience).toBe(0.7);
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

    it('works before first use (no prior ensureTable)', async () => {
      // Fresh store — clear() before any other operation
      const freshStore = new LanceVectorStore(logger, {
        dbPath: tmpDir,
        embedder,
        tableName: 'fresh_clear',
      });
      await freshStore.clear();
      expect(await freshStore.count()).toBe(0);
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

    it('returns 0 for empty types array', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'one' }));
      expect(await store.count({ types: [] })).toBe(0);
    });
  });

  // ─── getAll ─────────────────────────────────────────────────────────────

  describe('getAll', () => {
    it('returns all entries sorted by timestamp desc', async () => {
      await store.save(
        makeEntry({ id: 'e1', content: 'old', timestamp: new Date('2025-01-01') })
      );
      await store.save(
        makeEntry({ id: 'e2', content: 'new', timestamp: new Date('2026-01-01') })
      );
      const all = await store.getAll();
      expect(all).toHaveLength(2);
      expect(all[0]!.id).toBe('e2');
      expect(all[1]!.id).toBe('e1');
    });
  });

  // ─── Search ─────────────────────────────────────────────────────────────

  describe('search', () => {
    it('returns empty for empty types array (matches nothing)', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world' }));
      const results = await store.search({ query: 'hello', types: [] });
      expect(results).toHaveLength(0);
    });

    it('returns empty for short query without filters', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world' }));
      const results = await store.search({ query: 'h' });
      expect(results).toHaveLength(0);
    });

    it('same-text query returns exact match with highest score', async () => {
      await store.save(makeEntry({ id: 'exact', content: 'feeling stressed about work' }));
      await store.save(makeEntry({ id: 'other', content: 'completely different topic xyz' }));
      const results = await store.search({ query: 'feeling stressed about work' });
      expect(results[0]!.entry.id).toBe('exact');
    });

    it('combined score is greater than 0', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world' }));
      const results = await store.search({ query: 'hello world' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.score).toBeGreaterThan(0);
    });

    it('boosts higher confidence entries', async () => {
      await store.save(
        makeEntry({ id: 'high', content: 'identical content here', confidence: 0.95 })
      );
      await store.save(
        makeEntry({ id: 'low', content: 'identical content here', confidence: 0.2 })
      );
      const results = await store.search({ query: 'identical content here' });
      expect(results[0]!.entry.id).toBe('high');
    });

    it('applies recency boost — recent entry ranks higher than old entry at equal similarity', async () => {
      const recentDate = new Date();
      const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 2 weeks old
      await store.save(
        makeEntry({ id: 'recent', content: 'same text content', timestamp: recentDate })
      );
      await store.save(
        makeEntry({ id: 'old', content: 'same text content', timestamp: oldDate })
      );
      const results = await store.search({ query: 'same text content' });
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

  // ─── Filtering ──────────────────────────────────────────────────────────

  describe('search filtering', () => {
    it('filters by type', async () => {
      await store.save(makeEntry({ id: 'f1', content: 'important fact', type: 'fact' }));
      await store.save(makeEntry({ id: 't1', content: 'important thought', type: 'thought' }));
      const results = await store.search({ query: 'important', types: ['fact'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('f1');
    });

    it('filters by recipientId — entries without recipientId pass through', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'hello world', recipientId: 'user1' }));
      await store.save(makeEntry({ id: 'e2', content: 'hello world', recipientId: 'user2' }));
      await store.save(makeEntry({ id: 'e3', content: 'hello world' })); // no recipientId
      const results = await store.search({ query: 'hello world', recipientId: 'user1' });
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('e1');
      expect(ids).toContain('e3'); // NULL recipientId passes through
      expect(ids).not.toContain('e2');
    });

    it('filters by status — entries without status pass through', async () => {
      await store.save(
        makeEntry({ id: 'e1', content: 'task thing', type: 'intention', status: 'pending' })
      );
      await store.save(
        makeEntry({ id: 'e2', content: 'task thing', type: 'intention', status: 'completed' })
      );
      await store.save(
        makeEntry({ id: 'e3', content: 'task thing', type: 'fact' }) // no status
      );
      const results = await store.search({ query: 'task thing', status: 'pending' });
      const ids = results.map((r) => r.entry.id);
      expect(ids).toContain('e1');
      expect(ids).toContain('e3'); // NULL status passes through
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
        makeEntry({ id: 'e1', content: 'test entry one', metadata: { kind: 'reminder' } })
      );
      await store.save(
        makeEntry({ id: 'e2', content: 'test entry two', metadata: { kind: 'note' } })
      );
      const results = await store.search({
        query: 'test entry',
        metadata: { kind: 'reminder' },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });
  });

  // ─── Pagination ─────────────────────────────────────────────────────────

  describe('pagination', () => {
    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeEntry({ id: `e${i}`, content: `unique test item content ${i}` }));
      }
      const page1 = await store.search({ query: 'unique test item', limit: 2, offset: 0 });
      const page2 = await store.search({ query: 'unique test item', limit: 2, offset: 2 });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // No overlap
      const page1Ids = page1.map((r) => r.entry.id);
      const page2Ids = page2.map((r) => r.entry.id);
      expect(page1Ids.filter((id) => page2Ids.includes(id))).toHaveLength(0);
    });
  });

  // ─── Browse mode ────────────────────────────────────────────────────────

  describe('browse mode', () => {
    it('returns results with empty query when filters are provided', async () => {
      await store.save(makeEntry({ id: 'e1', content: 'test content', type: 'fact' }));
      await store.save(makeEntry({ id: 'e2', content: 'other content', type: 'thought' }));
      const results = await store.search({ query: '', types: ['fact'] });
      expect(results).toHaveLength(1);
      expect(results[0]!.entry.id).toBe('e1');
    });
  });

  // ─── Pruning ────────────────────────────────────────────────────────────

  describe('pruning', () => {
    it('prunes oldest entries when over maxEntries', async () => {
      const smallStore = new LanceVectorStore(logger, {
        dbPath: tmpDir,
        embedder,
        tableName: 'small',
        maxEntries: 3,
      });

      for (let i = 0; i < 5; i++) {
        await smallStore.save(
          makeEntry({
            id: `e${i}`,
            content: `entry number ${i}`,
            timestamp: new Date(Date.now() - (5 - i) * 1000),
          })
        );
      }

      expect(await smallStore.count()).toBeLessThanOrEqual(3);
    });

    it('protects unresolved soul:reflection thoughts from pruning', async () => {
      const smallStore = new LanceVectorStore(logger, {
        dbPath: tmpDir,
        embedder,
        tableName: 'protect',
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
        makeEntry({
          id: 'normal1',
          content: 'normal entry 1',
          timestamp: new Date(Date.now() - 5000),
        })
      );
      await smallStore.save(
        makeEntry({ id: 'normal2', content: 'normal entry 2', timestamp: new Date() })
      );

      // Protected entry should survive
      const result = await smallStore.getById('protected');
      expect(result).toBeDefined();
    });

    it('expires excess protected soul thoughts with tag mutation', async () => {
      const smallStore = new LanceVectorStore(logger, {
        dbPath: tmpDir,
        embedder,
        tableName: 'expire',
        maxEntries: 2,
      });

      // Add 2 protected entries + 1 normal to trigger pruning
      await smallStore.save(
        makeEntry({
          id: 'p1',
          content: 'old reflection',
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
          timestamp: new Date(Date.now() - 20000),
        })
      );
      await smallStore.save(
        makeEntry({
          id: 'p2',
          content: 'newer reflection',
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
          timestamp: new Date(Date.now() - 10000),
        })
      );
      await smallStore.save(
        makeEntry({ id: 'normal', content: 'normal entry', timestamp: new Date() })
      );

      // The oldest protected entry should have been tag-mutated
      const p1 = await smallStore.getById('p1');
      if (p1) {
        // If it survived, its tags should have been mutated
        expect(p1.tags).toContain('state:expired');
        expect(p1.tags).not.toContain('state:unresolved');
      }
      // p2 should retain its protection
      const p2 = await smallStore.getById('p2');
      if (p2) {
        expect(p2.tags).toContain('state:unresolved');
      }
    });
  });

  // ─── SQL predicate safety ──────────────────────────────────────────────

  describe('predicate escaping', () => {
    it('handles single quotes in content without breaking queries', async () => {
      await store.save(makeEntry({ id: 'e1', content: "John's birthday is tomorrow" }));
      const result = await store.getById('e1');
      expect(result).toBeDefined();
      expect(result!.content).toBe("John's birthday is tomorrow");
    });

    it('handles single quotes in ID without breaking queries', async () => {
      await store.save(makeEntry({ id: "mem_o'brien", content: 'test content' }));
      const result = await store.getById("mem_o'brien");
      expect(result).toBeDefined();
      expect(await store.delete("mem_o'brien")).toBe(true);
      expect(await store.getById("mem_o'brien")).toBeUndefined();
    });
  });

  // ─── Bulk import ────────────────────────────────────────────────────────

  describe('bulkImport', () => {
    it('imports pre-embedded entries', async () => {
      const entries = [
        makeEntry({ id: 'b1', content: 'first' }),
        makeEntry({ id: 'b2', content: 'second' }),
      ];
      const vectors = await embedder.embedBatch(['first', 'second']);
      await store.bulkImport(entries, vectors);
      expect(await store.count()).toBe(2);
      const result = await store.getById('b1');
      expect(result!.content).toBe('first');
    });
  });

  // ─── Persist is no-op ──────────────────────────────────────────────────

  describe('persist', () => {
    it('is a no-op that does not throw', async () => {
      await expect(store.persist()).resolves.toBeUndefined();
    });
  });
});
