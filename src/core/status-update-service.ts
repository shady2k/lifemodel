/**
 * StatusUpdateService — handles state transitions for domain memory entries
 * (predictions, opinions, desires, commitments).
 *
 * Extracted from CoreLoop (lines 2363-2654) to reduce monolith size.
 * All 4 methods share the pattern: fetch → update tags → update metadata → save → side effects.
 */

import type { Logger } from '../types/index.js';
import type { MemoryEntry, MemoryProvider } from '../layers/cognition/tools/core/memory.js';
import type { SoulProvider } from '../storage/soul-provider.js';
import type { Precedent } from '../types/agent/soul.js';
import type { ThoughtData } from '../types/signal.js';
import type { ConversationManager } from '../storage/conversation-manager.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StatusUpdateDeps {
  memoryProvider: MemoryProvider;
  logger: Logger;
  soulProvider?: SoulProvider | undefined;
  conversationManager?: ConversationManager | undefined;
  /** Callback to enqueue a thought signal (for prediction reflection) */
  enqueueThought?: ((data: ThoughtData, source: string) => void) | undefined;
}

// ─── Service ──────────────────────────────────────────────────────────────────

/** Validation count threshold for promoting an opinion to a soul precedent */
const OPINION_PROMOTION_THRESHOLD = 3;

export class StatusUpdateService {
  private readonly mp: MemoryProvider;
  private readonly logger: Logger;
  private readonly soulProvider: SoulProvider | undefined;
  private readonly conversationManager: ConversationManager | undefined;
  private readonly enqueueThought:
    | ((data: ThoughtData, source: string) => void)
    | undefined;

  constructor(deps: StatusUpdateDeps) {
    this.mp = deps.memoryProvider;
    this.logger = deps.logger.child({ component: 'status-update' });
    this.soulProvider = deps.soulProvider;
    this.conversationManager = deps.conversationManager;
    this.enqueueThought = deps.enqueueThought;
  }

  // ─── Prediction ───────────────────────────────────────────────────────────

  /**
   * Update prediction status in memory.
   * If prediction is missed, enqueues a reflection thought.
   */
  async updatePredictionStatus(
    predictionId: string,
    outcome: 'confirmed' | 'missed' | 'mixed',
    signaledDuePredictions: Set<string>,
  ): Promise<void> {
    try {
      const prediction = await this.mp.getById(predictionId);
      if (!prediction) {
        this.logger.warn({ predictionId }, 'Prediction not found for status update');
        return;
      }

      const claim = prediction.content;
      const updatedEntry = this.replaceStateTag(prediction, outcome, {
        status: outcome,
        resolvedAt: new Date().toISOString(),
      });

      await this.mp.save(updatedEntry);

      // Clear from due dedup set so it won't block future signals
      signaledDuePredictions.delete(predictionId);

      // If missed, enqueue reflection thought
      if (outcome === 'missed' && this.enqueueThought) {
        const thoughtContent = `My prediction was wrong: "${claim}". What can I learn from this?`;
        this.enqueueThought(
          {
            kind: 'thought',
            content: thoughtContent,
            triggerSource: 'memory',
            depth: 0,
            rootThoughtId: `pred_missed_${predictionId}`,
          },
          'cognition.thought',
        );
        this.logger.info(
          { predictionId, claim },
          'Reflection thought enqueued for missed prediction',
        );
      }
    } catch (err) {
      this.logger.error(
        { predictionId, outcome, error: err instanceof Error ? err.message : String(err) },
        'Failed to update prediction status',
      );
    }
  }

  // ─── Opinion ──────────────────────────────────────────────────────────────

