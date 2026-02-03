/**
 * AUTONOMIC layer exports.
 *
 * The autonomic layer monitors state and emits signals.
 * Like the biological autonomic nervous system - always running,
 * no conscious control, handles vital functions.
 *
 * Dynamic Registration:
 * - Neurons can be registered/unregistered at runtime via PluginLoader
 * - Filters can be registered to transform/classify incoming signals
 * - AutonomicProcessor exposes registerNeuron/unregisterNeuron methods
 * - Changes are queued and applied at tick boundaries
 *
 * Note: Individual neurons are loaded as plugins via the plugin system.
 * See src/plugins/alertness/, src/plugins/social-debt/, etc.
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

// Signal filters
export { FilterRegistry, createFilterRegistry } from './filter-registry.js';
export type { SignalFilter, FilterContext, FilterUserModel } from './filter-registry.js';

// Core filters (not plugin-based)
export { ReactionSignalFilter, createReactionSignalFilter } from './reaction-filter.js';
