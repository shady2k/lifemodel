/**
 * AGGREGATION layer exports.
 *
 * The aggregation layer collects signals, detects patterns,
 * and decides when to wake COGNITION. Like the thalamus -
 * filters sensory information before it reaches consciousness.
 */

// Main processor
export { AggregationProcessor, createAggregationProcessor } from './processor.js';
export type { AggregationProcessorConfig } from './processor.js';

// Signal aggregator
export { SignalAggregator, createSignalAggregator } from './aggregator.js';
export type { AggregatorConfig } from './aggregator.js';

// Threshold engine
export { ThresholdEngine, createThresholdEngine } from './threshold-engine.js';
export type { WakeDecision } from './threshold-engine.js';

// Pattern detector
export { PatternDetector, createPatternDetector } from './pattern-detector.js';
export type { Pattern, PatternMatch, PatternDetectorConfig } from './pattern-detector.js';

// Ack registry
export { SignalAckRegistry, createAckRegistry } from './ack-registry.js';
export type {
  AckType,
  SignalAck,
  AckCheckResult,
  AckRegistryConfig,
  PersistedAckRegistryState,
  PersistedSignalAck,
} from './ack-registry.js';

// Persistent ack registry
export { PersistentAckRegistry } from './persistent-ack-registry.js';
