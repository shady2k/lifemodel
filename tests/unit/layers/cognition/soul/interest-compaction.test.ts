/**
 * Tests for interest-compaction.ts
 *
 * Validates: LLM compaction, validation rules, hash-based caching,
 * and fail-closed behavior on invalid output.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  compactInterests,
  computeInterestsHash,
} from '../../../../../src/layers/cognition/soul/interest-compaction.js';
import type { Interests } from '../../../../../src/types/user/interests.js';
import type { CognitionLLM } from '../../../../../src/layers/cognition/agentic-loop-types.js';
import type { Logger } from '../../../../../src/types/logger.js';

function createInterests(
  weights: Record<string, number>,
  urgency: Record<string, number> = {}
): Interests {
  return { weights, urgency, topicBaselines: {} };
}

function createMockLLM(response: string): CognitionLLM {
  return {
    complete: vi.fn().mockResolvedValue(response),
    completeWithTools: vi.fn(),
  };
}

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

describe('computeInterestsHash', () => {
  it('produces deterministic hash for same keys', () => {
    const interests = createInterests({ a: 1.0, b: 0.5, c: 0.3 });
    const hash1 = computeInterestsHash(interests);
    const hash2 = computeInterestsHash(interests);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(16);
  });

  it('ignores zero-weight keys', () => {
    const with0 = createInterests({ a: 1.0, b: 0, c: 0.5 });
    const without0 = createInterests({ a: 1.0, c: 0.5 });
    expect(computeInterestsHash(with0)).toBe(computeInterestsHash(without0));
  });

  it('changes when keys change', () => {
    const v1 = createInterests({ a: 1.0, b: 0.5 });
    const v2 = createInterests({ a: 1.0, b: 0.5, c: 0.3 });
    expect(computeInterestsHash(v1)).not.toBe(computeInterestsHash(v2));
  });

  it('does not change when weight values change but keys stay same', () => {
    const v1 = createInterests({ a: 1.0, b: 0.5 });
    const v2 = createInterests({ a: 0.3, b: 0.8 });
    expect(computeInterestsHash(v1)).toBe(computeInterestsHash(v2));
  });
});

describe('compactInterests', () => {
  it('returns valid groups from well-formed LLM response', async () => {
    const interests = createInterests(
      { газ: 1.0, вода: 1.0, отключения: 1.0, crypto: 0.8 },
      { газ: 0.5, вода: 0.5, отключения: 0.5, crypto: 0.5 }
    );

    const llm = createMockLLM(
      JSON.stringify([
        { label: 'коммунальные отключения', topics: ['газ', 'вода', 'отключения'] },
      ])
    );

    const result = await compactInterests(interests, llm, createMockLogger());

    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(1);
    expect(result!.groups[0].label).toBe('коммунальные отключения');
    expect(result!.groups[0].topics).toEqual(['газ', 'вода', 'отключения']);
    expect(result!.interestsHash).toHaveLength(16);
    expect(result!.generatedAt).toBeTruthy();
  });

  it('handles markdown code blocks in LLM response', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM(
      '```json\n[{"label": "ab group", "topics": ["a", "b"]}]\n```'
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(1);
  });

  it('returns null for invalid JSON', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM('not json at all');
    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when topic not in canonical interests', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM(
      JSON.stringify([{ label: 'group', topics: ['a', 'nonexistent'] }])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when duplicate topic across groups', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 1.0, e: 0.5 },
      {}
    );

    const llm = createMockLLM(
      JSON.stringify([
        { label: 'group1', topics: ['a', 'b'] },
        { label: 'group2', topics: ['b', 'c'] },
      ])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when group has only 1 topic', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM(
      JSON.stringify([{ label: 'solo', topics: ['a'] }])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when group has > 6 topics', async () => {
    const weights: Record<string, number> = {};
    for (let i = 0; i < 10; i++) weights[`t${String(i)}`] = 1.0;

    const interests = createInterests(weights);
    const llm = createMockLLM(
      JSON.stringify([
        { label: 'big', topics: ['t0', 't1', 't2', 't3', 't4', 't5', 't6'] },
      ])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when label too short', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM(
      JSON.stringify([{ label: 'x', topics: ['a', 'b'] }])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('returns null when too few interests (< 3)', async () => {
    const interests = createInterests({ a: 1.0, b: 0.5 });
    const llm = createMockLLM('should not be called');

    const result = await compactInterests(interests, llm, createMockLogger());

    expect(result).toBeNull();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('returns null on LLM error (fail-closed)', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm: CognitionLLM = {
      complete: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      completeWithTools: vi.fn(),
    };

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });
});
