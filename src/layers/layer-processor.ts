import type { Event, ProcessingLayer, Logger, Intent, Thought } from '../types/index.js';
import type { ProcessingContext } from './context.js';
import { createProcessingContext } from './context.js';
import { createReflexLayer } from './reflex-layer.js';
import { createPerceptionLayer } from './perception-layer.js';
import { createInterpretationLayer } from './interpretation-layer.js';
import { createCognitionLayer } from './cognition-layer.js';
import { createDecisionLayer } from './decision-layer.js';
import { createExpressionLayer } from './expression-layer.js';

/**
 * Result from processing an event through all layers.
 */
export interface ProcessingResult {
  /** Final context after all processing */
  context: ProcessingContext;

  /** All intents generated across layers */
  intents: Intent[];

  /** All thoughts generated across layers */
  thoughts: Thought[];

  /** Which layers were executed */
  layersExecuted: string[];

  /** Was hoisting triggered? */
  hoisted: boolean;

  /** Total processing time in ms */
  processingTimeMs: number;
}

/**
 * LayerProcessor - orchestrates the 6-layer processing pipeline.
 *
 * Events flow through layers in order:
 * REFLEX → PERCEPTION → INTERPRETATION → COGNITION → DECISION → EXPRESSION
 *
 * Supports:
 * - Confidence-based hoisting (low confidence → skip to next layer)
 * - Early termination (layer says stop)
 * - Intent and thought collection
 */
export class LayerProcessor {
  private readonly layers: ProcessingLayer[];
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'layer-processor' });

    // Create all layers in order
    this.layers = [
      createReflexLayer(logger),
      createPerceptionLayer(logger),
      createInterpretationLayer(logger),
      createCognitionLayer(logger),
      createDecisionLayer(logger),
      createExpressionLayer(logger),
    ];
  }

  /**
   * Process an event through all layers.
   */
  async process(event: Event): Promise<ProcessingResult> {
    const startTime = Date.now();
    const context = createProcessingContext(event);
    const allIntents: Intent[] = [];
    const allThoughts: Thought[] = [];
    const layersExecuted: string[] = [];
    let hoisted = false;

    this.logger.debug(
      { eventId: event.id, source: event.source, type: event.type },
      'Starting layer processing'
    );

    for (const layer of this.layers) {
      try {
        // Process through this layer
        const result = await layer.process(context);

        layersExecuted.push(layer.name);

        // Collect intents
        if (result.intents) {
          allIntents.push(...result.intents);
        }

        // Collect thoughts
        if (result.thoughts) {
          allThoughts.push(...result.thoughts);
        }

        // Check for stop signal
        if (result.stop) {
          this.logger.debug(
            { layer: layer.name, eventId: event.id },
            'Processing stopped by layer'
          );
          break;
        }

        // Check for hoisting (low confidence)
        if (result.confidence < layer.confidenceThreshold) {
          hoisted = true;
          context.meta.hoisted = true;
          context.meta.hoistedFrom = layer.name;

          this.logger.debug(
            {
              layer: layer.name,
              confidence: result.confidence.toFixed(2),
              threshold: layer.confidenceThreshold,
            },
            'Low confidence, hoisting to next layer'
          );
          // Continue to next layer (hoisting)
        }

        // Update context confidence
        context.confidence = result.confidence;
      } catch (error) {
        this.logger.error(
          {
            layer: layer.name,
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Layer processing error'
        );
        // Continue to next layer on error
      }
    }

    const processingTimeMs = Date.now() - startTime;

    this.logger.debug(
      {
        eventId: event.id,
        layers: layersExecuted.length,
        intents: allIntents.length,
        thoughts: allThoughts.length,
        hoisted,
        timeMs: processingTimeMs,
      },
      'Layer processing complete'
    );

    return {
      context,
      intents: allIntents,
      thoughts: allThoughts,
      layersExecuted,
      hoisted,
      processingTimeMs,
    };
  }

  /**
   * Get layer names in processing order.
   */
  getLayerNames(): string[] {
    return this.layers.map((l) => l.name);
  }
}

/**
 * Factory function.
 */
export function createLayerProcessor(logger: Logger): LayerProcessor {
  return new LayerProcessor(logger);
}
