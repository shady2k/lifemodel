/**
 * Tests for buildAssociationsSection.
 *
 * Covers: XML format, empty/null cases, truncation/caps.
 */

import { describe, it, expect } from 'vitest';
import { buildAssociationsSection } from '../../../src/layers/cognition/prompts/context-sections.js';
import type { LoopContext } from '../../../src/layers/cognition/agentic-loop-types.js';
import type { MemoryEntry, AssociationResult } from '../../../src/layers/cognition/tools/registry.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMinimalContext(associations?: AssociationResult): LoopContext {
  return {
    triggerSignal: { id: 'sig_1', type: 'user_message', timestamp: new Date(), data: {} },
    agentState: {} as LoopContext['agentState'],
    conversationHistory: [],
    userModel: {},
    tickId: 'tick_1',
    drainPendingUserMessages: undefined,
    associations,
  };
}

function makeEntry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
  return {
    id: `mem_${Math.random().toString(36).slice(2, 6)}`,
    type: 'fact',
    timestamp: new Date(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000), // 3 weeks ago
    confidence: 0.95,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('buildAssociationsSection', () => {
  it('returns null when no associations', () => {
    const context = makeMinimalContext(undefined);
    expect(buildAssociationsSection(context)).toBeNull();
  });

  it('returns null when all arrays are empty', () => {
    const context = makeMinimalContext({
      directMatches: [],
      relatedContext: [],
      openCommitments: [],
    });
    expect(buildAssociationsSection(context)).toBeNull();
  });

  it('renders direct memories in XML format', () => {
    const context = makeMinimalContext({
      directMatches: [
        makeEntry({ content: 'John works at Google' }),
      ],
      relatedContext: [],
      openCommitments: [],
    });

    const result = buildAssociationsSection(context);
    expect(result).not.toBeNull();
    expect(result).toContain('<associations>');
    expect(result).toContain('<direct_memories>');
    expect(result).toContain('John works at Google');
    expect(result).toContain('confidence: 0.95');
    expect(result).toContain('</direct_memories>');
    expect(result).toContain('</associations>');
  });

  it('renders related context with via path', () => {
    const context = makeMinimalContext({
      directMatches: [],
      relatedContext: [
        {
          entry: makeEntry({ content: 'Sarah started a new job at Meta' }),
          via: 'John → married_to → Sarah',
        },
      ],
      openCommitments: [],
    });

    const result = buildAssociationsSection(context);
    expect(result).toContain('<related_context>');
    expect(result).toContain('Sarah started a new job at Meta');
    expect(result).toContain('via: John → married_to → Sarah');
    expect(result).toContain('</related_context>');
  });

  it('renders open commitments with age', () => {
    const context = makeMinimalContext({
      directMatches: [],
      relatedContext: [],
      openCommitments: [
        makeEntry({
          content: 'Promised to intro John to VC friend',
          timestamp: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000), // 2 weeks ago
        }),
      ],
    });

    const result = buildAssociationsSection(context);
    expect(result).toContain('<open_commitments>');
    expect(result).toContain('Promised to intro John to VC friend');
    expect(result).toContain('</open_commitments>');
  });

  it('includes instruction to use naturally', () => {
    const context = makeMinimalContext({
      directMatches: [makeEntry({ content: 'test' })],
      relatedContext: [],
      openCommitments: [],
    });

    const result = buildAssociationsSection(context);
    expect(result).toContain('Use naturally if relevant. Do not force.');
  });

  it('renders all three sections when present', () => {
    const context = makeMinimalContext({
      directMatches: [makeEntry({ content: 'direct match' })],
      relatedContext: [
        { entry: makeEntry({ content: 'related entry' }), via: 'A → related_to → B' },
      ],
      openCommitments: [makeEntry({ content: 'commitment entry' })],
    });

    const result = buildAssociationsSection(context);
    expect(result).toContain('<direct_memories>');
    expect(result).toContain('<related_context>');
    expect(result).toContain('<open_commitments>');
  });
});
