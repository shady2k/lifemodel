/**
 * AGGREGATION Layer Processor
 *
 * Collects signals, detects patterns, decides when to wake COGNITION.
 * Pure algorithmic processing - no LLM calls.
 *
 * Like the thalamus - filters and routes sensory information,
 * deciding what reaches conscious awareness (COGNITION).
 *
 * Responsibilities:
 * - Collect signals into type+source buckets
 * - Compute aggregates (current value, trend, rate of change)
 * - Detect patterns (anomalies, correlations)
 * - Decide if COGNITION should be woken
 */

import type {
  Signal,
  SignalAggregate,
  SignalType,
  SignalSource,
  ThoughtData,
} from '../../types/signal.js';
import { THOUGHT_LIMITS } from '../../types/signal.js';
import {
  tokenize,
  findSimilarThought,
  DEFAULT_SIMILARITY_THRESHOLD,
  type RecentThoughtEntry,
} from '../../core/utils/text-similarity.js';
import type { AgentState } from '../../types/agent/state.js';
import type { AggregationLayer, AggregationResult } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';

import type { SignalAggregator } from './aggregator.js';
import { createSignalAggregator } from './aggregator.js';
import type {
  ThresholdEngine,
  ThresholdEngineDeps,
  PluginEventValidator,
} from './threshold-engine.js';
import { createThresholdEngine } from './threshold-engine.js';
import type { PatternDetector } from './pattern-detector.js';
import { createPatternDetector } from './pattern-detector.js';
import type { ConversationManager } from '../../storage/conversation-manager.js';
import type { UserModel } from '../../models/user-model.js';
import type { SignalAckRegistry } from './ack-registry.js';
import type { MemoryProvider } from '../cognition/tools/core/memory.js';

/**
 * Configuration for AGGREGATION processor.
 */
export interface AggregationProcessorConfig {
  /** Enable pattern detection */
  enablePatternDetection: boolean;

  /** Prune expired signals every N ticks */
  pruneIntervalTicks: number;

  /** Similarity threshold for thought deduplication (0-1, default 0.85) */
  thoughtSimilarityThreshold: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: AggregationProcessorConfig = {
  enablePatternDetection: true,
  pruneIntervalTicks: 10,
  thoughtSimilarityThreshold: DEFAULT_SIMILARITY_THRESHOLD,
};

/**
 * AGGREGATION layer processor implementation.
 */
export class AggregationProcessor implements AggregationLayer {
  readonly name = 'aggregation' as const;

  private readonly aggregator: SignalAggregator;
  private readonly thresholdEngine: ThresholdEngine;
  private readonly patternDetector: PatternDetector;
  private readonly config: AggregationProcessorConfig;
  private readonly logger: Logger;
  private tickCount = 0;

  /** Recent thoughts for similarity-based deduplication (cross-tick) */
  private recentThoughts: RecentThoughtEntry[] = [];

  constructor(logger: Logger, config: Partial<AggregationProcessorConfig> = {}) {
    this.logger = logger.child({ layer: 'aggregation' });
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.aggregator = createSignalAggregator(this.logger);
    this.thresholdEngine = createThresholdEngine(this.logger);
    this.patternDetector = createPatternDetector(this.logger);
  }

  /**
   * Update dependencies for conversation-aware proactive contact.
   */
  updateDeps(deps: {
    conversationManager?: ConversationManager;
    userModel?: UserModel;
    primaryRecipientId?: string;
    pluginEventValidator?: PluginEventValidator;
    memoryProvider?: MemoryProvider;
    ackRegistry?: SignalAckRegistry;
  }): void {
    const thresholdDeps: ThresholdEngineDeps = {};
    if (deps.conversationManager) thresholdDeps.conversationManager = deps.conversationManager;
    if (deps.userModel) thresholdDeps.userModel = deps.userModel;
    if (deps.primaryRecipientId) thresholdDeps.primaryRecipientId = deps.primaryRecipientId;
    if (deps.pluginEventValidator) thresholdDeps.pluginEventValidator = deps.pluginEventValidator;
    if (deps.memoryProvider) thresholdDeps.memoryProvider = deps.memoryProvider;
    if (deps.ackRegistry) thresholdDeps.ackRegistry = deps.ackRegistry;
    this.thresholdEngine.updateDeps(thresholdDeps);
    this.logger.debug('AGGREGATION dependencies updated');
  }

  /**
   * Process signals and decide whether to wake COGNITION.
   *
   * @param signals All signals from this tick
   * @param state Current agent state
   * @returns Aggregation result with wake decision
   */
  async process(signals: Signal[], state: AgentState): Promise<AggregationResult> {
    const startTime = Date.now();
    this.tickCount++;

    // 1. Merge duplicate thoughts before aggregating
    const mergedSignals = this.mergeThoughtSignals(signals);

    // 2. Add signals to aggregator
    this.aggregator.addAll(mergedSignals);

    // 3. Compute aggregates
    const aggregates = this.aggregator.getAllAggregates();

    // 4. Detect patterns (may emit additional signals)
    let allSignals = mergedSignals;
    if (this.config.enablePatternDetection) {
      const patternSignals = this.patternDetector.detect(aggregates, signals);
      if (patternSignals.length > 0) {
        // Add pattern signals to aggregator too
        this.aggregator.addAll(patternSignals);
        allSignals = [...signals, ...patternSignals];
      }
    }

    // 5. Evaluate wake decision (async for conversation status checks)
    const wakeDecision = await this.thresholdEngine.evaluate(allSignals, aggregates, state);

    // 6. Periodic pruning
    if (this.tickCount % this.config.pruneIntervalTicks === 0) {
      this.aggregator.prune();
    }

    const duration = Date.now() - startTime;

    this.logger.trace(
      {
        signalCount: signals.length,
        aggregateCount: aggregates.length,
        wakeCognition: wakeDecision.shouldWake,
        wakeReason: wakeDecision.reason,
        duration,
      },
      'AGGREGATION tick complete'
    );

    const result: AggregationResult = {
      wakeCognition: wakeDecision.shouldWake,
      aggregates,
      triggerSignals: wakeDecision.triggerSignals,
      intents: [],
    };

    if (wakeDecision.reason) {
      result.wakeReason = wakeDecision.reason;
    }

    return result;
  }

