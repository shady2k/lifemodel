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

/**
 * Configuration for AGGREGATION processor.
 */
export interface AggregationProcessorConfig {
  /** Enable pattern detection */
  enablePatternDetection: boolean;

  /** Prune expired signals every N ticks */
  pruneIntervalTicks: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: AggregationProcessorConfig = {
  enablePatternDetection: true,
  pruneIntervalTicks: 10,
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
    primaryUserChatId?: string;
    pluginEventValidator?: PluginEventValidator;
  }): void {
    const thresholdDeps: ThresholdEngineDeps = {};
    if (deps.conversationManager) thresholdDeps.conversationManager = deps.conversationManager;
    if (deps.userModel) thresholdDeps.userModel = deps.userModel;
    if (deps.primaryUserChatId) thresholdDeps.primaryUserChatId = deps.primaryUserChatId;
    if (deps.pluginEventValidator) thresholdDeps.pluginEventValidator = deps.pluginEventValidator;
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
   * Merge duplicate thought signals before processing.
   * Groups by dedupeKey and keeps highest priority (lowest number).
   */
  private mergeThoughtSignals(signals: Signal[]): Signal[] {
    const thoughtSignals = signals.filter((s) => s.type === 'thought');
    const otherSignals = signals.filter((s) => s.type !== 'thought');

    if (thoughtSignals.length <= 1) {
      return signals;
    }

    // Group by dedupeKey - keep highest priority (lowest number)
    const merged = new Map<string, Signal>();
    for (const thought of thoughtSignals) {
      const data = thought.data as ThoughtData | undefined;
      if (!data) continue;

      const key = data.dedupeKey;
      const existing = merged.get(key);

      if (!existing || thought.priority < existing.priority) {
        merged.set(key, thought);
      }
    }

    const mergedCount = thoughtSignals.length - merged.size;
    if (mergedCount > 0) {
      this.logger.debug({ mergedCount }, 'Merged duplicate thought signals');
    }

    return [...otherSignals, ...merged.values()];
  }

  /**
   * Clear all state.
   */
  clear(): void {
    this.aggregator.clear();
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
