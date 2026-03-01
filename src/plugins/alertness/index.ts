/**
 * Alertness Neuron Plugin
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
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
import type { NeuronPluginV2, PluginPrimitives } from '../../types/plugin.js';
import { BaseNeuron } from '../../layers/autonomic/neuron-registry.js';
import { Priority } from '../../types/priority.js';
import { neuron, type NeuronResult } from '../../core/utils/weighted-score.js';
import { DateTime } from 'luxon';
import type { IAlertness } from '../../ports/alertness.js';

/** Module-level reference captured during activation (same pattern as calories plugin). */
let pluginPrimitives: PluginPrimitives | null = null;

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
};

/**
 * Alertness Neuron implementation.
 */
export class AlertnessNeuron extends BaseNeuron implements IAlertness {
  readonly id = 'alertness';
  readonly signalType: SignalType = 'alertness';
  readonly source: SignalSource = 'neuron.alertness';
  readonly description = 'Calculates agent alertness level';

  private readonly config: AlertnessNeuronConfig;
  private readonly getTimezone: () => string;
  private _lastNeuronResult: NeuronResult | undefined;
  private recentActivityLevel = 0.5;

  constructor(
    logger: Logger,
    config: Partial<AlertnessNeuronConfig> = {},
    getTimezone?: () => string
  ) {
    super(logger);
    this.config = { ...DEFAULT_ALERTNESS_CONFIG, ...config };
    this.getTimezone = getTimezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  check(state: AgentState, _alertness: number, correlationId: string): Signal | undefined {
    const result = this.calculateAlertness(state);
    const currentValue = result.output;

    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      this._lastNeuronResult = result;
      return this.createSignal(currentValue, result, correlationId);
    }

    // Emit on significant change (>0.15 delta)
    const delta = Math.abs(currentValue - this.previousValue);
    if (delta > 0.15) {
      const signal = this.createSignal(currentValue, result, correlationId);
      this.updatePrevious(currentValue);
      this._lastNeuronResult = result;
      this.recordEmission();
      return signal;
    }

    this.updatePrevious(currentValue);
    this._lastNeuronResult = result;
    return undefined;
  }

  private calculateAlertness(state: AgentState): NeuronResult {
    const hour = DateTime.now().setZone(this.getTimezone()).hour;
    const timeOfDayFactor = this.getTimeOfDayFactor(hour);

    return neuron([
      { name: 'energy', value: state.energy, weight: this.config.weights.energy },
      {
        name: 'recentActivity',
        value: this.recentActivityLevel,
        weight: this.config.weights.recentActivity,
      },
      { name: 'timeOfDay', value: timeOfDayFactor, weight: this.config.weights.timeOfDay },
    ]);
  }

  private getTimeOfDayFactor(hour: number): number {
    if (hour >= 22 || hour < 6) return 0.2;
    if (hour >= 6 && hour < 9) return 0.6;
    if (hour >= 9 && hour < 12) return 0.9;
    if (hour >= 12 && hour < 14) return 0.8;
    if (hour >= 14 && hour < 17) return 0.85;
    if (hour >= 17 && hour < 20) return 0.7;
    return 0.5;
  }

  private createSignal(value: number, result: NeuronResult, correlationId: string): Signal {
    const metrics: SignalMetrics = {
      value,
      confidence: 1.0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    for (const contribution of result.contributions) {
      metrics[`contrib_${contribution.name}`] = contribution.contribution;
    }

    return createSignal(this.signalType, this.source, metrics, {
      priority: Priority.LOW,
      correlationId,
    });
  }

  recordActivity(intensity = 0.1): void {
    this.recentActivityLevel = Math.min(1, this.recentActivityLevel + intensity);
  }

  decayActivity(decayFactor = 0.95): void {
    this.recentActivityLevel *= decayFactor;
  }

  getCurrentAlertness(state: AgentState): number {
    return this.calculateAlertness(state).output;
  }

  getLastNeuronResult(): NeuronResult | undefined {
    return this._lastNeuronResult;
  }

  reset(): void {
    super.reset();
    this._lastNeuronResult = undefined;
    this.recentActivityLevel = 0.5;
  }
}

/**
 * Create an alertness neuron.
 */
export function createAlertnessNeuron(
  logger: Logger,
  config?: Partial<AlertnessNeuronConfig>,
  getTimezone?: () => string
): AlertnessNeuron {
  return new AlertnessNeuron(logger, config, getTimezone);
}

/**
 * Alertness neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'alertness',
    name: 'Alertness Neuron',
    version: '1.0.0',
    description: 'Monitors agent alertness level for sensitivity adjustment',
    provides: [{ type: 'neuron', id: 'alertness' }],
    requires: [],
  },
  lifecycle: {
    activate: (primitives: PluginPrimitives) => {
      pluginPrimitives = primitives;
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) => {
      const primitives = pluginPrimitives;
      const getTimezone = primitives ? () => primitives.services.getTimezone() : undefined;
      return new AlertnessNeuron(logger, config as Partial<AlertnessNeuronConfig>, getTimezone);
    },
    defaultConfig: DEFAULT_ALERTNESS_CONFIG,
  },
};

export default plugin;
