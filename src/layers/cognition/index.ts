/**
 * COGNITION Layer
 *
 * Processes aggregated signals using LLM with automatic smart retry.
 *
 * Like the prefrontal cortex - conscious processing, but only
 * when the autonomic/aggregation layers determine it's needed.
 * Uses fast model by default, smart model when confidence is low.
 */

export { CognitionProcessor, createCognitionProcessor } from './processor.js';
export type { CognitionProcessorConfig, CognitionProcessorDeps } from './processor.js';

// Agentic loop types
export type {
  CognitionLLM,
  LLMOptions,
  LoopContext,
  LoopResult,
  ConversationMessage,
  PreviousAttempt,
  RuntimeConfig,
} from './agentic-loop.js';
