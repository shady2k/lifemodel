/**
 * Characterization tests for CoreLoop tracker scanning logic.
 *
 * Pins behavior of: updateThoughtPressure, updateDesirePressure,
 * checkOverdueCommitments, checkOverduePredictions, pruneSignaledSets
 * before extraction to domain tracker services.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MemoryEntry } from '../../src/layers/cognition/tools/core/memory.js';

// ─── Mock infrastructure ──────────────────────────────────────────────────────

function createMockMemoryProvider() {
  const store = new Map<string, MemoryEntry>();
  return {
    store,
    getById: vi.fn(async (id: string) => store.get(id) ?? null),
    save: vi.fn(async (entry: MemoryEntry) => { store.set(entry.id, entry); }),
    findByKind: vi.fn(async (_kind: string, _opts?: { state?: string; limit?: number }) => {
      return [] as MemoryEntry[];
    }),
    getRecentByType: vi.fn(async (_type: string, _opts?: { windowMs?: number; limit?: number }) => {
      return [] as MemoryEntry[];
    }),
  };
}

interface PushedSignal {
  eventKind: string;
  payload: Record<string, unknown>;
}

// ─── Thought pressure logic (mirrors CoreLoop lines 976-1026) ────────────────

function calculateThoughtPressure(
  thoughts: { timestamp: Date }[],
  energy: number,
): { pressure: number; pendingCount: number } {
  const thoughtCount = thoughts.length;

  let oldestAgeMs = 0;
  if (thoughtCount > 0) {
    const now = Date.now();
    const timestamps = thoughts.map((t) => t.timestamp.getTime());
    const oldest = Math.min(...timestamps);
    oldestAgeMs = now - oldest;
  }

  const countFactor = Math.min(1, thoughtCount / 5);
  const twoHoursMs = 2 * 60 * 60 * 1000;
  const ageFactor = Math.min(1, oldestAgeMs / twoHoursMs);

  const energyAmplifier = 1 + (1 - energy) * 0.3;
  const rawPressure = (countFactor * 0.6 + ageFactor * 0.4) * energyAmplifier;
  const pressure = Math.min(1, rawPressure);

  return { pressure, pendingCount: thoughtCount };
}

// ─── Desire pressure logic (mirrors CoreLoop lines 1037-1075) ────────────────

function calculateDesirePressure(
  activeDesires: { metadata?: Record<string, unknown>; confidence?: number }[],
): number {
  if (activeDesires.length === 0) return 0;

  const intensities = activeDesires.map((e) => {
    const raw = e.metadata?.['intensity'];
    return typeof raw === 'number' ? raw : (e.confidence ?? 0.5);
  });

  const maxIntensity = Math.max(...intensities);
  const countFactor = Math.min(1, activeDesires.length / 5);
  return Math.min(1, maxIntensity * 0.6 + countFactor * 0.4);
}

// ─── Commitment scanning logic (mirrors CoreLoop lines 1095-1199) ────────────

const COMMITMENT_GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

function checkOverdueCommitments(
  activeCommitments: MemoryEntry[],
  signaledDue: Set<string>,
  signaledOverdue: Set<string>,
  primaryRecipientId: string,
): PushedSignal[] {
  const signals: PushedSignal[] = [];
  const now = Date.now();
  const nowDate = new Date(now);

  for (const entry of activeCommitments) {
    const dueAtStr = entry.metadata?.['dueAt'];
    if (typeof dueAtStr !== 'string') continue;

    const dueAt = new Date(dueAtStr);
    if (dueAt > nowDate) continue;

    const recipientId = entry.recipientId ?? primaryRecipientId;
    const msSinceDue = now - dueAt.getTime();

    // Stage 1: due
    if (!signaledDue.has(entry.id)) {
      signals.push({
        eventKind: 'commitment:due',
        payload: {
          commitmentId: entry.id,
          recipientId,
          text: entry.content,
          dueAt: dueAtStr,
        },
      });
      signaledDue.add(entry.id);
      continue; // Don't emit overdue in same scan
    }

    // Stage 2: overdue (after grace period)
    if (msSinceDue >= COMMITMENT_GRACE_PERIOD_MS && !signaledOverdue.has(entry.id)) {
      signals.push({
        eventKind: 'commitment:overdue',
        payload: {
          commitmentId: entry.id,
          recipientId,
          text: entry.content,
          dueAt: dueAtStr,
        },
      });
      signaledOverdue.add(entry.id);
    }
  }

  return signals;
}

// ─── Prediction scanning logic (mirrors CoreLoop lines 1213-1275) ────────────

function checkOverduePredictions(
  pendingPredictions: MemoryEntry[],
  signaledDue: Set<string>,
  primaryRecipientId: string,
): PushedSignal[] {
  const signals: PushedSignal[] = [];
  const nowDate = new Date();

  for (const entry of pendingPredictions) {
    const horizonAtStr = entry.metadata?.['horizonAt'];
    if (typeof horizonAtStr !== 'string') continue;

    const horizonAt = new Date(horizonAtStr);
    if (horizonAt > nowDate) continue;
    if (signaledDue.has(entry.id)) continue;

    signals.push({
      eventKind: 'perspective:prediction_due',
      payload: {
        predictionId: entry.id,
        recipientId: entry.recipientId ?? primaryRecipientId,
        claim: entry.content,
        horizonAt: horizonAtStr,
        confidence: (entry.metadata?.['confidence'] as number | undefined) ?? 0.6,
      },
    });
    signaledDue.add(entry.id);
  }

  return signals;
}

// ─── Dedup pruning logic (mirrors CoreLoop lines 1281-1319) ──────────────────

async function pruneSignaledSets(
  mp: ReturnType<typeof createMockMemoryProvider>,
  sets: Set<string>[],
): Promise<number> {
  let pruned = 0;
  for (const set of sets) {
    for (const id of set) {
      const entry = await mp.getById(id);
      if (!entry) {
        set.delete(id);
        pruned++;
      }
    }
  }
  return pruned;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CoreLoop Trackers (characterization)', () => {
  // ── Thought pressure ──────────────────────────────────────────────────────

  describe('calculateThoughtPressure', () => {
    it('returns 0 pressure with no thoughts', () => {
      const result = calculateThoughtPressure([], 1.0);
      expect(result.pressure).toBe(0);
      expect(result.pendingCount).toBe(0);
    });

    it('pressure increases with thought count (60% weight)', () => {
      const now = Date.now();
      // 3 recent thoughts (count factor = 3/5 = 0.6, age ~0)
      const thoughts = [
        { timestamp: new Date(now - 1000) },
        { timestamp: new Date(now - 2000) },
        { timestamp: new Date(now - 3000) },
      ];

      const result = calculateThoughtPressure(thoughts, 1.0);

      // countFactor = 0.6, ageFactor ≈ 0, energy=1→amplifier=1
      // pressure ≈ 0.6 * 0.6 = 0.36
      expect(result.pressure).toBeGreaterThan(0.3);
      expect(result.pressure).toBeLessThan(0.4);
      expect(result.pendingCount).toBe(3);
    });

    it('pressure increases with thought age (40% weight)', () => {
      const now = Date.now();
      const twoHoursAgo = now - 2 * 60 * 60 * 1000;
      // 1 old thought (count factor = 1/5 = 0.2, age factor = 1.0)
      const thoughts = [{ timestamp: new Date(twoHoursAgo) }];

      const result = calculateThoughtPressure(thoughts, 1.0);

      // countFactor = 0.2, ageFactor = 1.0, amplifier = 1.0
      // pressure = 0.2 * 0.6 + 1.0 * 0.4 = 0.12 + 0.4 = 0.52
      expect(result.pressure).toBeCloseTo(0.52, 1);
    });

    it('low energy amplifies pressure by up to 30%', () => {
      const now = Date.now();
      const thoughts = [
        { timestamp: new Date(now - 1000) },
        { timestamp: new Date(now - 2000) },
      ];

      const highEnergy = calculateThoughtPressure(thoughts, 1.0);
      const lowEnergy = calculateThoughtPressure(thoughts, 0.0);

      // Low energy: amplifier = 1 + (1 - 0) * 0.3 = 1.3
      expect(lowEnergy.pressure).toBeGreaterThan(highEnergy.pressure);
      expect(lowEnergy.pressure / highEnergy.pressure).toBeCloseTo(1.3, 1);
    });

    it('caps count factor at 5 thoughts', () => {
      const now = Date.now();
      const thoughts = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(now - i * 1000),
      }));

      const result = calculateThoughtPressure(thoughts, 1.0);

      // countFactor = min(1, 10/5) = 1.0
      // With 5 or 10 thoughts, countFactor is the same (1.0)
      const fiveThoughts = calculateThoughtPressure(thoughts.slice(0, 5), 1.0);
      // Both have countFactor=1.0, ages differ slightly but very close
      expect(Math.abs(result.pressure - fiveThoughts.pressure)).toBeLessThan(0.05);
    });

    it('caps pressure at 1.0', () => {
      const now = Date.now();
      const veryOld = now - 4 * 60 * 60 * 1000; // 4 hours old
      const thoughts = Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(veryOld + i * 1000),
      }));

      const result = calculateThoughtPressure(thoughts, 0.0);

      // maxed count + maxed age + max amplifier → capped at 1.0
      expect(result.pressure).toBe(1);
    });
  });

  // ── Desire pressure ───────────────────────────────────────────────────────

  describe('calculateDesirePressure', () => {
    it('returns 0 with no active desires', () => {
      expect(calculateDesirePressure([])).toBe(0);
    });

    it('uses intensity from metadata (60% weight)', () => {
      const desires = [
        { metadata: { intensity: 0.8 }, confidence: 0.5 },
      ];

      const pressure = calculateDesirePressure(desires);

      // maxIntensity=0.8, countFactor=1/5=0.2
      // pressure = 0.8*0.6 + 0.2*0.4 = 0.48 + 0.08 = 0.56
      expect(pressure).toBeCloseTo(0.56, 2);
    });

    it('falls back to confidence when intensity missing', () => {
      const desires = [
        { metadata: {}, confidence: 0.9 },
      ];

      const pressure = calculateDesirePressure(desires);

      // maxIntensity=0.9 (from confidence), countFactor=0.2
      // pressure = 0.9*0.6 + 0.2*0.4 = 0.54 + 0.08 = 0.62
      expect(pressure).toBeCloseTo(0.62, 2);
    });

    it('caps count factor at 5 desires', () => {
      const desires = Array.from({ length: 10 }, () => ({
        metadata: { intensity: 0.5 },
        confidence: 0.5,
      }));

      const pressure = calculateDesirePressure(desires);

      // maxIntensity=0.5, countFactor=min(1,10/5)=1.0
      // pressure = 0.5*0.6 + 1.0*0.4 = 0.3 + 0.4 = 0.7
      expect(pressure).toBeCloseTo(0.7, 2);
    });

    it('strongest desire dominates intensity component', () => {
      const desires = [
        { metadata: { intensity: 0.2 } },
        { metadata: { intensity: 0.9 } },
        { metadata: { intensity: 0.3 } },
      ];

      const pressure = calculateDesirePressure(desires);

      // maxIntensity=0.9, countFactor=3/5=0.6
      // pressure = 0.9*0.6 + 0.6*0.4 = 0.54 + 0.24 = 0.78
      expect(pressure).toBeCloseTo(0.78, 2);
    });
  });

  // ── Commitment scanning ───────────────────────────────────────────────────

  describe('checkOverdueCommitments', () => {
    const makeCommitment = (id: string, dueAt: Date, recipientId?: string): MemoryEntry => ({
      id,
      type: 'fact',
      content: `Commitment ${id}`,
      timestamp: new Date(),
      recipientId,
      tags: ['commitment', 'state:active'],
      confidence: 0.9,
      metadata: { kind: 'commitment', dueAt: dueAt.toISOString(), source: 'explicit' },
    });

    it('emits commitment:due for past-due commitments', () => {
      const pastDue = new Date(Date.now() - 60_000); // 1 min ago
      const commitments = [makeCommitment('c1', pastDue)];

      const signals = checkOverdueCommitments(commitments, new Set(), new Set(), 'default_user');

      expect(signals).toHaveLength(1);
      expect(signals[0].eventKind).toBe('commitment:due');
      expect(signals[0].payload['commitmentId']).toBe('c1');
    });

    it('skips future commitments', () => {
      const future = new Date(Date.now() + 86_400_000); // tomorrow
      const commitments = [makeCommitment('c2', future)];

      const signals = checkOverdueCommitments(commitments, new Set(), new Set(), 'default_user');

      expect(signals).toHaveLength(0);
    });

    it('does NOT emit due signal twice (dedup)', () => {
      const pastDue = new Date(Date.now() - 60_000);
      const commitments = [makeCommitment('c3', pastDue)];
      const dueSet = new Set(['c3']); // already signaled

      const signals = checkOverdueCommitments(commitments, dueSet, new Set(), 'default_user');

      // No due signal (already in set), no overdue (not past grace period)
      expect(signals).toHaveLength(0);
    });

    it('emits commitment:overdue after grace period', () => {
      const wayPastDue = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const commitments = [makeCommitment('c4', wayPastDue)];
      const dueSet = new Set(['c4']); // already signaled due

      const signals = checkOverdueCommitments(commitments, dueSet, new Set(), 'default_user');

      expect(signals).toHaveLength(1);
      expect(signals[0].eventKind).toBe('commitment:overdue');
    });

    it('does NOT emit overdue and due in same scan', () => {
      const wayPastDue = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const commitments = [makeCommitment('c5', wayPastDue)];

      // First scan: should emit due only
      const signals = checkOverdueCommitments(commitments, new Set(), new Set(), 'default_user');

      expect(signals).toHaveLength(1);
      expect(signals[0].eventKind).toBe('commitment:due');
    });

    it('uses entry recipientId when available, falls back to primary', () => {
      const pastDue = new Date(Date.now() - 60_000);
      const withRecipient = makeCommitment('c6', pastDue, 'custom_recipient');
      const withoutRecipient = makeCommitment('c7', pastDue);

      const signals = checkOverdueCommitments(
        [withRecipient, withoutRecipient],
        new Set(), new Set(), 'default_user',
      );

      expect(signals[0].payload['recipientId']).toBe('custom_recipient');
      expect(signals[1].payload['recipientId']).toBe('default_user');
    });

    it('skips entries without dueAt metadata', () => {
      const entry: MemoryEntry = {
        id: 'c8',
        type: 'fact',
        content: 'No dueAt',
        timestamp: new Date(),
        tags: ['commitment', 'state:active'],
        metadata: { kind: 'commitment' }, // no dueAt!
      };

      const signals = checkOverdueCommitments([entry], new Set(), new Set(), 'default_user');
      expect(signals).toHaveLength(0);
    });
  });

  // ── Prediction scanning ───────────────────────────────────────────────────

  describe('checkOverduePredictions', () => {
    const makePrediction = (id: string, horizonAt: Date, recipientId?: string): MemoryEntry => ({
      id,
      type: 'fact',
      content: `Prediction ${id}`,
      timestamp: new Date(),
      recipientId,
      tags: ['prediction', 'state:pending'],
      confidence: 0.7,
      metadata: { kind: 'prediction', horizonAt: horizonAt.toISOString(), confidence: 0.7 },
    });

    it('emits prediction_due for past-horizon predictions', () => {
      const past = new Date(Date.now() - 60_000);
      const predictions = [makePrediction('p1', past)];

      const signals = checkOverduePredictions(predictions, new Set(), 'default_user');

      expect(signals).toHaveLength(1);
      expect(signals[0].eventKind).toBe('perspective:prediction_due');
      expect(signals[0].payload['predictionId']).toBe('p1');
    });

    it('skips future predictions', () => {
      const future = new Date(Date.now() + 86_400_000);
      const signals = checkOverduePredictions([makePrediction('p2', future)], new Set(), 'user');

      expect(signals).toHaveLength(0);
    });

    it('deduplicates already-signaled predictions', () => {
      const past = new Date(Date.now() - 60_000);
      const dueSet = new Set(['p3']);

      const signals = checkOverduePredictions([makePrediction('p3', past)], dueSet, 'user');

      expect(signals).toHaveLength(0);
    });

    it('uses default confidence of 0.6 when not in metadata', () => {
      const past = new Date(Date.now() - 60_000);
      const entry: MemoryEntry = {
        id: 'p4',
        type: 'fact',
        content: 'No confidence',
        timestamp: new Date(),
        tags: ['prediction', 'state:pending'],
        metadata: { kind: 'prediction', horizonAt: past.toISOString() }, // no confidence
      };

      const signals = checkOverduePredictions([entry], new Set(), 'user');

      expect(signals[0].payload['confidence']).toBe(0.6);
    });
  });

  // ── Dedup pruning ─────────────────────────────────────────────────────────

  describe('pruneSignaledSets', () => {
    let mp: ReturnType<typeof createMockMemoryProvider>;

    beforeEach(() => {
      mp = createMockMemoryProvider();
    });

    it('removes IDs that no longer exist in memory', async () => {
      // Only 'existing' is in memory
      mp.store.set('existing', {
        id: 'existing',
        type: 'fact',
        content: 'still here',
        timestamp: new Date(),
      });

      const set1 = new Set(['existing', 'gone1']);
      const set2 = new Set(['gone2']);

      const pruned = await pruneSignaledSets(mp, [set1, set2]);

      expect(pruned).toBe(2);
      expect(set1.has('existing')).toBe(true);
      expect(set1.has('gone1')).toBe(false);
      expect(set2.has('gone2')).toBe(false);
    });

    it('returns 0 when all IDs still exist', async () => {
      mp.store.set('a', { id: 'a', type: 'fact', content: 'a', timestamp: new Date() });
      mp.store.set('b', { id: 'b', type: 'fact', content: 'b', timestamp: new Date() });

      const set1 = new Set(['a', 'b']);
      const pruned = await pruneSignaledSets(mp, [set1]);

      expect(pruned).toBe(0);
      expect(set1.size).toBe(2);
    });
  });
});
