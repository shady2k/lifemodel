/**
 * Tests for behavioral self-learning rules.
 *
 * Covers:
 * - getBehaviorRules: tiered decay, filtering, sorting, cleanup
 * - saveBehaviorRule: create new, update existing, weight reinforcement
 * - buildBehaviorRulesSection: null when empty, correct formatting
 * - parseBehaviorRules: validation, max cap, ruleId validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../helpers/factories.js';
import type { MemoryEntry, MemoryProvider } from '../../src/layers/cognition/tools/registry.js';
import type { BehaviorRule } from '../../src/layers/cognition/tools/core/memory.js';
import { JsonMemoryProvider } from '../../src/storage/memory-provider.js';
import type { Storage } from '../../src/storage/storage.js';
import { buildBehaviorRulesSection } from '../../src/layers/cognition/prompts/context-sections.js';
import type { LoopContext } from '../../src/layers/cognition/agentic-loop-types.js';
import { saveBehaviorRule, pruneExcessBehaviorRules } from '../../src/layers/cognition/soul/reflection.js';
import type { ExtractedBehaviorRule } from '../../src/layers/cognition/soul/reflection.js';

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

function createBehaviorRuleEntry(overrides: Partial<MemoryEntry> & { weight?: number; source?: string; lastReinforcedAt?: string } = {}): MemoryEntry {
  const { weight = 1.0, source = 'user_feedback', lastReinforcedAt, ...rest } = overrides;
  const ruleId = `rule_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: `mem_behavior_${ruleId}`,
    type: 'fact',
    content: 'Test behavior rule',
    timestamp: new Date(),
    tags: ['behavior:rule', 'state:active'],
    confidence: 0.9,
    metadata: {
      subject: 'behavior_rule',
      attribute: ruleId,
      weight,
      count: 1,
      source,
      evidence: 'User said something',
      lastReinforcedAt: lastReinforcedAt ?? new Date().toISOString(),
    },
    ...rest,
  };
}

// Minimal LoopContext for testing buildBehaviorRulesSection
function createMinimalLoopContext(overrides: Partial<LoopContext> = {}): LoopContext {
  return {
    triggerSignal: {
      id: 'test',
      type: 'user_message',
      source: 'test',
      payload: { value: 1, confidence: 1 },
      priority: 0,
      timestamp: new Date(),
    },
    agentState: {
      energy: 0.8,
      socialDebt: 0.3,
      taskPressure: 0,
      curiosity: 0.5,
      acquaintancePressure: 0,
      acquaintancePending: false,
      thoughtPressure: 0,
      pendingThoughtCount: 0,
      lastTickAt: new Date(),
      tickInterval: 1000,
    },
    conversationHistory: [],
    userModel: {},
    tickId: 'test-tick',
    drainPendingUserMessages: undefined,
    ...overrides,
  };
}

describe('getBehaviorRules', () => {
  let provider: JsonMemoryProvider;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    provider = new JsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });
  });

  it('returns empty array when no rules exist', async () => {
    const rules = await provider.getBehaviorRules();
    expect(rules).toEqual([]);
  });

  it('returns active behavior rules', async () => {
    const entry = createBehaviorRuleEntry({ content: 'Keep responses short' });
    await provider.save(entry);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.content).toBe('Keep responses short');
    expect(rules[0]!.effectiveWeight).toBeGreaterThan(0.9);
  });

  it('applies user_feedback decay (60-day half-life)', async () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const entry = createBehaviorRuleEntry({
      content: 'Old rule',
      source: 'user_feedback',
      lastReinforcedAt: thirtyDaysAgo.toISOString(),
      timestamp: thirtyDaysAgo,
    });
    await provider.save(entry);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    // After 30 days with 60-day half-life: weight ~= 1.0 * 0.5^(30/60) ≈ 0.707
    expect(rules[0]!.effectiveWeight).toBeGreaterThan(0.65);
    expect(rules[0]!.effectiveWeight).toBeLessThan(0.75);
  });

  it('applies pattern decay (21-day half-life)', async () => {
    const twentyOneDaysAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const entry = createBehaviorRuleEntry({
      content: 'Pattern rule',
      source: 'pattern',
      lastReinforcedAt: twentyOneDaysAgo.toISOString(),
      timestamp: twentyOneDaysAgo,
    });
    await provider.save(entry);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    // After 21 days with 21-day half-life: weight ~= 1.0 * 0.5^1 = 0.5
    expect(rules[0]!.effectiveWeight).toBeGreaterThan(0.45);
    expect(rules[0]!.effectiveWeight).toBeLessThan(0.55);
  });

  it('filters out rules with effectiveWeight < 0.1', async () => {
    // User_feedback with 60-day half-life: to get below 0.1, need ~200 days
    const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const entry = createBehaviorRuleEntry({
      content: 'Dead rule',
      source: 'user_feedback',
      lastReinforcedAt: veryOld.toISOString(),
      timestamp: veryOld,
    });
    await provider.save(entry);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(0);
  });

  it('cleans up rules with effectiveWeight < 0.05', async () => {
    // Pattern with 21-day half-life: to get below 0.05, need ~90 days
    const veryOld = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const entry = createBehaviorRuleEntry({
      content: 'Decayed rule',
      source: 'pattern',
      lastReinforcedAt: veryOld.toISOString(),
      timestamp: veryOld,
    });
    await provider.save(entry);

    // Should have 1 entry before getBehaviorRules
    const allBefore = await provider.getAll();
    expect(allBefore).toHaveLength(1);

    // getBehaviorRules triggers cleanup
    await provider.getBehaviorRules();

    // Should be deleted
    const allAfter = await provider.getAll();
    expect(allAfter).toHaveLength(0);
  });

  it('sorts by effectiveWeight descending', async () => {
    const fresh = createBehaviorRuleEntry({ content: 'Fresh rule', weight: 2.0 });
    const old = createBehaviorRuleEntry({
      content: 'Older rule',
      weight: 1.0,
      lastReinforcedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await provider.save(fresh);
    await provider.save(old);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(2);
    expect(rules[0]!.entry.content).toBe('Fresh rule');
    expect(rules[1]!.entry.content).toBe('Older rule');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.save(createBehaviorRuleEntry({ content: `Rule ${String(i)}` }));
    }

    const rules = await provider.getBehaviorRules({ limit: 2 });
    expect(rules).toHaveLength(2);
  });

  it('filters by recipientId', async () => {
    const globalRule = createBehaviorRuleEntry({ content: 'Global rule' });
    const scopedRule = createBehaviorRuleEntry({ content: 'Scoped rule', recipientId: 'user1' });
    const otherRule = createBehaviorRuleEntry({ content: 'Other user rule', recipientId: 'user2' });
    await provider.save(globalRule);
    await provider.save(scopedRule);
    await provider.save(otherRule);

    const rules = await provider.getBehaviorRules({ recipientId: 'user1' });
    // Should include global (no recipientId) and user1-scoped, but not user2-scoped
    expect(rules).toHaveLength(2);
    const contents = rules.map((r) => r.entry.content);
    expect(contents).toContain('Global rule');
    expect(contents).toContain('Scoped rule');
    expect(contents).not.toContain('Other user rule');
  });

  it('ignores entries without correct tags', async () => {
    const normalFact: MemoryEntry = {
      id: 'fact1',
      type: 'fact',
      content: 'Normal fact, not a rule',
      timestamp: new Date(),
      tags: ['general'],
    };
    await provider.save(normalFact);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(0);
  });
});

describe('buildBehaviorRulesSection', () => {
  it('returns null when no behavioral rules', () => {
    const context = createMinimalLoopContext();
    expect(buildBehaviorRulesSection(context)).toBeNull();
  });

  it('returns null when behaviorRules is empty array', () => {
    const context = createMinimalLoopContext({ behaviorRules: [] });
    expect(buildBehaviorRulesSection(context)).toBeNull();
  });

  it('formats rules correctly', () => {
    const rules: MemoryEntry[] = [
      createBehaviorRuleEntry({ content: 'Keep responses concise' }),
      createBehaviorRuleEntry({ content: "Don't bring up projects unless asked" }),
    ];
    const context = createMinimalLoopContext({ behaviorRules: rules });

    const result = buildBehaviorRulesSection(context);
    expect(result).not.toBeNull();
    expect(result).toContain('<learned_behaviors>');
    expect(result).toContain('- Keep responses concise');
    expect(result).toContain("- Don't bring up projects unless asked");
    expect(result).toContain('Follow these naturally.');
  });
});

describe('saveBehaviorRule', () => {
  let provider: JsonMemoryProvider;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    provider = new JsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });
  });

  it('creates a new behavioral rule', async () => {
    const extracted: ExtractedBehaviorRule = {
      action: 'create',
      rule: 'Keep responses short',
      evidence: 'User said: "too long, be brief"',
    };

    await saveBehaviorRule(provider, extracted, logger);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.content).toBe('Keep responses short');
    expect(rules[0]!.entry.tags).toContain('behavior:rule');
    expect(rules[0]!.entry.tags).toContain('state:active');
    expect(rules[0]!.entry.metadata?.['weight']).toBe(1.0);
    expect(rules[0]!.entry.metadata?.['source']).toBe('user_feedback');
    expect(rules[0]!.entry.metadata?.['evidence']).toBe('User said: "too long, be brief"');
  });

  it('reinforces existing rule on update', async () => {
    // First create a rule
    const entry = createBehaviorRuleEntry({ content: 'Be concise' });
    const ruleId = entry.metadata!['attribute'] as string;
    await provider.save(entry);

    // Now update it
    const extracted: ExtractedBehaviorRule = {
      action: 'update',
      ruleId,
      rule: 'Be very concise',
      evidence: 'User said again: "shorter please"',
    };

    await saveBehaviorRule(provider, extracted, logger);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.content).toBe('Be very concise');
    expect(rules[0]!.entry.metadata?.['weight']).toBe(1.5); // 1.0 + 0.5
    expect(rules[0]!.entry.metadata?.['count']).toBe(2);
  });

  it('caps weight at 3.0 on reinforcement', async () => {
    const entry = createBehaviorRuleEntry({ content: 'Be concise', weight: 2.8 });
    const ruleId = entry.metadata!['attribute'] as string;
    await provider.save(entry);

    const extracted: ExtractedBehaviorRule = {
      action: 'update',
      ruleId,
      rule: 'Be concise',
      evidence: 'Another correction',
    };

    await saveBehaviorRule(provider, extracted, logger);

    const rules = await provider.getBehaviorRules();
    expect(rules[0]!.entry.metadata?.['weight']).toBe(3.0);
  });

  it('falls through to create when update target not found', async () => {
    const extracted: ExtractedBehaviorRule = {
      action: 'update',
      ruleId: 'nonexistent_rule',
      rule: 'New rule from failed update',
      evidence: 'Some evidence',
    };

    await saveBehaviorRule(provider, extracted, logger);

    const rules = await provider.getBehaviorRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.entry.content).toBe('New rule from failed update');
  });
});

describe('pruneExcessBehaviorRules', () => {
  let provider: JsonMemoryProvider;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    provider = new JsonMemoryProvider(logger, {
      storage: createMockStorage(),
      storageKey: 'memory',
      maxEntries: 1000,
    });
  });

  it('does nothing when under limit', async () => {
    await provider.save(createBehaviorRuleEntry({ content: 'Rule 1' }));
    await provider.save(createBehaviorRuleEntry({ content: 'Rule 2' }));

    await pruneExcessBehaviorRules(provider, logger, 5);

    const rules = await provider.getBehaviorRules({ limit: 100 });
    expect(rules).toHaveLength(2);
  });

  it('deletes lowest-weight rules when over limit', async () => {
    // Create 4 rules with different weights
    for (let i = 0; i < 4; i++) {
      await provider.save(createBehaviorRuleEntry({
        content: `Rule ${String(i)}`,
        weight: i + 1, // weights: 1, 2, 3, 4
      }));
    }

    await pruneExcessBehaviorRules(provider, logger, 2);

    const rules = await provider.getBehaviorRules({ limit: 100 });
    expect(rules).toHaveLength(2);
    // Should keep the highest-weight rules
    expect(rules[0]!.entry.content).toBe('Rule 3'); // weight 4
    expect(rules[1]!.entry.content).toBe('Rule 2'); // weight 3
  });
});
