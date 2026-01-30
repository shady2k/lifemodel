/**
 * Social Debt Neuron Plugin
 *
 * Monitors social debt accumulation and emits signals when it changes significantly.
 * Social debt represents the pressure from lack of interaction - like feeling
 * that you "should" reach out to someone.
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
 * Configuration for social debt neuron.
 */
export interface SocialDebtNeuronConfig {
  /** Change detection config */
  changeConfig: ChangeDetectorConfig;

  /** Minimum interval between emissions (ms) */
  refractoryPeriodMs: number;

  /** Threshold for high priority signal */
  highPriorityThreshold: number;
}

/**
 * Default configuration.
 */
export const DEFAULT_SOCIAL_DEBT_CONFIG: SocialDebtNeuronConfig = {
  changeConfig: {
    baseThreshold: 0.08,
    minAbsoluteChange: 0.02,
    maxThreshold: 0.3,
    alertnessInfluence: 0.3,
  },
  refractoryPeriodMs: 5000,
  highPriorityThreshold: 0.7,
};

/**
 * Social Debt Neuron implementation.
 */
export class SocialDebtNeuron extends BaseNeuron {
  readonly id = 'social-debt';
  readonly signalType: SignalType = 'social_debt';
  readonly source: SignalSource = 'neuron.social_debt';
  readonly description = 'Monitors social debt accumulation';

  private readonly config: SocialDebtNeuronConfig;

  constructor(logger: Logger, config: Partial<SocialDebtNeuronConfig> = {}) {
    super(logger);
    this.config = { ...DEFAULT_SOCIAL_DEBT_CONFIG, ...config };
  }

  check(state: AgentState, alertness: number, correlationId: string): Signal | undefined {
    const currentValue = state.socialDebt;

    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      if (currentValue > 0.1) {
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

    if (!changeResult.isSignificant) {
      this.updatePrevious(currentValue);
      return undefined;
    }

    const signal = this.createSignal(currentValue, changeResult.relativeChange, correlationId);

    this.updatePrevious(currentValue);
    this.recordEmission();

    this.logger.debug(
      {
        previous: this.previousValue,
        current: currentValue,
        change: changeResult.relativeChange,
        reason: changeResult.reason,
      },
      'Social debt change detected'
    );

    return signal;
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
 * Create a social debt neuron.
 */
export function createSocialDebtNeuron(
  logger: Logger,
  config?: Partial<SocialDebtNeuronConfig>
): SocialDebtNeuron {
  return new SocialDebtNeuron(logger, config);
}

/**
 * Social debt neuron plugin.
 */
const plugin: NeuronPluginV2 = {
  manifest: {
    manifestVersion: 2,
    id: 'social-debt',
    name: 'Social Debt Neuron',
    version: '1.0.0',
    description: 'Monitors social debt accumulation',
    provides: [{ type: 'neuron', id: 'social-debt' }],
    requires: [],
  },
  lifecycle: {
    activate: () => {
      // Neuron plugins don't need activation - neuron is created via factory
    },
  },
  neuron: {
    create: (logger: Logger, config?: unknown) =>
      new SocialDebtNeuron(logger, config as Partial<SocialDebtNeuronConfig>),
    defaultConfig: DEFAULT_SOCIAL_DEBT_CONFIG,
  },
};

export default plugin;
