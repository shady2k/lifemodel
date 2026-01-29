/**
 * Scheduler Port - Hexagonal Architecture
 *
 * Defines interfaces for time-based scheduling.
 * Scheduler adapters implement this port to provide different backends
 * (in-memory timers, cron, distributed schedulers, etc.).
 *
 * Key features:
 * - One-time and recurring schedules
 * - Timezone-aware scheduling
 * - Idempotent fire IDs (for safe retries)
 */

/**
 * Recurrence pattern for recurring schedules.
 */
export interface RecurrencePattern {
  /** Cron expression (e.g., "0 9 * * *" for daily at 9am) */
  cron?: string;
  /** Simple interval in milliseconds */
  intervalMs?: number;
  /** Human-readable interval (e.g., "daily", "weekly") */
  interval?: 'hourly' | 'daily' | 'weekly' | 'monthly';
  /** Day of week for weekly (0=Sunday, 6=Saturday) */
  dayOfWeek?: number;
  /** Day of month for monthly (1-31) */
  dayOfMonth?: number;
  /** Hour of day (0-23) */
  hour?: number;
  /** Minute of hour (0-59) */
  minute?: number;
}

/**
 * Options for creating a schedule.
 */
export interface ScheduleOptions {
  /** Unique schedule ID (for idempotency) */
  id?: string;
  /** When to fire (absolute time) */
  fireAt?: Date;
  /** Delay from now in milliseconds */
  delayMs?: number;
  /** Recurrence pattern for repeating schedules */
  recurrence?: RecurrencePattern;
  /** IANA timezone for time-of-day calculations */
  timezone?: string;
  /** Arbitrary data passed to handler when fired */
  data?: Record<string, unknown>;
  /** Maximum number of fires (for recurring, null = unlimited) */
  maxFires?: number;
  /** Idempotency key (prevents duplicate fires) */
  fireId?: string;
}

/**
 * A scheduled entry.
 */
export interface ScheduleEntry {
  /** Schedule ID */
  id: string;
  /** When it will next fire */
  nextFireAt: Date;
  /** When it was created */
  createdAt: Date;
  /** Number of times it has fired */
  fireCount: number;
  /** Whether it's a recurring schedule */
  recurring: boolean;
  /** Schedule data */
  data?: Record<string, unknown>;
  /** IANA timezone */
  timezone?: string;
}

/**
 * Fired schedule event.
 */
export interface ScheduleFiredEvent {
  /** Schedule ID */
  scheduleId: string;
  /** Idempotency key */
  fireId: string;
  /** Scheduled fire time */
  scheduledAt: Date;
  /** Actual fire time */
  firedAt: Date;
  /** Schedule data */
  data?: Record<string, unknown>;
  /** Fire number (for recurring) */
  fireNumber: number;
}

/**
 * IScheduler - Primary scheduling port.
 */
export interface IScheduler {
  /**
   * Schedule a new event.
   * Returns the schedule ID.
   */
  schedule(options: ScheduleOptions): Promise<string>;

  /**
   * Cancel a scheduled event.
   * Returns true if found and cancelled.
   */
  cancel(scheduleId: string): Promise<boolean>;

  /**
   * Get all active schedules.
   */
  getSchedules(): ScheduleEntry[] | Promise<ScheduleEntry[]>;

  /**
   * Get a specific schedule by ID.
   */
  getSchedule?(scheduleId: string): Promise<ScheduleEntry | null>;

  /**
   * Register handler for fired schedules.
   */
  onFire?(handler: (event: ScheduleFiredEvent) => void | Promise<void>): void;

  /**
   * Start the scheduler (begin firing events).
   */
  start?(): Promise<void>;

  /**
   * Stop the scheduler (stop firing, preserve pending).
   */
  stop?(): Promise<void>;

  /**
   * Pause a specific schedule.
   */
  pause?(scheduleId: string): Promise<boolean>;

  /**
   * Resume a paused schedule.
   */
  resume?(scheduleId: string): Promise<boolean>;
}

/**
 * ITimer - Simple timer interface.
 *
 * For basic delay operations without full scheduling.
 */
export interface ITimer {
  /**
   * Set a one-time timer.
   * Returns a handle that can be used to cancel.
   */
  setTimeout(callback: () => void, delayMs: number): unknown;

  /**
   * Set a recurring timer.
   */
  setInterval(callback: () => void, intervalMs: number): unknown;

  /**
   * Cancel a timer.
   */
  clear(handle: unknown): void;
}

/**
 * Factory for creating namespaced schedulers (for plugin isolation).
 */
export type SchedulerFactory = (namespace: string) => IScheduler;
