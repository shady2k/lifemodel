/**
 * Thoughts Neuron Plugin
 *
 * Monitors agent's thought pressure and emits signals when it changes significantly.
 * Thought pressure represents the cognitive load from unprocessed thoughts.
 *
 * Based on the Zeigarnik Effect: incomplete tasks/thoughts persist in memory
 * and create cognitive pressure until processed.
 *
 * High thought pressure:
 * - Agent has a lot on their mind
 * - May want to process or share thoughts
 * - Can trigger proactive COGNITION wake
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
 * Configuration for thoughts neuron.
 */
export interface ThoughtsNeuronConfig {
  /** Change detection config */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) */
  refractoryPeriodMs: number;

  /** Threshold for moderate thought pressure (triggers logging) */
  moderatePressureThreshold: number;

  /** Threshold for high thought pressure (HIGH priority signal) */
  highPressureThreshold: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_THOUGHTS_CONFIG: ThoughtsNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.15, // 15% relative change (thoughts accumulate slowly)
    minAbsoluteChange: 0.05, // Need at least 5% absolute change
    maxThreshold: 0.3,
    alertnessInfluence: 0.2, // Alertness has modest effect
  },
  refractoryPeriodMs: 5000, // 5 seconds minimum between emissions
  moderatePressureThreshold: 0.4, // 40%
  highPressureThreshold: 0.7, // 70%
};

/**
 * Thoughts Neuron implementation.
 *
 * Monitors thoughtPressure in AgentState and emits thought_pressure signals
 * when pressure changes significantly or crosses thresholds.
 */
export class ThoughtsNeuron extends BaseNeuron {
  readonly id = 'thoughts';
  readonly signalType: SignalType = 'thought_pressure';
  readonly source: SignalSource = 'neuron.thought_pressure';
  readonly description = 'Monitors thought pressure from accumulated unprocessed thoughts';

  private readonly config: ThoughtsNeuronConfig;

  constructor(logger: Logger, config: Partial<ThoughtsNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_THOUGHTS_CONFIG, ...config };
  }

  check(state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    const currentValue = state.thoughtPressure;

    // First tick - initialize but don't emit unless already high
    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      // Emit on first check if already under significant pressure
      if (currentValue >= this.config.moderatePressureThreshold) {
        return this.createSignal(currentValue, 0, state.pendingThoughtCount, correlationId);
      }
      return undefined;
    }

    // Check refractory period
    if (this.isInRefractoryPeriod(this.config.refractoryPeriodMs)) {
      return undefined;
    }

    // Use Weber-Fechner change detection
    const changeResult = detectChange(
      currentValue,
      this.previousValue,
      alertness,
      this.config.changeConfig
    );

    // Check for threshold crossings
    const crossedModerate =
      (this.previousValue < this.config.moderatePressureThreshold &&
        currentValue >= this.config.moderatePressureThreshold) ||
      (this.previousValue >= this.config.moderatePressureThreshold &&
        currentValue < this.config.moderatePressureThreshold);

    const crossedHigh =
      (this.previousValue < this.config.highPressureThreshold &&
        currentValue >= this.config.highPressureThreshold) ||
      (this.previousValue >= this.config.highPressureThreshold &&
        currentValue < this.config.highPressureThreshold);

    // Emit if change is significant OR crossed important thresholds
    if (!changeResult.isSignificant && !crossedModerate && !crossedHigh) {
      this.updatePrevious(currentValue);
      return undefined;
    }

    const signal = this.createSignal(
      currentValue,
      changeResult.relativeChange,
      state.pendingThoughtCount,
      correlationId
    );
    const previousForLog = this.previousValue;

    this.updatePrevious(currentValue);
    this.recordEmission();

    this.logger.debug(
      {
        previous: previousForLog.toFixed(2),
        current: currentValue.toFixed(2),
        change: changeResult.relativeChange.toFixed(2),
        thoughtCount: state.pendingThoughtCount,
        crossedModerate,
        crossedHigh,
      },
      'Thought pressure change detected'
    );

    return signal;
  }

  private createSignal(
    value: number,
    rateOfChange: number,
    thoughtCount: number,
    correlationId: string
  ): Signal {
    // Priority based on pressure level
    let priority: Priority;
    if (value >= this.config.highPressureThreshold) {
      priority = Priority.HIGH; // High pressure - may want to process/share
    } else if (value >= this.config.moderatePressureThreshold) {
      priority = Priority.NORMAL;
    } else {
      priority = Priority.LOW;
    }

    const metrics: SignalMetrics = {
      value,
      rateOfChange,
      confidence: 1.0,
      thoughtCount,
      isModerate: value >= this.config.moderatePressureThreshold ? 1 : 0,
      isHigh: value >= this.config.highPressureThreshold ? 1 : 0,
    };

    if (this.previousValue !== undefined) {
      metrics.previousValue = this.previousValue;
    }

    return createSignal(this.signalType, this.source, metrics, { priority, correlationId });
  }
}

/**
 * Create a thoughts neuron.
 */
export function createThoughtsNeuron(
  logger: Logger,
  config?: Partial<ThoughtsNeuronConfig>
): ThoughtsNeuron {
  return new ThoughtsNeuron(logger, config);
}

/**
 * Thoughts neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'thoughts',
    name: 'Thoughts Neuron',
    version: '1.0.0',
    description:
      'Monitors thought pressure from accumulated unprocessed thoughts (Zeigarnik Effect)',
    provides: [{ type: 'neuron', id: 'thoughts' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new ThoughtsNeuron(logger, config as Partial<ThoughtsNeuronConfig>),
    defaultConfig: DEFAULT_THOUGHTS_CONFIG,
  },
};

export default plugin;
