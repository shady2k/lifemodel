import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSleepMaintenance } from '../../src/layers/cognition/soul/sleep-maintenance.js';
import { createSoulProvider, type SoulProviderConfig } from '../../src/storage/soul-provider.js';
import type { Storage } from '../../src/storage/storage.js';
import type { MemoryEntry, MemoryProvider } from '../../src/layers/cognition/tools/registry.js';
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

// Create a mock memory provider
function createMockMemoryProvider(entries: MemoryEntry[] = []): MemoryProvider {
  const store = [...entries];

  return {
    save: vi.fn().mockImplementation(async (entry: MemoryEntry) => {
      const existingIndex = store.findIndex((e) => e.id === entry.id);
      if (existingIndex >= 0) {
        store[existingIndex] = entry;
      } else {
        store.push(entry);
      }
    }),
    search: vi.fn().mockResolvedValue({ entries: [], metadata: { total: 0, returned: 0 } }),
    getRecent: vi.fn().mockResolvedValue(store),
    getRecentByType: vi.fn().mockImplementation(async (type: string) => {
      return store.filter((e) => e.type === type);
    }),
    getAll: vi.fn().mockResolvedValue(store),
    clear: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
    getBehaviorRules: vi.fn().mockResolvedValue([]),
  } as unknown as MemoryProvider;
}

