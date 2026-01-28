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
  /** How long silence must last to be considered a break (ms) */
  silenceThresholdMs: number;

  /** Minimum signals before pattern detection activates */
  minSignalsForDetection: number;

  /** Minimum change in pattern value to re-fire (prevents repeated triggers for same condition) */
  significantChangeThreshold: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_PATTERN_CONFIG: PatternDetectorConfig = {
  silenceThresholdMs: 30_000, // 30 seconds of silence
  minSignalsForDetection: 5,
  significantChangeThreshold: 0.2, // 20% change needed to re-fire pattern
};

/**
 * Acknowledged pattern state - what COGNITION already knows about.
 * Like pain awareness - once brain processes it, we don't re-analyze
 * unless the condition CHANGES significantly.
 */
interface AcknowledgedPattern {
  /** The condition value when acknowledged */
  value: number;
  /** What type of condition (e.g., "energy_decreasing") */
  conditionKey: string;
  /** When acknowledged */
  acknowledgedAt: number;
}

/**
 * Pattern Detector - identifies anomalies and patterns.
 */
export class PatternDetector {
  private readonly patterns: Pattern[] = [];
  private readonly config: PatternDetectorConfig;
  private readonly logger: Logger;
  private lastActivityAt: Date = new Date();
  private activityHistory: { timestamp: Date; count: number }[] = [];
  /**
   * Acknowledged patterns - COGNITION already knows about these.
   * Key: "patternId:conditionKey" (e.g., "rate_spike:energy_decreasing")
   */
  private readonly acknowledged = new Map<string, AcknowledgedPattern>();

  constructor(logger: Logger, config: Partial<PatternDetectorConfig> = {}) {
    this.logger = logger.child({ component: 'pattern-detector' });
    this.config = { ...DEFAULT_PATTERN_CONFIG, ...config };

    this.registerBuiltInPatterns();
  }

  /**
   * Acknowledge a pattern - COGNITION has processed it.
   * Called by COGNITION after handling a pattern_break signal.
   */
  acknowledge(patternId: string, conditionKey: string, value: number): void {
    const key = `${patternId}:${conditionKey}`;
    this.acknowledged.set(key, {
      value,
      conditionKey,
      acknowledgedAt: Date.now(),
    });
    this.logger.debug({ patternId, conditionKey, value }, 'Pattern acknowledged');
  }

  /**
   * Check if a pattern condition is already acknowledged and unchanged.
   * Returns true if we should SKIP firing (already known, no significant change).
   */
  private isAlreadyAcknowledged(
    patternId: string,
    conditionKey: string,
    currentValue: number
  ): boolean {
    const key = `${patternId}:${conditionKey}`;
    const ack = this.acknowledged.get(key);

    if (!ack) return false; // Not acknowledged, should fire

    // Check if condition changed significantly
    const change = Math.abs(currentValue - ack.value);
    if (change >= this.config.significantChangeThreshold) {
      // Condition changed significantly - clear ack, allow re-fire
      this.acknowledged.delete(key);
      this.logger.debug(
        { patternId, conditionKey, oldValue: ack.value, newValue: currentValue, change },
        'Pattern condition changed significantly, clearing acknowledgment'
      );
      return false;
    }

    return true; // Still acknowledged, skip firing
  }

  /**
   * Clear acknowledgment when condition resolves.
   */
  private clearAcknowledgmentIfResolved(patternId: string, conditionKey: string): void {
    const key = `${patternId}:${conditionKey}`;
    if (this.acknowledged.has(key)) {
      this.acknowledged.delete(key);
      this.logger.debug({ patternId, conditionKey }, 'Pattern resolved, acknowledgment cleared');
    }
  }

  /**
   * Register built-in patterns.
   */
  private registerBuiltInPatterns(): void {
    // NOTE: Removed rate_spike pattern for internal signals (energy, social_debt).
    // Monotone changes in internal state are expected behavior, not anomalies.
    // Pattern detection should focus on USER behavior anomalies.

    // Sudden silence after activity
    this.patterns.push({
      id: 'sudden_silence',
      description: 'Unexpected quiet period',
      signalTypes: ['user_message'],
      detect: (aggregates, signals) => this.detectSuddenSilence(aggregates, signals),
    });

    // NOTE: Removed energy_pressure_conflict - handled by energy gate in threshold-engine.
    // When energy is low, COGNITION won't wake for contact pressure anyway.
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
          // Get condition key from context (e.g., "energy_decreasing")
          const rawConditionKey = match.context?.['conditionKey'];
          const rawConditionValue = match.context?.['conditionValue'];
          const conditionKey = typeof rawConditionKey === 'string' ? rawConditionKey : 'default';
          const conditionValue =
            typeof rawConditionValue === 'number' ? rawConditionValue : match.confidence;

          // Check if already acknowledged (COGNITION already knows)
          if (this.isAlreadyAcknowledged(match.patternId, conditionKey, conditionValue)) {
            this.logger.debug(
              { patternId: match.patternId, conditionKey },
              'Pattern already acknowledged, skipping'
            );
            continue;
          }

          patternSignals.push(this.createPatternSignal(match));

          this.logger.debug(
            {
              patternId: match.patternId,
              conditionKey,
              confidence: match.confidence.toFixed(2),
              description: match.description,
            },
            'Pattern detected (needs attention)'
          );
        } else {
          // Condition not detected - clear any acknowledgment so it can fire again if it returns
          const conditionKey = (pattern as { defaultConditionKey?: string }).defaultConditionKey;
          if (conditionKey) {
            this.clearAcknowledgmentIfResolved(pattern.id, conditionKey);
          }
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

  // NOTE: detectRateSpike removed - monotone internal state changes are expected,
  // not anomalies. Pattern detection focuses on user behavior anomalies.

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

  // NOTE: detectEnergyPressureConflict removed - handled by energy gate.

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
    this.activityHistory = this.activityHistory.filter((h) => h.timestamp.getTime() > cutoff);
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
