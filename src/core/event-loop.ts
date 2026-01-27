import { randomUUID } from 'node:crypto';
import type {
  Event,
  EventQueue,
  Logger,
  Metrics,
  Intent,
  PruneConfig,
  Thought,
} from '../types/index.js';
import { Priority, PRIORITY_DISTURBANCE_WEIGHT } from '../types/index.js';
import type { Agent } from './agent.js';
import type { EventBus } from './event-bus.js';
import type { LayerProcessor } from '../layers/layer-processor.js';

/**
 * Event loop configuration.
 */
export interface EventLoopConfig {
  /** Minimum tick interval in ms (default: 1000) */
  minTickInterval: number;

  /** Maximum tick interval in ms (default: 60000) */
  maxTickInterval: number;

  /** Default tick interval in ms (default: 30000) */
  defaultTickInterval: number;

  /** Max events to process per tick (default: 100) */
  maxEventsPerTick: number;

  /** Run aggregation every N ticks (default: 5) */
  aggregationInterval: number;

  /** Run pruning every N ticks (default: 10) */
  pruneInterval: number;

  /** Prune config for overload handling */
  pruneConfig: PruneConfig;
}

const DEFAULT_CONFIG: EventLoopConfig = {
  minTickInterval: 1_000,
  maxTickInterval: 60_000,
  defaultTickInterval: 30_000,
  maxEventsPerTick: 100,
  aggregationInterval: 5,
  pruneInterval: 10,
  pruneConfig: {
    maxAge: 60_000, // 1 minute
    maxPriorityToDrop: Priority.LOW,
    emergencyThreshold: 1000,
  },
};

/**
 * EventLoop - the heartbeat of the agent.
 *
 * Two concurrent processes:
 * 1. Event receiver (async, always listening) - via EventBus subscriptions
 * 2. Tick loop (periodic, dynamic interval) - this class
 *
 * The tick loop:
 * - Processes queued events
 * - Updates agent state (decay, accumulation)
 * - Evaluates rules (returns intents)
 * - Applies intents
 * - Calculates next tick interval
 *
 * Like a heartbeat, the tick never stops while the loop is running.
 */
export class EventLoop {
  private readonly agent: Agent;
  private readonly eventQueue: EventQueue;
  private readonly eventBus: EventBus;
  private readonly layerProcessor: LayerProcessor;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly config: EventLoopConfig;

