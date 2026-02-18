/**
 * Desire Pressure Neuron Plugin
 *
 * Emits signals based on the agent's desire pressure - the combined
 * intensity of active wants. This drives proactive behavior through
 * wanting, not guilt.
 *
 * Unlike social debt (which is guilt-driven), desire pressure creates
 * positive motivation: "I want to learn about their new job" vs
 * "I should message them because it's been too long."
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
 * Configuration for desire pressure neuron.
 */
export interface DesirePressureNeuronConfig {
  /** Change detection config (Weber-Fechner) */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) */
  refractoryPeriodMs: number;

  /** Threshold for high priority (desire is strong) */
  highPriorityThreshold: number;

  /** Minimum pressure to emit signals (0-1). Below this, no signals are emitted. */
  emitThreshold: number;

  /** If true, continuously emit while pressure is above emitThreshold (respecting refractory period) */
  emitWhileAbove: boolean;
}

/**
 * Default configuration.
 */
export const DEFAULT_DESIRE_PRESSURE_CONFIG: DesirePressureNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.1,
    minAbsoluteChange: 0.05,
    maxThreshold: 0.4,
    alertnessInfluence: 0.3,
  },
  refractoryPeriodMs: 60000, // 1 minute - desires change more slowly
  highPriorityThreshold: 0.6,
  emitThreshold: 0.2,
  emitWhileAbove: true,
};

/**
 * Desire Pressure Neuron implementation.
 */
export class DesirePressureNeuron extends BaseNeuron {
  readonly id = 'desire-pressure';
  readonly signalType: SignalType = 'desire_pressure';
  readonly source: SignalSource = 'neuron.desire_pressure';
  readonly description = 'Emits signals based on active desire intensity';

  private readonly config: DesirePressureNeuronConfig;
  private wasAboveEmitThreshold = false;
  private wasHighPriority = false;

  constructor(logger: Logger, config: Partial<DesirePressureNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_DESIRE_PRESSURE_CONFIG, ...config };
  }

  check(state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    const currentValue = state.desirePressure;

    // First check: emit if above emit threshold (initial state)
    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      if (currentValue >= this.config.emitThreshold) {
        this.recordEmission();
        this.logTransitions(currentValue);
        return this.createSignal(currentValue, 0, correlationId);
      }
      return undefined;
    }

    // Refractory period check - prevents signal spam
    if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
      return undefined;
    }

    // Continuous emission: emit while above threshold
    if (this.config.emitWhileAbove && currentValue >= this.config.emitThreshold) {
      const rateOfChange = currentValue - this.previousValue;

      // Stable value: use longer keep-alive interval
      if (rateOfChange === 0 && this.isInRefractoryPeriod(this.config.refractoryPeriodMs * 12)) {
        this.updatePrevious(currentValue);
        return undefined;
      }

      const signal = this.createSignal(currentValue, rateOfChange, correlationId);
      const previousForLog = this.previousValue;

      this.updatePrevious(currentValue);
      this.recordEmission();
      this.logTransitions(currentValue);

      this.logger.trace(
        {
          previous: previousForLog,
          current: currentValue.toFixed(2),
          emitReason: rateOfChange === 0 ? 'keep_alive' : 'above_threshold',
        },
        'Desire pressure emitting (above threshold)'
      );

      return signal;
    }

    // Also emit on significant change (Weber-Fechner for observability)
    const changeResult = detectChange(
      currentValue,
      this.previousValue,
      alertness,
      this.config.changeConfig
    );

    if (changeResult.isSignificant) {
      const rateOfChange = currentValue - this.previousValue;
      const signal = this.createSignal(currentValue, rateOfChange, correlationId);
      const previousForLog = this.previousValue;

      this.updatePrevious(currentValue);
      this.recordEmission();
      this.logTransitions(currentValue);

      this.logger.trace(
        {
          previous: previousForLog,
          current: currentValue.toFixed(2),
          change: changeResult.relativeChange.toFixed(2),
          emitReason: changeResult.reason,
        },
        'Desire pressure change detected'
      );

      return signal;
    }

    // Log transition below threshold
    if (this.wasAboveEmitThreshold && currentValue < this.config.emitThreshold) {
      this.logger.debug(
        { current: currentValue.toFixed(2), threshold: this.config.emitThreshold },
        'Desire pressure dropped below emit threshold'
      );
      this.wasAboveEmitThreshold = false;
    }

    this.updatePrevious(currentValue);
    return undefined;
  }

  private logTransitions(currentValue: number): void {
    const isAbove = currentValue >= this.config.emitThreshold;
    const isHighPriority = currentValue >= this.config.highPriorityThreshold;

    // Crossed above emit threshold
    if (isAbove && !this.wasAboveEmitThreshold) {
      this.logger.debug(
        {
          current: currentValue.toFixed(2),
          threshold: this.config.emitThreshold,
        },
        'Desire pressure crossed above emit threshold'
      );
    }

    // Crossed into high priority
    if (isHighPriority && !this.wasHighPriority) {
      this.logger.debug(
        {
          current: currentValue.toFixed(2),
          threshold: this.config.highPriorityThreshold,
        },
        'Desire pressure reached HIGH priority'
      );
    }

    // Dropped out of high priority
    if (!isHighPriority && this.wasHighPriority) {
      this.logger.debug(
        { current: currentValue.toFixed(2), threshold: this.config.highPriorityThreshold },
        'Desire pressure dropped below high priority'
      );
    }

    this.wasAboveEmitThreshold = isAbove;
    this.wasHighPriority = isHighPriority;
  }

  private createSignal(value: number, rateOfChange: number, correlationId: string): Signal {
    const priority = value >= this.config.highPriorityThreshold ? Priority.HIGH : Priority.NORMAL;

    const metrics: SignalMetrics = {
      value,
      rateOfChange,
      confidence: 1.0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    return createSignal(this.signalType, this.source, metrics, { priority, correlationId });
  }
}

/**
 * Create a desire pressure neuron.
 */
export function createDesirePressureNeuron(
  logger: Logger,
  config?: Partial<DesirePressureNeuronConfig>
): DesirePressureNeuron {
  return new DesirePressureNeuron(logger, config);
}

/**
 * Desire pressure neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'desire-pressure',
    name: 'Desire Pressure Neuron',
    version: '1.0.0',
    description: 'Emits signals based on active desire intensity',
    provides: [{ type: 'neuron', id: 'desire-pressure' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new DesirePressureNeuron(logger, config as Partial<DesirePressureNeuronConfig>),
    defaultConfig: DEFAULT_DESIRE_PRESSURE_CONFIG,
  },
};

export default plugin;
