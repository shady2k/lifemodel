/**
 * Tests for conversation-aware batch reflection.
 *
 * Covers:
 * - processBatchReflection fetches getHistory() with batch recipientId
 * - Works without conversationManager (graceful degradation)
 * - Conversation context appears in LLM system prompt with timestamps
 * - Tool messages filtered out of context
 * - getHistory failure doesn't block batch processing
 * - Mismatched-recipient items are requeued with warning log
 * - Implicit correction source parsed from LLM response
 * - Implicit corrections saved with weight 0.7
 * - Implicit corrections get 21-day half-life in getBehaviorRules()
 * - Dynamic budget check returns batch to pending when over budget
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger } from '../helpers/factories.js';
import type { MemoryEntry } from '../../src/layers/cognition/tools/registry.js';
import { createJsonMemoryProvider } from '../../src/storage/memory-provider.js';
import type { Storage } from '../../src/storage/storage.js';
import {
  processBatchReflection,
  saveBehaviorRule,
} from '../../src/layers/cognition/soul/reflection.js';
import type {
  ReflectionDeps,
  ExtractedBehaviorRule,
} from '../../src/layers/cognition/soul/reflection.js';
import type { PendingReflection } from '../../src/types/agent/soul.js';
import type { ConversationMessage } from '../../src/storage/conversation-manager.js';

// ─── Helpers ───────────────────────────────────────────────

function createMockStorage(): Storage {
  const store = new Map<string, unknown>();
  return {
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, data: unknown) => { store.set(key, data); },
    delete: async (key: string) => { const existed = store.has(key); store.delete(key); return existed; },
    exists: async (key: string) => store.has(key),
    keys: async () => Array.from(store.keys()),
  };
}

function createPendingItem(overrides: Partial<PendingReflection> = {}): PendingReflection {
  return {
    responseText: 'How was your day?',
    triggerSummary: 'user_message: hi',
    recipientId: 'user-1',
    tickId: `tick_${String(Date.now())}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date('2026-02-18T15:00:00Z'),
    ...overrides,
  };
}

/** Minimal FullSoulState mock for reflection */
function createMockSoulState() {
  return {
    selfModel: {
      narrative: { currentStory: 'I am a helpful digital companion.' },
      behaviorExpectations: [],
    },
    constitution: {
      coreCares: [{ care: 'helpfulness', weight: 1.0, sacred: false }],
      invariants: [],
    },
    softLearning: { decay: { halfLifeHours: 72 } },
    pendingReflections: [],
    batchWindowStartAt: null,
  };
}

/** Build mock SoulProvider with sensible defaults */
function createMockSoulProvider(items: PendingReflection[] = []) {
  const enqueuedItems: PendingReflection[] = [];
  let committed = false;

  return {
    canReflect: vi.fn().mockResolvedValue(true),
    canAfford: vi.fn().mockResolvedValue(true),
    getBatchStatus: vi.fn().mockResolvedValue({ inFlight: false, pendingCount: items.length }),
    takePendingBatch: vi.fn().mockResolvedValue(items),
    incrementBatchAttempt: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockResolvedValue(createMockSoulState()),
    recordReflection: vi.fn().mockResolvedValue(undefined),
    deductTokens: vi.fn().mockResolvedValue(undefined),
    commitPendingBatch: vi.fn().mockImplementation(async () => { committed = true; }),
    addSoftLearningItem: vi.fn().mockResolvedValue(undefined),
    enqueuePendingReflection: vi.fn().mockImplementation(async (item: PendingReflection) => {
      enqueuedItems.push(item);
      return enqueuedItems.length === 1;
    }),
    // Expose for assertions
    _enqueuedItems: enqueuedItems,
    _isCommitted: () => committed,
  };
}

/** Build a mock CognitionLLM that returns a valid batch response */
function createMockLLM(items: PendingReflection[], extraRules: ExtractedBehaviorRule[] = []) {
  const responseObj = {
    results: items.map((item) => ({
      tickId: item.tickId,
      dissonance: 2,
      reasoning: 'Looks fine',
    })),
    patterns: [],
    behaviorRules: extraRules,
  };

  return {
    complete: vi.fn().mockResolvedValue(JSON.stringify(responseObj)),
  };
}

/** Build a mock ConversationManager */
function createMockConversationManager(messages: ConversationMessage[] = []) {
  return {
    getHistory: vi.fn().mockResolvedValue(messages),
    getStatus: vi.fn().mockResolvedValue({ status: 'idle', lastMessageAt: new Date() }),
    getLastUserMessageTime: vi.fn().mockResolvedValue(null),
    addCompletedAction: vi.fn().mockResolvedValue(undefined),
    getRecentActions: vi.fn().mockResolvedValue([]),
    needsCompaction: vi.fn().mockResolvedValue(false),
    getMessagesToCompact: vi.fn().mockResolvedValue([]),
    compact: vi.fn().mockResolvedValue(undefined),
  };
}

