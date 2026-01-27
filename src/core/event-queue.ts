import type { Event, EventQueue, PruneConfig } from '../types/index.js';
import { Priority } from '../types/index.js';

/**
 * In-memory event queue with priority ordering.
 *
 * Events are processed in priority order (lower number = higher priority).
 * Within the same priority, events are processed FIFO.
 *
 * This is the MVP implementation. Can be swapped for Valkey, Kafka, etc. later.
 */
export class InMemoryEventQueue implements EventQueue {
  private queues = new Map<Priority, Event[]>();

  constructor() {
    // Initialize queues for each priority level
    for (const priority of Object.values(Priority)) {
      if (typeof priority === 'number') {
        this.queues.set(priority, []);
      }
    }
  }

  push(event: Event): Promise<void> {
    const queue = this.queues.get(event.priority);
    if (queue) {
      queue.push(event);
    }
    return Promise.resolve();
  }

  pull(): Promise<Event | null> {
    // Pull from highest priority (lowest number) first
    for (const priority of [
      Priority.CRITICAL,
      Priority.HIGH,
      Priority.NORMAL,
      Priority.LOW,
      Priority.IDLE,
    ]) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        return Promise.resolve(queue.shift() ?? null);
      }
    }
    return Promise.resolve(null);
  }

  peek(): Promise<Event | null> {
    // Peek at highest priority (lowest number) first
    for (const priority of [
      Priority.CRITICAL,
      Priority.HIGH,
      Priority.NORMAL,
      Priority.LOW,
      Priority.IDLE,
    ]) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        return Promise.resolve(queue[0] ?? null);
      }
    }
    return Promise.resolve(null);
  }

  size(): number {
    let total = 0;
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  sizeByPriority(): Map<Priority, number> {
    const sizes = new Map<Priority, number>();
    for (const [priority, queue] of this.queues) {
      sizes.set(priority, queue.length);
    }
    return sizes;
  }

  /**
   * Aggregate similar events to reduce volume.
   *
   * Events are considered similar if they have the same:
   * - source
   * - channel
   * - type
   *
   * Returns the number of events aggregated (removed).
   */
  aggregate(): Promise<number> {
    let aggregatedCount = 0;
    const now = Date.now();
    const aggregationWindowMs = 5000; // 5 seconds

    for (const queue of this.queues.values()) {
      const aggregated = new Map<string, Event>();

      for (let i = queue.length - 1; i >= 0; i--) {
        const event = queue[i];
        if (!event) continue;

        const key = `${event.source}:${event.channel ?? ''}:${event.type}`;
        const existing = aggregated.get(key);

        if (existing) {
          // Check if within aggregation window
          const timeDiff = Math.abs(event.timestamp.getTime() - existing.timestamp.getTime());
          if (timeDiff <= aggregationWindowMs) {
            // Merge into existing event
            existing.meta = {
              ...existing.meta,
              aggregatedCount: (existing.meta?.aggregatedCount ?? 1) + 1,
              firstOccurrence: existing.meta?.firstOccurrence ?? event.timestamp,
            };
            existing.timestamp = new Date(Math.max(event.timestamp.getTime(), now));

            // Remove the duplicate
            queue.splice(i, 1);
            aggregatedCount++;
          }
        } else {
          aggregated.set(key, event);
        }
      }
    }

    return Promise.resolve(aggregatedCount);
  }

  /**
   * Prune old/low-priority events based on config.
   *
   * Returns the number of events pruned.
   */
  prune(config: PruneConfig): Promise<number> {
    let prunedCount = 0;
    const now = Date.now();

    // Prune by age + priority
    for (const [priority, queue] of this.queues) {
      if (priority <= config.maxPriorityToDrop) {
        for (let i = queue.length - 1; i >= 0; i--) {
          const event = queue[i];
          if (!event) continue;

          const age = now - event.timestamp.getTime();
          if (age > config.maxAge) {
            queue.splice(i, 1);
            prunedCount++;
          }
        }
      }
    }

    // Emergency pruning if queue is still too large
    if (config.emergencyThreshold !== undefined && this.size() > config.emergencyThreshold) {
      // Drop all IDLE events
      const idleQueue = this.queues.get(Priority.IDLE);
      if (idleQueue) {
        prunedCount += idleQueue.length;
        idleQueue.length = 0;
      }

      // If still too large, drop LOW events
      if (this.size() > config.emergencyThreshold) {
        const lowQueue = this.queues.get(Priority.LOW);
        if (lowQueue) {
          prunedCount += lowQueue.length;
          lowQueue.length = 0;
        }
      }
    }

    return Promise.resolve(prunedCount);
  }

  /**
   * Clear all events from the queue.
   */
  clear(): void {
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
  }
}

/**
 * Create an in-memory event queue.
 */
export function createEventQueue(): EventQueue {
  return new InMemoryEventQueue();
}
