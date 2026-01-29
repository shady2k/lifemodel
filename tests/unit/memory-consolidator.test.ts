import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MemoryConsolidator,
  createMemoryConsolidator,
} from '../../src/storage/memory-consolidator.js';
import type { MemoryEntry, MemoryProvider } from '../../src/layers/cognition/tools/registry.js';
import { createMockLogger } from '../helpers/factories.js';

/**
 * Create a mock memory provider for testing.
 */
function createMockMemoryProvider(entries: MemoryEntry[]) {
  const store = [...entries];

  return {
    getAll: vi.fn().mockResolvedValue(store),
    save: vi.fn().mockImplementation((entry: MemoryEntry) => {
      store.push(entry);
      return Promise.resolve();
    }),
    clear: vi.fn().mockImplementation(() => {
      store.length = 0;
      return Promise.resolve();
    }),
    search: vi.fn().mockResolvedValue([]),
    getRecent: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Create a memory entry for testing.
 */
function createMemoryEntry(
  overrides: Partial<MemoryEntry> & { subject?: string; predicate?: string; object?: string }
): MemoryEntry {
  const { subject, predicate, object, ...rest } = overrides;

  return {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'fact',
    content: `${subject ?? 'user'} ${predicate ?? 'has'} ${object ?? 'value'}`,
    timestamp: new Date(),
    recipientId: 'rcpt_123',
    confidence: 0.8,
    tags: [],
    metadata: {
      subject: subject ?? 'user',
      predicate: predicate ?? 'has',
      object: object ?? 'value',
    },
    ...rest,
  };
}

describe('MemoryConsolidator', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let consolidator: MemoryConsolidator;

  beforeEach(() => {
    logger = createMockLogger();
    consolidator = createMemoryConsolidator(logger);
  });

  describe('Duplicate merging', () => {
    it('merges facts with same (chatId, subject, predicate)', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'birthday',
          object: 'November 9th',
          content: 'user birthday November 9th (said "born 9 November")',
          confidence: 0.95,
          tags: ['personal', 'birthday'],
        }),
        createMemoryEntry({
          id: 'mem_2',
          subject: 'user',
          predicate: 'birthday',
          object: 'November',
          content: 'user birthday month November',
          confidence: 0.9,
          tags: ['personal'],
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.merged).toBe(1); // 2 entries -> 1
      expect(result.totalBefore).toBe(2);
      expect(result.totalAfter).toBe(1);
      expect(provider.clear).toHaveBeenCalled();
      expect(provider.save).toHaveBeenCalledTimes(1);
    });

    it('keeps the most specific (longest content) entry when merging', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'birthday',
          object: 'November 9th',
          content: 'user birthday November 9th (said "born 9 November")',
          confidence: 0.95,
        }),
        createMemoryEntry({
          id: 'mem_2',
          subject: 'user',
          predicate: 'birthday',
          object: 'November',
          content: 'user birthday November',
          confidence: 0.95,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      await consolidator.consolidate(provider as unknown as MemoryProvider);

      // The saved entry should be the longer one
      const savedEntry = (provider.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryEntry;
      expect(savedEntry.content).toContain('November 9th');
    });

    it('combines tags from all merged entries', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'name',
          object: 'Shady',
          tags: ['identity'],
        }),
        createMemoryEntry({
          id: 'mem_2',
          subject: 'user',
          predicate: 'name',
          object: 'Shady',
          tags: ['nickname', 'personal'],
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      await consolidator.consolidate(provider as unknown as MemoryProvider);

      const savedEntry = (provider.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryEntry;
      expect(savedEntry.tags).toContain('identity');
      expect(savedEntry.tags).toContain('nickname');
      expect(savedEntry.tags).toContain('personal');
    });

    it('keeps highest confidence when merging', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'mood',
          object: 'happy',
          confidence: 0.7,
        }),
        createMemoryEntry({
          id: 'mem_2',
          subject: 'user',
          predicate: 'mood',
          object: 'happy',
          confidence: 0.95,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      await consolidator.consolidate(provider as unknown as MemoryProvider);

      const savedEntry = (provider.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryEntry;
      expect(savedEntry.confidence).toBe(0.95);
    });

    it('does not merge facts with different predicates', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'birthday',
          object: 'November 9th',
        }),
        createMemoryEntry({
          id: 'mem_2',
          subject: 'user',
          predicate: 'name',
          object: 'Shady',
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.merged).toBe(0);
      expect(result.totalAfter).toBe(2);
    });

    it('does not merge facts with different recipientIds', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          recipientId: 'rcpt_123',
          subject: 'user',
          predicate: 'name',
          object: 'Alice',
        }),
        createMemoryEntry({
          id: 'mem_2',
          recipientId: 'rcpt_456',
          subject: 'user',
          predicate: 'name',
          object: 'Bob',
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.merged).toBe(0);
      expect(result.totalAfter).toBe(2);
    });
  });

  describe('Confidence decay', () => {
    it('decays confidence based on age', async () => {
      const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days ago

      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'preference',
          object: 'coffee',
          confidence: 0.8,
          timestamp: oldDate,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      await consolidator.consolidate(provider as unknown as MemoryProvider);

      const savedEntry = (provider.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryEntry;
      // After 14 days (2 half-lives of 7 days), confidence should be ~0.8 * 0.25 = 0.2
      expect(savedEntry.confidence).toBeLessThan(0.4);
      expect(savedEntry.confidence).toBeGreaterThan(0.1);
    });

    it('does not decay recent entries significantly', async () => {
      const recentDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'mood',
          object: 'happy',
          confidence: 0.9,
          timestamp: recentDate,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      await consolidator.consolidate(provider as unknown as MemoryProvider);

      const savedEntry = (provider.save as ReturnType<typeof vi.fn>).mock.calls[0][0] as MemoryEntry;
      // Should be very close to original
      expect(savedEntry.confidence).toBeGreaterThan(0.85);
    });
  });

  describe('Forgetting', () => {
    it('removes entries below forget threshold after decay', async () => {
      // Very old entry that will decay below threshold
      const veryOldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'mentioned',
          object: 'something',
          confidence: 0.3, // Low confidence + old = forgotten
          timestamp: veryOldDate,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.forgotten).toBe(1);
      expect(result.totalAfter).toBe(0);
    });

    it('keeps high-confidence entries even when old', async () => {
      const oldDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 14 days ago

      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'birthday',
          object: 'November 9th',
          confidence: 0.99, // Very high confidence
          timestamp: oldDate,
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.forgotten).toBe(0);
      expect(result.totalAfter).toBe(1);
    });
  });

  describe('Non-fact handling', () => {
    it('removes old non-facts (thoughts, messages) beyond max age', async () => {
      const veryOldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

      const entries: MemoryEntry[] = [
        {
          id: 'mem_1',
          type: 'thought',
          content: 'I should ask about their day',
          timestamp: veryOldDate,
          chatId: '123',
        },
        {
          id: 'mem_2',
          type: 'message',
          content: 'Hello!',
          timestamp: veryOldDate,
          chatId: '123',
        },
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.forgotten).toBe(2);
      expect(result.totalAfter).toBe(0);
    });

    it('keeps recent non-facts', async () => {
      const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

      const entries: MemoryEntry[] = [
        {
          id: 'mem_1',
          type: 'thought',
          content: 'User seems tired',
          timestamp: recentDate,
          chatId: '123',
        },
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.forgotten).toBe(0);
      expect(result.totalAfter).toBe(1);
    });
  });

  describe('Edge cases', () => {
    it('handles empty memory', async () => {
      const provider = createMockMemoryProvider([]);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.totalBefore).toBe(0);
      expect(result.totalAfter).toBe(0);
      expect(result.merged).toBe(0);
      expect(result.forgotten).toBe(0);
      expect(provider.clear).not.toHaveBeenCalled();
    });

    it('handles single entry (no duplicates)', async () => {
      const entries: MemoryEntry[] = [
        createMemoryEntry({
          id: 'mem_1',
          subject: 'user',
          predicate: 'name',
          object: 'Shady',
        }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.merged).toBe(0);
      expect(result.totalAfter).toBe(1);
    });

    it('handles multiple groups with duplicates', async () => {
      const entries: MemoryEntry[] = [
        // Group 1: birthday (2 duplicates)
        createMemoryEntry({ id: 'mem_1', subject: 'user', predicate: 'birthday', object: 'Nov 9' }),
        createMemoryEntry({ id: 'mem_2', subject: 'user', predicate: 'birthday', object: 'November' }),
        // Group 2: name (3 duplicates)
        createMemoryEntry({ id: 'mem_3', subject: 'user', predicate: 'name', object: 'Shady' }),
        createMemoryEntry({ id: 'mem_4', subject: 'user', predicate: 'name', object: 'Shady' }),
        createMemoryEntry({ id: 'mem_5', subject: 'user', predicate: 'name', object: 'Shady' }),
        // Group 3: mood (1 entry, no duplicates)
        createMemoryEntry({ id: 'mem_6', subject: 'user', predicate: 'mood', object: 'happy' }),
      ];

      const provider = createMockMemoryProvider(entries);
      const result = await consolidator.consolidate(provider as unknown as MemoryProvider);

      expect(result.totalBefore).toBe(6);
      expect(result.merged).toBe(3); // 1 from birthday + 2 from name
      expect(result.totalAfter).toBe(3); // 3 groups
    });
  });
});