  /**
   * Update opinion status in memory.
   *
   * Tracks validation count: when revised with same-or-higher confidence,
   * it counts as a validation. After reaching the promotion threshold,
   * the opinion is promoted to a soul precedent (case law).
   */
  async updateOpinionStatus(
    opinionId: string,
    newStance?: string,
    newConfidence?: number,
  ): Promise<void> {
    try {
      const opinion = await this.mp.getById(opinionId);
      if (!opinion) {
        this.logger.warn({ opinionId }, 'Opinion not found for status update');
        return;
      }

      const oldConfidence =
        typeof opinion.metadata?.['confidence'] === 'number'
          ? opinion.metadata['confidence']
          : 0.5;
      const oldValidationCount =
        typeof opinion.metadata?.['validationCount'] === 'number'
          ? opinion.metadata['validationCount']
          : 0;

      // A revision with same-or-higher confidence counts as validation
      const isValidation = newConfidence !== undefined && newConfidence >= oldConfidence;
      const newValidationCount = isValidation ? oldValidationCount + 1 : oldValidationCount;

      // Build metadata
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

      await this.mp.save(updatedEntry);

      // Promote to soul precedent if validation threshold reached
      if (
        newValidationCount >= OPINION_PROMOTION_THRESHOLD &&
        oldValidationCount < OPINION_PROMOTION_THRESHOLD &&
        this.soulProvider
      ) {
        const rationale =
          typeof opinion.metadata?.['rationale'] === 'string'
            ? opinion.metadata['rationale']
            : '';

        const precedent: Precedent = {
          id: `prec_${opinionId}`,
          situation: `Forming a view on: ${topic}`,
          choice: stance,
          reasoning:
            rationale ||
            `Validated ${String(newValidationCount)} times through experience`,
          valuesPrioritized: ['honesty', 'informed_judgment'],
          outcome: 'helped',
          binding: false,
          scopeConditions: [`topic:${topic}`],
          createdAt: new Date(),
        };

        await this.soulProvider.addPrecedent(precedent);

        this.logger.info(
          {
            opinionId,
            topic,
            validationCount: newValidationCount,
            precedentId: precedent.id,
          },
          'Opinion promoted to soul precedent (case law)',
        );
      }
    } catch (err) {
      this.logger.error(
        { opinionId, error: err instanceof Error ? err.message : String(err) },
        'Failed to update opinion status',
      );
    }
  }

  // ─── Desire ───────────────────────────────────────────────────────────────

  /**
   * Update desire status in memory.
   */
  async updateDesireStatus(
    desireId: string,
    status: 'active' | 'satisfied' | 'stale' | 'dropped',
    newIntensity?: number,
  ): Promise<void> {
    try {
      const desire = await this.mp.getById(desireId);
      if (!desire) {
        this.logger.warn({ desireId }, 'Desire not found for status update');
        return;
      }

      const extraMeta: Record<string, unknown> = {
        status,
        [`${status}At`]: new Date().toISOString(),
      };
      if (newIntensity !== undefined) extraMeta['intensity'] = newIntensity;

      const updatedEntry = this.replaceStateTag(desire, status, extraMeta);
      await this.mp.save(updatedEntry);
    } catch (err) {
      this.logger.error(
        { desireId, status, error: err instanceof Error ? err.message : String(err) },
        'Failed to update desire status',
      );
    }
  }

  // ─── Commitment ───────────────────────────────────────────────────────────

  /**
   * Update commitment status in memory.
   */
  async updateCommitmentStatus(
    commitmentId: string,
    status: 'kept' | 'breached' | 'repaired' | 'cancelled',
    signaledDueCommitments: Set<string>,
    signaledOverdueCommitments: Set<string>,
    recipientId?: string,
    repairNote?: string,
  ): Promise<void> {
    try {
      const commitment = await this.mp.getById(commitmentId);
      if (!commitment) {
        this.logger.warn({ commitmentId }, 'Commitment not found for status update');
        return;
      }

      const extraMeta: Record<string, unknown> = {
        status,
        [`${status}At`]: new Date().toISOString(),
      };
      if (repairNote) extraMeta['repairNote'] = repairNote;

      const updatedEntry = this.replaceStateTag(commitment, status, extraMeta);
      await this.mp.save(updatedEntry);

      // Clear from dedup sets so it won't block future signals if re-activated
      signaledDueCommitments.delete(commitmentId);
      signaledOverdueCommitments.delete(commitmentId);

      // Record completed action for kept/repaired
      if (
        recipientId &&
        this.conversationManager &&
        (status === 'kept' || status === 'repaired')
      ) {
        const summary = `commitment ${status}: "${commitment.content.slice(0, 30)}..."`;
        this.conversationManager
          .addCompletedAction(recipientId, { tool: 'core.commitment', summary })
          .catch((err: unknown) => {
            this.logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              'Failed to record completed action for commitment update',
            );
          });
      }
    } catch (err) {
      this.logger.error(
        { commitmentId, status, error: err instanceof Error ? err.message : String(err) },
        'Failed to update commitment status',
      );
    }
  }

  // ─── Shared helper ────────────────────────────────────────────────────────

  /**
   * Replace `state:*` tag on a memory entry and merge extra metadata.
   * Common pattern across all 4 status update methods.
   */
  private replaceStateTag(
    entry: MemoryEntry,
    newState: string,
    extraMetadata: Record<string, unknown>,
  ): MemoryEntry {
    const oldTags = entry.tags ?? [];
    const newTags = oldTags.filter((t) => !t.startsWith('state:'));
    newTags.push(`state:${newState}`);

    return {
      ...entry,
      tags: newTags,
      metadata: { ...(entry.metadata ?? {}), ...extraMetadata },
    };
  }
}