  private running = false;
  private tickCount = 0;
  private tickTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    agent: Agent,
    eventQueue: EventQueue,
    eventBus: EventBus,
    layerProcessor: LayerProcessor,
    logger: Logger,
    metrics: Metrics,
    config: Partial<EventLoopConfig> = {}
  ) {
    this.agent = agent;
    this.eventQueue = eventQueue;
    this.eventBus = eventBus;
    this.layerProcessor = layerProcessor;
    this.logger = logger.child({ component: 'event-loop' });
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the event loop.
   */
  start(): void {
    if (this.running) {
      this.logger.warn('Event loop already running');
      return;
    }

    this.running = true;
    this.logger.info('Event loop started');

    // Schedule first tick immediately
    this.scheduleTick(0);
  }

  /**
   * Stop the event loop.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;

    if (this.tickTimeout) {
      clearTimeout(this.tickTimeout);
      this.tickTimeout = null;
    }

    this.logger.info({ tickCount: this.tickCount }, 'Event loop stopped');
  }

  /**
   * Check if the loop is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current tick count.
   */
  getTickCount(): number {
    return this.tickCount;
  }

  /**
   * Emit an event into the system.
   * Events go to the queue and are processed on next tick.
   */
  async emit(event: Omit<Event, 'id' | 'timestamp'>): Promise<string> {
    const fullEvent: Event = {
      ...event,
      id: randomUUID(),
      timestamp: new Date(),
    };

    await this.eventQueue.push(fullEvent);
    return fullEvent.id;
  }

  /**
   * Emit a tick event.
   */
  private emitTickEvent(): void {
    const tickEvent: Event = {
      id: randomUUID(),
      source: 'time',
      type: 'tick',
      priority: Priority.NORMAL,
      timestamp: new Date(),
      payload: { tickCount: this.tickCount },
    };

    // Publish directly to bus (don't queue ticks)
    void this.eventBus.publish(tickEvent);
  }

  /**
   * Schedule the next tick.
   */
  private scheduleTick(delay: number): void {
    if (!this.running) return;

    this.tickTimeout = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  /**
   * Execute one tick cycle.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const tickStart = Date.now();
    this.tickCount++;

    try {
      // 1. Process queued events
      const eventsProcessed = await this.processEvents();

      // 2. Update agent state (energy, social debt, etc.)
      const intents = this.agent.tick();

      // 3. Apply intents
      this.applyIntents(intents);

      // 4. Emit tick event to subscribers
      this.emitTickEvent();

      // 5. Periodic maintenance
      await this.periodicMaintenance();

      // 6. Calculate next tick interval
      const nextInterval = this.calculateNextInterval();

      // 7. Log tick summary
      const tickDuration = Date.now() - tickStart;
      this.logger.debug(
        {
          tick: this.tickCount,
          eventsProcessed,
          intents: intents.length,
          duration: tickDuration,
          nextInterval,
          mode: this.agent.getAlertnessMode(),
          energy: this.agent.getEnergy().toFixed(2),
        },
        'Tick completed'
      );

      // Update metrics
      this.metrics.counter('event_loop_ticks');
      this.metrics.gauge('event_loop_tick_duration', tickDuration);
      this.metrics.gauge('event_loop_events_processed', eventsProcessed);
      this.metrics.gauge('event_loop_next_interval', nextInterval);

      // Schedule next tick
      this.scheduleTick(nextInterval);
    } catch (error) {
      this.logger.error({ error, tick: this.tickCount }, 'Tick failed');

      // Continue running despite error
      this.scheduleTick(this.config.defaultTickInterval);
    }
  }

  /**
   * Process events from the queue through the layer processor.
   */
  private async processEvents(): Promise<number> {
    let processed = 0;
    const mode = this.agent.getAlertnessMode();

    while (processed < this.config.maxEventsPerTick) {
      const event = await this.eventQueue.peek();

      if (!event) break;

      // Filter based on alertness mode
      if (!this.shouldProcessEvent(event, mode)) {
        // Add disturbance for filtered events
        const disturbance = PRIORITY_DISTURBANCE_WEIGHT[event.priority];
        const woke = this.agent.addDisturbance(disturbance);

        if (woke) {
          // Agent woke up - process this event
          this.logger.debug({ eventId: event.id, priority: event.priority }, 'Event woke agent');
        } else {
          // Skip this event, but remove it from queue
          await this.eventQueue.pull();
          processed++;
          continue;
        }
      }

      // Pull the event
      await this.eventQueue.pull();

      // Notify agent of event processing (drains energy)
      this.agent.onEventProcessed();

      // Process through 6-layer brain pipeline
      const result = await this.layerProcessor.process(event);

      // Apply intents from layer processing
      this.applyIntents(result.intents);

      // Recycle thoughts that need further processing
      await this.recycleThoughts(result.thoughts);

      // Also publish to EventBus for any additional subscribers
      await this.eventBus.publish(event);

      // Log processing summary
      this.logger.debug(
        {
          eventId: event.id,
          layers: result.layersExecuted.length,
          intents: result.intents.length,
          thoughts: result.thoughts.length,
          hoisted: result.hoisted,
          timeMs: result.processingTimeMs,
        },
        'Event processed through layers'
      );

      // Update metrics
      this.metrics.histogram('layer_processing_time', result.processingTimeMs);
      this.metrics.counter('events_processed_through_layers');

      processed++;

      // CRITICAL events wake the agent immediately
      if (event.priority === Priority.CRITICAL) {
        this.agent.wake();
      }
    }

    return processed;
  }

  /**
   * Convert thoughts that require processing into internal events.
   * This completes the thinking loop - thoughts can trigger further processing.
   */
  private async recycleThoughts(thoughts: Thought[]): Promise<void> {
    for (const thought of thoughts) {
      if (!thought.requiresProcessing) {
        // Just log thoughts that don't need processing
        this.logger.debug(
          { thoughtId: thought.id, content: thought.content },
          'Thought noted (no processing needed)'
        );
        continue;
      }

      // Convert thought to internal event
      const thoughtEvent: Event = {
        id: randomUUID(),
        source: 'thoughts',
        type: 'internal_thought',
        priority: thought.priority,
        timestamp: new Date(),
        payload: {
          thoughtId: thought.id,
          content: thought.content,
          sourceEvent: thought.source,
        },
      };

      await this.eventQueue.push(thoughtEvent);

      this.logger.debug(
        {
          thoughtId: thought.id,
          eventId: thoughtEvent.id,
          priority: thought.priority,
        },
        'Thought recycled as internal event'
      );

      this.metrics.counter('thoughts_recycled');
    }
  }

  /**
   * Check if an event should be processed based on alertness mode.
   */
  private shouldProcessEvent(event: Event, mode: string): boolean {
    switch (mode) {
      case 'alert':
        return true; // Process all events

      case 'normal':
        return true; // Process all events

      case 'relaxed':
        // Only HIGH and above
        return event.priority <= Priority.HIGH;

      case 'sleep':
        // Only CRITICAL
        return event.priority === Priority.CRITICAL;

      default:
        return true;
    }
  }

  /**
   * Apply intents from agent tick.
   */
  private applyIntents(intents: Intent[]): void {
    for (const intent of intents) {
      switch (intent.type) {
        case 'UPDATE_STATE':
          this.agent.applyIntent(intent);
          break;

        case 'SCHEDULE_EVENT':
          // TODO: Implement scheduled events
          this.logger.debug({ intent }, 'SCHEDULE_EVENT not yet implemented');
          break;

        case 'SEND_MESSAGE':
          // TODO: Route to channel
          this.logger.debug({ intent }, 'SEND_MESSAGE not yet implemented');
          break;

        case 'LOG':
          this.logger[intent.payload.level](intent.payload.context ?? {}, intent.payload.message);
          break;

        case 'EMIT_METRIC': {
          const { type: metricType, name, value, labels } = intent.payload;
          switch (metricType) {
            case 'gauge':
              this.metrics.gauge(name, value, labels);
              break;
            case 'counter':
              this.metrics.counter(name, labels);
              break;
            case 'histogram':
              this.metrics.histogram(name, value, labels);
              break;
          }
          break;
        }

        case 'CANCEL_EVENT':
          // TODO: Implement event cancellation
          this.logger.debug({ intent }, 'CANCEL_EVENT not yet implemented');
          break;
      }
    }
  }

  /**
   * Run periodic maintenance tasks.
   */
  private async periodicMaintenance(): Promise<void> {
    // Aggregation
    if (this.tickCount % this.config.aggregationInterval === 0) {
      if (this.eventQueue.aggregate) {
        const aggregated = await this.eventQueue.aggregate();
        if (aggregated > 0) {
          this.logger.debug({ aggregated }, 'Events aggregated');
        }
      }
    }

    // Pruning
    if (this.tickCount % this.config.pruneInterval === 0) {
      if (this.eventQueue.prune) {
        const pruned = await this.eventQueue.prune(this.config.pruneConfig);
        if (pruned > 0) {
          this.logger.debug({ pruned }, 'Events pruned');
        }
      }
    }
  }

  /**
   * Calculate the next tick interval based on agent state.
   */
  private calculateNextInterval(): number {
    // Get interval from agent state
    const agentInterval = this.agent.getState().tickInterval;

    // Clamp to configured bounds
    return Math.max(
      this.config.minTickInterval,
      Math.min(this.config.maxTickInterval, agentInterval)
    );
  }
}

/**
 * Factory function for creating an event loop.
 */
export function createEventLoop(
  agent: Agent,
  eventQueue: EventQueue,
  eventBus: EventBus,
  layerProcessor: LayerProcessor,
  logger: Logger,
  metrics: Metrics,
  config?: Partial<EventLoopConfig>
): EventLoop {
  return new EventLoop(agent, eventQueue, eventBus, layerProcessor, logger, metrics, config);
}
