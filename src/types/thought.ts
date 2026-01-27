import type { Priority } from './priority.js';
import type { Intent } from './intent.js';

/**
 * Internal thought triggered by event processing.
 *
 * Events don't just get processed → response.
 * They trigger internal thoughts that may need further processing.
 */
export interface Thought {
  /** Unique thought identifier */
  id: string;

  /** What the thought is about */
  content: string;

  /** What triggered this thought (event ID or another thought ID) */
  source: string;

  /** Priority for processing */
  priority: Priority;

  /** Should this thought be processed through layers? */
  requiresProcessing: boolean;

  /** When the thought was generated */
  createdAt: Date;
}

/**
 * Result from processing a layer.
 */
export interface LayerResult {
  /** How confident the layer is in its output (0-1) */
  confidence: number;

  /** Output to pass to the next layer */
  output: unknown;

  /** Side effects to apply (state changes, scheduled events, etc.) */
  intents?: Intent[];

  /** Internal thoughts triggered by this processing */
  thoughts?: Thought[];

  /** If true, stop processing - don't continue to next layer */
  stop?: boolean;
}

/**
 * Processing layer interface.
 */
export interface ProcessingLayer {
  /** Layer name for logging/debugging */
  name: string;

  /** Confidence threshold - below this, hoist to next layer */
  confidenceThreshold: number;

  /** Process an event/context through this layer */
  process(context: unknown): Promise<LayerResult> | LayerResult;
}