function buildDeps(
  items: PendingReflection[],
  opts: {
    conversationManager?: ReturnType<typeof createMockConversationManager>;
    llm?: ReturnType<typeof createMockLLM>;
    memoryProvider?: JsonMemoryProvider;
    soulProvider?: ReturnType<typeof createMockSoulProvider>;
  } = {}
): ReflectionDeps & { _soulProvider: ReturnType<typeof createMockSoulProvider>; _llm: ReturnType<typeof createMockLLM> } {
  const logger = createMockLogger();
  const soulProvider = opts.soulProvider ?? createMockSoulProvider(items);
  const memoryProvider = opts.memoryProvider ?? createJsonMemoryProvider(logger, {
    storage: createMockStorage(),
    storageKey: 'memory',
    maxEntries: 1000,
  });
  const llm = opts.llm ?? createMockLLM(items);

  return {
    logger,
    soulProvider: soulProvider as any,
    memoryProvider,
    llm: llm as any,
    conversationManager: opts.conversationManager as any,
    _soulProvider: soulProvider,
    _llm: llm,
  };
}

// ─── Tests ─────────────────────────────────────────────────

describe('conversation-aware batch reflection', () => {
  it('calls getHistory() with batch recipientId when conversationManager provided', async () => {
    const items = [createPendingItem({ recipientId: 'user-42' })];
    const convManager = createMockConversationManager([
      { role: 'user', content: 'hi', timestamp: new Date('2026-02-18T14:58:00Z') },
      { role: 'assistant', content: 'How was your day?', timestamp: new Date('2026-02-18T15:00:00Z') },
    ]);
    const deps = buildDeps(items, { conversationManager: convManager });

    await processBatchReflection(deps);

    expect(convManager.getHistory).toHaveBeenCalledWith('user-42', {
      maxRecentTurns: 4,
      includeCompacted: false,
    });
  });

  it('works without conversationManager (graceful degradation)', async () => {
    const items = [createPendingItem()];
    const deps = buildDeps(items); // no conversationManager

    // Should not throw
    await processBatchReflection(deps);

    expect(deps._soulProvider.commitPendingBatch).toHaveBeenCalled();
  });

  it('includes conversation context with timestamps in LLM prompt', async () => {
    const items = [createPendingItem()];
    const convManager = createMockConversationManager([
      { role: 'user', content: 'hello there', timestamp: new Date('2026-02-18T14:58:00Z') },
      { role: 'assistant', content: 'How was your day?', timestamp: new Date('2026-02-18T15:00:00Z') },
    ]);
    const deps = buildDeps(items, { conversationManager: convManager });

    await processBatchReflection(deps);

    // Check what was passed to llm.complete
    const llmCall = deps._llm.complete.mock.calls[0]![0] as { systemPrompt: string };
    expect(llmCall.systemPrompt).toContain('Recent conversation:');
    expect(llmCall.systemPrompt).toContain('USER: hello there');
    expect(llmCall.systemPrompt).toContain('ASSISTANT: How was your day?');
    // Timestamps should be present (HH:MM format — exact value depends on local timezone)
    expect(llmCall.systemPrompt).toMatch(/\[\d{2}:\d{2}\] USER:/);
  });

  it('filters tool messages out of conversation context', async () => {
    const items = [createPendingItem()];
    const convManager = createMockConversationManager([
      { role: 'user', content: 'hello', timestamp: new Date() },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }], timestamp: new Date() },
      { role: 'tool', content: 'result', tool_call_id: 'tc1', timestamp: new Date() },
      { role: 'assistant', content: 'Here is the result', timestamp: new Date() },
    ]);
    const deps = buildDeps(items, { conversationManager: convManager });

    await processBatchReflection(deps);

    const llmCall = deps._llm.complete.mock.calls[0]![0] as { systemPrompt: string };
    // Tool messages should be filtered
    expect(llmCall.systemPrompt).not.toContain('TOOL:');
    // But user/assistant should remain
    expect(llmCall.systemPrompt).toContain('USER: hello');
    expect(llmCall.systemPrompt).toContain('ASSISTANT: Here is the result');
  });

  it('getHistory failure does not block batch processing', async () => {
    const items = [createPendingItem()];
    const convManager = createMockConversationManager();
    convManager.getHistory.mockRejectedValue(new Error('Storage unavailable'));
    const deps = buildDeps(items, { conversationManager: convManager });

    // Should not throw — proceeds without conversation context
    await processBatchReflection(deps);

    expect(deps._soulProvider.commitPendingBatch).toHaveBeenCalled();
  });

  it('requeues mismatched-recipient items with warning', async () => {
    const item1 = createPendingItem({ recipientId: 'user-1', tickId: 'tick_1' });
    const item2 = createPendingItem({ recipientId: 'user-2', tickId: 'tick_2' });
    const soulProvider = createMockSoulProvider([item1, item2]);

    // LLM should only see the primary recipient's item
    const llmResponse = {
      results: [{ tickId: 'tick_1', dissonance: 2, reasoning: 'Fine' }],
      patterns: [],
      behaviorRules: [],
    };
    const llm = { complete: vi.fn().mockResolvedValue(JSON.stringify(llmResponse)) };

    const convManager = createMockConversationManager();
    const deps = buildDeps([item1, item2], {
      soulProvider,
      llm: llm as any,
      conversationManager: convManager,
    });

    await processBatchReflection(deps);

    // item2 should have been requeued
    expect(soulProvider.enqueuePendingReflection).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 'user-2', tickId: 'tick_2' })
    );
    // Only item1 should be sent to LLM
    const userPrompt = llm.complete.mock.calls[0]?.[0]?.userPrompt as string;
    expect(userPrompt).toContain('tick_1');
    expect(userPrompt).not.toContain('tick_2');
  });

  it('parses implicit_correction source from LLM response', async () => {
    const items = [createPendingItem({ tickId: 'tick_abc' })];
    const llmResponse = {
      results: [{ tickId: 'tick_abc', dissonance: 3, reasoning: 'Contextual mismatch' }],
      patterns: [],
      behaviorRules: [{
        action: 'create',
        rule: 'Check time of day before asking about day completion',
        evidence: 'User replied "it is not over yet"',
        source: 'implicit_correction',
      }],
    };
    const llm = { complete: vi.fn().mockResolvedValue(JSON.stringify(llmResponse)) };

    const logger = createMockLogger();
    const memoryProvider = createJsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });

    const deps = buildDeps(items, { llm: llm as any, memoryProvider });

    await processBatchReflection(deps);

    // Verify rule was saved to memoryProvider
    const rules = await memoryProvider.getBehaviorRules({ limit: 10 });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.content).toBe('Check time of day before asking about day completion');
    expect(rules[0]!.entry.metadata?.['source']).toBe('implicit_correction');
  });

  it('saves implicit corrections with weight 0.7', async () => {
    const logger = createMockLogger();
    const memoryProvider = createJsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });

    const rule: ExtractedBehaviorRule = {
      action: 'create',
      rule: 'Avoid morning greetings referencing day completion',
      evidence: 'User said "it is not over yet"',
      source: 'implicit_correction',
    };

    await saveBehaviorRule(memoryProvider, rule, logger);

    const rules = await memoryProvider.getBehaviorRules({ limit: 10 });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.metadata?.['weight']).toBe(0.7);
    expect(rules[0]!.entry.metadata?.['source']).toBe('implicit_correction');
  });

  it('implicit corrections get 21-day half-life in getBehaviorRules()', async () => {
    const logger = createMockLogger();
    const memoryProvider = createJsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });

    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const ruleId = `rule_test_implicit`;
    const entry: MemoryEntry = {
      id: `mem_behavior_${ruleId}`,
      type: 'fact',
      content: 'Implicit rule for decay test',
      timestamp: twentyOneDaysAgo,
      tags: ['behavior:rule', 'state:active'],
      confidence: 0.9,
      metadata: {
        subject: 'behavior_rule',
        attribute: ruleId,
        weight: 1.0,
        count: 1,
        source: 'implicit_correction',
        evidence: 'test',
        lastReinforcedAt: twentyOneDaysAgo.toISOString(),
      },
    };
    await memoryProvider.save(entry);

    const rules = await memoryProvider.getBehaviorRules({ limit: 10 });
    expect(rules).toHaveLength(1);
    // After 21 days with 21-day half-life: effective ≈ 1.0 * 0.5 = 0.5
    expect(rules[0]!.effectiveWeight).toBeGreaterThan(0.45);
    expect(rules[0]!.effectiveWeight).toBeLessThan(0.55);
  });

  it('dynamic budget check returns batch to pending when over budget', async () => {
    const longResponse = 'x'.repeat(10_000);
    const items = [createPendingItem({ responseText: longResponse })];
    const soulProvider = createMockSoulProvider(items);

    // First canAfford (pre-check) passes, second (dynamic) fails
    let affordCallCount = 0;
    soulProvider.canAfford.mockImplementation(async () => {
      affordCallCount++;
      return affordCallCount <= 1; // pass pre-check, fail dynamic
    });

    const deps = buildDeps(items, { soulProvider });

    await processBatchReflection(deps);

    // Batch items should be requeued
    expect(soulProvider.enqueuePendingReflection).toHaveBeenCalledWith(
      expect.objectContaining({ responseText: longResponse })
    );
    // Batch should be committed (to clear in-flight state)
    expect(soulProvider.commitPendingBatch).toHaveBeenCalled();
    // LLM should NOT have been called
    expect(deps._llm.complete).not.toHaveBeenCalled();
  });
});
