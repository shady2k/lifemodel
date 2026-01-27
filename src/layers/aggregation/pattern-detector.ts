/**
 * Pattern Detector
 *
 * Detects patterns and anomalies in signal streams:
 * - Rate-of-change spikes (novelty)
 * - Pattern breaks (sudden silence after activity)
 * - Cross-type correlations (energy LOW + message HIGH)
 *
 * Like the brain's pattern recognition - notices when
 * something is different from the usual.
 */

import type { Signal, SignalAggregate, SignalType, PatternData } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import { Priority } from '../../types/priority.js';
import type { Logger } from '../../types/logger.js';

/**
 * Pattern definition.
 */
export interface Pattern {
  /** Pattern identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Signal types involved */
  signalTypes: SignalType[];

  /** Detection function */
  detect: (aggregates: SignalAggregate[], signals: Signal[]) => PatternMatch | null;
}

/**
 * Result when a pattern is matched.
 */
export interface PatternMatch {
  /** Pattern ID */
  patternId: string;

  /** Confidence in the match (0-1) */
  confidence: number;

  /** Description of what was detected */
  description: string;

  /** Signals that triggered the match */
  triggerSignals: Signal[];

  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Configuration for pattern detector.
 */
export interface PatternDetectorConfig {
  /** Minimum rate of change to consider a spike */
  rateOfChangeSpikeThreshold: number;

  /** How long silence must last to be considered a break (ms) */
  silenceThresholdMs: number;

  /** Minimum signals before pattern detection activates */
  minSignalsForDetection: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_PATTERN_CONFIG: PatternDetectorConfig = {
  rateOfChangeSpikeThreshold: 0.5, // 50% change per second
  silenceThresholdMs: 30_000, // 30 seconds of silence
  minSignalsForDetection: 5,
};

/**
 * Pattern Detector - identifies anomalies and patterns.
 */
export class PatternDetector {
  private readonly patterns: Pattern[] = [];
  private readonly config: PatternDetectorConfig;
  private readonly logger: Logger;
  private lastActivityAt: Date = new Date();
  private activityHistory: { timestamp: Date; count: number }[] = [];

  constructor(logger: Logger, config: Partial<PatternDetectorConfig> = {}) {
    this.logger = logger.child({ component: 'pattern-detector' });
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };

    this.registerBuiltInPatterns();
  }

  /**
   * Register built-in patterns.
   */
  private registerBuiltInPatterns(): void {
    // Rate of change spike (novelty)
    this.patterns.push({
      id: 'rate_spike',
      description: 'Sudden change in rate',
      signalTypes: ['social_debt', 'energy', 'contact_pressure'],
      detect: (aggregates) => this.detectRateSpike(aggregates),
    });

    // Sudden silence after activity
    this.patterns.push({
      id: 'sudden_silence',
      description: 'Unexpected quiet period',
      signalTypes: ['user_message'],
      detect: (aggregates, signals) => this.detectSuddenSilence(aggregates, signals),
    });

    // Energy dropping while pressure rising
    this.patterns.push({
      id: 'energy_pressure_conflict',
      description: 'Low energy with high pressure',
      signalTypes: ['energy', 'contact_pressure'],
      detect: (aggregates) => this.detectEnergyPressureConflict(aggregates),
    });
  }

