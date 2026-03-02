/**
 * Tests for trigger-sections.ts
 *
 * Validates: formatInterests() priority buckets, deterministic sort,
 * interest group display, proactive trigger guardrail sentence.
 */

import { describe, it, expect } from 'vitest';
import {
  formatInterests,
  buildProactiveContactSection,
} from '../../../../../src/layers/cognition/prompts/trigger-sections.js';
import type { Interests } from '../../../../../src/types/user/interests.js';
import type { LoopContext } from '../../../../../src/layers/cognition/agentic-loop-types.js';
import type { InterestGroup } from '../../../../../src/layers/cognition/soul/interest-compaction.js';

function createInterests(
  weights: Record<string, number>,
  urgency: Record<string, number> = {}
): Interests {
  return { weights, urgency, topicBaselines: {} };
}

function createMockContext(override?: Partial<LoopContext>): LoopContext {
  return {
    triggerSignal: { type: 'contact_urge', id: 'test', data: {} },
    agentState: {
      energy: 0.5,
      socialDebt: 0,
      taskPressure: 0,
      curiosity: 0.5,
      acquaintancePressure: 0,
    },
    conversationHistory: [],
    userModel: {},
    tickId: 'test-tick',
    drainPendingUserMessages: undefined,
    ...override,
  } as LoopContext;
}

