/**
 * Event priority levels.
 *
 * Like the nervous system: urgent signals get processed first.
 * Lower number = higher priority.
 */
export enum Priority {
  /** Errors, "help!", system failures - always processed */
  CRITICAL = 0,
  /** User messages, urgent tasks */
  HIGH = 1,
  /** Regular events, timers */
  NORMAL = 2,
  /** Analytics, background sync */
  LOW = 3,
  /** Cleanup, optimization */
  IDLE = 4,
}

/**
 * Disturbance weight by priority.
 * Used for accumulated wake-up during sleep mode.
 */
export const PRIORITY_DISTURBANCE_WEIGHT: Record<Priority, number> = {
  [Priority.CRITICAL]: 1.0, // Instant wake
  [Priority.HIGH]: 0.3,
  [Priority.NORMAL]: 0.1,
  [Priority.LOW]: 0.05,
  [Priority.IDLE]: 0.01,
};
