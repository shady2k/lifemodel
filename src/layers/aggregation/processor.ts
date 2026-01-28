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

import type { Signal, SignalAggregate, SignalType, SignalSource } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { AggregationLayer, AggregationResult } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';

import type { SignalAggregator } from './aggregator.js';
import { createSignalAggregator } from './aggregator.js';
import type { ThresholdEngine } from './threshold-engine.js';
import { createThresholdEngine } from './threshold-engine.js';
import type { PatternDetector } from './pattern-detector.js';
import { createPatternDetector } from './pattern-detector.js';

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
   * Process signals and decide whether to wake COGNITION.
   *
   * @param signals All signals from this tick
   * @param state Current agent state
   * @returns Aggregation result with wake decision
   */
  process(signals: Signal[], state: AgentState): AggregationResult {
    const startTime = Date.now();
    this.tickCount++;

    // 1. Add signals to aggregator
    this.aggregator.addAll(signals);

    // 2. Compute aggregates
    const aggregates = this.aggregator.getAllAggregates();

    // 3. Detect patterns (may emit additional signals)
    let allSignals = signals;
    if (this.config.enablePatternDetection) {
      const patternSignals = this.patternDetector.detect(aggregates, signals);
      if (patternSignals.length > 0) {
        // Add pattern signals to aggregator too
        this.aggregator.addAll(patternSignals);
        allSignals = [...signals, ...patternSignals];
      }
    }

    // 4. Evaluate wake decision
    const wakeDecision = this.thresholdEngine.evaluate(allSignals, aggregates, state);

    // 5. Periodic pruning
    if (this.tickCount % this.config.pruneIntervalTicks === 0) {
      this.aggregator.prune();
    }

    const duration = Date.now() - startTime;

    this.logger.debug(
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
   * Get current aggregate for a signal type.
   */
  getAggregate(type: SignalType, source: SignalSource): SignalAggregate | undefined {
    return this.aggregator.getAggregate(type, source);
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
