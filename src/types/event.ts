import type { Priority } from './priority.js';

/**
 * Event sources - high-level categories like senses in the nervous system.
 */
export type EventSource = 'communication' | 'thoughts' | 'internal' | 'time' | 'system';

/**
 * Core event structure.
 *
 * Events are source-based (like the nervous system):
 * - source: high-level category (communication, thoughts, internal, time, system)
 * - channel: specific implementation (telegram, openrouter, etc.)
 */
export interface Event {
  /** Unique event identifier */
  id: string;

  /** High-level source category */
  source: EventSource;

  /** Specific channel within source (e.g., "telegram" under "communication") */
  channel?: string;

  /** Event type within the source/channel */
  type: string;

  /** Event priority for processing order */
  priority: Priority;

  /** When the event was created */
  timestamp: Date;

  /** Event-specific data */
  payload: unknown;

  /** Optional metadata */
  meta?: EventMeta;
}

/**
 * Event metadata for tracing and correlation.
 */
export interface EventMeta {
  /** Trace related events across the system */
  correlationId?: string;

  /** Parent event that caused this one */
  causedBy?: string;

  /** Number of times this event was aggregated (for overload handling) */
  aggregatedCount?: number;

  /** Original timestamp if aggregated */
  firstOccurrence?: Date;
}

/**
 * Event queue interface.
 *
 * Abstract interface for event queuing. MVP uses in-memory,
 * can be swapped for Valkey, Kafka, etc. later.
 */
export interface EventQueue {
  /** Add event to queue */
  push(event: Event): Promise<void>;

  /** Remove and return highest priority event */
  pull(): Promise<Event | null>;

  /** Peek at next event without removing */
  peek(): Promise<Event | null>;

  /** Current queue size */
  size(): number;

  /** Size by priority level */
  sizeByPriority(): Map<Priority, number>;

  /** Acknowledge event processing (for persistent queues) */
  ack?(eventId: string): Promise<void>;

  /** Negative acknowledge - return to queue (for persistent queues) */
  nack?(eventId: string): Promise<void>;

  /** Aggregate similar events to reduce volume */
  aggregate?(): Promise<number>;

  /** Prune old/low-priority events based on config */
  prune?(config: PruneConfig): Promise<number>;
}

/**
 * Configuration for pruning events during overload.
 */
export interface PruneConfig {
  /** Drop events older than this (ms) with priority <= maxPriorityToDrop */
  maxAge: number;

  /** Maximum priority level to drop (e.g., Priority.LOW) */
  maxPriorityToDrop: Priority;

  /** Queue size threshold to trigger emergency pruning */
  emergencyThreshold?: number;
}
