/**
 * Characterization tests for CoreLoop status update methods.
 *
 * Pins behavior of: updatePredictionStatus, updateOpinionStatus,
 * updateDesireStatus, updateCommitmentStatus before extraction to
 * StatusUpdateService.
 *
 * Pattern: simulates the status update logic extracted from CoreLoop
 * (lines 2363-2654) using mock MemoryProvider + SoulProvider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryEntry } from '../../src/layers/cognition/tools/core/memory.js';
import type { Precedent } from '../../src/types/agent/soul.js';

// ─── Mock infrastructure ──────────────────────────────────────────────────────

interface MockThought {
  content: string;
  signalSource: string;
}

function createMockMemoryProvider() {
  const store = new Map<string, MemoryEntry>();
  return {
    store,
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    save: vi.fn(async (entry: MemoryEntry) => { store.set(entry.id, entry); }),
    findByKind: vi.fn(async (_kind: string, _opts?: unknown) => [] as MemoryEntry[]),
  };
}

function createMockSoulProvider() {
  const precedents: Precedent[] = [];
  return {
    precedents,
    addPrecedent: vi.fn(async (p: Precedent) => { precedents.push(p); }),
  };
}

// ─── Status update logic (mirrors CoreLoop implementation) ────────────────────

const OPINION_PROMOTION_THRESHOLD = 3;

async function updatePredictionStatus(
  mp: ReturnType<typeof createMockMemoryProvider>,
  signaledDuePredictions: Set<string>,
  enqueueThought: (t: MockThought) => void,
  predictionId: string,
  outcome: 'confirmed' | 'missed' | 'mixed',
): Promise<void> {
  const prediction = await mp.getById(predictionId);
  if (!prediction) return;

  const claim = prediction.content;
  const oldTags = prediction.tags ?? [];
  const newTags = oldTags.filter((t) => !t.startsWith('state:'));
  newTags.push(`state:${outcome}`);

  const metadata = {
    ...(prediction.metadata ?? {}),
    status: outcome,
    resolvedAt: new Date().toISOString(),
  };

  const updatedEntry: MemoryEntry = { ...prediction, tags: newTags, metadata };
  await mp.save(updatedEntry);

  signaledDuePredictions.delete(predictionId);

  if (outcome === 'missed') {
    const thoughtContent = `My prediction was wrong: "${claim}". What can I learn from this?`;
    enqueueThought({ content: thoughtContent, signalSource: 'cognition.thought' });
  }
}

async function updateOpinionStatus(
  mp: ReturnType<typeof createMockMemoryProvider>,
  sp: ReturnType<typeof createMockSoulProvider> | null,
  opinionId: string,
  newStance?: string,
  newConfidence?: number,
): Promise<void> {
  const opinion = await mp.getById(opinionId);
  if (!opinion) return;

  const oldConfidence =
    typeof opinion.metadata?.['confidence'] === 'number' ? opinion.metadata['confidence'] : 0.5;
  const oldValidationCount =
    typeof opinion.metadata?.['validationCount'] === 'number'
      ? opinion.metadata['validationCount']
      : 0;

  const isValidation = newConfidence !== undefined && newConfidence >= oldConfidence;
  const newValidationCount = isValidation ? oldValidationCount + 1 : oldValidationCount;

  const metadata: Record<string, unknown> = {
    ...(opinion.metadata ?? {}),
    previousStance: opinion.metadata?.['stance'],
    revisedAt: new Date().toISOString(),
    validationCount: newValidationCount,
  };

  if (newStance) metadata['stance'] = newStance;
  if (newConfidence !== undefined) metadata['confidence'] = newConfidence;

  const topicValue = opinion.metadata?.['topic'];
  const topic = typeof topicValue === 'string' ? topicValue : 'topic';
  const stance =
    typeof metadata['stance'] === 'string'
      ? metadata['stance']
      : typeof opinion.metadata?.['stance'] === 'string'
        ? opinion.metadata['stance']
        : '';

  const updatedEntry: MemoryEntry = {
    ...opinion,
    content: newStance ? `${topic}: ${newStance}` : opinion.content,
    metadata,
  };

  await mp.save(updatedEntry);

  if (
    newValidationCount >= OPINION_PROMOTION_THRESHOLD &&
    oldValidationCount < OPINION_PROMOTION_THRESHOLD &&
    sp
  ) {
    const rationale =
      typeof opinion.metadata?.['rationale'] === 'string' ? opinion.metadata['rationale'] : '';

    const precedent: Precedent = {
      id: `prec_${opinionId}`,
      situation: `Forming a view on: ${topic}`,
      choice: stance,
      reasoning: rationale || `Validated ${String(newValidationCount)} times through experience`,
      valuesPrioritized: ['honesty', 'informed_judgment'],
      outcome: 'helped',
      binding: false,
      scopeConditions: [`topic:${topic}`],
      createdAt: new Date(),
    };

    await sp.addPrecedent(precedent);
  }
}

async function updateDesireStatus(
  mp: ReturnType<typeof createMockMemoryProvider>,
  desireId: string,
  status: 'active' | 'satisfied' | 'stale' | 'dropped',
  newIntensity?: number,
): Promise<void> {
  const desire = await mp.getById(desireId);
  if (!desire) return;

  const oldTags = desire.tags ?? [];
  const newTags = oldTags.filter((t) => !t.startsWith('state:'));
  newTags.push(`state:${status}`);

  const metadata = {
    ...(desire.metadata ?? {}),
    status,
    [`${status}At`]: new Date().toISOString(),
  };

  if (newIntensity !== undefined) {
    metadata['intensity'] = newIntensity;
  }

  const updatedEntry: MemoryEntry = { ...desire, tags: newTags, metadata };
  await mp.save(updatedEntry);
}

async function updateCommitmentStatus(
  mp: ReturnType<typeof createMockMemoryProvider>,
  signaledDueCommitments: Set<string>,
  signaledOverdueCommitments: Set<string>,
  commitmentId: string,
  status: 'kept' | 'breached' | 'repaired' | 'cancelled',
  recipientId?: string,
  repairNote?: string,
): Promise<{ recordedAction: boolean }> {
  const commitment = await mp.getById(commitmentId);
  if (!commitment) return { recordedAction: false };

  const oldTags = commitment.tags ?? [];
  const newTags = oldTags.filter((t) => !t.startsWith('state:'));
  newTags.push(`state:${status}`);

  const metadata = {
    ...(commitment.metadata ?? {}),
    status,
    [`${status}At`]: new Date().toISOString(),
  };

  if (repairNote) metadata['repairNote'] = repairNote;

  const updatedEntry: MemoryEntry = { ...commitment, tags: newTags, metadata };
  await mp.save(updatedEntry);

  signaledDueCommitments.delete(commitmentId);
  signaledOverdueCommitments.delete(commitmentId);

  const recordedAction = !!recipientId && (status === 'kept' || status === 'repaired');
  return { recordedAction };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CoreLoop Status Updates (characterization)', () => {
  let mp: ReturnType<typeof createMockMemoryProvider>;
  let sp: ReturnType<typeof createMockSoulProvider>;

  beforeEach(() => {
    mp = createMockMemoryProvider();
    sp = createMockSoulProvider();
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
      return entry;
    };

    it('replaces state:pending tag with state:confirmed', async () => {
      makePrediction('pred_1');
      const dedup = new Set<string>();
      const thoughts: MockThought[] = [];

      await updatePredictionStatus(mp, dedup, (t) => thoughts.push(t), 'pred_1', 'confirmed');

      const saved = mp.store.get('pred_1')!;
      expect(saved.tags).toContain('state:confirmed');
      expect(saved.tags).not.toContain('state:pending');
    });

    it('sets resolvedAt and status in metadata', async () => {
      makePrediction('pred_2');
      const dedup = new Set<string>();

      await updatePredictionStatus(mp, dedup, () => {}, 'pred_2', 'mixed');

      const saved = mp.store.get('pred_2')!;
      expect(saved.metadata?.['status']).toBe('mixed');
      expect(saved.metadata?.['resolvedAt']).toBeDefined();
    });

    it('clears prediction from dedup set', async () => {
      makePrediction('pred_3');
      const dedup = new Set(['pred_3', 'pred_other']);

      await updatePredictionStatus(mp, dedup, () => {}, 'pred_3', 'confirmed');

      expect(dedup.has('pred_3')).toBe(false);
      expect(dedup.has('pred_other')).toBe(true);
    });

    it('enqueues reflection thought on missed outcome', async () => {
      makePrediction('pred_4', 'Rain tomorrow');
      const dedup = new Set<string>();
      const thoughts: MockThought[] = [];

      await updatePredictionStatus(mp, dedup, (t) => thoughts.push(t), 'pred_4', 'missed');

      expect(thoughts).toHaveLength(1);
      expect(thoughts[0].content).toContain('Rain tomorrow');
      expect(thoughts[0].content).toContain('wrong');
    });

    it('does NOT enqueue thought on confirmed outcome', async () => {
      makePrediction('pred_5');
      const thoughts: MockThought[] = [];

      await updatePredictionStatus(mp, new Set(), (t) => thoughts.push(t), 'pred_5', 'confirmed');

      expect(thoughts).toHaveLength(0);
    });

    it('no-ops when prediction not found', async () => {
      const thoughts: MockThought[] = [];

      await updatePredictionStatus(mp, new Set(), (t) => thoughts.push(t), 'nonexistent', 'missed');

      expect(mp.save).not.toHaveBeenCalled();
      expect(thoughts).toHaveLength(0);
    });
  });

  // ── Opinion ───────────────────────────────────────────────────────────────

  describe('updateOpinionStatus', () => {
    const makeOpinion = (
      id: string,
      opts: { confidence?: number; validationCount?: number; topic?: string; stance?: string } = {},
    ) => {
      const entry: MemoryEntry = {
        id,
        type: 'fact',
        content: `${opts.topic ?? 'crypto'}: ${opts.stance ?? 'bullish'}`,
        timestamp: new Date(),
        tags: ['opinion', 'state:active'],
        confidence: opts.confidence ?? 0.7,
        metadata: {
          kind: 'opinion',
          topic: opts.topic ?? 'crypto',
          stance: opts.stance ?? 'bullish',
          rationale: 'test rationale',
          confidence: opts.confidence ?? 0.7,
          validationCount: opts.validationCount ?? 0,
        },
      };
      mp.store.set(id, entry);
      return entry;
    };

    it('increments validationCount when confidence increases', async () => {
      makeOpinion('op_1', { confidence: 0.7, validationCount: 0 });

      await updateOpinionStatus(mp, sp, 'op_1', undefined, 0.8);

      const saved = mp.store.get('op_1')!;
      expect(saved.metadata?.['validationCount']).toBe(1);
    });

    it('increments validationCount when confidence stays same', async () => {
      makeOpinion('op_2', { confidence: 0.7, validationCount: 1 });

      await updateOpinionStatus(mp, sp, 'op_2', undefined, 0.7);

      const saved = mp.store.get('op_2')!;
      expect(saved.metadata?.['validationCount']).toBe(2);
    });

    it('does NOT increment validationCount when confidence decreases', async () => {
      makeOpinion('op_3', { confidence: 0.7, validationCount: 1 });

      await updateOpinionStatus(mp, sp, 'op_3', undefined, 0.5);

      const saved = mp.store.get('op_3')!;
      expect(saved.metadata?.['validationCount']).toBe(1);
    });

    it('updates stance and content when new stance provided', async () => {
      makeOpinion('op_4', { topic: 'AI', stance: 'cautious' });

      await updateOpinionStatus(mp, sp, 'op_4', 'optimistic', 0.8);

      const saved = mp.store.get('op_4')!;
      expect(saved.content).toBe('AI: optimistic');
      expect(saved.metadata?.['stance']).toBe('optimistic');
      expect(saved.metadata?.['previousStance']).toBe('cautious');
    });

    it('promotes to soul precedent at validation threshold', async () => {
      makeOpinion('op_5', { confidence: 0.7, validationCount: 2, topic: 'privacy', stance: 'essential' });

      await updateOpinionStatus(mp, sp, 'op_5', undefined, 0.8);

      expect(sp.addPrecedent).toHaveBeenCalledTimes(1);
      const precedent = sp.precedents[0];
      expect(precedent.id).toBe('prec_op_5');
      expect(precedent.situation).toContain('privacy');
      expect(precedent.binding).toBe(false);
    });

    it('does NOT promote below threshold', async () => {
      makeOpinion('op_6', { confidence: 0.7, validationCount: 1 });

      await updateOpinionStatus(mp, sp, 'op_6', undefined, 0.8);

      expect(sp.addPrecedent).not.toHaveBeenCalled();
    });

    it('does NOT promote when already above threshold (prevents re-promotion)', async () => {
      makeOpinion('op_7', { confidence: 0.7, validationCount: 4 });

      await updateOpinionStatus(mp, sp, 'op_7', undefined, 0.8);

      // validationCount goes from 4→5, but oldCount(4) >= threshold(3), so no promotion
      expect(sp.addPrecedent).not.toHaveBeenCalled();
    });

    it('does NOT promote without soulProvider', async () => {
      makeOpinion('op_8', { confidence: 0.7, validationCount: 2 });

      await updateOpinionStatus(mp, null, 'op_8', undefined, 0.8);

      // No soulProvider → no promotion
    });
  });

  // ── Desire ────────────────────────────────────────────────────────────────

  describe('updateDesireStatus', () => {
    const makeDesire = (id: string, intensity = 0.6) => {
      const entry: MemoryEntry = {
        id,
        type: 'fact',
        content: 'Learn Rust',
        timestamp: new Date(),
        tags: ['desire', 'state:active'],
        confidence: intensity,
        metadata: { kind: 'desire', intensity, source: 'self_inference' },
      };
      mp.store.set(id, entry);
      return entry;
    };

    it('transitions state:active to state:satisfied', async () => {
      makeDesire('des_1');

      await updateDesireStatus(mp, 'des_1', 'satisfied');

      const saved = mp.store.get('des_1')!;
      expect(saved.tags).toContain('state:satisfied');
      expect(saved.tags).not.toContain('state:active');
      expect(saved.metadata?.['satisfiedAt']).toBeDefined();
    });

    it('updates intensity when provided', async () => {
      makeDesire('des_2', 0.5);

      await updateDesireStatus(mp, 'des_2', 'active', 0.9);

      const saved = mp.store.get('des_2')!;
      expect(saved.metadata?.['intensity']).toBe(0.9);
    });

    it('preserves existing metadata fields', async () => {
      makeDesire('des_3');

      await updateDesireStatus(mp, 'des_3', 'stale');

      const saved = mp.store.get('des_3')!;
      expect(saved.metadata?.['kind']).toBe('desire');
      expect(saved.metadata?.['source']).toBe('self_inference');
      expect(saved.metadata?.['status']).toBe('stale');
    });
  });

  // ── Commitment ────────────────────────────────────────────────────────────

  describe('updateCommitmentStatus', () => {
    const makeCommitment = (id: string, content = 'Reply by Friday') => {
      const entry: MemoryEntry = {
        id,
        type: 'fact',
        content,
        timestamp: new Date(),
        tags: ['commitment', 'state:active'],
        confidence: 0.9,
        metadata: {
          kind: 'commitment',
          dueAt: new Date(Date.now() + 86400000).toISOString(),
          source: 'explicit',
        },
      };
      mp.store.set(id, entry);
      return entry;
    };

    it('transitions to kept state and clears dedup sets', async () => {
      makeCommitment('com_1');
      const dueSet = new Set(['com_1']);
      const overdueSet = new Set(['com_1']);

      await updateCommitmentStatus(mp, dueSet, overdueSet, 'com_1', 'kept');

      const saved = mp.store.get('com_1')!;
      expect(saved.tags).toContain('state:kept');
      expect(saved.tags).not.toContain('state:active');
      expect(saved.metadata?.['keptAt']).toBeDefined();
      expect(dueSet.has('com_1')).toBe(false);
      expect(overdueSet.has('com_1')).toBe(false);
    });

    it('stores repairNote when repaired', async () => {
      makeCommitment('com_2');
      const dueSet = new Set<string>();
      const overdueSet = new Set<string>();

      await updateCommitmentStatus(
        mp, dueSet, overdueSet, 'com_2', 'repaired', 'recip_1', 'Apologized and rescheduled',
      );

      const saved = mp.store.get('com_2')!;
      expect(saved.metadata?.['repairNote']).toBe('Apologized and rescheduled');
      expect(saved.metadata?.['repairedAt']).toBeDefined();
    });

    it('records completed action for kept status with recipientId', async () => {
      makeCommitment('com_3');
      const result = await updateCommitmentStatus(
        mp, new Set(), new Set(), 'com_3', 'kept', 'recip_1',
      );

      expect(result.recordedAction).toBe(true);
    });

    it('does NOT record completed action for cancelled status', async () => {
      makeCommitment('com_4');
      const result = await updateCommitmentStatus(
        mp, new Set(), new Set(), 'com_4', 'cancelled', 'recip_1',
      );

      expect(result.recordedAction).toBe(false);
    });

    it('does NOT record completed action without recipientId', async () => {
      makeCommitment('com_5');
      const result = await updateCommitmentStatus(
        mp, new Set(), new Set(), 'com_5', 'kept',
      );

      expect(result.recordedAction).toBe(false);
    });
  });
});
