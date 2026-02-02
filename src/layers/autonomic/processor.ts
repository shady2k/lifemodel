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
 * Dynamic Registration:
 * - Neurons can be registered/unregistered at runtime
 * - Changes are queued and applied at tick boundaries
 * - AlertnessNeuron is validated after initial plugin loading
 *
 * Zero LLM cost - pure algorithmic processing.
 */

import type { Signal } from '../../types/signal.js';
import type { Intent } from '../../types/intent.js';
import type { AgentState } from '../../types/agent/state.js';
import type { AutonomicLayer, AutonomicResult } from '../../types/layers.js';
import type { Logger } from '../../types/logger.js';
import type { Neuron, NeuronRegistry } from './neuron-registry.js';
import { createNeuronRegistry } from './neuron-registry.js';
import type { AlertnessNeuron } from '../../plugins/alertness/index.js';
import type { FilterRegistry } from './filter-registry.js';
import {
  createFilterRegistry,
  type SignalFilter,
  type FilterContext,
  type FilterUserModel,
} from './filter-registry.js';

/**
 * Configuration for AUTONOMIC processor.
 */
export interface AutonomicProcessorConfig {
  /** Energy drain per incoming signal processed */
  energyDrainPerSignal: number;

  /** Energy drain per neuron signal emitted */
  energyDrainPerNeuron: number;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: AutonomicProcessorConfig = {
  energyDrainPerSignal: 0.001,
  energyDrainPerNeuron: 0.0005,
};

/**
 * AUTONOMIC layer processor implementation.
 *
 * Supports dynamic neuron registration via registerNeuron/unregisterNeuron.
 * Changes are queued and applied at the start of each tick to avoid
 * modifying the registry during iteration.
 */
export class AutonomicProcessor implements AutonomicLayer {
  readonly name = 'autonomic' as const;

  private readonly registry: NeuronRegistry;
  private readonly filterRegistry: FilterRegistry;
  private readonly logger: Logger;
  private readonly config: AutonomicProcessorConfig;

  /** AlertnessNeuron reference (required, but registered dynamically) */
  private alertnessNeuron: AlertnessNeuron | undefined;

  /** Whether validateRequiredNeurons() has been called */
  private alertnessValidated = false;

  /** Pending neuron registrations (applied at tick boundary) */
  private pendingRegistrations: Neuron[] = [];

  /** Pending neuron unregistrations by ID (applied at tick boundary) */
  private pendingUnregistrations: string[] = [];

  /** User model for filter context (injected via setUserModel) */
  private userModel: FilterUserModel | null = null;

  /** Primary recipient ID for filter context (used for routing urgent signals) */
  private primaryRecipientId: string | undefined;

  constructor(logger: Logger, config: Partial<AutonomicProcessorConfig> = {}) {
    this.logger = logger.child({ layer: 'autonomic' });
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = createNeuronRegistry(this.logger);
    this.filterRegistry = createFilterRegistry(this.logger);

    // No initializeNeurons() - neurons are registered dynamically via callbacks
    this.logger.info('AUTONOMIC layer created (awaiting neuron/filter registration)');
  }

  /**
   * Register a neuron dynamically (queued for next tick).
   * Called by PluginLoader when neuron plugins load.
   *
   * @param neuron The neuron instance to register
   */
  registerNeuron(neuron: Neuron): void {
    this.pendingRegistrations.push(neuron);
    this.logger.debug({ neuronId: neuron.id }, 'Neuron queued for registration');
  }

  /**
   * Unregister a neuron dynamically (queued for next tick).
   * Called by PluginLoader when neuron plugins unload/pause.
   *
   * @param id The neuron ID to unregister
   */
  unregisterNeuron(id: string): void {
    if (!this.pendingUnregistrations.includes(id)) {
      this.pendingUnregistrations.push(id);
      this.logger.debug({ neuronId: id }, 'Neuron queued for unregistration');
    }
  }

  // ============================================================
  // Signal Filter Registration
  // ============================================================

  /**
   * Register a signal filter.
   * Called by plugins to add signal transformation/classification.
   *
   * @param filter The filter to register
   * @param priority Optional priority (lower = runs first)
   */
  registerFilter(filter: SignalFilter, priority?: number): void {
    this.filterRegistry.register(filter, priority);
  }

  /**
   * Unregister a signal filter.
   */
  unregisterFilter(id: string): boolean {
    return this.filterRegistry.unregister(id);
  }

  /**
   * Set the user model for filter context.
   * Called by container after creation to wire up dependencies.
   *
   * @param userModel The user model (or null if not configured)
   */
  setUserModel(userModel: FilterUserModel | null): void {
    this.userModel = userModel;
    this.logger.debug({ hasUserModel: !!userModel }, 'User model set for filters');
  }

