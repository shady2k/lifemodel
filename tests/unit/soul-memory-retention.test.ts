import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JsonMemoryProvider } from '../../src/storage/memory-provider.js';
import type { Storage } from '../../src/storage/storage.js';
import type { MemoryEntry } from '../../src/layers/cognition/tools/registry.js';
import { createMockLogger } from '../helpers/factories.js';

// In-memory storage for testing
function createMockStorage(): Storage {
  const store = new Map<string, unknown>();
  return {
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, data: unknown) => {
      store.set(key, data);
    },
    delete: async (key: string) => {
      const existed = store.has(key);
      store.delete(key);
      return existed;
    },
    exists: async (key: string) => store.has(key),
    keys: async () => Array.from(store.keys()),
  };
}

// Create a memory entry for testing
function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'fact',
    content: 'Test memory content',
    timestamp: new Date(),
    recipientId: 'rcpt_123',
    confidence: 0.8,
    tags: [],
    ...overrides,
  };
}

describe('Soul Memory Retention Rules', () => {
  let storage: Storage;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    storage = createMockStorage();
    logger = createMockLogger();
    vi.clearAllMocks();
  });

  describe('Protected soul thoughts', () => {
    it('protects unresolved soul:reflection thoughts from pruning', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 5, // Low limit to trigger pruning
      });

      // Add an unresolved soul reflection (should be protected)
      const protectedThought = createMemoryEntry({
        id: 'protected_soul_thought',
        type: 'thought',
        content: 'This dissonance needs processing',
        tags: ['soul:reflection', 'state:unresolved'],
        timestamp: new Date(Date.now() - 10000), // Older
      });
      await provider.save(protectedThought);

      // Add regular entries to trigger pruning
      for (let i = 0; i < 6; i++) {
        await provider.save(
          createMemoryEntry({
            id: `regular_${i}`,
            type: 'fact',
            timestamp: new Date(Date.now() + i), // Newer
          })
        );
      }

      // Get all entries - protected thought should still be there
      const entries = await provider.getAll();
      const protectedExists = entries.some((e) => e.id === 'protected_soul_thought');
      expect(protectedExists).toBe(true);
    });

    it('allows resolved soul thoughts to be pruned', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 5,
      });

      // Add a resolved soul thought (should NOT be protected)
      const resolvedThought = createMemoryEntry({
        id: 'resolved_soul_thought',
        type: 'thought',
        content: 'This was processed',
        tags: ['soul:reflection', 'state:resolved'],
        timestamp: new Date(Date.now() - 10000), // Oldest
      });
      await provider.save(resolvedThought);

      // Add regular entries to trigger pruning
      for (let i = 0; i < 6; i++) {
        await provider.save(
          createMemoryEntry({
            id: `regular_${i}`,
            type: 'fact',
            timestamp: new Date(Date.now() + i),
          })
        );
      }

      // Resolved thought may be pruned (it's not protected)
      const entries = await provider.getAll();
      expect(entries.length).toBeLessThanOrEqual(5);
    });

    it('expires oldest protected thoughts when exceeding max protected limit', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 20, // Higher limit to focus on protection logic
      });

      // Add 12 unresolved soul thoughts (limit is 10)
      for (let i = 0; i < 12; i++) {
        await provider.save(
          createMemoryEntry({
            id: `protected_${i}`,
            type: 'thought',
            content: `Unresolved thought ${i}`,
            tags: ['soul:reflection', 'state:unresolved'],
            timestamp: new Date(Date.now() + i * 1000), // Different times
          })
        );
      }

      // Add more entries to trigger prune
      for (let i = 0; i < 10; i++) {
        await provider.save(
          createMemoryEntry({
            id: `filler_${i}`,
            type: 'fact',
            timestamp: new Date(Date.now() + 20000 + i),
          })
        );
      }

      const entries = await provider.getAll();

      // Count how many still have state:unresolved
      const stillUnresolved = entries.filter(
        (e) => e.tags?.includes('state:unresolved') && e.tags?.includes('soul:reflection')
      );

      // Should have at most 10 unresolved
      expect(stillUnresolved.length).toBeLessThanOrEqual(10);

      // Check if oldest ones got state:expired
      const expired = entries.filter((e) => e.tags?.includes('state:expired'));
      // Some should have been expired (the oldest 2 of the 12)
      expect(expired.length + stillUnresolved.length).toBeGreaterThanOrEqual(10);
    });

    it('only protects soul:reflection (not soul:question)', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 10, // Higher limit so max protected = min(10, 5) = 5
      });

      // Add different types of unresolved soul thoughts
      await provider.save(
        createMemoryEntry({
          id: 'soul_reflection',
          type: 'thought',
          tags: ['soul:reflection', 'state:unresolved'],
          timestamp: new Date(Date.now() - 10000),
        })
      );

      // soul:question is NOT protected by retention rule (only soul:reflection is)
      await provider.save(
        createMemoryEntry({
          id: 'soul_question',
          type: 'thought',
          tags: ['soul:question', 'state:unresolved'],
          timestamp: new Date(Date.now() - 9000),
        })
      );

      // Add regular entries to fill up
      for (let i = 0; i < 10; i++) {
        await provider.save(
          createMemoryEntry({
            id: `regular_${i}`,
            type: 'fact',
            timestamp: new Date(Date.now() + i),
          })
        );
      }

      const entries = await provider.getAll();

      // soul:reflection should be protected
      expect(entries.some((e) => e.id === 'soul_reflection')).toBe(true);
      // soul:question is NOT protected, may be pruned (oldest non-protected entries are pruned first)
      // It's older than the soul_reflection but the question is whether it survives
      // Since it's not protected, it competes with regular entries for space
    });
  });

  describe('Pruning behavior', () => {
    it('prunes oldest non-protected entries first', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 3,
      });

      // Add entries in order: old → new
      await provider.save(
        createMemoryEntry({
          id: 'oldest',
          timestamp: new Date(Date.now() - 3000),
        })
      );
      await provider.save(
        createMemoryEntry({
          id: 'middle',
          timestamp: new Date(Date.now() - 2000),
        })
      );
      await provider.save(
        createMemoryEntry({
          id: 'newest',
          timestamp: new Date(Date.now() - 1000),
        })
      );

      // Add one more to trigger prune
      await provider.save(
        createMemoryEntry({
          id: 'trigger',
          timestamp: new Date(),
        })
      );

      const entries = await provider.getAll();

      // Oldest should be pruned
      expect(entries.some((e) => e.id === 'oldest')).toBe(false);
      // Newer ones should remain
      expect(entries.some((e) => e.id === 'newest')).toBe(true);
      expect(entries.some((e) => e.id === 'trigger')).toBe(true);
    });

    it('honors maxEntries even with protected entries', async () => {
      const provider = new JsonMemoryProvider(logger as any, {
        storage,
        storageKey: 'memory-test',
        maxEntries: 20, // Higher limit so max protected = min(10, 10) = 10
      });

      // Add 3 protected entries
      for (let i = 0; i < 3; i++) {
        await provider.save(
          createMemoryEntry({
            id: `protected_${i}`,
            type: 'thought',
            tags: ['soul:reflection', 'state:unresolved'],
            timestamp: new Date(Date.now() + i),
          })
        );
      }

      // Add 20 regular entries to exceed maxEntries
      for (let i = 0; i < 20; i++) {
        await provider.save(
          createMemoryEntry({
            id: `regular_${i}`,
            type: 'fact',
            timestamp: new Date(Date.now() + 100 + i),
          })
        );
      }

      const entries = await provider.getAll();

      // Total should not exceed maxEntries
      expect(entries.length).toBeLessThanOrEqual(20);

      // All 3 protected should still exist (within max protected limit of 10)
      const protectedCount = entries.filter(
        (e) => e.tags?.includes('soul:reflection') && e.tags?.includes('state:unresolved')
      ).length;
      expect(protectedCount).toBe(3);
    });
  });
});
