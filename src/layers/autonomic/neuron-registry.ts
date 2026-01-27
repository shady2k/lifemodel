/**
 * Neuron registry - manages all neurons in the AUTONOMIC layer.
 *
 * Neurons are the basic units that monitor specific aspects of state
 * and emit signals when meaningful changes occur. Like biological neurons:
 * - Each monitors a specific input
 * - Fires (emits signal) when threshold is crossed
 * - Has refractory period (doesn't fire constantly)
 */

import type { Signal, SignalType, SignalSource } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { Logger } from '../../types/logger.js';

/**
 * Neuron interface - a single monitoring unit.
 */
export interface Neuron {
  /** Unique neuron identifier */
  readonly id: string;

  /** What signal type this neuron emits */
  readonly signalType: SignalType;

  /** Source identifier for signals */
  readonly source: SignalSource;

  /** Human-readable description */
  readonly description: string;

  /**
   * Check state and emit signal if meaningful change detected.
   *
   * @param state Current agent state
   * @param alertness Current alertness level (affects sensitivity)
   * @param correlationId Tick correlation ID for bundling
   * @returns Signal if change is significant, undefined otherwise
   */
  check(
    state: AgentState,
    alertness: number,
    correlationId: string
  ): Signal | undefined;

  /**
   * Reset neuron state (e.g., clear previous values).
   */
  reset(): void;

  /**
   * Get neuron's last known value (for debugging).
   */
  getLastValue(): number | undefined;
}

/**
 * Base class for neurons with common functionality.
 */
export abstract class BaseNeuron implements Neuron {
  abstract readonly id: string;
  abstract readonly signalType: SignalType;
  abstract readonly source: SignalSource;
  abstract readonly description: string;

  protected previousValue: number | undefined;
  protected lastEmittedAt: Date | undefined;
  protected readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ neuron: this.constructor.name });
  }

  abstract check(
    state: AgentState,
    alertness: number,
    correlationId: string
  ): Signal | undefined;

  reset(): void {
    this.previousValue = undefined;
    this.lastEmittedAt = undefined;
  }

  getLastValue(): number | undefined {
    return this.previousValue;
  }

  /**
   * Update previous value after check.
   */
  protected updatePrevious(value: number): void {
    this.previousValue = value;
  }

  /**
   * Record that a signal was emitted.
   */
  protected recordEmission(): void {
    this.lastEmittedAt = new Date();
  }

  /**
   * Check if neuron is in refractory period.
   *
   * @param minIntervalMs Minimum time between emissions
   */
  protected isInRefractoryPeriod(minIntervalMs: number): boolean {
    if (!this.lastEmittedAt) return false;
    const elapsed = Date.now() - this.lastEmittedAt.getTime();
    return elapsed < minIntervalMs;
  }
}

/**
 * Neuron registry - manages all neurons.
 */
export class NeuronRegistry {
  private readonly neurons = new Map<string, Neuron>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'neuron-registry' });
  }

  /**
   * Register a neuron.
   */
  register(neuron: Neuron): void {
    if (this.neurons.has(neuron.id)) {
      this.logger.warn({ neuronId: neuron.id }, 'Replacing existing neuron');
    }
    this.neurons.set(neuron.id, neuron);
    this.logger.debug(
      { neuronId: neuron.id, signalType: neuron.signalType },
      'Neuron registered'
    );
  }

  /**
   * Unregister a neuron.
   */
  unregister(id: string): boolean {
    const removed = this.neurons.delete(id);
    if (removed) {
      this.logger.debug({ neuronId: id }, 'Neuron unregistered');
    }
    return removed;
  }

  /**
   * Get a neuron by ID.
   */
  get(id: string): Neuron | undefined {
    return this.neurons.get(id);
  }

  /**
   * Get all registered neurons.
   */
  getAll(): Neuron[] {
    return Array.from(this.neurons.values());
  }

  /**
   * Check all neurons and collect emitted signals.
   *
   * @param state Current agent state
   * @param alertness Current alertness level
   * @param correlationId Tick correlation ID
   * @returns All signals emitted by neurons
   */
  checkAll(state: AgentState, alertness: number, correlationId: string): Signal[] {
    const signals: Signal[] = [];

    for (const neuron of this.neurons.values()) {
      try {
        const signal = neuron.check(state, alertness, correlationId);
        if (signal) {
          signals.push(signal);
          this.logger.debug(
            {
              neuronId: neuron.id,
              signalType: signal.type,
              value: signal.metrics.value,
            },
            'Neuron emitted signal'
          );
        }
      } catch (error) {
        this.logger.error(
          {
            neuronId: neuron.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Neuron check failed'
        );
      }
    }

    return signals;
  }

  /**
   * Reset all neurons.
   */
  resetAll(): void {
    for (const neuron of this.neurons.values()) {
      neuron.reset();
    }
    this.logger.debug({ count: this.neurons.size }, 'All neurons reset');
  }

  /**
   * Get registry size.
   */
  size(): number {
    return this.neurons.size;
  }
}

/**
 * Create a neuron registry.
 */
export function createNeuronRegistry(logger: Logger): NeuronRegistry {
  return new NeuronRegistry(logger);
}
