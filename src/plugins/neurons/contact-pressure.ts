/**
 * Contact Pressure Neuron
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
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { Priority } from '../../types/priority.js';
import { neuron, type NeuronResult } from '../../core/utils/weighted-score.js';

/**
 * Configuration for contact pressure neuron.
 */
export interface ContactPressureNeuronConfig {
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
  refractoryPeriodMs: 5000,
  highPriorityThreshold: 0.6,
  weights: {
    socialDebt: 0.4, // Primary driver
    taskPressure: 0.2,
    curiosity: 0.1,
    acquaintancePressure: 0.3, // Want to learn user's name
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

  check(state: AgentState, _alertness: number, correlationId: string): Signal | undefined {
    // Calculate pressure using weighted neuron
    const result = this.calculatePressure(state);
    const currentValue = result.output;

    // Check refractory period to avoid signal spam
    if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
      return undefined;
    }

    // Emit signal with current pressure value
    // Aggregation layer decides what's significant, not the neuron
    const signal = this.createSignal(currentValue, result, correlationId);

    this.updatePrevious(currentValue);
    this.lastNeuronResult = result;
    this.recordEmission();

    this.logger.trace(
      {
        pressure: currentValue.toFixed(2),
        contributions: result.contributions.map((c) => ({
          name: c.name,
          value: c.value.toFixed(2),
          contribution: c.contribution.toFixed(2),
        })),
      },
      'Contact pressure emitted'
    );

    return signal;
  }

  /**
   * Calculate pressure using weighted neuron function.
   */
  private calculatePressure(state: AgentState): NeuronResult {
    return neuron([
      {
        name: 'socialDebt',
        value: state.socialDebt,
        weight: this.config.weights.socialDebt,
      },
      {
        name: 'taskPressure',
        value: state.taskPressure,
        weight: this.config.weights.taskPressure,
      },
      {
        name: 'curiosity',
        value: state.curiosity,
        weight: this.config.weights.curiosity,
      },
      {
        name: 'acquaintancePressure',
        value: state.acquaintancePressure,
        weight: this.config.weights.acquaintancePressure,
      },
    ]);
  }

  private createSignal(value: number, neuronResult: NeuronResult, correlationId: string): Signal {
    const priority = value >= this.config.highPriorityThreshold ? Priority.HIGH : Priority.NORMAL;

    // Include contribution breakdown in metrics
    const metrics: SignalMetrics = {
      value,
      confidence: 1.0,
    };

    // Add previousValue only if defined
    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    // Add individual contributions
    for (const contribution of neuronResult.contributions) {
      metrics[`contrib_${contribution.name}`] = contribution.contribution;
    }

    return createSignal(this.signalType, this.source, metrics, {
      priority,
      correlationId,
    });
  }

  /**
   * Get the last neuron result for debugging.
   */
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
