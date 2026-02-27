/**
 * DomainTrackerService — scans memory for due commitments, overdue predictions,
 * and calculates desire/thought pressure.
 *
 * Extracted from CoreLoop (lines 976-1335) to reduce monolith size.
 * Each tracker owns its throttle state and dedup sets.
 *
 * Returns signals and state updates to the caller — does NOT push signals
 * or update agent state directly (keeps the service pure).
 */

import type { Signal, SignalSource } from '../types/index.js';
import type { Logger } from '../types/index.js';
import type { MemoryEntry, MemoryProvider } from '../layers/cognition/tools/core/memory.js';
import type { PluginEventData } from '../types/signal.js';
import { createSignal } from '../types/signal.js';
import { Priority } from '../types/index.js';
import { withCaller } from './trace-context.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PressureResult {
  thoughtPressure?: number | undefined;
  pendingThoughtCount?: number | undefined;
  desirePressure?: number | undefined;
}

export interface DomainTrackerDeps {
  memoryProvider: MemoryProvider;
  logger: Logger;
  primaryRecipientId?: string | undefined;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/** Grace period before a due commitment becomes overdue (1 hour) */
const COMMITMENT_GRACE_PERIOD_MS = 60 * 60 * 1000;

export class DomainTrackerService {
  private readonly mp: MemoryProvider;
  private readonly logger: Logger;
  private readonly primaryRecipientId: string;

  // ── Dedup sets (pruned on sleep) ────────────────────────────────────────
  readonly signaledDueCommitments = new Set<string>();
  readonly signaledOverdueCommitments = new Set<string>();
  readonly signaledDuePredictions = new Set<string>();

  // ── Throttle timestamps ─────────────────────────────────────────────────
  private lastDesirePressureCheckAt = 0;
  private lastCommitmentCheckAt = 0;
  private lastPredictionCheckAt = 0;

  constructor(deps: DomainTrackerDeps) {
    this.mp = deps.memoryProvider;
    this.logger = deps.logger.child({ component: 'domain-trackers' });
    this.primaryRecipientId = deps.primaryRecipientId ?? 'default';
  }

  // ─── Thought pressure ─────────────────────────────────────────────────

  /**
   * Calculate thought pressure from recent thoughts and energy level.
   * Returns pressure values to be set on agent state.
   */
  async calculateThoughtPressure(energy: number): Promise<PressureResult> {
    try {
      const windowMs = 30 * 60 * 1000;
      const recentThoughts = await this.mp.getRecentByType('thought', {
        windowMs,
        limit: 20,
      });

      const thoughtCount = recentThoughts.length;

      let oldestAgeMs = 0;
      if (thoughtCount > 0) {
        const now = Date.now();
        const timestamps = recentThoughts.map((t) => t.timestamp.getTime());
        const oldest = Math.min(...timestamps);
        oldestAgeMs = now - oldest;
      }

      const countFactor = Math.min(1, thoughtCount / 5);
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const ageFactor = Math.min(1, oldestAgeMs / twoHoursMs);

      const energyAmplifier = 1 + (1 - energy) * 0.3;
      const rawPressure = (countFactor * 0.6 + ageFactor * 0.4) * energyAmplifier;

      return {
        thoughtPressure: Math.min(1, rawPressure),
        pendingThoughtCount: thoughtCount,
      };
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to update thought pressure',
      );
      return {};
    }
  }

  // ─── Desire pressure ──────────────────────────────────────────────────

