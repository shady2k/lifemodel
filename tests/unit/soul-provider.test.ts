import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSoulProvider, type SoulProviderConfig } from '../../src/storage/soul-provider.js';
import type { Storage } from '../../src/storage/storage.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

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

describe('SoulProvider', () => {
  let storage: Storage;
  let config: SoulProviderConfig;

  beforeEach(() => {
    storage = createMockStorage();
    config = { storage, storageKey: 'soul-test' };
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('creates default soul state when no data exists', async () => {
      const provider = createSoulProvider(mockLogger as any, config);
      const state = await provider.getState();

      expect(state).toBeDefined();
      expect(state.constitution).toBeDefined();
      expect(state.constitution.invariants.length).toBeGreaterThan(0);
      expect(state.constitution.coreCares.length).toBeGreaterThan(0);
      expect(state.parliament).toBeDefined();
      expect(state.parliament.voices.length).toBeGreaterThan(0);
      expect(state.socraticEngine).toBeDefined();
      expect(state.unanswerableCore).toBeDefined();
    });

    it('loads existing state from storage', async () => {
      // First, create and persist state
      const provider1 = createSoulProvider(mockLogger as any, config);
      const state1 = await provider1.getState();
      state1.selfModel.narrative.currentStory = 'Modified story';
      await provider1.persist();

      // Create new provider and verify it loads the modified state
      const provider2 = createSoulProvider(mockLogger as any, config);
      const state2 = await provider2.getState();

      expect(state2.selfModel.narrative.currentStory).toBe('Modified story');
    });
  });

  describe('budget management', () => {
    it('tracks token usage', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      const canAfford = await provider.canAfford(1000);
      expect(canAfford).toBe(true);

      await provider.deductTokens(1000);

      const status = await provider.getBudgetStatus();
      expect(status.tokensUsed).toBe(1000);
      expect(status.tokensRemaining).toBe(49000); // 50000 - 1000
    });

    it('respects reflection cooldown', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // First reflection should be allowed
      let canReflect = await provider.canReflect();
      expect(canReflect).toBe(true);

      // Record a reflection
      await provider.recordReflection();

      // Immediate second reflection should be blocked (30s cooldown)
      canReflect = await provider.canReflect();
      expect(canReflect).toBe(false);
    });

    it('respects audit cooldown', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // First audit should be allowed
      let canAudit = await provider.canAudit();
      expect(canAudit).toBe(true);

      // Record an audit
      await provider.recordAudit();

      // Immediate second audit should be blocked (300s cooldown)
      canAudit = await provider.canAudit();
      expect(canAudit).toBe(false);
    });
  });

  describe('self-questions', () => {
    it('adds questions and enforces max limit', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Add 6 questions (limit is 5)
      for (let i = 0; i < 6; i++) {
        await provider.addQuestion({
          id: `q-${i}`,
          question: `Question ${i}`,
          trigger: { type: 'manual', description: 'test' },
          depth: 'medium',
          createdAt: new Date(),
          thoughtPressureContribution: 0.1,
          expectedOutput: 'self_understanding',
        });
      }

      const state = await provider.getState();
      expect(state.socraticEngine.activeQuestions).toHaveLength(5);
      // Oldest question should be removed
      expect(state.socraticEngine.activeQuestions.find((q) => q.id === 'q-0')).toBeUndefined();
    });

    it('resolves questions and moves to history', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      await provider.addQuestion({
        id: 'q-to-resolve',
        question: 'Why did I do that?',
        trigger: { type: 'prediction_error', description: 'test' },
        depth: 'deep',
        createdAt: new Date(),
        thoughtPressureContribution: 0.15,
        expectedOutput: 'self_understanding',
      });

      await provider.resolveQuestion('q-to-resolve', 'Because I value honesty', {
        type: 'self_understanding',
        summary: 'Learned about my values',
      });

      const state = await provider.getState();
      expect(state.socraticEngine.activeQuestions).toHaveLength(0);
      expect(state.socraticEngine.resolvedQuestions).toHaveLength(1);
      expect(state.socraticEngine.resolvedQuestions[0].answer).toBe('Because I value honesty');
    });
  });

  describe('persistence', () => {
    it('correctly serializes and deserializes dates', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Modify a date field to test serialization
      const state = await provider.getState();
      const testDate = new Date('2024-01-15T10:30:00Z');
      state.constitution.lastModifiedAt = testDate;
      await provider.persist();

      // Create new provider to force reload
      const provider2 = createSoulProvider(mockLogger as any, config);
      const reloadedState = await provider2.getState();

      expect(reloadedState.constitution.lastModifiedAt).toBeInstanceOf(Date);
      expect(reloadedState.constitution.lastModifiedAt.toISOString()).toBe('2024-01-15T10:30:00.000Z');
    });
  });

  describe('health metrics', () => {
    it('updates stability based on constitution modification', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Initial stability should be low (constitution just created)
      const state = await provider.getState();
      expect(state.health.stability).toBeLessThanOrEqual(1);

      // Stability increases over time (days since last modification)
      // Since constitution was just created, stability should be near 0
      // After 7 days it would be 1.0 (max stability)
      expect(state.health.stability).toBeDefined();
    });

    it('maintains coherence default', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Initial coherence should be the default (0.7)
      const state = await provider.getState();
      expect(state.health.coherence).toBe(0.7);

      // Note: coherence is now computed from memory (unresolved thoughts)
      // not from internal state, so the provider just preserves the value
    });
  });

  describe('batch reflection queue', () => {
    it('sets batchWindowStartAt only on first item', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // First item should trigger window start
      const wasEmpty1 = await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });
      expect(wasEmpty1).toBe(true);

      const state1 = await provider.getState();
      expect(state1.batchWindowStartAt).toBeDefined();
      const windowStart = state1.batchWindowStartAt;

      // Second item should not change window start
      const wasEmpty2 = await provider.enqueuePendingReflection({
        responseText: 'response 2',
        triggerSummary: 'trigger 2',
        recipientId: 'user1',
        tickId: 'tick2',
        timestamp: new Date(),
      });
      expect(wasEmpty2).toBe(false);

      const state2 = await provider.getState();
      expect(state2.batchWindowStartAt?.getTime()).toBe(windowStart?.getTime());
    });

    it('returns null from takePendingBatch if already in-flight', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Enqueue items
      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      // Take first batch
      const batch1 = await provider.takePendingBatch();
      expect(batch1).not.toBeNull();
      expect(batch1).toHaveLength(1);

      // Second take should return null (already in-flight)
      const batch2 = await provider.takePendingBatch();
      expect(batch2).toBeNull();
    });

    it('takePendingBatch moves items to in-flight and clears queue', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      const batch = await provider.takePendingBatch();
      expect(batch).toHaveLength(1);

      const state = await provider.getState();
      expect(state.pendingReflections).toHaveLength(0);
      expect(state.reflectionBatchInFlight).toBeDefined();
      expect(state.reflectionBatchInFlight?.itemCount).toBe(1);
      expect(state.batchWindowStartAt).toBeUndefined();
    });

    it('commitPendingBatch clears in-flight state', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      await provider.takePendingBatch();
      await provider.commitPendingBatch();

      const state = await provider.getState();
      expect(state.reflectionBatchInFlight).toBeUndefined();
    });

    it('recoverStaleBatch moves items back after 5 minutes', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      await provider.takePendingBatch();

      // Manually make the batch stale by backdating startedAt
      const state = await provider.getState();
      if (state.reflectionBatchInFlight) {
        state.reflectionBatchInFlight.startedAt = new Date(Date.now() - 6 * 60 * 1000); // 6 minutes ago
        await provider.persist();
      }

      // Recover should move items back
      const recovered = await provider.recoverStaleBatch();
      expect(recovered).toHaveLength(1);

      const stateAfter = await provider.getState();
      expect(stateAfter.pendingReflections).toHaveLength(1);
      expect(stateAfter.reflectionBatchInFlight).toBeUndefined();
      expect(stateAfter.batchWindowStartAt).toBeDefined(); // Window restarted
    });

    it('recoverStaleBatch recovers after too many attempts', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      await provider.takePendingBatch();

      // Increment attempts to 3
      await provider.incrementBatchAttempt();
      await provider.incrementBatchAttempt();
      await provider.incrementBatchAttempt();

      // Recover should trigger due to too many attempts
      const recovered = await provider.recoverStaleBatch();
      expect(recovered).toHaveLength(1);

      const stateAfter = await provider.getState();
      expect(stateAfter.reflectionBatchInFlight).toBeUndefined();
    });

    it('drops oldest item when queue exceeds 50', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Enqueue 51 items
      for (let i = 0; i < 51; i++) {
        await provider.enqueuePendingReflection({
          responseText: `response ${String(i)}`,
          triggerSummary: `trigger ${String(i)}`,
          recipientId: 'user1',
          tickId: `tick${String(i)}`,
          timestamp: new Date(),
        });
      }

      const state = await provider.getState();
      expect(state.pendingReflections).toHaveLength(50); // Capped at 50
      // First item should have been dropped
      expect(state.pendingReflections[0].tickId).toBe('tick1');
      expect(state.pendingReflections[49].tickId).toBe('tick50');
    });

    it('getBatchStatus returns correct state', async () => {
      const provider = createSoulProvider(mockLogger as any, config);

      // Initially empty
      const status1 = await provider.getBatchStatus();
      expect(status1.pendingCount).toBe(0);
      expect(status1.windowStartAt).toBeUndefined();
      expect(status1.inFlight).toBeUndefined();

      // After enqueueing
      await provider.enqueuePendingReflection({
        responseText: 'response 1',
        triggerSummary: 'trigger 1',
        recipientId: 'user1',
        tickId: 'tick1',
        timestamp: new Date(),
      });

      const status2 = await provider.getBatchStatus();
      expect(status2.pendingCount).toBe(1);
      expect(status2.windowStartAt).toBeDefined();

      // After taking batch
      await provider.takePendingBatch();
      const status3 = await provider.getBatchStatus();
      expect(status3.pendingCount).toBe(0);
      expect(status3.inFlight).toBeDefined();
      expect(status3.inFlight?.itemCount).toBe(1);
    });
  });
});
