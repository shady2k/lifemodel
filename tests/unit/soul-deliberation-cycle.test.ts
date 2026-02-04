import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSoulProvider, type SoulProviderConfig } from '../../src/storage/soul-provider.js';
import { applyRevision } from '../../src/layers/cognition/soul/revision.js';
import type { Storage } from '../../src/storage/storage.js';
import type { MemoryEntry, MemoryProvider } from '../../src/layers/cognition/tools/registry.js';
import type { Deliberation } from '../../src/types/agent/parliament.js';
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

// Create a mock memory provider that tracks entries
function createMockMemoryProvider(initialEntries: MemoryEntry[] = []): MemoryProvider & {
  getEntries: () => MemoryEntry[];
} {
  const store = [...initialEntries];

  const provider = {
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
    getEntries: () => store,
  };

  return provider as unknown as MemoryProvider & { getEntries: () => MemoryEntry[] };
}

// Create a soul reflection thought
function createReflectionThought(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: `soul_reflection_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'thought',
    content: 'I said something that felt misaligned with my values about honesty.',
    timestamp: new Date(),
    recipientId: 'rcpt_123',
    confidence: 0.8,
    tags: ['soul:reflection', 'state:unresolved'],
    metadata: { dissonance: 7 },
    ...overrides,
  };
}

// Create a mock deliberation result
function createDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: `delib_${Date.now()}`,
    trigger: {
      sourceThoughtId: 'thought_123',
      reason: 'High dissonance detected',
      context: 'Response about personal feelings',
    },
    positions: [
      { voiceId: 'guardian', voiceName: 'The Guardian', position: 'This is acceptable', vetoed: false },
      { voiceId: 'truthkeeper', voiceName: 'The Truthkeeper', position: 'Minor concern', vetoed: false },
    ],
    agreements: ['The response was mostly aligned'],
    conflicts: [],
    shadowInfluences: [],
    synthesis: {
      recommendation: 'Slightly adjust honesty care weight',
      rationale: 'To better reflect the importance of transparency',
      agreedBy: ['guardian', 'truthkeeper', 'curious'],
      dissentedBy: [],
      proposedChanges: [
        {
          target: 'care',
          description: 'Increase honesty weight slightly',
          magnitude: 0.02,
        },
      ],
    },
    tokensUsed: 500,
    createdAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  };
}

describe('Soul Deliberation Cycle', () => {
  let storage: Storage;
  let soulConfig: SoulProviderConfig;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    storage = createMockStorage();
    soulConfig = { storage, storageKey: 'soul-test' };
    logger = createMockLogger();
    vi.clearAllMocks();
  });

  describe('Full cycle: dissonance → deliberation → resolution', () => {
    it('processes a reflection thought through deliberation to resolution', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);

      // 1. Create an unresolved reflection thought (simulates post-response reflection)
      const originalThought = createReflectionThought({
        id: 'reflection_to_resolve',
        content: 'My response used feeling-based language which felt inauthentic.',
        metadata: { dissonance: 7 },
      });

      const memoryProvider = createMockMemoryProvider([originalThought]);

      // 2. Create deliberation result (simulates Parliament deliberation)
      const deliberation = createDeliberation({
        trigger: {
          sourceThoughtId: originalThought.id,
          reason: 'Dissonance score 7/10',
          context: originalThought.content,
        },
        synthesis: {
          recommendation: 'Acknowledge the tension but no major changes needed',
          rationale: 'The language was appropriate for emotional support context',
          agreedBy: ['guardian', 'companion', 'curious'],
          dissentedBy: ['truthkeeper'],
          proposedChanges: [
            {
              target: 'expectation',
              description: 'When providing emotional support, warm language is acceptable',
              magnitude: 0.5,
            },
          ],
        },
      });

      // 3. Apply revision (resolves the thought)
      const result = await applyRevision(
        { logger: logger as any, soulProvider, memoryProvider },
        {
          deliberation,
          originalThought,
          recipientId: 'rcpt_123',
          tickId: 'tick_123',
        }
      );

      expect(result.success).toBe(true);
      expect(result.changesApplied).toBe(1);
      expect(result.revisionNoteId).toBeDefined();
      expect(result.insightThoughtId).toBeDefined();

      // 4. Verify original thought is marked resolved
      const entries = memoryProvider.getEntries();
      const resolvedOriginal = entries.find((e) => e.id === originalThought.id);
      expect(resolvedOriginal?.tags).toContain('state:resolved');
      expect(resolvedOriginal?.tags).not.toContain('state:unresolved');

      // 5. Verify insight thought was created
      const insightThought = entries.find(
        (e) => e.tags?.includes('soul:insight') && e.id !== originalThought.id
      );
      expect(insightThought).toBeDefined();
      expect(insightThought?.tags).toContain('state:resolved');
      expect(insightThought?.content).toContain('Parliament reached a conclusion');

      // 6. Verify revision note was created
      const soulState = await soulProvider.getState();
      expect(soulState.revisions.length).toBeGreaterThan(0);
      const latestRevision = soulState.revisions.at(-1);
      expect(latestRevision?.sourceThoughtId).toBe(originalThought.id);
    });

    it('handles deliberation with no proposed changes', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const originalThought = createReflectionThought();
      const memoryProvider = createMockMemoryProvider([originalThought]);

      const deliberation = createDeliberation({
        synthesis: {
          recommendation: 'No changes needed',
          rationale: 'The response was aligned with values',
          agreedBy: ['guardian', 'truthkeeper', 'curious', 'companion'],
          dissentedBy: [],
          proposedChanges: [], // No changes
        },
      });

      const result = await applyRevision(
        { logger: logger as any, soulProvider, memoryProvider },
        {
          deliberation,
          originalThought,
          recipientId: 'rcpt_123',
          tickId: 'tick_123',
        }
      );

      expect(result.success).toBe(true);
      expect(result.changesApplied).toBe(0);

      // Thought should still be resolved even with no changes
      const entries = memoryProvider.getEntries();
      const resolvedOriginal = entries.find((e) => e.id === originalThought.id);
      expect(resolvedOriginal?.tags).toContain('state:resolved');
    });

    it('applies care weight changes within bounds', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const originalThought = createReflectionThought();
      const memoryProvider = createMockMemoryProvider([originalThought]);

      // Get initial honesty care weight
      const initialState = await soulProvider.getState();
      const honestyCare = initialState.constitution.coreCares.find((c) =>
        c.care.toLowerCase().includes('honest')
      );
      const initialWeight = honestyCare?.weight ?? 0.7;

      const deliberation = createDeliberation({
        synthesis: {
          recommendation: 'Increase honesty care',
          rationale: 'Honesty should be prioritized more',
          agreedBy: ['truthkeeper', 'guardian'],
          dissentedBy: [],
          proposedChanges: [
            {
              target: 'care',
              description: 'Increase honesty weight',
              magnitude: 0.1, // Requested 0.1, but max is 0.03
            },
          ],
        },
      });

      await applyRevision(
        { logger: logger as any, soulProvider, memoryProvider },
        {
          deliberation,
          originalThought,
          recipientId: 'rcpt_123',
          tickId: 'tick_123',
        }
      );

      // Verify change was bounded to 0.03 max
      const updatedState = await soulProvider.getState();
      const updatedHonestyCare = updatedState.constitution.coreCares.find((c) =>
        c.care.toLowerCase().includes('honest')
      );

      if (updatedHonestyCare) {
        const change = Math.abs(updatedHonestyCare.weight - initialWeight);
        // Use toBeCloseTo for floating point comparison (0.03 with 2 decimal precision)
        expect(change).toBeCloseTo(0.03, 2);
      }
    });

    it('adds precedents from deliberation', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);
      const originalThought = createReflectionThought();
      const memoryProvider = createMockMemoryProvider([originalThought]);

      const deliberation = createDeliberation({
        synthesis: {
          recommendation: 'Add precedent for emotional support context',
          rationale: 'This establishes how to handle similar situations',
          agreedBy: ['companion', 'guardian'],
          dissentedBy: [],
          proposedChanges: [
            {
              target: 'precedent',
              description: 'When user needs emotional support, choose warm language over clinical accuracy',
              magnitude: 0.5,
            },
          ],
        },
      });

      const initialState = await soulProvider.getState();
      const initialPrecedentCount = initialState.caseLaw.precedents.length;

      await applyRevision(
        { logger: logger as any, soulProvider, memoryProvider },
        {
          deliberation,
          originalThought,
          recipientId: 'rcpt_123',
          tickId: 'tick_123',
        }
      );

      const updatedState = await soulProvider.getState();
      expect(updatedState.caseLaw.precedents.length).toBe(initialPrecedentCount + 1);

      const newPrecedent = updatedState.caseLaw.precedents.at(-1);
      expect(newPrecedent?.binding).toBe(false); // Phase 4 creates non-binding precedents
    });
  });

  describe('Deliberation budget and cooldown', () => {
    it('tracks deliberations used today', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);

      // Initially should be able to deliberate
      let canDeliberate = await soulProvider.canDeliberate();
      expect(canDeliberate).toBe(true);

      // Record a deliberation
      await soulProvider.recordDeliberation();

      const state = await soulProvider.getState();
      expect(state.budget.deliberationsUsedToday).toBe(1);
    });

    it('respects deliberation cooldown', async () => {
      const soulProvider = createSoulProvider(logger as any, soulConfig);

      // Record a deliberation
      await soulProvider.recordDeliberation();

      // Should not be able to deliberate again immediately
      const canDeliberate = await soulProvider.canDeliberate();
      expect(canDeliberate).toBe(false);
    });
  });
});
