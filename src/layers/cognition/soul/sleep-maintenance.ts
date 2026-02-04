/**
 * Soul Sleep Maintenance
 *
 * Runs during sleep/low-activity periods to perform maintenance tasks:
 * - Partial refresh of Parliament voice budgets
 * - Promote soft learning items that have accumulated enough evidence
 * - Mark very old resolved thoughts for natural pruning
 *
 * Philosophy: Like human sleep, this is when the system processes
 * accumulated experience without the pressure of real-time interaction.
 */

import type { Logger } from '../../../types/logger.js';
import type { SoulProvider } from '../../../storage/soul-provider.js';
import type { MemoryProvider, MemoryEntry } from '../tools/registry.js';

/**
 * Dependencies for sleep maintenance.
 */
export interface SleepMaintenanceDeps {
  logger: Logger;
  soulProvider: SoulProvider;
  memoryProvider: MemoryProvider;
}

/**
 * Configuration for sleep maintenance.
 */
export interface SleepMaintenanceConfig {
  /** Fraction of voice budget to restore during sleep (0-1) */
  voiceBudgetRefreshFraction: number;
  /** Age in hours after which resolved thoughts can be pruned */
  resolvedThoughtMaxAgeHours: number;
  /** Maximum number of thoughts to process per maintenance cycle */
  maxThoughtsToProcess: number;
}

const DEFAULT_CONFIG: SleepMaintenanceConfig = {
  voiceBudgetRefreshFraction: 0.3, // Restore 30% of voice budgets during sleep
  resolvedThoughtMaxAgeHours: 72, // 3 days
  maxThoughtsToProcess: 50,
};

/**
 * Result of sleep maintenance.
 */
export interface SleepMaintenanceResult {
  /** Whether maintenance ran successfully */
  success: boolean;
  /** Number of voice budgets refreshed */
  voicesRefreshed: number;
  /** Number of soft learning items promoted to thoughts */
  softLearningPromoted: number;
  /** Number of old resolved thoughts marked for pruning */
  thoughtsMarkedForPruning: number;
  /** Duration of maintenance in ms */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Run sleep maintenance on the soul system.
 *
 * Called by CoreLoop when entering sleep mode, alongside memory consolidation.
 * This is the "slow path" processing that happens during quiet periods.
 *
 * @param deps Dependencies
 * @param config Optional configuration overrides
 * @returns Result of maintenance operations
 */
export async function runSleepMaintenance(
  deps: SleepMaintenanceDeps,
  config: Partial<SleepMaintenanceConfig> = {}
): Promise<SleepMaintenanceResult> {
  const startTime = Date.now();
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { logger, soulProvider, memoryProvider } = deps;
  const log = logger.child({ component: 'soul-sleep-maintenance' });

  log.info('Starting soul sleep maintenance');

  try {
    // 1. Refresh voice budgets (partial)
    const voicesRefreshed = await refreshVoiceBudgets(soulProvider, cfg.voiceBudgetRefreshFraction);
    log.debug(
      { voicesRefreshed, fraction: cfg.voiceBudgetRefreshFraction },
      'Voice budgets refreshed'
    );

    // 2. Promote soft learning items that have accumulated enough evidence
    const promotedItems = await soulProvider.promoteSoftLearning();
    const softLearningPromoted = promotedItems.length;

    // Create reflection thoughts for promoted items
    for (const item of promotedItems) {
      await createPromotedReflectionThought(memoryProvider, item, log);
    }
    if (softLearningPromoted > 0) {
      log.info({ softLearningPromoted }, 'Soft learning items promoted to reflection thoughts');
    }

    // 3. Decay soft learning (runs automatically on any SoulProvider write,
    //    but run explicitly here to ensure maintenance happens)
    await soulProvider.decaySoftLearning();

    // 4. Mark very old resolved thoughts for natural pruning
    const thoughtsMarkedForPruning = await markOldResolvedThoughts(
      memoryProvider,
      cfg.resolvedThoughtMaxAgeHours,
      cfg.maxThoughtsToProcess,
      log
    );

    // 5. Update health metrics from memory (recompute openWoundCount)
    await soulProvider.computeHealthFromMemory(async () => {
      const unresolvedThoughts = await memoryProvider.getRecentByType('thought', {
        windowMs: 30 * 24 * 60 * 60 * 1000, // 30 days
        limit: 100,
      });
      return unresolvedThoughts.filter(
        (t) => t.tags && t.tags.includes('soul:reflection') && t.tags.includes('state:unresolved')
      ).length;
    });

    const durationMs = Date.now() - startTime;

    log.info(
      {
        voicesRefreshed,
        softLearningPromoted,
        thoughtsMarkedForPruning,
        durationMs,
      },
      'Soul sleep maintenance completed'
    );

    return {
      success: true,
      voicesRefreshed,
      softLearningPromoted,
      thoughtsMarkedForPruning,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ error: errorMsg, durationMs }, 'Soul sleep maintenance failed');

    return {
      success: false,
      voicesRefreshed: 0,
      softLearningPromoted: 0,
      thoughtsMarkedForPruning: 0,
      durationMs,
      error: errorMsg,
    };
  }
}

