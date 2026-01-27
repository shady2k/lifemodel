/**
 * Processing layers - brain-like event processing.
 *
 * Events flow through 6 layers:
 * 0. REFLEX - mechanical, no understanding
 * 1. PERCEPTION - parse, extract structure
 * 2. INTERPRETATION - intent, sentiment
 * 3. COGNITION - beliefs, memory, thoughts
 * 4. DECISION - should act?
 * 5. EXPRESSION - compose output
 */

// Context types
export type * from './context.js';
export { createProcessingContext } from './context.js';

// Base layer
export { BaseLayer } from './base-layer.js';

// Individual layers
export { ReflexLayer, createReflexLayer } from './reflex-layer.js';
export { PerceptionLayer, createPerceptionLayer } from './perception-layer.js';
export { InterpretationLayer, createInterpretationLayer } from './interpretation-layer.js';
export type { CognitionLayerDeps } from './cognition-layer.js';
export { CognitionLayer, createCognitionLayer } from './cognition-layer.js';
export { DecisionLayer, createDecisionLayer } from './decision-layer.js';
export { ExpressionLayer, createExpressionLayer } from './expression-layer.js';

// Layer processor (pipeline)
export type { ProcessingResult } from './layer-processor.js';
export { LayerProcessor, createLayerProcessor } from './layer-processor.js';

// Pattern accumulator
export type { Pattern, PatternTrigger } from './pattern-accumulator.js';
export {
  PatternAccumulator,
  createPatternAccumulator,
  createDefaultPatterns,
} from './pattern-accumulator.js';
