/**
 * Processing layers - 4-layer brain architecture.
 *
 * Signals flow through 4 layers:
 * 1. AUTONOMIC - neurons monitor state, emit signals (zero LLM cost)
 * 2. AGGREGATION - collect signals, decide when to wake cognition (zero LLM cost)
 * 3. COGNITION - fast LLM processing, decide action or escalate
 * 4. SMART - expensive LLM for complex reasoning (only when needed)
 */

// AUTONOMIC layer
export {
  AutonomicProcessor,
  createAutonomicProcessor,
} from './autonomic/index.js';
export type { AutonomicProcessorConfig } from './autonomic/index.js';

// AGGREGATION layer
export {
  AggregationProcessor,
  createAggregationProcessor,
} from './aggregation/index.js';
export type { AggregationProcessorConfig } from './aggregation/index.js';

// COGNITION layer
export {
  CognitionProcessor,
  createCognitionProcessor,
} from './cognition/index.js';
export type {
  CognitionProcessorConfig,
  CognitionProcessorDeps,
} from './cognition/index.js';

// SMART layer
export {
  SmartProcessor,
  createSmartProcessor,
} from './smart/index.js';
export type {
  SmartProcessorConfig,
  SmartProcessorDeps,
} from './smart/index.js';
