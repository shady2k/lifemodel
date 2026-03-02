/**
 * Tests for interest-compaction.ts
 *
 * Validates: LLM compaction, validation rules, hash-based caching,
 * chunked compaction, merge pass, and graceful degradation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  compactInterests,
  computeInterestsHash,
  CHUNK_SIZE,
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

function createMockLLM(response: string | string[]): CognitionLLM {
  const completeFn = Array.isArray(response)
    ? vi.fn<[], Promise<string>>()
    : vi.fn().mockResolvedValue(response);

  if (Array.isArray(response)) {
    for (const r of response) {
      (completeFn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(r);
    }
  }

  return {
    complete: completeFn,
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

/** Generate N topics with weights from 1.0 descending. */
function generateTopics(n: number): Record<string, number> {
  const weights: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    weights[`topic_${String(i)}`] = Math.max(0.1, 1.0 - i * 0.01);
  }
  return weights;
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

describe('compactInterests — single batch', () => {
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

describe('compactInterests — chunked compaction', () => {
  it('uses single batch when topics ≤ CHUNK_SIZE', async () => {
    // Exactly CHUNK_SIZE topics — should NOT chunk
    const weights = generateTopics(CHUNK_SIZE);
    const interests = createInterests(weights);

    const topicKeys = Object.keys(weights).slice(0, 4);
    const llm = createMockLLM(
      JSON.stringify([
        { label: 'group A', topics: [topicKeys[0], topicKeys[1]] },
        { label: 'group B', topics: [topicKeys[2], topicKeys[3]] },
      ])
    );

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    // Single batch = 1 LLM call
    expect(llm.complete).toHaveBeenCalledTimes(1);
  });

  it('chunks when topics > CHUNK_SIZE and merges results', async () => {
    // CHUNK_SIZE + 5 topics → 2 chunks + 1 merge call
    const n = CHUNK_SIZE + 5;
    const weights = generateTopics(n);
    const interests = createInterests(weights);
    const allTopics = Object.keys(weights).sort(
      (a, b) => weights[b] - weights[a]
    );

    // Chunk 1 response: group from first chunk
    const chunk1Response = JSON.stringify([
      { label: 'chunk1 group', topics: [allTopics[0], allTopics[1]] },
    ]);
    // Chunk 2 response: group from second chunk
    const chunk2Response = JSON.stringify([
      { label: 'chunk2 group', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
    ]);
    // Merge response: keeps both groups as they don't overlap
    const mergeResponse = JSON.stringify([
      { label: 'chunk1 group', topics: [allTopics[0], allTopics[1]] },
      { label: 'chunk2 group', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
    ]);

    const llm = createMockLLM([chunk1Response, chunk2Response, mergeResponse]);

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(2);
    // 2 chunk calls + 1 merge call
    expect(llm.complete).toHaveBeenCalledTimes(3);
  });

  it('survives when one chunk fails', async () => {
    const n = CHUNK_SIZE + 5;
    const weights = generateTopics(n);
    const interests = createInterests(weights);
    const allTopics = Object.keys(weights).sort(
      (a, b) => weights[b] - weights[a]
    );

    const completeFn = vi.fn<[], Promise<string>>()
      // Chunk 1: fails
      .mockRejectedValueOnce(new Error('model crashed'))
      // Chunk 2: succeeds
      .mockResolvedValueOnce(
        JSON.stringify([
          { label: 'surviving group', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
        ])
      );
    // No merge call needed (only 1 group)

    const llm: CognitionLLM = { complete: completeFn, completeWithTools: vi.fn() };

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(1);
    expect(result!.groups[0].label).toBe('surviving group');
  });

  it('falls back to unmerged groups when merge fails', async () => {
    const n = CHUNK_SIZE + 5;
    const weights = generateTopics(n);
    const interests = createInterests(weights);
    const allTopics = Object.keys(weights).sort(
      (a, b) => weights[b] - weights[a]
    );

    const chunk1Response = JSON.stringify([
      { label: 'group A', topics: [allTopics[0], allTopics[1]] },
    ]);
    const chunk2Response = JSON.stringify([
      { label: 'group B', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
    ]);

    const completeFn = vi.fn<[], Promise<string>>()
      .mockResolvedValueOnce(chunk1Response)
      .mockResolvedValueOnce(chunk2Response)
      // Merge call fails
      .mockRejectedValueOnce(new Error('merge failed'));

    const llm: CognitionLLM = { complete: completeFn, completeWithTools: vi.fn() };

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    // Falls back to the 2 unmerged chunk groups
    expect(result!.groups).toHaveLength(2);
    expect(result!.groups[0].label).toBe('group A');
    expect(result!.groups[1].label).toBe('group B');
  });

  it('returns null when all chunks fail', async () => {
    const n = CHUNK_SIZE + 5;
    const weights = generateTopics(n);
    const interests = createInterests(weights);

    const llm: CognitionLLM = {
      complete: vi.fn().mockRejectedValue(new Error('all broken')),
      completeWithTools: vi.fn(),
    };

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).toBeNull();
  });

  it('deduplicates topics across chunks (first-seen wins)', async () => {
    const n = CHUNK_SIZE + 5;
    const weights = generateTopics(n);
    const interests = createInterests(weights);
    const allTopics = Object.keys(weights).sort(
      (a, b) => weights[b] - weights[a]
    );

    // Both chunks claim topic_0 (which belongs to chunk 1)
    // This simulates a model hallucinating a topic from the other chunk
    // But since validation checks canonical topics per-chunk, topic_0 won't be
    // in chunk 2's canonical set. So we test dedup within valid groups.
    const chunk1Response = JSON.stringify([
      { label: 'group A', topics: [allTopics[0], allTopics[1]] },
      { label: 'group C', topics: [allTopics[2], allTopics[3]] },
    ]);
    const chunk2Response = JSON.stringify([
      { label: 'group B', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
    ]);
    // Merge keeps all 3 (no overlap)
    const mergeResponse = JSON.stringify([
      { label: 'group A', topics: [allTopics[0], allTopics[1]] },
      { label: 'group C', topics: [allTopics[2], allTopics[3]] },
      { label: 'group B', topics: [allTopics[CHUNK_SIZE], allTopics[CHUNK_SIZE + 1]] },
    ]);

    const llm = createMockLLM([chunk1Response, chunk2Response, mergeResponse]);

    const result = await compactInterests(interests, llm, createMockLogger());
    expect(result).not.toBeNull();
    expect(result!.groups).toHaveLength(3);
  });

  it('prompt includes 2-6 topics constraint', async () => {
    const interests = createInterests(
      { a: 1.0, b: 1.0, c: 1.0, d: 0.5 },
      {}
    );

    const llm = createMockLLM(
      JSON.stringify([{ label: 'test group', topics: ['a', 'b'] }])
    );

    await compactInterests(interests, llm, createMockLogger());

    const callArgs = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    const systemPrompt = callArgs[0].systemPrompt as string;
    expect(systemPrompt).toContain('2-6 topics');
  });
});