describe('formatInterests', () => {
  it('returns empty for no positive interests', () => {
    const interests = createInterests({ blocked: 0, suppressed: -1 });
    const result = formatInterests(interests);
    expect(result.lines).toEqual([]);
    expect(result.omittedCount).toBe(0);
  });

  it('returns empty for empty weights', () => {
    const interests = createInterests({});
    const result = formatInterests(interests);
    expect(result.lines).toEqual([]);
    expect(result.omittedCount).toBe(0);
  });

  it('high-urgency topics always included regardless of position', () => {
    // Create 20 topics at weight 1.0, only "location" has high urgency
    const weights: Record<string, number> = {};
    const urgency: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      weights[`topic_${String(i).padStart(2, '0')}`] = 1.0;
      urgency[`topic_${String(i).padStart(2, '0')}`] = 0.5;
    }
    weights['яблоновский'] = 1.0;
    urgency['яблоновский'] = 1.0;

    const interests = createInterests(weights, urgency);
    const result = formatInterests(interests, 5);

    // яблоновский must be in the output
    expect(result.lines.some((l) => l.includes('яблоновский'))).toBe(true);
    expect(result.lines[0]).toContain('яблоновский');
    expect(result.lines[0]).toContain('high urgency');
  });

  it('deterministic tie-break: weight DESC → urgency DESC → topic ASC', () => {
    const interests = createInterests(
      { banana: 1.0, apple: 1.0, cherry: 1.0 },
      { banana: 0.5, apple: 0.5, cherry: 0.5 }
    );
    const result = formatInterests(interests, 3);

    // All same weight and urgency → alphabetical
    expect(result.lines[0]).toContain('apple');
    expect(result.lines[1]).toContain('banana');
    expect(result.lines[2]).toContain('cherry');
  });

  it('weight takes priority over urgency in sorting', () => {
    const interests = createInterests(
      { high_weight: 2.0, high_urgency: 1.0 },
      { high_weight: 0.3, high_urgency: 0.6 }
    );
    const result = formatInterests(interests, 2);

    expect(result.lines[0]).toContain('high_weight');
    expect(result.lines[1]).toContain('high_urgency');
  });

  it('soft cap: max items shown, omitted count correct', () => {
    const weights: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      weights[`topic_${String(i).padStart(2, '0')}`] = 0.5;
    }
    const interests = createInterests(weights);
    const result = formatInterests(interests, 10);

    // 10 topic lines + 1 omitted line
    const topicLines = result.lines.filter((l) => l.startsWith('- '));
    expect(topicLines.length).toBe(10);
    expect(result.omittedCount).toBe(20);
    expect(result.lines[result.lines.length - 1]).toContain('+20 lower-priority interests omitted');
  });

  it('high-urgency can exceed maxItems', () => {
    const weights: Record<string, number> = {};
    const urgency: Record<string, number> = {};
    // 5 high-urgency topics
    for (let i = 0; i < 5; i++) {
      weights[`urgent_${String(i)}`] = 1.0;
      urgency[`urgent_${String(i)}`] = 0.9;
    }
    // 10 normal topics
    for (let i = 0; i < 10; i++) {
      weights[`normal_${String(i)}`] = 0.5;
      urgency[`normal_${String(i)}`] = 0.3;
    }
    const interests = createInterests(weights, urgency);
    const result = formatInterests(interests, 3);

    // All 5 urgent must be shown even though maxItems=3
    const urgentLines = result.lines.filter((l) => l.includes('high urgency'));
    expect(urgentLines.length).toBe(5);
    // No remaining slots, so all 10 normal are omitted
    expect(result.omittedCount).toBe(10);
  });

  it('mixed Cyrillic/Latin deterministic sort', () => {
    const interests = createInterests(
      { газ: 1.0, вода: 1.0, crypto: 1.0 },
      { газ: 0.5, вода: 0.5, crypto: 0.5 }
    );
    const result = formatInterests(interests, 10);

    // localeCompare determines order — the key thing is it's deterministic
    expect(result.lines.length).toBe(3);
    // Run twice to confirm determinism
    const result2 = formatInterests(interests, 10);
    expect(result.lines).toEqual(result2.lines);
  });

  it('uses interest groups to display grouped labels', () => {
    const interests = createInterests(
      { газ: 1.0, вода: 1.0, отключения: 1.0, crypto: 0.8 },
      { газ: 0.5, вода: 0.5, отключения: 0.5, crypto: 0.5 }
    );
    const groups: InterestGroup[] = [{ label: 'коммунальные отключения', topics: ['газ', 'вода', 'отключения'] }];
    const result = formatInterests(interests, 15, groups);

    // Should show group label instead of individual topics
    expect(result.lines.some((l) => l.includes('коммунальные отключения'))).toBe(true);
    // crypto should still be individual
    expect(result.lines.some((l) => l.includes('crypto'))).toBe(true);
  });

  it('pinned topics never grouped even if in a group', () => {
    const interests = createInterests(
      { газ: 1.0, вода: 1.0, яблоновский: 1.0 },
      { газ: 0.5, вода: 0.5, яблоновский: 1.0 }
    );
    const groups: InterestGroup[] = [{ label: 'коммунальное', topics: ['газ', 'вода', 'яблоновский'] }];
    const result = formatInterests(interests, 15, groups);

    // яблоновский should appear individually (pinned)
    expect(result.lines.some((l) => l.includes('яблоновский') && l.includes('high urgency'))).toBe(true);
    // The group should not include яблоновский (only 2 remaining → газ, вода → can still group)
    const groupLine = result.lines.find((l) => l.includes('коммунальное'));
    if (groupLine) {
      expect(groupLine).not.toContain('яблоновский');
    }
  });
});

describe('buildProactiveContactSection', () => {
  it('includes guardrail sentence about topic/location interests', () => {
    const context = createMockContext({
      timeSinceLastMessageMs: 3600000,
    });
    const result = buildProactiveContactSection(context, 'contact_urge');

    expect(result).toContain('topic interests describe what to look for');
    expect(result).toContain('location interests describe where it applies');
  });

  it('includes one-topic-per-message and deduplication guidance', () => {
    const context = createMockContext({
      timeSinceLastMessageMs: 3600000,
    });
    const result = buildProactiveContactSection(context, 'contact_urge');

    expect(result).toContain('single most valuable thing');
    expect(result).toContain('One topic per message');
    expect(result).toContain('scan conversation history for URLs');
    expect(result).toContain('Choose ONE');
  });

  it('renders interests section with formatted interests', () => {
    const context = createMockContext({
      timeSinceLastMessageMs: 3600000,
      userInterests: createInterests(
        { crypto: 1.0, отключения: 0.8 },
        { crypto: 0.9, отключения: 0.5 }
      ),
    });
    const result = buildProactiveContactSection(context, 'contact_urge');

    expect(result).toContain('crypto');
    expect(result).toContain('отключения');
  });
});
