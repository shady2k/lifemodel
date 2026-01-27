/**
 * Energy Neuron
 *
 * Monitors agent's energy level and emits signals when it changes significantly.
 * Energy affects the agent's capacity to engage - like human tiredness.
 *
 * Low energy:
 * - Higher thresholds for action (harder to motivate)
 * - Longer tick intervals (conserve resources)
 * - Less sensitive to non-critical signals
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../../types/signal.js';
import { createSignal } from '../../../types/signal.js';
import type { AgentState } from '../../../types/agent/state.js';
import type { Logger } from '../../../types/logger.js';
import { BaseNeuron } from '../neuron-registry.js';
import { detectChange, type ChangeDetectorConfig } from '../change-detector.js';
import { Priority } from '../../../types/priority.js';

/**
 * Configuration for energy neuron.
 */
export interface EnergyNeuronConfig {
  /** Change detection config */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) */
  refractoryPeriodMs: number;

  /** Threshold for low energy warning */
  lowEnergyThreshold: number;

  /** Threshold for critical energy (HIGH priority) */
  criticalEnergyThreshold: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_ENERGY_CONFIG: EnergyNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.10, // 10% change is noticeable
    minAbsoluteChange: 0.03, // Ignore tiny fluctuations
    maxThreshold: 0.25, // Don't become too insensitive
    alertnessInfluence: 0.2, // Alertness has mild effect on sensitivity
  },
  refractoryPeriodMs: 3000, // Can emit every 3 seconds
  lowEnergyThreshold: 0.3, // Below 30% is low
  criticalEnergyThreshold: 0.1, // Below 10% is critical
};

/**
 * Energy Neuron implementation.
 */
export class EnergyNeuron extends BaseNeuron {
  readonly id = 'energy';
  readonly signalType: SignalType = 'energy';
  readonly source: SignalSource = 'neuron.energy';
  readonly description = 'Monitors agent energy level';

  private readonly config: EnergyNeuronConfig;

  constructor(logger: Logger, config: Partial<EnergyNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_ENERGY_CONFIG, ...config };
  }

  check(state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    const currentValue = state.energy;

    // First check - establish baseline
    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      // Emit initial signal if energy is noteworthy
      if (currentValue < this.config.lowEnergyThreshold) {
        return this.createSignal(currentValue, 0, correlationId);
      }
      return undefined;
    }

    // Check refractory period
    if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
      return undefined;
    }

    // Detect if change is significant
    const changeResult = detectChange(
      currentValue,
      this.previousValue,
      alertness,
      this.config.changeConfig
    );

    // Also check for threshold crossings (even if change isn't "significant")
    const crossedLowThreshold =
      (this.previousValue >= this.config.lowEnergyThreshold &&
        currentValue < this.config.lowEnergyThreshold) ||
      (this.previousValue < this.config.lowEnergyThreshold &&
        currentValue >= this.config.lowEnergyThreshold);

    const crossedCriticalThreshold =
      (this.previousValue >= this.config.criticalEnergyThreshold &&
        currentValue < this.config.criticalEnergyThreshold) ||
      (this.previousValue < this.config.criticalEnergyThreshold &&
        currentValue >= this.config.criticalEnergyThreshold);

    if (!changeResult.isSignificant && !crossedLowThreshold && !crossedCriticalThreshold) {
      this.updatePrevious(currentValue);
      return undefined;
    }

    // Change detected - emit signal
    const signal = this.createSignal(
      currentValue,
      changeResult.relativeChange,
      correlationId
    );

    this.updatePrevious(currentValue);
    this.recordEmission();

    this.logger.debug(
      {
        previous: this.previousValue,
        current: currentValue,
        change: changeResult.relativeChange,
        crossedLow: crossedLowThreshold,
        crossedCritical: crossedCriticalThreshold,
      },
      'Energy change detected'
    );

    return signal;
  }

  private createSignal(
    value: number,
    rateOfChange: number,
    correlationId: string
  ): Signal {
    // Determine priority based on energy level
    let priority: Priority;
    if (value < this.config.criticalEnergyThreshold) {
      priority = Priority.HIGH;
    } else if (value < this.config.lowEnergyThreshold) {
      priority = Priority.NORMAL;
    } else {
      priority = Priority.LOW;
    }

    const metrics: SignalMetrics = {
      value,
      rateOfChange,
      confidence: 1.0,
      // Additional metrics
      isLow: value < this.config.lowEnergyThreshold ? 1 : 0,
      isCritical: value < this.config.criticalEnergyThreshold ? 1 : 0,
    };

    // Add previousValue only if defined
    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    return createSignal(this.signalType, this.source, metrics, {
      priority,
      correlationId,
    });
  }
}

/**
 * Create an energy neuron.
 */
export function createEnergyNeuron(
  logger: Logger,
  config?: Partial<EnergyNeuronConfig>
): EnergyNeuron {
  return new EnergyNeuron(logger, config);
}