  /**
   * Detect patterns in current state.
   *
   * @param aggregates Current signal aggregates
   * @param signals Recent signals
   * @returns Pattern match signals to emit
   */
  detect(aggregates: SignalAggregate[], signals: Signal[]): Signal[] {
    const patternSignals: Signal[] = [];

    // Update activity tracking
    this.updateActivityHistory(signals);

    // Check each pattern
    for (const pattern of this.patterns) {
      try {
        const match = pattern.detect(aggregates, signals);
        if (match && match.confidence >= 0.5) {
          patternSignals.push(this.createPatternSignal(match));

          this.logger.debug(
            {
              patternId: match.patternId,
              confidence: match.confidence.toFixed(2),
              description: match.description,
            },
            'Pattern detected'
          );
        }
      } catch (error) {
        this.logger.warn(
          {
            patternId: pattern.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Pattern detection failed'
        );
      }
    }

    return patternSignals;
  }

  /**
   * Register a custom pattern.
   */
  registerPattern(pattern: Pattern): void {
    this.patterns.push(pattern);
    this.logger.debug({ patternId: pattern.id }, 'Pattern registered');
  }

  /**
   * Detect rate of change spikes.
   */
  private detectRateSpike(aggregates: SignalAggregate[]): PatternMatch | null {
    for (const aggregate of aggregates) {
      if (Math.abs(aggregate.rateOfChange) > this.config.rateOfChangeSpikeThreshold) {
        const direction = aggregate.rateOfChange > 0 ? 'increasing' : 'decreasing';
        return {
          patternId: 'rate_spike',
          confidence: Math.min(
            1,
            Math.abs(aggregate.rateOfChange) / this.config.rateOfChangeSpikeThreshold
          ),
          description: `${aggregate.type} is ${direction} rapidly`,
          triggerSignals: [],
          context: {
            type: aggregate.type,
            rateOfChange: aggregate.rateOfChange,
            currentValue: aggregate.currentValue,
          },
        };
      }
    }
    return null;
  }

  /**
   * Detect sudden silence after activity.
   */
  private detectSuddenSilence(
    _aggregates: SignalAggregate[],
    signals: Signal[]
  ): PatternMatch | null {
    // Check if we had recent activity but now silence
    const recentHistory = this.activityHistory.filter(
      (h) => Date.now() - h.timestamp.getTime() < this.config.silenceThresholdMs * 2
    );

    if (recentHistory.length < 2) return null;

    // Calculate average activity
    const totalActivity = recentHistory.reduce((sum, h) => sum + h.count, 0);
    const avgActivity = totalActivity / recentHistory.length;

    // Check current activity
    const currentActivity = signals.filter((s) => s.type === 'user_message').length;
    const timeSinceLastActivity = Date.now() - this.lastActivityAt.getTime();

    // Detect if we had activity but now silence
    if (
      avgActivity > 1 &&
      currentActivity === 0 &&
      timeSinceLastActivity > this.config.silenceThresholdMs
    ) {
      return {
        patternId: 'sudden_silence',
        confidence: Math.min(1, timeSinceLastActivity / (this.config.silenceThresholdMs * 2)),
        description: 'User was active but has gone quiet',
        triggerSignals: [],
        context: {
          avgActivity,
          silenceDurationMs: timeSinceLastActivity,
        },
      };
    }

    return null;
  }

  /**
   * Detect energy-pressure conflict.
   */
  private detectEnergyPressureConflict(aggregates: SignalAggregate[]): PatternMatch | null {
    const energy = aggregates.find((a) => a.type === 'energy');
    const pressure = aggregates.find((a) => a.type === 'contact_pressure');

    if (!energy || !pressure) return null;

    // Low energy + high pressure = conflict
    if (energy.currentValue < 0.3 && pressure.currentValue > 0.6) {
      return {
        patternId: 'energy_pressure_conflict',
        confidence: (1 - energy.currentValue) * pressure.currentValue,
        description: 'Want to contact but energy is low',
        triggerSignals: [],
        context: {
          energy: energy.currentValue,
          pressure: pressure.currentValue,
        },
      };
    }

    return null;
  }

  /**
   * Update activity history.
   */
  private updateActivityHistory(signals: Signal[]): void {
    const userMessages = signals.filter((s) => s.type === 'user_message');

    if (userMessages.length > 0) {
      this.lastActivityAt = new Date();
    }

    // Add current tick to history
    this.activityHistory.push({
      timestamp: new Date(),
      count: userMessages.length,
    });

    // Trim old history
    const cutoff = Date.now() - this.config.silenceThresholdMs * 3;
    this.activityHistory = this.activityHistory.filter(
      (h) => h.timestamp.getTime() > cutoff
    );
  }

  /**
   * Create a pattern_break signal.
   */
  private createPatternSignal(match: PatternMatch): Signal {
    const patternData: PatternData = {
      kind: 'pattern',
      patternName: match.patternId,
      description: match.description,
    };

    // Only add optional fields if they're defined
    const expected = match.context?.['expected'];
    const actual = match.context?.['actual'];
    if (typeof expected === 'string') {
      patternData.expected = expected;
    }
    if (typeof actual === 'string') {
      patternData.actual = actual;
    }

    return createSignal(
      'pattern_break',
      'meta.pattern_detector',
      {
        value: match.confidence,
        confidence: match.confidence,
      },
      {
        priority: Priority.NORMAL,
        data: patternData,
      }
    );
  }
}

/**
 * Create a pattern detector.
 */
export function createPatternDetector(
  logger: Logger,
  config?: Partial<PatternDetectorConfig>
): PatternDetector {
  return new PatternDetector(logger, config);
}
