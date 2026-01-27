/**
 * COGNITION Layer
 *
 * Processes aggregated signals using fast LLM.
 * Decides actions or escalates to SMART when uncertain.
 *
 * Like the prefrontal cortex - conscious processing, but only
 * when the autonomic/aggregation layers determine it's needed.
 */

export { CognitionProcessor, createCognitionProcessor } from './processor.js';
export type { CognitionProcessorConfig, CognitionProcessorDeps } from './processor.js';

export { ThoughtSynthesizer, createThoughtSynthesizer } from './thought-synthesizer.js';
export type { ThoughtSynthesizerConfig, SynthesisResult } from './thought-synthesizer.js';

export { ActionDecider, createActionDecider } from './action-decider.js';
export type { ActionDeciderConfig, ActionDecision } from './action-decider.js';
