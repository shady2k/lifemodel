/**
 * Alertness Port — interface for alertness calculations in AUTONOMIC layer.
 *
 * Decouples the autonomic processor from the concrete AlertnessNeuron plugin.
 * This is a "driven" (secondary) port: the core uses it to query alertness state.
 */

import type { AgentState } from '../types/agent/state.js';

/**
 * Provides alertness state to the AUTONOMIC processor.
 *
 * Implemented by the AlertnessNeuron plugin. The processor needs only
 * these 3 methods, not the full Neuron interface.
 */
export interface IAlertness {
  /** Get the current alertness level (0-1) given agent state */
  getCurrentAlertness(state: AgentState): number;

  /** Record activity to boost alertness (e.g., user message = high activity) */
  recordActivity(intensity?: number): void;

  /** Decay recent activity (called each tick to model attention fading) */
  decayActivity(decayFactor?: number): void;
}
