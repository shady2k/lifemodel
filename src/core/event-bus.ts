import type { Event, Logger, Priority } from '../types/index.js';

/**
 * Event handler function type.
 */
export type EventHandler = (event: Event) => void | Promise<void>;

/**
 * Subscription options.
 */
export interface SubscriptionOptions {
  /** Only receive events from this source */
  source?: Event['source'];

  /** Only receive events from this channel */
  channel?: string;

  /** Only receive events of this type */
  type?: string;

  /** Only receive events at or above this priority (lower number = higher priority) */
  minPriority?: Priority;
}

/**
 * Internal subscription record.
 */
interface Subscription {
  id: string;
  handler: EventHandler;
  options: SubscriptionOptions;
}

/**
 * EventBus - pub/sub system for events.
 *
 * Allows components to subscribe to events based on:
 * - source (communication, thoughts, internal, time, system)
 * - channel (telegram, openrouter, etc.)
 * - type (message_received, tick, etc.)
 * - priority (only HIGH and above, etc.)
 *
 * Events are delivered to all matching subscribers.
 */
export class EventBus {
  private subscriptions: Subscription[] = [];
  private nextId = 1;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'event-bus' });
  }

  /**
   * Subscribe to events matching the given options.
   *
   * @returns Subscription ID for unsubscribing
   */
  subscribe(handler: EventHandler, options: SubscriptionOptions = {}): string {
    const id = `sub_${String(this.nextId++)}`;
    this.subscriptions.push({ id, handler, options });

    this.logger.debug({ subscriptionId: id, options }, 'Subscription added');

    return id;
  }

  /**
   * Unsubscribe by subscription ID.
   */
  unsubscribe(subscriptionId: string): boolean {
    const index = this.subscriptions.findIndex((s) => s.id === subscriptionId);
    if (index >= 0) {
      this.subscriptions.splice(index, 1);
      this.logger.debug({ subscriptionId }, 'Subscription removed');
      return true;
    }
    return false;
  }

  /**
   * Publish an event to all matching subscribers.
   *
   * @returns Number of handlers that received the event
   */
  async publish(event: Event): Promise<number> {
    const matchingSubscriptions = this.subscriptions.filter((sub) =>
      this.matchesSubscription(event, sub.options)
    );

    if (matchingSubscriptions.length === 0) {
      return 0;
    }

    // Execute all handlers (in parallel for async handlers)
    // Wrap in Promise.resolve to handle both sync and async handlers
    const results = await Promise.allSettled(
      matchingSubscriptions.map((sub) => Promise.resolve(sub.handler(event)))
    );

    // Log any failures
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const sub = matchingSubscriptions[index];
        this.logger.error(
          {
            subscriptionId: sub?.id,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            eventId: event.id,
          },
          'Event handler failed'
        );
      }
    });

    return matchingSubscriptions.length;
  }

  /**
   * Get count of active subscriptions.
   */
  subscriptionCount(): number {
    return this.subscriptions.length;
  }

  /**
   * Clear all subscriptions.
   */
  clear(): void {
    this.subscriptions = [];
    this.logger.debug('All subscriptions cleared');
  }

  /**
   * Check if an event matches a subscription's options.
   */
  private matchesSubscription(event: Event, options: SubscriptionOptions): boolean {
    // Check source filter
    if (options.source !== undefined && event.source !== options.source) {
      return false;
    }

    // Check channel filter
    if (options.channel !== undefined && event.channel !== options.channel) {
      return false;
    }

    // Check type filter
    if (options.type !== undefined && event.type !== options.type) {
      return false;
    }

    // Check priority filter (lower number = higher priority)
    if (options.minPriority !== undefined && event.priority > options.minPriority) {
      return false;
    }

    return true;
  }
}

/**
 * Factory function for creating an event bus.
 */
export function createEventBus(logger: Logger): EventBus {
  return new EventBus(logger);
}
