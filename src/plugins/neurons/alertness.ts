/**
 * Alertness Neuron
 *
 * Monitors and calculates the agent's alertness level.
 * Alertness determines:
 * - How sensitive the agent is to signals
 * - What priority of signals get processed
 * - The effective threshold for waking COGNITION
 *
 * This is a synthesizing neuron that combines:
 * - Energy level
 * - Recent activity
 * - Time of day
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState, AlertnessMode } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { detectTransition } from '../../layers/autonomic/change-detector.js';
import { Priority } from '../../types/priority.js';
import { neuron, type NeuronResult } from '../../core/utils/weighted-score.js';

/**
 * Configuration for alertness neuron.
 */
export interface AlertnessNeuronConfig {
  /** Weights for alertness calculation */
  weights: {
    energy: number;
    recentActivity: number;
    timeOfDay: number;
  };

  /** Thresholds for mode transitions */
  modeThresholds: {
    alert: number; // Above this = alert
    normal: number; // Above this = normal
    relaxed: number; // Above this = relaxed, below = sleep
  };

  /** Minimum interval between mode change emissions (ms) */
  modeChangeRefractoryMs: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_ALERTNESS_CONFIG: AlertnessNeuronConfig = {
  weights: {
    energy: 0.4, // Primary factor
    recentActivity: 0.3,
    timeOfDay: 0.3,
  },
  modeThresholds: {
    alert: 0.8,
    normal: 0.5,
    relaxed: 0.25,
  },
  modeChangeRefractoryMs: 10000, // 10 seconds between mode changes
};

/**
 * Alertness Neuron implementation.
 */
export class AlertnessNeuron extends BaseNeuron {
  readonly id = 'alertness';
  readonly signalType: SignalType = 'alertness';
  readonly source: SignalSource = 'neuron.alertness';
  readonly description = 'Calculates agent alertness level';

  private readonly config: AlertnessNeuronConfig;
  private lastMode: AlertnessMode | undefined;
  private lastModeChangeAt: Date | undefined;
  // Note: lastNeuronResult tracked for debugging but not currently exposed
  private _lastNeuronResult: NeuronResult | undefined;
  private recentActivityLevel = 0.5; // Track activity between ticks

  constructor(logger: Logger, config: Partial<AlertnessNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_ALERTNESS_CONFIG, ...config };
  }

  check(state: AgentState, _alertness: number, correlationId: string): Signal | undefined {
    // Calculate current alertness
    const result = this.calculateAlertness(state);
    const currentValue = result.output;
    const currentMode = this.valueToMode(currentValue);

    // First check - establish baseline
    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      this.lastMode = currentMode;
      this._lastNeuronResult = result;
      return this.createSignal(currentValue, currentMode, result, correlationId);
    }

    // Check for mode transition
    const modeChanged = detectTransition(currentMode, this.lastMode);

    // Check refractory period for mode changes
    const canEmitModeChange =
      !this.lastModeChangeAt ||
      Date.now() - this.lastModeChangeAt.getTime() >= this.config.modeChangeRefractoryMs;

    if (modeChanged && canEmitModeChange) {
      const signal = this.createSignal(currentValue, currentMode, result, correlationId);

      this.updatePrevious(currentValue);
      this.lastMode = currentMode;
      this.lastModeChangeAt = new Date();
      this._lastNeuronResult = result;
      this.recordEmission();

      this.logger.info(
        {
          previousMode: this.lastMode,
          currentMode,
          alertnessValue: currentValue.toFixed(2),
        },
        'Alertness mode changed'
      );

      return signal;
    }

    // Update tracking even if no signal emitted
    this.updatePrevious(currentValue);
    this.lastMode = currentMode;
    this._lastNeuronResult = result;