  /**
   * Set the primary recipient ID for filter context.
   * Used by filters to set recipientId on urgent signals for routing.
   *
   * @param recipientId The primary recipient ID (or undefined if not configured)
   */
  setPrimaryRecipientId(recipientId: string | undefined): void {
    this.primaryRecipientId = recipientId;
    this.logger.debug({ primaryRecipientId: recipientId }, 'Primary recipient ID set for filters');
  }

  /**
   * Apply pending registrations/unregistrations.
   * Called at START of process() to avoid mutation during iteration.
   *
   * Order: unregistrations first, then registrations (allows replace-in-place).
   */
  applyPendingChanges(): void {
    // FIRST: Process all unregistrations
    for (const id of this.pendingUnregistrations) {
      try {
        this.registry.unregister(id);
        if (id === 'alertness') {
          this.alertnessNeuron = undefined;
          this.logger.warn('AlertnessNeuron unregistered');
        }
      } catch (error) {
        this.logger.error(
          { neuronId: id, error: error instanceof Error ? error.message : String(error) },
          'Failed to unregister neuron'
        );
      }
    }
    this.pendingUnregistrations = [];

    // THEN: Process all registrations
    for (const neuron of this.pendingRegistrations) {
      try {
        this.registry.register(neuron);

        // Track AlertnessNeuron specially
        if (neuron.id === 'alertness') {
          this.alertnessNeuron = neuron as AlertnessNeuron;
          this.logger.info('AlertnessNeuron registered');
        }

        this.logger.debug({ neuronId: neuron.id }, 'Neuron registered');
      } catch (error) {
        this.logger.error(
          { neuronId: neuron.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to register neuron'
        );
      }
    }
    this.pendingRegistrations = [];
  }

  /**
   * Validate that required neurons are registered.
   * Called after initial plugin loading completes.
   *
   * @throws Error if AlertnessNeuron is not registered
   */
  validateRequiredNeurons(): void {
    // Apply any pending registrations first
    this.applyPendingChanges();

    if (!this.alertnessNeuron) {
      throw new Error(
        'AlertnessNeuron not registered - this neuron is required. ' +
          'Ensure the alertness plugin is enabled in plugins configuration.'
      );
    }

    this.alertnessValidated = true;
    this.logger.info(
      { neuronCount: this.registry.size() },
      'Required neurons validated, AUTONOMIC layer ready'
    );
  }

  /**
   * Check if required neurons have been validated.
   */
  isValidated(): boolean {
    return this.alertnessValidated;
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

    // Apply queued changes at start of tick (before any iteration)
    this.applyPendingChanges();

    // AlertnessNeuron must be present after validation
    if (!this.alertnessNeuron) {
      throw new Error(
        'AlertnessNeuron missing - cannot process tick. ' +
          'Call validateRequiredNeurons() after loading plugins.'
      );
    }

    // Get current alertness for sensitivity adjustment
    const alertness = this.alertnessNeuron.getCurrentAlertness(state);

    // Decay activity in alertness neuron
    this.alertnessNeuron.decayActivity();

    // Record activity from incoming signals
    if (incomingSignals.length > 0) {
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

    // Build filter context with user model and primary recipient
    const filterContext: FilterContext = {
      state,
      alertness,
      correlationId,
      userModel: this.userModel,
      primaryRecipientId: this.primaryRecipientId,
    };

    // Run incoming signals through filters (transform/classify)
    const filteredSignals = this.filterRegistry.process(incomingSignals, filterContext);

    // Combine filtered incoming signals with neuron signals
    const allSignals = [...filteredSignals, ...neuronSignals];

    // Generate state update intents (e.g., energy drain from processing)
    const intents = this.generateIntents(incomingSignals.length, neuronSignals.length);

    const duration = Date.now() - startTime;

    this.logger.trace(
      {
        incomingSignals: incomingSignals.length,
        filteredSignals: filteredSignals.length,
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
   * Get the filter registry (for testing/debugging).
   */
  getFilterRegistry(): FilterRegistry {
    return this.filterRegistry;
  }

  /**
   * Get current alertness value.
   * AlertnessNeuron must be registered before calling this method.
   *
   * @throws Error if AlertnessNeuron is not registered
   */
  getAlertness(state: AgentState): number {
    if (!this.alertnessNeuron) {
      throw new Error('AlertnessNeuron not registered - cannot get alertness');
    }
    return this.alertnessNeuron.getCurrentAlertness(state);
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
 *
 * The processor starts without any neurons. Register neurons via:
 * - registerNeuron(neuron) to add neurons
 * - unregisterNeuron(id) to remove neurons
 *
 * After loading plugins, call validateRequiredNeurons() to ensure
 * the AlertnessNeuron is registered.
 *
 * @param logger Logger instance
 * @param config Optional processor configuration
 */
export function createAutonomicProcessor(
  logger: Logger,
  config?: Partial<AutonomicProcessorConfig>
): AutonomicProcessor {
  return new AutonomicProcessor(logger, config);
}
