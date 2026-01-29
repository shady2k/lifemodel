/**
 * Processing layers - 3-layer brain architecture.
 *
 * Signals flow through 3 layers:
 * 1. AUTONOMIC - neurons monitor state, emit signals (zero LLM cost)
 * 2. AGGREGATION - collect signals, decide when to wake cognition (zero LLM cost)
 * 3. COGNITION - LLM processing with automatic smart retry when confidence is low
 *
 * Note: SMART layer merged into COGNITION - smart retry is internal to COGNITION.
 */

// AUTONOMIC layer
export { AutonomicProcessor, createAutonomicProcessor } from './autonomic/index.js';
export type { AutonomicProcessorConfig } from './autonomic/index.js';

// AGGREGATION layer
export { AggregationProcessor, createAggregationProcessor } from './aggregation/index.js';
export type { AggregationProcessorConfig } from './aggregation/index.js';

// COGNITION layer
export { CognitionProcessor, createCognitionProcessor } from './cognition/index.js';
export type { CognitionProcessorConfig, CognitionProcessorDeps } from './cognition/index.js';
