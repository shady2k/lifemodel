/**
 * Contact Pressure Neuron Plugin
 *
 * Calculates the combined pressure to contact the user using weighted factors.
 * This is a "higher-order" neuron that synthesizes multiple state variables
 * into a single pressure value.
 *
 * Like the feeling of "I should message them" that emerges from:
 * - Social debt (haven't talked in a while)
 * - Task pressure (have something to say)
 * - Curiosity (want to engage)
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { NeuronPluginV2 } from '../../types/plugin.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { detectChange, type ChangeDetectorConfig } from '../../layers/autonomic/change-detector.js';
import { Priority } from '../../types/priority.js';
import { neuron, type NeuronResult } from '../../core/utils/weighted-score.js';

/**
 * Configuration for contact pressure neuron.
 */
export interface ContactPressureNeuronConfig {
  /** Change detection config (Weber-Fechner) */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) */
  refractoryPeriodMs: number;

  /** Threshold for high priority (pressure is significant) */
  highPriorityThreshold: number;

  /** Weights for pressure calculation */
  weights: {
    socialDebt: number;
    taskPressure: number;
    curiosity: number;
    acquaintancePressure: number;
  };
}

/**
 * Default configuration.
 */
export const DEFAULT_CONTACT_PRESSURE_CONFIG: ContactPressureNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.1,
    minAbsoluteChange: 0.02,
    maxThreshold: 0.4,
    alertnessInfluence: 0.3,
  },
  refractoryPeriodMs: 5000,
  highPriorityThreshold: 0.6,
  weights: {
    socialDebt: 0.4,
    taskPressure: 0.2,
    curiosity: 0.1,
    acquaintancePressure: 0.3,
  },
};

/**
 * Contact Pressure Neuron implementation.
 */
export class ContactPressureNeuron extends BaseNeuron {
  readonly id = 'contact-pressure';
  readonly signalType: SignalType = 'contact_pressure';
  readonly source: SignalSource = 'neuron.contact_pressure';
  readonly description = 'Calculates combined pressure to contact user';

  private readonly config: ContactPressureNeuronConfig;
  private lastNeuronResult: NeuronResult | undefined;

  constructor(logger: Logger, config: Partial<ContactPressureNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_CONTACT_PRESSURE_CONFIG, ...config };
  }

  check(state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    const result = this.calculatePressure(state);
    const currentValue = result.output;

    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      this.lastNeuronResult = result;
      if (currentValue > 0.1) {
        this.recordEmission();
        return this.createSignal(currentValue, result, 0, correlationId);
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

    if (!changeResult.isSignificant) {
      this.updatePrevious(currentValue);
      this.lastNeuronResult = result;
      return undefined;
    }

    const signal = this.createSignal(
      currentValue,
      result,
      changeResult.relativeChange,
      correlationId
    );
    const previousForLog = this.previousValue;

    this.updatePrevious(currentValue);
    this.lastNeuronResult = result;
    this.recordEmission();

    this.logger.debug(
      {
        previous: previousForLog,
        current: currentValue.toFixed(2),
        change: changeResult.relativeChange.toFixed(2),
        reason: changeResult.reason,
        contributions: result.contributions.map((c) => ({
          name: c.name,
          value: c.value.toFixed(2),
          contribution: c.contribution.toFixed(2),
        })),
      },
      'Contact pressure change detected'
    );

    return signal;
  }

  private calculatePressure(state: AgentState): NeuronResult {
    return neuron([
      { name: 'socialDebt', value: state.socialDebt, weight: this.config.weights.socialDebt },
      { name: 'taskPressure', value: state.taskPressure, weight: this.config.weights.taskPressure },
      { name: 'curiosity', value: state.curiosity, weight: this.config.weights.curiosity },
      {
        name: 'acquaintancePressure',
        value: state.acquaintancePressure,
        weight: this.config.weights.acquaintancePressure,
      },
    ]);
  }

  private createSignal(
    value: number,
    neuronResult: NeuronResult,
    rateOfChange: number,
    correlationId: string
  ): Signal {
    const priority = value >= this.config.highPriorityThreshold ? Priority.HIGH : Priority.NORMAL;

    const metrics: SignalMetrics = {
      value,
      rateOfChange,
      confidence: 1.0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    for (const contribution of neuronResult.contributions) {
      metrics[`contrib_${contribution.name}`] = contribution.contribution;
    }

    return createSignal(this.signalType, this.source, metrics, { priority, correlationId });
  }

  getLastNeuronResult(): NeuronResult | undefined {
    return this.lastNeuronResult;
  }
}

/**
 * Create a contact pressure neuron.
 */
export function createContactPressureNeuron(
  logger: Logger,
  config?: Partial<ContactPressureNeuronConfig>
): ContactPressureNeuron {
  return new ContactPressureNeuron(logger, config);
}

/**
 * Contact pressure neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'contact-pressure',
    name: 'Contact Pressure Neuron',
    version: '1.0.0',
    description: 'Calculates combined pressure to contact user',
    provides: [{ type: 'neuron', id: 'contact-pressure' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new ContactPressureNeuron(logger, config as Partial<ContactPressureNeuronConfig>),
    defaultConfig: DEFAULT_CONTACT_PRESSURE_CONFIG,
  },
};

export default plugin;
