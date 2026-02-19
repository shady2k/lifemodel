/**
 * Tests for LLMEntityExtractor.
 *
 * Covers: mock LLM, extraction prompt validation, parse response,
 * grounding check, confidence threshold, error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LLMEntityExtractor } from '../../../src/storage/entity-extractor.js';
import type { MemoryEntry } from '../../../src/layers/cognition/tools/registry.js';
import type { CognitionLLM } from '../../../src/layers/cognition/agentic-loop-types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as import('../../../src/types/logger.js').Logger;
}

function createMockLLM(response: string): CognitionLLM {
  return {
    complete: vi.fn().mockResolvedValue(response),
    completeWithTools: vi.fn(),
  };
}

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    type: 'fact',
    timestamp: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LLMEntityExtractor', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  it('extracts entities and relations from valid LLM response', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [
        { name: 'John', type: 'person', aliases: ['Johnny'], confidence: 0.9 },
        { name: 'Google', type: 'organization', aliases: [], confidence: 0.8 },
      ],
      relations: [
        { from: 'John', to: 'Google', type: 'works_at', strength: 0.8, confidence: 0.85 },
      ],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'John works at Google as an engineer' })],
      []
    );

    expect(result.entities).toHaveLength(2);
    expect(result.entities[0]!.name).toBe('John');
    expect(result.entities[1]!.name).toBe('Google');
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.type).toBe('works_at');
  });

  it('filters out entities not grounded in source text', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [
        { name: 'John', type: 'person', aliases: [], confidence: 0.9 },
        { name: 'Hallucinated Person', type: 'person', aliases: [], confidence: 0.8 },
      ],
      relations: [],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'John went to the park' })],
      []
    );

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe('John');
  });

  it('filters out entities below confidence threshold', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [
        { name: 'John', type: 'person', aliases: [], confidence: 0.3 },
      ],
      relations: [],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'John mentioned something' })],
      []
    );

    expect(result.entities).toHaveLength(0);
  });

  it('filters out relations with missing endpoints', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [
        { name: 'John', type: 'person', aliases: [], confidence: 0.9 },
      ],
      relations: [
        { from: 'John', to: 'NonExistent', type: 'works_at', strength: 0.8, confidence: 0.85 },
      ],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'John went to work' })],
      []
    );

    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(0);
  });

  it('handles invalid JSON from LLM gracefully', async () => {
    const llm = createMockLLM('This is not JSON at all');

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'test content' })],
      []
    );

    expect(result.entities).toHaveLength(0);
    expect(result.relations).toHaveLength(0);
  });

  it('handles malformed JSON schema from LLM gracefully', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [{ wrong_field: 'bad' }],
      relations: [],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'test content' })],
      []
    );

    expect(result.entities).toHaveLength(0);
  });

  it('includes existing entity names in prompt for dedup', async () => {
    const llm = createMockLLM(JSON.stringify({ entities: [], relations: [] }));

    const extractor = new LLMEntityExtractor(logger, llm);
    await extractor.extract(
      [makeEntry({ id: 'e1', content: 'test' })],
      ['John Smith', 'Google']
    );

    // Verify existing names were passed to the LLM
    const callArgs = (llm.complete as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].userPrompt).toContain('John Smith');
    expect(callArgs[0].userPrompt).toContain('Google');
  });

  it('relations can reference existing entities', async () => {
    const llm = createMockLLM(JSON.stringify({
      entities: [
        { name: 'Sarah', type: 'person', aliases: [], confidence: 0.9 },
      ],
      relations: [
        { from: 'Sarah', to: 'John', type: 'married_to', strength: 0.9, confidence: 0.9 },
      ],
    }));

    const extractor = new LLMEntityExtractor(logger, llm);
    const result = await extractor.extract(
      [makeEntry({ id: 'e1', content: 'Sarah is married to John' })],
      ['John'] // Pre-existing entity
    );

    expect(result.entities).toHaveLength(1);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]!.fromName).toBe('Sarah');
    expect(result.relations[0]!.toName).toBe('John');
  });

  it('handles LLM errors gracefully per batch', async () => {
    const llm: CognitionLLM = {
      complete: vi.fn()
        .mockRejectedValueOnce(new Error('LLM timeout'))
        .mockResolvedValueOnce(JSON.stringify({
          entities: [{ name: 'Bob', type: 'person', aliases: [], confidence: 0.9 }],
          relations: [],
        })),
      completeWithTools: vi.fn(),
    };

    const extractor = new LLMEntityExtractor(logger, llm);
    // Create 25 entries to trigger 2 batches (batch size = 20)
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ id: `e${i}`, content: `Entry ${i} about Bob` })
    );
    const result = await extractor.extract(entries, []);

    // First batch fails, second succeeds
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe('Bob');
  });
});
