/**
 * AUTONOMIC layer exports.
 *
 * The autonomic layer monitors state and emits signals.
 * Like the biological autonomic nervous system - always running,
 * no conscious control, handles vital functions.
 */

// Main processor
export { AutonomicProcessor, createAutonomicProcessor } from './processor.js';
export type { AutonomicProcessorConfig } from './processor.js';

// Neuron registry
export { NeuronRegistry, createNeuronRegistry, BaseNeuron } from './neuron-registry.js';
export type { Neuron } from './neuron-registry.js';

// Change detection
export {
  detectChange,
  detectTransition,
  calculateRateOfChange,
  detectAcceleration,
  DEFAULT_CHANGE_CONFIG,
} from './change-detector.js';
export type { ChangeDetectorConfig, ChangeResult } from './change-detector.js';

// Individual neurons
export * from './neurons/index.js';
