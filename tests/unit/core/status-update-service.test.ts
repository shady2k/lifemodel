/**
 * Unit tests for StatusUpdateService.
 *
 * Tests the extracted service directly (not CoreLoop simulation).
 * Validates the same behavior as core-loop-status-updates.test.ts
 * but against the real service implementation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StatusUpdateService } from '../../../src/core/status-update-service.js';
import type { MemoryEntry } from '../../../src/layers/cognition/tools/core/memory.js';
import type { ThoughtData } from '../../../src/types/signal.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function createMockMemoryProvider() {
  const store = new Map<string, MemoryEntry>();
  return {
    store,
    search: vi.fn(),
    save: vi.fn(async (entry: MemoryEntry) => { store.set(entry.id, entry); }),
    getRecent: vi.fn().mockResolvedValue([]),
    getRecentByType: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    getBehaviorRules: vi.fn().mockResolvedValue([]),
    findByKind: vi.fn().mockResolvedValue([]),
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    getAll: vi.fn().mockResolvedValue([]),
    getStats: vi.fn().mockResolvedValue({ totalEntries: 0 }),
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    fatal: vi.fn(),
  };
}

function createMockSoulProvider() {
  const precedents: unknown[] = [];
  return {
    getSoul: vi.fn().mockResolvedValue(null),
    saveSoul: vi.fn(),
    addPrecedent: vi.fn(async (p: unknown) => { precedents.push(p); }),
    precedents,
  };
}

function createMockConversationManager() {
  return {
    addCompletedAction: vi.fn().mockResolvedValue(undefined),
    addMessage: vi.fn(),
    getHistory: vi.fn(),
    getStatus: vi.fn(),
    setStatus: vi.fn(),
    getLastAssistantMessage: vi.fn(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('StatusUpdateService', () => {
  let mp: ReturnType<typeof createMockMemoryProvider>;
  let logger: ReturnType<typeof createMockLogger>;
  let soulProvider: ReturnType<typeof createMockSoulProvider>;
  let conversationManager: ReturnType<typeof createMockConversationManager>;
  let enqueuedThoughts: Array<{ data: ThoughtData; source: string }>;
  let service: StatusUpdateService;

  beforeEach(() => {
    mp = createMockMemoryProvider();
    logger = createMockLogger();
    soulProvider = createMockSoulProvider();
    conversationManager = createMockConversationManager();
    enqueuedThoughts = [];

    service = new StatusUpdateService({
      memoryProvider: mp as never,
      logger: logger as never,
      soulProvider: soulProvider as never,
      conversationManager: conversationManager as never,
      enqueueThought: (data, source) => { enqueuedThoughts.push({ data, source }); },
    });
  });

  // ── Prediction ────────────────────────────────────────────────────────────

  describe('updatePredictionStatus', () => {
    const makePrediction = (id: string, content = 'BTC will hit 100k') => {
      const entry: MemoryEntry = {
        id,
        type: 'fact',
        content,
        timestamp: new Date(),
        tags: ['prediction', 'state:pending'],
        confidence: 0.7,
        metadata: { kind: 'prediction', claim: content, status: 'pending' },
      };
      mp.store.set(id, entry);
    };

    it('replaces state tag and sets metadata', async () => {
      makePrediction('pred_1');
      const dedup = new Set<string>();

      await service.updatePredictionStatus('pred_1', 'confirmed', dedup);

      const saved = mp.store.get('pred_1')!;
      expect(saved.tags).toContain('state:confirmed');
      expect(saved.tags).not.toContain('state:pending');
      expect(saved.metadata?.['resolvedAt']).toBeDefined();
    });

    it('clears dedup set entry', async () => {
      makePrediction('pred_2');
      const dedup = new Set(['pred_2', 'other']);

      await service.updatePredictionStatus('pred_2', 'confirmed', dedup);

      expect(dedup.has('pred_2')).toBe(false);
      expect(dedup.has('other')).toBe(true);
    });

    it('enqueues reflection thought on missed outcome', async () => {
      makePrediction('pred_3', 'Rain tomorrow');
      const dedup = new Set<string>();

      await service.updatePredictionStatus('pred_3', 'missed', dedup);

      expect(enqueuedThoughts).toHaveLength(1);
      expect(enqueuedThoughts[0].data.content).toContain('Rain tomorrow');
      expect(enqueuedThoughts[0].data.content).toContain('wrong');
      expect(enqueuedThoughts[0].source).toBe('cognition.thought');
    });

    it('no-ops for missing prediction', async () => {
      await service.updatePredictionStatus('nonexistent', 'missed', new Set());
      expect(mp.save).not.toHaveBeenCalled();
    });
  });

  // ── Opinion ───────────────────────────────────────────────────────────────

  describe('updateOpinionStatus', () => {
    const makeOpinion = (
      id: string,
      opts: { confidence?: number; validationCount?: number; topic?: string } = {},
    ) => {
      const entry: MemoryEntry = {
        id,
        type: 'fact',
        content: `${opts.topic ?? 'crypto'}: bullish`,
        timestamp: new Date(),
        tags: ['opinion', 'state:active'],
        metadata: {
          kind: 'opinion',
          topic: opts.topic ?? 'crypto',
          stance: 'bullish',
          rationale: 'test',
          confidence: opts.confidence ?? 0.7,
          validationCount: opts.validationCount ?? 0,
        },
      };
      mp.store.set(id, entry);
    };

    it('increments validationCount on same-or-higher confidence', async () => {
      makeOpinion('op_1', { confidence: 0.7, validationCount: 0 });

      await service.updateOpinionStatus('op_1', undefined, 0.8);

      expect(mp.store.get('op_1')!.metadata?.['validationCount']).toBe(1);
    });

    it('promotes to soul precedent at threshold', async () => {
      makeOpinion('op_2', { confidence: 0.7, validationCount: 2, topic: 'privacy' });

      await service.updateOpinionStatus('op_2', undefined, 0.8);

      expect(soulProvider.addPrecedent).toHaveBeenCalledTimes(1);
      const call = soulProvider.addPrecedent.mock.calls[0][0] as { id: string; binding: boolean };
      expect(call.id).toBe('prec_op_2');
      expect(call.binding).toBe(false);
    });

    it('does not re-promote above threshold', async () => {
      makeOpinion('op_3', { confidence: 0.7, validationCount: 5 });

      await service.updateOpinionStatus('op_3', undefined, 0.8);

      expect(soulProvider.addPrecedent).not.toHaveBeenCalled();
    });
  });

  // ── Desire ────────────────────────────────────────────────────────────────

  describe('updateDesireStatus', () => {
    it('transitions state tag and sets timestamp', async () => {
      mp.store.set('des_1', {
        id: 'des_1',
        type: 'fact',
        content: 'Learn Rust',
        timestamp: new Date(),
        tags: ['desire', 'state:active'],
        metadata: { kind: 'desire', intensity: 0.6 },
      });

      await service.updateDesireStatus('des_1', 'satisfied');

      const saved = mp.store.get('des_1')!;
      expect(saved.tags).toContain('state:satisfied');
      expect(saved.metadata?.['satisfiedAt']).toBeDefined();
    });

    it('updates intensity when provided', async () => {
      mp.store.set('des_2', {
        id: 'des_2',
        type: 'fact',
        content: 'Travel',
        timestamp: new Date(),
        tags: ['desire', 'state:active'],
        metadata: { kind: 'desire', intensity: 0.3 },
      });

      await service.updateDesireStatus('des_2', 'active', 0.9);

      expect(mp.store.get('des_2')!.metadata?.['intensity']).toBe(0.9);
    });
  });

  // ── Commitment ────────────────────────────────────────────────────────────

  describe('updateCommitmentStatus', () => {
    const makeCommitment = (id: string) => {
      mp.store.set(id, {
        id,
        type: 'fact',
        content: 'Reply by Friday',
        timestamp: new Date(),
        tags: ['commitment', 'state:active'],
        metadata: { kind: 'commitment', dueAt: new Date().toISOString() },
      });
    };

    it('clears both dedup sets', async () => {
      makeCommitment('com_1');
      const dueSet = new Set(['com_1']);
      const overdueSet = new Set(['com_1']);

      await service.updateCommitmentStatus('com_1', 'kept', dueSet, overdueSet);

      expect(dueSet.has('com_1')).toBe(false);
      expect(overdueSet.has('com_1')).toBe(false);
    });

    it('records completed action for kept with recipientId', async () => {
      makeCommitment('com_2');

      await service.updateCommitmentStatus(
        'com_2', 'kept', new Set(), new Set(), 'recip_1',
      );

      expect(conversationManager.addCompletedAction).toHaveBeenCalledWith(
        'recip_1',
        expect.objectContaining({ tool: 'core.commitment' }),
      );
    });

    it('stores repairNote', async () => {
      makeCommitment('com_3');

      await service.updateCommitmentStatus(
        'com_3', 'repaired', new Set(), new Set(), 'recip_1', 'Sorry, rescheduled',
      );

      expect(mp.store.get('com_3')!.metadata?.['repairNote']).toBe('Sorry, rescheduled');
    });

    it('does NOT record action for cancelled', async () => {
      makeCommitment('com_4');

      await service.updateCommitmentStatus(
        'com_4', 'cancelled', new Set(), new Set(), 'recip_1',
      );

      expect(conversationManager.addCompletedAction).not.toHaveBeenCalled();
    });
  });
});
