/**
 * AUTONOMIC Layer Processor
 *
 * The autonomic nervous system of the agent. Runs every tick, monitors
 * state through neurons, and emits signals when meaningful changes occur.
 *
 * Like the biological autonomic system:
 * - Always running in background
 * - No conscious control needed
 * - Monitors vital signs (energy, pressure, alertness)
 * - Responds to external stimuli via sensory signals
 *
 * Zero LLM cost - pure algorithmic processing.
 */

import type { Signal } from '../../types/signal.js';
import type { Intent } from '../../types/intent.js';
import type { AgentState } from '../../types/agent/state.js';
import type { AutonomicLayer, AutonomicResult } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';
import type { NeuronRegistry } from './neuron-registry.js';
import { createNeuronRegistry } from './neuron-registry.js';
import {
  createSocialDebtNeuron,
  createEnergyNeuron,
  createContactPressureNeuron,
  createTimeNeuron,
  createAlertnessNeuron,
  type AlertnessNeuron,
} from './neurons/index.js';

/**
 * Configuration for AUTONOMIC processor.
 */
export interface AutonomicProcessorConfig {
  /** Enable/disable specific neurons */
  enabledNeurons: {
    socialDebt: boolean;
    energy: boolean;
    contactPressure: boolean;
    time: boolean;
    alertness: boolean;
  };

  /** Energy drain per incoming signal processed */
  energyDrainPerSignal: number;

  /** Energy drain per neuron signal emitted */
  energyDrainPerNeuron: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: AutonomicProcessorConfig = {
  enabledNeurons: {
    socialDebt: true,
    energy: true,
    contactPressure: true,
    time: true,
    alertness: true,
  },
  energyDrainPerSignal: 0.001,
  energyDrainPerNeuron: 0.0005,
};

/**
 * AUTONOMIC layer processor implementation.
 */
export class AutonomicProcessor implements AutonomicLayer {
  readonly name = 'autonomic' as const;

  private readonly registry: NeuronRegistry;
  private readonly logger: Logger;
  private readonly config: AutonomicProcessorConfig;
  private alertnessNeuron: AlertnessNeuron | undefined;

  constructor(logger: Logger, config: Partial<AutonomicProcessorConfig> = {}) {
    this.logger = logger.child({ layer: 'autonomic' });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = createNeuronRegistry(this.logger);

    this.initializeNeurons();
  }

  /**
   * Initialize all enabled neurons.
   */
  private initializeNeurons(): void {
    const { enabledNeurons } = this.config;

    if (enabledNeurons.alertness) {
      this.alertnessNeuron = createAlertnessNeuron(this.logger);
      this.registry.register(this.alertnessNeuron);
    }

    if (enabledNeurons.socialDebt) {
      this.registry.register(createSocialDebtNeuron(this.logger));
    }

    if (enabledNeurons.energy) {
      this.registry.register(createEnergyNeuron(this.logger));
    }

    if (enabledNeurons.contactPressure) {
      this.registry.register(createContactPressureNeuron(this.logger));
    }

    if (enabledNeurons.time) {
      this.registry.register(createTimeNeuron(this.logger));
    }

    this.logger.info({ neuronCount: this.registry.size() }, 'AUTONOMIC layer initialized');
  }

  /**
   * Process a tick - check all neurons and emit signals.
   *
   * @param state Current agent state
   * @param incomingSignals Signals from sensory organs (channels)
   * @param correlationId Tick correlation ID
   * @returns Signals emitted by neurons + state intents
   */
  process(state: AgentState, incomingSignals: Signal[], correlationId: string): AutonomicResult {
    const startTime = Date.now();

    // Get current alertness for sensitivity adjustment
    const alertness = this.alertnessNeuron ? this.alertnessNeuron.getCurrentAlertness(state) : 0.5;

    // Decay activity in alertness neuron
    if (this.alertnessNeuron) {
      this.alertnessNeuron.decayActivity();
    }

    // Record activity from incoming signals
    if (this.alertnessNeuron && incomingSignals.length > 0) {
      // User messages are high activity
      const userMessageCount = incomingSignals.filter((s) => s.type === 'user_message').length;
      if (userMessageCount > 0) {
        this.alertnessNeuron.recordActivity(0.3 * userMessageCount);
      }
      // Other signals are mild activity
      const otherSignalCount = incomingSignals.length - userMessageCount;
      if (otherSignalCount > 0) {
        this.alertnessNeuron.recordActivity(0.05 * otherSignalCount);
      }
    }

    // Check all neurons
    const neuronSignals = this.registry.checkAll(state, alertness, correlationId);

    // Combine with incoming sensory signals
    const allSignals = [...incomingSignals, ...neuronSignals];

    // Generate state update intents (e.g., energy drain from processing)
    const intents = this.generateIntents(incomingSignals.length, neuronSignals.length);

    const duration = Date.now() - startTime;

    this.logger.trace(
      {
        incomingSignals: incomingSignals.length,
        neuronSignals: neuronSignals.length,
        totalSignals: allSignals.length,
        alertness: alertness.toFixed(2),
        duration,
      },
      'AUTONOMIC tick complete'
    );

    return {
      signals: allSignals,
      intents,
    };
  }

  /**
   * Generate intents based on processing activity.
   */
  private generateIntents(incomingCount: number, neuronCount: number): Intent[] {
    const intents: Intent[] = [];

    // Processing drains energy (very small amount per signal)
    const energyDrain =
      incomingCount * this.config.energyDrainPerSignal +
      neuronCount * this.config.energyDrainPerNeuron;
    if (energyDrain > 0) {
      intents.push({
        type: 'UPDATE_STATE',
        payload: {
          key: 'energy',
          value: -energyDrain,
          delta: true,
        },
      });
    }

    return intents;
  }

  /**
   * Get the neuron registry (for testing/debugging).
   */
  getRegistry(): NeuronRegistry {
    return this.registry;
  }

  /**
   * Get current alertness value.
   */
  getAlertness(state: AgentState): number {
    return this.alertnessNeuron ? this.alertnessNeuron.getCurrentAlertness(state) : 0.5;
  }

  /**
   * Reset all neurons.
   */
  reset(): void {
    this.registry.resetAll();
    this.logger.debug('AUTONOMIC layer reset');
  }
}

/**
 * Create an AUTONOMIC processor.
 */
export function createAutonomicProcessor(
  logger: Logger,
  config?: Partial<AutonomicProcessorConfig>
): AutonomicProcessor {
  return new AutonomicProcessor(logger, config);
}
