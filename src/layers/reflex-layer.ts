import type { LayerResult, Logger, Intent } from '../types/index.js';
import type { ProcessingContext } from './context.js';
import { BaseLayer } from './base-layer.js';

/**
 * Layer 0: REFLEX
 *
 * Handles mechanical events that don't require understanding.
 * Like spinal reflexes - fast, automatic, no conscious thought.
 *
 * Handles:
 * - System events (tick, connect, disconnect, error)
 * - Heartbeat/health checks
 * - Direct state updates
 *
 * Cost: Zero (no LLM)
 */
export class ReflexLayer extends BaseLayer {
  readonly name = 'reflex';
  readonly confidenceThreshold = 0.9;

  constructor(logger: Logger) {
    super(logger, 'reflex');
  }

  protected processImpl(context: ProcessingContext): LayerResult {
    const { event } = context;
    context.stage = 'reflex';

    // Handle system events directly
    if (event.source === 'system') {
      return this.handleSystemEvent(context);
    }

    // Handle time events (ticks)
    if (event.source === 'time') {
      return this.handleTimeEvent(context);
    }

    // Handle internal events
    if (event.source === 'internal') {
      return this.handleInternalEvent(context);
    }

    // Not a reflex-level event, pass to next layer
    return this.success(context, 1.0);
  }

  private handleSystemEvent(context: ProcessingContext): LayerResult {
    const { event } = context;
    const intents: Intent[] = [];

    switch (event.type) {
      case 'startup':
        this.logger.info('System startup event');
        intents.push({
          type: 'LOG',
          payload: { level: 'info', message: 'Agent started' },
        });
        return this.stop(context, { intents });

      case 'shutdown':
        this.logger.info('System shutdown event');
        return this.stop(context, { intents });

      case 'error':
        this.logger.error({ payload: event.payload }, 'System error event');
        intents.push({
          type: 'EMIT_METRIC',
          payload: { type: 'counter', name: 'system_errors', value: 1 },
        });
        return this.stop(context, { intents });

      case 'health_check':
        // Just acknowledge, no processing needed
        return this.stop(context);

      default:
        // Unknown system event, let higher layers handle
        return this.success(context, 0.5);
    }
  }

  private handleTimeEvent(context: ProcessingContext): LayerResult {
    const { event } = context;

    switch (event.type) {
      case 'tick':
        // Tick events are handled by the event loop, not layers
        return this.stop(context);

      case 'scheduled':
        // Scheduled events might need processing
        return this.success(context, 0.8);

      case 'reminder':
        // Reminders need higher-level processing
        return this.success(context, 0.7);

      default:
        return this.success(context, 1.0);
    }
  }

  private handleInternalEvent(context: ProcessingContext): LayerResult {
    const { event } = context;
    const intents: Intent[] = [];

    switch (event.type) {
      case 'threshold_crossed':
        // Important - needs decision layer
        return this.success(context, 0.9);

      case 'state_change':
        // Log state changes
        intents.push({
          type: 'LOG',
          payload: {
            level: 'debug',
            message: 'Internal state changed',
            context: { payload: event.payload },
          },
        });
        return this.stop(context, { intents });

      case 'belief_update':
        // Belief updates are handled automatically
        return this.stop(context);

      default:
        return this.success(context, 1.0);
    }
  }
}

/**
 * Factory function.
 */
export function createReflexLayer(logger: Logger): ReflexLayer {
  return new ReflexLayer(logger);
}
