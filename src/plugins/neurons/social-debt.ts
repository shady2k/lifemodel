/**
 * Social Debt Neuron
 *
 * Monitors social debt accumulation and emits signals when it changes significantly.
 * Social debt represents the pressure from lack of interaction - like feeling
 * that you "should" reach out to someone.
 */

import type { Signal, SignalSource, SignalType, SignalMetrics } from '../../types/signal.js';
import { createSignal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';
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
    baseThreshold: 0.08, // 8% change is noticeable
    minAbsoluteChange: 0.02, // Ignore tiny changes
    maxThreshold: 0.3, // Don't become too insensitive
    alertnessInfluence: 0.3, // Alertness has mild effect
  },
  refractoryPeriodMs: 5000, // Don't emit more than every 5 seconds
  highPriorityThreshold: 0.7, // High priority when debt is high
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

    // First check - establish baseline
    if (this.previousValue === undefined) {
      this.updatePrevious(currentValue);
      // Emit initial signal if debt is significant
      if (currentValue > 0.1) {
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

    if (!changeResult.isSignificant) {
      // Still update previous to track gradual changes
      this.updatePrevious(currentValue);
      return undefined;
    }

    // Significant change detected - emit signal
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
    // High priority if debt is high
    const priority = value >= this.config.highPriorityThreshold ? Priority.HIGH : Priority.NORMAL;

    const metrics: SignalMetrics = {
      value,
      rateOfChange,
      confidence: 1.0, // We're certain about our own state
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
 * Create a social debt neuron.
 */
export function createSocialDebtNeuron(
  logger: Logger,
  config?: Partial<SocialDebtNeuronConfig>
): SocialDebtNeuron {
  return new SocialDebtNeuron(logger, config);
}