  /**
   * Get current aggregate for a signal type and source.
   */
  getAggregate(type: SignalType, source?: SignalSource): SignalAggregate | undefined {
    // If source is provided, get specific aggregate
    if (source) {
      return this.aggregator.getAggregate(type, source);
    }
    // Otherwise, find first aggregate for this type
    return this.aggregator.getAllAggregates().find((a) => a.type === type);
  }

  /**
   * Prune expired signals.
   */
  prune(): number {
    return this.aggregator.prune();
  }

  /**
   * Get all current aggregates (for debugging).
   */
  getAllAggregates(): SignalAggregate[] {
    return this.aggregator.getAllAggregates();
  }

  /**
   * Get aggregator stats (for debugging).
   */
  getStats(): { buckets: number; signals: number } {
    return {
      buckets: this.aggregator.getBucketCount(),
      signals: this.aggregator.getTotalSignalCount(),
    };
  }

  /**
   * Get the ack registry (for external access from CoreLoop).
   */
  getAckRegistry(): SignalAckRegistry {
    return this.thresholdEngine.getAckRegistry();
  }

  /**
   * Cleanup old thought entries from the deduplication cache.
   */
  private cleanupOldThoughts(now: number): void {
    const cutoff = now - THOUGHT_LIMITS.DEDUPE_WINDOW_MS;
    const before = this.recentThoughts.length;
    this.recentThoughts = this.recentThoughts.filter((entry) => entry.timestamp > cutoff);
    const pruned = before - this.recentThoughts.length;
    if (pruned > 0) {
      this.logger.debug({ pruned }, 'Pruned old thought entries');
    }
  }

  /**
   * Deduplicate thought signals using similarity-based matching.
   *
   * This is the brain stem's habituation mechanism - filtering out
   * thoughts we've already seen (or very similar ones) within the
   * deduplication window.
   *
   * Two-phase deduplication:
   * 1. Cross-tick: Check against recentThoughts cache (15-min window)
   * 2. Same-tick: Merge similar thoughts within current batch
   */
  private mergeThoughtSignals(signals: Signal[]): Signal[] {
    const thoughtSignals = signals.filter((s) => s.type === 'thought');
    const otherSignals = signals.filter((s) => s.type !== 'thought');

    if (thoughtSignals.length === 0) {
      return signals;
    }

    const now = Date.now();
    this.cleanupOldThoughts(now);

    const uniqueThoughts: Signal[] = [];
    let dedupedCount = 0;

    for (const thought of thoughtSignals) {
      const data = thought.data as ThoughtData | undefined;
      if (!data) {
        uniqueThoughts.push(thought);
        continue;
      }

      const tokens = tokenize(data.content);

      // Phase 1: Check against cross-tick cache
      const existingMatch = findSimilarThought(
        tokens,
        this.recentThoughts,
        this.config.thoughtSimilarityThreshold
      );

      if (existingMatch) {
        this.logger.debug(
          {
            content: data.content.slice(0, 30),
            matchedContent: existingMatch.content.slice(0, 30),
          },
          'Thought deduplicated (similar to recent)'
        );
        dedupedCount++;
        continue;
      }

      // Phase 2: Check against same-tick thoughts (already added to uniqueThoughts)
      const sameBatchMatch = uniqueThoughts.find((existing) => {
        const existingData = existing.data as ThoughtData | undefined;
        if (!existingData) return false;
        const existingTokens = tokenize(existingData.content);
        const similarity = findSimilarThought(
          tokens,
          [{ tokens: existingTokens, content: existingData.content, timestamp: now }],
          this.config.thoughtSimilarityThreshold
        );
        return similarity !== undefined;
      });

      if (sameBatchMatch) {
        // Keep higher priority (lower number)
        if (thought.priority < sameBatchMatch.priority) {
          // Replace with higher priority thought
          const idx = uniqueThoughts.indexOf(sameBatchMatch);
          uniqueThoughts[idx] = thought;
        }
        this.logger.debug(
          { content: data.content.slice(0, 30) },
          'Thought deduplicated (similar in same batch)'
        );
        dedupedCount++;
        continue;
      }

      // Not a duplicate - add to both unique list and cache
      uniqueThoughts.push(thought);
      this.recentThoughts.push({
        tokens,
        content: data.content,
        timestamp: now,
      });
    }

    if (dedupedCount > 0) {
      this.logger.debug({ dedupedCount }, 'Thoughts deduplicated via similarity');
    }

    return [...otherSignals, ...uniqueThoughts];
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.aggregator.clear();
    this.recentThoughts = [];
    this.logger.debug('AGGREGATION layer cleared');
  }
}

/**
 * Create an AGGREGATION processor.
 */
export function createAggregationProcessor(
  logger: Logger,
  config?: Partial<AggregationProcessorConfig>
): AggregationProcessor {
  return new AggregationProcessor(logger, config);
}
