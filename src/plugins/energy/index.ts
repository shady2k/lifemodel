/**
 * Energy Neuron Plugin
 *
 * Monitors agent's energy level and emits signals when it changes significantly.
 * Energy affects the agent's capacity to engage - like human tiredness.
 *
 * Low energy:
 * - Higher thresholds for action (harder to motivate)
 * - Longer tick intervals (conserve resources)
 * - Less sensitive to non-critical signals
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { NeuronPluginV2 } from '../../types/plugin.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { detectChange, type ChangeDetectorConfig } from '../../layers/autonomic/change-detector.js';
import { Priority } from '../../types/priority.js';

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
    baseThreshold: 0.1,
    minAbsoluteChange: 0.03,
    maxThreshold: 0.25,
    alertnessInfluence: 0.2,
  },
  refractoryPeriodMs: 3000,
  lowEnergyThreshold: 0.3,
  criticalEnergyThreshold: 0.1,
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

    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      if (currentValue < this.config.lowEnergyThreshold) {
        return this.createSignal(currentValue, 0, correlationId);
      }
      return undefined;
    }

    if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
      return undefined;
    }

    const changeResult = detectChange(
      currentValue,
      this.previousValue,
      alertness,
      this.config.changeConfig
    );

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

    const signal = this.createSignal(currentValue, changeResult.relativeChange, correlationId);
    const previousForLog = this.previousValue;

    this.updatePrevious(currentValue);
    this.recordEmission();

    this.logger.debug(
      {
        previous: previousForLog,
        current: currentValue,
        change: changeResult.relativeChange,
        crossedLow: crossedLowThreshold,
        crossedCritical: crossedCriticalThreshold,
      },
      'Energy change detected'
    );

    return signal;
  }

  private createSignal(value: number, rateOfChange: number, correlationId: string): Signal {
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
      isLow: value < this.config.lowEnergyThreshold ? 1 : 0,
      isCritical: value < this.config.criticalEnergyThreshold ? 1 : 0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    return createSignal(this.signalType, this.source, metrics, { priority, correlationId });
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

/**
 * Energy neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'energy',
    name: 'Energy Neuron',
    version: '1.0.0',
    description: 'Monitors agent energy level',
    provides: [{ type: 'neuron', id: 'energy' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new EnergyNeuron(logger, config as Partial<EnergyNeuronConfig>),
    defaultConfig: DEFAULT_ENERGY_CONFIG,
  },
};

export default plugin;