  /**
   * Calculate desire pressure from active desires.
   * Throttled to once per 30 seconds. Returns undefined if throttled.
   */
  async calculateDesirePressure(): Promise<PressureResult> {
    const now = Date.now();
    if (now - this.lastDesirePressureCheckAt < 30_000) return {};
    this.lastDesirePressureCheckAt = now;

    try {
      const activeDesires = await withCaller('updateDesirePressure', () =>
        this.mp.findByKind('desire', { state: 'active', limit: 20 }),
      );

      if (activeDesires.length === 0) {
        return { desirePressure: 0 };
      }

      const intensities = activeDesires.map((e) => {
        const raw = e.metadata?.['intensity'];
        return typeof raw === 'number' ? raw : (e.confidence ?? 0.5);
      });

      const maxIntensity = Math.max(...intensities);
      const countFactor = Math.min(1, activeDesires.length / 5);
      return {
        desirePressure: Math.min(1, maxIntensity * 0.6 + countFactor * 0.4),
      };
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to update desire pressure',
      );
      return {};
    }
  }

  // ─── Commitment scanning ──────────────────────────────────────────────

  /**
   * Scan for due and overdue commitments. Returns signals to push.
   * Throttled to once per 60 seconds.
   */
  async checkOverdueCommitments(): Promise<Signal[]> {
    const now = Date.now();
    if (now - this.lastCommitmentCheckAt < 60_000) return [];
    this.lastCommitmentCheckAt = now;

    try {
      const activeCommitments = await withCaller('checkOverdueCommitments', () =>
        this.mp.findByKind('commitment', { state: 'active', limit: 50 }),
      );

      const signals: Signal[] = [];
      const nowDate = new Date();

      for (const entry of activeCommitments) {
        const dueAtStr = entry.metadata?.['dueAt'];
        if (typeof dueAtStr !== 'string') continue;

        const dueAt = new Date(dueAtStr);
        if (dueAt > nowDate) continue;

        const recipientId = entry.recipientId ?? this.primaryRecipientId;
        const msSinceDue = now - dueAt.getTime();

        // Stage 1: commitment:due
        if (!this.signaledDueCommitments.has(entry.id)) {
          signals.push(this.createCommitmentSignal(
            'commitment:due', entry, recipientId, dueAtStr, now,
          ));
          this.signaledDueCommitments.add(entry.id);
          this.logger.info(
            { commitmentId: entry.id, dueAt: dueAtStr, text: entry.content.slice(0, 50) },
            'Commitment due, signal emitted',
          );
          continue; // Don't emit overdue in same scan
        }

        // Stage 2: commitment:overdue (after grace period)
        if (
          msSinceDue >= COMMITMENT_GRACE_PERIOD_MS &&
          !this.signaledOverdueCommitments.has(entry.id)
        ) {
          signals.push(this.createCommitmentSignal(
            'commitment:overdue', entry, recipientId, dueAtStr, now,
          ));
          this.signaledOverdueCommitments.add(entry.id);
          this.logger.info(
            { commitmentId: entry.id, dueAt: dueAtStr, text: entry.content.slice(0, 50) },
            'Overdue commitment detected, signal emitted',
          );
        }
      }

      return signals;
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check overdue commitments',
      );
      return [];
    }
  }

  // ─── Prediction scanning ──────────────────────────────────────────────

  /**
   * Scan for overdue predictions. Returns signals to push.
   * Throttled to once per 60 seconds.
   */
  async checkOverduePredictions(): Promise<Signal[]> {
    const now = Date.now();
    if (now - this.lastPredictionCheckAt < 60_000) return [];
    this.lastPredictionCheckAt = now;

    try {
      const pendingPredictions = await withCaller('checkOverduePredictions', () =>
        this.mp.findByKind('prediction', { state: 'pending', limit: 50 }),
      );

      const signals: Signal[] = [];
      const nowDate = new Date();

      for (const entry of pendingPredictions) {
        const horizonAtStr = entry.metadata?.['horizonAt'];
        if (typeof horizonAtStr !== 'string') continue;

        const horizonAt = new Date(horizonAtStr);
        if (horizonAt > nowDate) continue;
        if (this.signaledDuePredictions.has(entry.id)) continue;

        const signalData: PluginEventData = {
          kind: 'plugin_event',
          eventKind: 'perspective:prediction_due',
          pluginId: 'perspective',
          fireId: `due_${entry.id}_${String(now)}`,
          payload: {
            predictionId: entry.id,
            recipientId: entry.recipientId ?? this.primaryRecipientId,
            claim: entry.content,
            horizonAt: horizonAtStr,
            confidence: (entry.metadata?.['confidence'] as number | undefined) ?? 0.6,
          },
        };

        signals.push(
          createSignal(
            'plugin_event',
            'plugin.perspective' as SignalSource,
            { value: 1, confidence: 1 },
            { data: signalData },
          ),
        );
        this.signaledDuePredictions.add(entry.id);

        this.logger.info(
          { predictionId: entry.id, horizonAt: horizonAtStr, claim: entry.content.slice(0, 50) },
          'Overdue prediction detected, signal emitted',
        );
      }

      return signals;
    } catch (error) {
      this.logger.trace(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to check overdue predictions',
      );
      return [];
    }
  }

  // ─── Dedup pruning ────────────────────────────────────────────────────

  /**
   * Prune dedup sets by removing IDs that no longer exist in memory.
   * Called on sleep transition to prevent unbounded growth.
   */
  async pruneSignaledSets(): Promise<number> {
    let pruned = 0;

    const sets = [
      this.signaledDueCommitments,
      this.signaledOverdueCommitments,
      this.signaledDuePredictions,
    ];

    for (const set of sets) {
      for (const id of set) {
        const entry = await this.mp.getById(id);
        if (!entry) {
          set.delete(id);
          pruned++;
        }
      }
    }

    if (pruned > 0) {
      this.logger.info(
        {
          pruned,
          remaining:
            this.signaledDueCommitments.size +
            this.signaledOverdueCommitments.size +
            this.signaledDuePredictions.size,
        },
        'Pruned stale entries from dedup sets',
      );
    }

    return pruned;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private createCommitmentSignal(
    eventKind: 'commitment:due' | 'commitment:overdue',
    entry: MemoryEntry,
    recipientId: string,
    dueAtStr: string,
    now: number,
  ): Signal {
    const prefix = eventKind === 'commitment:due' ? 'due' : 'overdue';
    const signalData: PluginEventData = {
      kind: 'plugin_event',
      eventKind,
      pluginId: 'commitment',
      fireId: `${prefix}_${entry.id}_${String(now)}`,
      payload: {
        commitmentId: entry.id,
        recipientId,
        text: entry.content,
        dueAt: dueAtStr,
        source: (entry.metadata?.['source'] as string | undefined) ?? 'explicit',
      },
    };

    return createSignal(
      'plugin_event',
      'plugin.commitment' as SignalSource,
      { value: 1, confidence: 1 },
      { priority: Priority.HIGH, data: signalData },
    );
  }
}