/**
 * Refresh Parliament voice budgets by a fraction.
 *
 * Unlike the midnight reset (which restores 100%), sleep refresh
 * partially replenishes budgets. This models "rest" rather than
 * a full new day.
 *
 * @returns Number of voices whose budgets were refreshed
 */
async function refreshVoiceBudgets(soulProvider: SoulProvider, fraction: number): Promise<number> {
  const state = await soulProvider.getState();
  let refreshed = 0;

  for (const voice of state.parliament.voices) {
    if (voice.budget) {
      const maxBudget = voice.budget.attentionTokensPerDay;
      const current = voice.budget.remaining;
      const toRestore = Math.floor((maxBudget - current) * fraction);

      if (toRestore > 0) {
        voice.budget.remaining = Math.min(maxBudget, current + toRestore);
        await soulProvider.updateVoice(voice.id, { budget: voice.budget });
        refreshed++;
      }
    }
  }

  return refreshed;
}

/**
 * Create a reflection thought from a promoted soft learning item.
 *
 * When borderline issues (dissonance 4-6) repeat enough times,
 * they get promoted to a real reflection thought for Parliament deliberation.
 */
async function createPromotedReflectionThought(
  memoryProvider: MemoryProvider,
  item: Awaited<ReturnType<SoulProvider['promoteSoftLearning']>>[0],
  logger: Logger
): Promise<void> {
  const content = `A recurring pattern of borderline dissonance has been observed.

Pattern: ${item.triggerSummary}
Response snippet: "${item.responseSnippet}"
Reasoning: ${item.reasoning}
${item.aspect ? `Aspect: ${item.aspect}` : ''}

This has been observed ${String(item.count)} times with accumulated weight ${item.weight.toFixed(2)}.
Original dissonance score: ${String(item.dissonance)}/10 (borderline, now promoted due to repetition).

This warrants deliberation: Is this a pattern that should inform identity, or noise to ignore?`;

  const thought: MemoryEntry = {
    id: `soul_promoted_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'thought',
    content,
    timestamp: new Date(),
    tags: ['soul:reflection', 'state:unresolved', 'promoted'],
    confidence: 0.7, // Surrogate dissonance 7 for promoted items
    recipientId: item.source.recipientId,
    tickId: item.source.tickId,
    metadata: {
      originalDissonance: item.dissonance,
      observationCount: item.count,
      softLearningKey: item.key,
      promotedFromSoftLearning: true,
    },
  };

  await memoryProvider.save(thought);
  logger.info(
    { thoughtId: thought.id, count: item.count },
    'Promoted soft learning to reflection thought'
  );
}

/**
 * Mark very old resolved thoughts for natural pruning.
 *
 * Resolved soul thoughts older than the threshold get their tags updated
 * to allow them to be pruned by normal memory maintenance.
 *
 * The tag 'soul:can-prune' signals that the thought has been fully processed
 * and can be safely removed when memory is full.
 *
 * @returns Number of thoughts marked for pruning
 */
async function markOldResolvedThoughts(
  memoryProvider: MemoryProvider,
  maxAgeHours: number,
  maxToProcess: number,
  logger: Logger
): Promise<number> {
  // Get recent thoughts (includes resolved ones)
  const windowMs = (maxAgeHours + 24) * 60 * 60 * 1000; // Extra day buffer
  const thoughts = await memoryProvider.getRecentByType('thought', {
    windowMs,
    limit: maxToProcess * 2, // Get more to filter
  });

  const cutoffTime = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let marked = 0;

  for (const thought of thoughts) {
    // Skip if not a resolved soul thought
    if (!thought.tags?.includes('state:resolved')) continue;
    // After the above check, we know thought.tags is defined
    if (!thought.tags.some((t) => t.startsWith('soul:'))) continue;

    // Skip if already marked for pruning
    if (thought.tags.includes('soul:can-prune')) continue;

    // Check age
    if (thought.timestamp.getTime() < cutoffTime) {
      // Mark for pruning
      const newTags = [...thought.tags, 'soul:can-prune'];
      const updated: MemoryEntry = { ...thought, tags: newTags };
      await memoryProvider.save(updated);
      marked++;

      if (marked >= maxToProcess) break;
    }
  }

  if (marked > 0) {
    logger.debug({ marked, maxAgeHours }, 'Old resolved thoughts marked for pruning');
  }

  return marked;
}
