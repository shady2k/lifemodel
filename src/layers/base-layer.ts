import type { ProcessingLayer, LayerResult, Logger } from '../types/index.js';
import type { ProcessingContext } from './context.js';

/**
 * Base class for processing layers.
 *
 * Provides common functionality like logging and confidence handling.
 */
export abstract class BaseLayer implements ProcessingLayer {
  abstract readonly name: string;
  abstract readonly confidenceThreshold: number;

  protected readonly logger: Logger;

  constructor(logger: Logger, layerName: string) {
    this.logger = logger.child({ layer: layerName });
  }

  /**
   * Process the context through this layer.
   * Subclasses implement processImpl for the actual logic.
   */
  async process(context: unknown): Promise<LayerResult> {
    const ctx = context as ProcessingContext;
    const startTime = Date.now();

    try {
      const result = await this.processImpl(ctx);

      // Track that this layer processed the context
      ctx.meta.processedLayers.push(this.name);

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          eventId: ctx.event.id,
          confidence: result.confidence.toFixed(2),
          duration,
          stop: result.stop ?? false,
        },
        'Layer processed'
      );

      return result;
    } catch (error) {
      this.logger.error(
        {
          eventId: ctx.event.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Layer processing failed'
      );

      // Return low confidence on error - will trigger hoisting
      return {
        confidence: 0,
        output: ctx,
        stop: false,
      };
    }
  }

  /**
   * Implement the actual layer processing logic.
   */
  protected abstract processImpl(context: ProcessingContext): Promise<LayerResult> | LayerResult;

  /**
   * Helper to create a successful result.
   */
  protected success(
    context: ProcessingContext,
    confidence: number,
    extras?: Partial<LayerResult>
  ): LayerResult {
    return {
      confidence,
      output: context,
      ...extras,
    };
  }

  /**
   * Helper to create a stop result (no further processing needed).
   */
  protected stop(context: ProcessingContext, extras?: Partial<LayerResult>): LayerResult {
    return {
      confidence: 1.0,
      output: context,
      stop: true,
      ...extras,
    };
  }
}