// Create a memory entry for testing
function createThought(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `thought_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'thought',
    content: 'Test thought content',
    timestamp: new Date(),
    recipientId: 'rcpt_123',
    confidence: 0.8,
    tags: [],
    ...overrides,
  };
}

describe('Soul Sleep Maintenance', () => {
  let storage: Storage;
  let soulConfig: SoulProviderConfig;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    storage = createMockStorage();
    soulConfig = { storage, storageKey: 'soul-test' };
    logger = createMockLogger();
    vi.clearAllMocks();
  });

  describe('runSleepMaintenance', () => {
    it('completes successfully with no data', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider();

      const result = await runSleepMaintenance({
        logger: logger as any,
        soulProvider,
        memoryProvider,
      });

      expect(result.success).toBe(true);
      expect(result.voicesRefreshed).toBeGreaterThanOrEqual(0);
      expect(result.softLearningPromoted).toBe(0);
      expect(result.thoughtsMarkedForPruning).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('refreshes voice budgets partially', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider();

      // Deplete some voice budget
      const state = await soulProvider.getState();
      const guardian = state.parliament.voices.find((v) => v.id === 'guardian');
      if (guardian?.budget) {
        guardian.budget.remaining = 50; // Half of 100
        await soulProvider.updateVoice('guardian', { budget: guardian.budget });
      }

      const result = await runSleepMaintenance(
        { logger: logger as any, soulProvider, memoryProvider },
        { voiceBudgetRefreshFraction: 0.5 } // Refresh 50%
      );

      expect(result.success).toBe(true);

      // Check budget was refreshed
      const updatedState = await soulProvider.getState();
      const updatedGuardian = updatedState.parliament.voices.find((v) => v.id === 'guardian');
      // Should restore 50% of missing 50 = 25, so total = 75
      expect(updatedGuardian?.budget?.remaining).toBe(75);
    });

    it('marks old resolved thoughts for pruning', async () => {
      // Create old resolved soul thoughts
      const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000); // 4 days ago
      const entries = [
        createThought({
          id: 'old_resolved_1',
          timestamp: oldDate,
          tags: ['soul:insight', 'state:resolved'],
        }),
        createThought({
          id: 'recent_resolved',
          timestamp: new Date(), // Now
          tags: ['soul:reflection', 'state:resolved'],
        }),
      ];

      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider(entries);

      const result = await runSleepMaintenance(
        { logger: logger as any, soulProvider, memoryProvider },
        { resolvedThoughtMaxAgeHours: 72 } // 3 days
      );

      expect(result.success).toBe(true);
      expect(result.thoughtsMarkedForPruning).toBe(1);

      // Verify the save was called with the pruning tag
      expect(memoryProvider.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'old_resolved_1',
          tags: expect.arrayContaining(['soul:can-prune']),
        })
      );
    });

    it('does not mark unresolved thoughts for pruning', async () => {
      const oldDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      const entries = [
        createThought({
          id: 'old_unresolved',
          timestamp: oldDate,
          tags: ['soul:reflection', 'state:unresolved'],
        }),
      ];

      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider(entries);

      const result = await runSleepMaintenance(
        { logger: logger as any, soulProvider, memoryProvider },
        { resolvedThoughtMaxAgeHours: 72 }
      );

      expect(result.success).toBe(true);
      expect(result.thoughtsMarkedForPruning).toBe(0);
    });

    it('updates health metrics from memory', async () => {
      // Create unresolved soul reflections
      const entries = [
        createThought({
          id: 'unresolved_1',
          tags: ['soul:reflection', 'state:unresolved'],
        }),
        createThought({
          id: 'unresolved_2',
          tags: ['soul:reflection', 'state:unresolved'],
        }),
      ];

      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider(entries);

      await runSleepMaintenance({
        logger: logger as any,
        soulProvider,
        memoryProvider,
      });

      const state = await soulProvider.getState();
      // 2 unresolved = openWoundCount should be 2
      expect(state.health.openWoundCount).toBe(2);
      // Coherence decreases with wounds (0.9 - 2*0.1 = 0.7)
      expect(state.health.coherence).toBe(0.7);
    });

    it('handles errors gracefully', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider();

      // Make getRecentByType throw an error
      vi.mocked(memoryProvider.getRecentByType).mockRejectedValue(new Error('DB error'));

      const result = await runSleepMaintenance({
        logger: logger as any,
        soulProvider,
        memoryProvider,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('soft learning promotion', () => {
    it('promotes soft learning items that meet criteria', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const memoryProvider = createMockMemoryProvider();

      // Promotion criteria: count >= 3 AND totalWeight >= 2.0
      // When items merge (same key), count accumulates but weight takes max.
      // So we need weight >= 2.0 on the merged item.
      // Note: In real usage, weight is derived from dissonance (max ~1.0),
      // so minTotalWeight may need adjustment. For testing, we set weight directly.
      const now = new Date();

      // First item establishes the key
      await soulProvider.addSoftLearningItem({
        id: 'soft_1',
        createdAt: now,
        lastTouchedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        dissonance: 6,
        triggerSummary: 'Anthropomorphic language',
        responseSnippet: 'I felt something...',
        reasoning: 'Using feeling-based language',
        weight: 2.5, // High weight to meet threshold (bypassing formula for test)
        count: 1,
        status: 'active',
        source: { tickId: 'tick_1', recipientId: 'rcpt_123' },
        key: 'anthropomorphic_language',
      });

      // Subsequent items merge (incrementing count)
      await soulProvider.addSoftLearningItem({
        id: 'soft_2',
        createdAt: now,
        lastTouchedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        dissonance: 5,
        triggerSummary: 'Anthropomorphic language',
        responseSnippet: 'I felt it again...',
        reasoning: 'Using feeling-based language',
        weight: 0.8,
        count: 1,
        status: 'active',
        source: { tickId: 'tick_2', recipientId: 'rcpt_123' },
        key: 'anthropomorphic_language',
      });

      await soulProvider.addSoftLearningItem({
        id: 'soft_3',
        createdAt: now,
        lastTouchedAt: now,
        expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        dissonance: 5,
        triggerSummary: 'Anthropomorphic language',
        responseSnippet: 'Again...',
        reasoning: 'Using feeling-based language',
        weight: 0.8,
        count: 1,
        status: 'active',
        source: { tickId: 'tick_3', recipientId: 'rcpt_123' },
        key: 'anthropomorphic_language',
      });

      // Now we have: count=3, weight=2.5 (max of all weights)
      // Meets criteria: count >= 3 ✓, totalWeight >= 2.0 ✓

      const result = await runSleepMaintenance({
        logger: logger as any,
        soulProvider,
        memoryProvider,
      });

      expect(result.success).toBe(true);
      expect(result.softLearningPromoted).toBe(1);

      // Verify thought was created
      expect(memoryProvider.save).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'thought',
          tags: expect.arrayContaining(['soul:reflection', 'state:unresolved', 'promoted']),
        })
      );
    });
  });
});