    return undefined;
  }

  /**
   * Calculate alertness using weighted factors.
   */
  private calculateAlertness(state: AgentState): NeuronResult {
    // Get time of day factor (0-1)
    const hour = new Date().getHours();
    const timeOfDayFactor = this.getTimeOfDayFactor(hour);

    return neuron([
      {
        name: 'energy',
        value: state.energy,
        weight: this.config.weights.energy,
      },
      {
        name: 'recentActivity',
        value: this.recentActivityLevel,
        weight: this.config.weights.recentActivity,
      },
      {
        name: 'timeOfDay',
        value: timeOfDayFactor,
        weight: this.config.weights.timeOfDay,
      },
    ]);
  }

  /**
   * Get time of day factor (higher during active hours).
   */
  private getTimeOfDayFactor(hour: number): number {
    // Peak alertness around noon, lowest at night
    // Rough approximation of circadian rhythm
    if (hour >= 22 || hour < 6) return 0.2; // Night
    if (hour >= 6 && hour < 9) return 0.6; // Early morning
    if (hour >= 9 && hour < 12) return 0.9; // Late morning
    if (hour >= 12 && hour < 14) return 0.8; // Early afternoon
    if (hour >= 14 && hour < 17) return 0.85; // Afternoon
    if (hour >= 17 && hour < 20) return 0.7; // Evening
    return 0.5; // Late evening (20-22)
  }

  /**
   * Convert alertness value to mode.
   */
  private valueToMode(value: number): AlertnessMode {
    if (value >= this.config.modeThresholds.alert) return 'alert';
    if (value >= this.config.modeThresholds.normal) return 'normal';
    if (value >= this.config.modeThresholds.relaxed) return 'relaxed';
    return 'sleep';
  }

  private createSignal(
    value: number,
    mode: AlertnessMode,
    result: NeuronResult,
    correlationId: string
  ): Signal {
    // Higher priority for significant mode changes
    const priority = mode === 'alert' || mode === 'sleep' ? Priority.NORMAL : Priority.LOW;

    const metrics: SignalMetrics = {
      value,
      confidence: 1.0,
      modeValue: this.modeToValue(mode),
    };

    // Add previousValue only if defined
    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    // Add contributions
    for (const contribution of result.contributions) {
      metrics[`contrib_${contribution.name}`] = contribution.contribution;
    }

    return createSignal(this.signalType, this.source, metrics, {
      priority,
      correlationId,
    });
  }

  /**
   * Convert mode to numeric value for metrics.
   */
  private modeToValue(mode: AlertnessMode): number {
    switch (mode) {
      case 'alert':
        return 1.0;
      case 'normal':
        return 0.66;
      case 'relaxed':
        return 0.33;
      case 'sleep':
      default:
        return 0;
    }
  }

  /**
   * Update recent activity level.
   * Call this when events are processed.
   */
  recordActivity(intensity = 0.1): void {
    // Activity adds to level, decays over time
    this.recentActivityLevel = Math.min(1, this.recentActivityLevel + intensity);
  }

  /**
   * Decay activity level.
   * Call this each tick.
   */
  decayActivity(decayFactor = 0.95): void {
    this.recentActivityLevel *= decayFactor;
  }

  /**
   * Get current calculated alertness (without emitting signal).
   */
  getCurrentAlertness(state: AgentState): number {
    return this.calculateAlertness(state).output;
  }

  /**
   * Get current mode (without emitting signal).
   */
  getCurrentMode(state: AgentState): AlertnessMode {
    return this.valueToMode(this.getCurrentAlertness(state));
  }

  /**
   * Get the last neuron result for debugging.
   */
  getLastNeuronResult(): NeuronResult | undefined {
    return this._lastNeuronResult;
  }

  reset(): void {
    super.reset();
    this.lastMode = undefined;
    this.lastModeChangeAt = undefined;
    this._lastNeuronResult = undefined;
    this.recentActivityLevel = 0.5;
  }
}

/**
 * Create an alertness neuron.
 */
export function createAlertnessNeuron(
  logger: Logger,
  config?: Partial<AlertnessNeuronConfig>
): AlertnessNeuron {
  return new AlertnessNeuron(logger, config);
}
