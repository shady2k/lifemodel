/**
 * Threshold Engine
 *
 * Decides when to wake COGNITION based on signal aggregates.
 * Uses Weber-Fechner relative thresholds and state-adaptive sensitivity.
 *
 * Wake triggers:
 * - User message (always wake)
 * - Contact pressure crossed threshold
 * - Pattern break detected
 * - Channel error
 * - Scheduled event
 */

import type { Signal, SignalAggregate } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import { Priority } from '../../types/priority.js';
import type { AgentState } from '../../types/agent/state.js';
import type { WakeTrigger, WakeThresholdConfig } from '../../types/layers.js';
import { DEFAULT_WAKE_THRESHOLDS } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';

/**
 * Result of wake decision.
 */
export interface WakeDecision {
  /** Whether to wake COGNITION */
  shouldWake: boolean;

  /** What triggered the wake (if shouldWake) */
  trigger?: WakeTrigger;

  /** Why we're waking */
  reason?: string;

  /** Signals that triggered the wake */
  triggerSignals: Signal[];

  /** Threshold that was crossed (if applicable) */
  threshold?: number;

  /** Value that crossed the threshold */
  value?: number;
}

/**
 * Threshold Engine - decides when to wake COGNITION.
 */
export class ThresholdEngine {
  private readonly config: WakeThresholdConfig;
  private readonly logger: Logger;

  constructor(logger: Logger, config: Partial<WakeThresholdConfig> = {}) {
    this.logger = logger.child({ component: 'threshold-engine' });
    this.config = { ...DEFAULT_WAKE_THRESHOLDS, ...config };
  }

  /**
   * Evaluate whether to wake COGNITION.
   *
   * @param signals All signals from this tick
   * @param aggregates Current aggregates
   * @param state Agent state (for threshold adjustment)
   */
  evaluate(signals: Signal[], aggregates: SignalAggregate[], state: AgentState): WakeDecision {
    // Check for high-priority triggers first (always wake for user messages)
    const userMessages = signals.filter((s) => s.type === 'user_message');
    if (userMessages.length > 0) {
      return {
        shouldWake: true,
        trigger: 'user_message',
        reason: 'User sent a message',
        triggerSignals: userMessages,
      };
    }

    // Energy gate: if energy is critically low, don't wake for anything else
    // This saves expensive LLM calls when agent is "tired"
    if (state.energy < this.config.lowEnergy) {
      this.logger.debug(
        { energy: state.energy.toFixed(2), threshold: this.config.lowEnergy },
        'Skipping COGNITION wake - energy too low'
      );
      return {
        shouldWake: false,
        triggerSignals: [],
      };
    }

    // Check for channel errors
    const channelErrors = signals.filter((s) => s.type === 'channel_error');
    if (channelErrors.length > 0) {
      return {
        shouldWake: true,
        trigger: 'channel_error',
        reason: 'Channel reported an error',
        triggerSignals: channelErrors,
      };
    }

    // Check for pattern breaks - only wake for user-related patterns
    const patternBreaks = signals.filter((s) => {
      if (s.type !== 'pattern_break') return false;
      const data = s.data as { patternName?: string } | undefined;
      // Only wake for user-behavior patterns, not internal state patterns
      // Internal patterns (rate_spike, energy_pressure_conflict) are handled autonomically
      return data?.patternName === 'sudden_silence';
    });
    if (patternBreaks.length > 0) {
      return {
        shouldWake: true,
        trigger: 'pattern_break',
        reason: 'User behavior pattern detected',
        triggerSignals: patternBreaks,
      };
    }

    // Check for threshold crossings in aggregates
    const thresholdResult = this.checkThresholds(aggregates, state, signals);
    if (thresholdResult.shouldWake) {
      return thresholdResult;
    }

    // No wake needed
    return {
      shouldWake: false,
      triggerSignals: [],
    };
  }

  /**
   * Check aggregates against thresholds.
   */
  private checkThresholds(
    aggregates: SignalAggregate[],
    state: AgentState,
    _signals: Signal[]
  ): WakeDecision {
    // Get contact pressure aggregate
    const contactPressure = aggregates.find((a) => a.type === 'contact_pressure');

    if (contactPressure) {
      // Calculate adaptive threshold
      const threshold = this.calculateAdaptiveThreshold(state);

      if (contactPressure.currentValue >= threshold) {
        this.logger.debug(
          {
            value: contactPressure.currentValue.toFixed(2),
            threshold: threshold.toFixed(2),
          },
          'Contact pressure threshold crossed'
        );

        // Create synthetic trigger signal so COGNITION has context
        const triggerSignal = createSignal(
          'threshold_crossed',
          'meta.threshold_monitor',
          { value: contactPressure.currentValue, confidence: 1.0 },
          {
            priority: Priority.NORMAL,
            data: {
              kind: 'threshold',
              thresholdName: 'contact_pressure',
              threshold,
              value: contactPressure.currentValue,
              direction: 'above',
            },
          }
        );

        return {
          shouldWake: true,
          trigger: 'threshold_crossed',
          reason: `Contact pressure ${(contactPressure.currentValue * 100).toFixed(0)}% >= threshold ${(threshold * 100).toFixed(0)}%`,
          triggerSignals: [triggerSignal],
          threshold,
          value: contactPressure.currentValue,
        };
      }
    }

    // Check social debt alone (may trigger without full contact pressure)
    const socialDebt = aggregates.find((a) => a.type === 'social_debt');

    if (socialDebt && socialDebt.currentValue >= this.config.socialDebt) {
      // Create synthetic trigger signal
      const triggerSignal = createSignal(
        'threshold_crossed',
        'meta.threshold_monitor',
        { value: socialDebt.currentValue, confidence: 1.0 },
        {
          priority: Priority.NORMAL,
          data: {
            kind: 'threshold',
            thresholdName: 'social_debt',
            threshold: this.config.socialDebt,
            value: socialDebt.currentValue,
            direction: 'above',
          },
        }
      );

      return {
        shouldWake: true,
        trigger: 'threshold_crossed',
        reason: `Social debt ${(socialDebt.currentValue * 100).toFixed(0)}% is high`,
        triggerSignals: [triggerSignal],
        threshold: this.config.socialDebt,
        value: socialDebt.currentValue,
      };
    }

    return {
      shouldWake: false,
      triggerSignals: [],
    };
  }

  /**
   * Calculate adaptive threshold based on agent state.
   *
   * Low energy → higher threshold (harder to wake)
   * Low user availability → higher threshold (respect user)
   */
  private calculateAdaptiveThreshold(state: AgentState): number {
    let threshold = this.config.contactPressure;

    // Low energy makes it harder to contact
    if (state.energy < this.config.lowEnergy) {
      threshold *= this.config.lowEnergyMultiplier;
    }

    // Cap at reasonable maximum
    return Math.min(threshold, 0.95);
  }

  /**
   * Get current thresholds (for debugging).
   */
  getThresholds(): WakeThresholdConfig {
    return { ...this.config };
  }
}

/**
 * Create a threshold engine.
 */
export function createThresholdEngine(
  logger: Logger,
  config?: Partial<WakeThresholdConfig>
): ThresholdEngine {
  return new ThresholdEngine(logger, config);
}
