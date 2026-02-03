/**
 * Signal Aggregator
 *
 * Collects signals into granular buckets by type+source.
 * Each bucket tracks:
 * - Current value (latest or aggregated)
 * - Rate of change
 * - Count of signals in time window
 * - Min/max values
 * - Trend (stable, increasing, decreasing, volatile)
 *
 * Like a dashboard of gauges - each gauge shows one measurement.
 */

import type { Signal, SignalType, SignalSource, SignalAggregate } from '../../types/signal.js';
import { isSignalExpired } from '../../types/signal.js';
import type { Logger } from '../../types/logger.js';

/**
 * Configuration for the aggregator.
 */
export interface AggregatorConfig {
  /** Time window for aggregation (ms) */
  windowMs: number;

  /** Maximum signals to keep per bucket */
  maxSignalsPerBucket: number;

  /** Threshold for volatile trend detection */
  volatilityThreshold: number;

  /** Threshold for trend detection (rate of change) */
  trendThreshold: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_AGGREGATOR_CONFIG: AggregatorConfig = {
  windowMs: 300_000, // 5 minute window - smoother trend detection across signal types
  maxSignalsPerBucket: 100,
  volatilityThreshold: 0.3, // 30% variance = volatile
  trendThreshold: 0.05, // 5% change = trending
};

/**
 * A bucket holding signals for one type+source combination.
 */
interface SignalBucket {
  type: SignalType;
  source: SignalSource;
  signals: Signal[];
  lastUpdated: Date;
}

/**
 * Signal Aggregator - collects signals into type+source buckets.
 */
export class SignalAggregator {
  private readonly buckets = new Map<string, SignalBucket>();
  private readonly config: AggregatorConfig;
  private readonly logger: Logger;

  constructor(logger: Logger, config: Partial<AggregatorConfig> = {}) {
    this.logger = logger.child({ component: 'aggregator' });
    this.config = { ...DEFAULT_AGGREGATOR_CONFIG, ...config };
  }

  /**
   * Add a signal to the appropriate bucket.
   */
  add(signal: Signal): void {
    const key = this.getBucketKey(signal.type, signal.source);

    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        type: signal.type,
        source: signal.source,
        signals: [],
        lastUpdated: new Date(),
      };
      this.buckets.set(key, bucket);
    }

    // Add signal to bucket
    bucket.signals.push(signal);
    bucket.lastUpdated = new Date();

    // Trim if over max
    if (bucket.signals.length > this.config.maxSignalsPerBucket) {
      bucket.signals.shift(); // Remove oldest
    }
  }

  /**
   * Add multiple signals.
   */
  addAll(signals: Signal[]): void {
    for (const signal of signals) {
      this.add(signal);
    }
  }

  /**
   * Get aggregate for a specific type+source.
   */
  getAggregate(type: SignalType, source: SignalSource): SignalAggregate | undefined {
    const key = this.getBucketKey(type, source);
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.signals.length === 0) {
      return undefined;
    }

    return this.computeAggregate(bucket);
  }

  /**
   * Get all current aggregates.
   */
  getAllAggregates(): SignalAggregate[] {
    const aggregates: SignalAggregate[] = [];

    for (const bucket of this.buckets.values()) {
      if (bucket.signals.length > 0) {
        aggregates.push(this.computeAggregate(bucket));
      }
    }

    return aggregates;
  }

  /**
   * Get signals of a specific type (from all sources).
   */
  getSignalsByType(type: SignalType): Signal[] {
    const signals: Signal[] = [];

    for (const bucket of this.buckets.values()) {
      if (bucket.type === type) {
        signals.push(...bucket.signals);
      }
    }

    return signals;
  }

  /**
   * Get the most recent signal of a type.
   */
  getLatestSignal(type: SignalType): Signal | undefined {
    let latest: Signal | undefined;

    for (const bucket of this.buckets.values()) {
      if (bucket.type === type && bucket.signals.length > 0) {
        const bucketLatest = bucket.signals[bucket.signals.length - 1];
        if (!latest || (bucketLatest && bucketLatest.timestamp > latest.timestamp)) {
          latest = bucketLatest;
        }
      }
    }

    return latest;
  }

  /**
   * Prune expired signals from all buckets.
   * Returns number of signals pruned.
   */
  prune(): number {
    let pruned = 0;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    for (const bucket of this.buckets.values()) {
      const before = bucket.signals.length;

      // Remove expired signals and signals outside window
      bucket.signals = bucket.signals.filter((signal) => {
        if (isSignalExpired(signal)) return false;
        if (signal.timestamp.getTime() < windowStart) return false;
        return true;
      });

      pruned += before - bucket.signals.length;
    }

    if (pruned > 0) {
      this.logger.trace({ pruned }, 'Pruned expired signals');
    }

    return pruned;
  }

  /**
   * Clear all buckets.
   */
  clear(): void {
    this.buckets.clear();
    this.logger.debug('Aggregator cleared');
  }

  /**
   * Get total signal count across all buckets.
   */
  getTotalSignalCount(): number {
    let total = 0;
    for (const bucket of this.buckets.values()) {
      total += bucket.signals.length;
    }
    return total;
  }

  /**
   * Get bucket count.
   */
  getBucketCount(): number {
    return this.buckets.size;
  }

  /**
   * Compute aggregate for a bucket.
   */
  private computeAggregate(bucket: SignalBucket): SignalAggregate {
    const signals = bucket.signals;
    const values = signals.map((s) => s.metrics.value);

    // Current value is latest
    const currentValue = values[values.length - 1] ?? 0;

    // Compute stats
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);

    // Compute rate of change (average)
    let totalRateOfChange = 0;
    let rateCount = 0;
    for (const signal of signals) {
      if (signal.metrics.rateOfChange !== undefined) {
        totalRateOfChange += signal.metrics.rateOfChange;
        rateCount++;
      }
    }
    const rateOfChange = rateCount > 0 ? totalRateOfChange / rateCount : 0;

    // Determine trend
    const trend = this.determineTrend(values, rateOfChange);

    return {
      type: bucket.type,
      source: bucket.source,
      currentValue,
      rateOfChange,
      count: signals.length,
      maxValue,
      minValue,
      lastUpdated: bucket.lastUpdated,
      trend,
    };
  }

  /**
   * Determine trend from values and rate of change.
   */
  private determineTrend(
    values: number[],
    rateOfChange: number
  ): 'stable' | 'increasing' | 'decreasing' | 'volatile' {
    if (values.length < 2) {
      return 'stable';
    }

    // Check volatility (variance)
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coeffOfVariation = mean !== 0 ? stdDev / Math.abs(mean) : 0;

    if (coeffOfVariation > this.config.volatilityThreshold) {
      return 'volatile';
    }

    // Check trend based on rate of change
    if (rateOfChange > this.config.trendThreshold) {
      return 'increasing';
    }
    if (rateOfChange < -this.config.trendThreshold) {
      return 'decreasing';
    }

    return 'stable';
  }

  /**
   * Get bucket key for type+source.
   */
  private getBucketKey(type: SignalType, source: SignalSource): string {
    return `${type}:${source}`;
  }
}

/**
 * Create a signal aggregator.
 */
export function createSignalAggregator(
  logger: Logger,
  config?: Partial<AggregatorConfig>
): SignalAggregator {
  return new SignalAggregator(logger, config);
}
