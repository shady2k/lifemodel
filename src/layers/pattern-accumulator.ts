import type { Event, Logger, Priority } from '../types/index.js';

/**
 * Pattern definition for accumulation.
 */
export interface Pattern {
  /** Pattern identifier */
  id: string;

  /** Event type to match */
  eventType: string;

  /** Optional source filter */
  source?: Event['source'];

  /** Time window in ms */
  windowMs: number;

  /** Count threshold to trigger */
  threshold: number;

  /** Priority of generated awareness event */
  priority: Priority;

  /** Description for logging */
  description: string;
}

/**
 * Accumulated count for a pattern.
 */
interface PatternCount {
  pattern: Pattern;
  timestamps: number[];
}

/**
 * Triggered pattern event.
 */
export interface PatternTrigger {
  pattern: Pattern;
  count: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
}

/**
 * PatternAccumulator - detects repeated events over time.
 *
 * Like humans noticing patterns:
 * - One car honk = ignore
 * - Ten car honks = "what's happening?"
 *
 * When events of a certain type accumulate within a time window
 * and cross a threshold, it triggers awareness (hoisting to higher layers).
 */
export class PatternAccumulator {
  private readonly patterns = new Map<string, PatternCount>();
  private readonly logger: Logger;

  constructor(logger: Logger, initialPatterns?: Pattern[]) {
    this.logger = logger.child({ component: 'pattern-accumulator' });

    if (initialPatterns) {
      for (const pattern of initialPatterns) {
        this.registerPattern(pattern);
      }
    }
  }

  /**
   * Register a pattern to track.
   */
  registerPattern(pattern: Pattern): void {
    this.patterns.set(pattern.id, {
      pattern,
      timestamps: [],
    });

    this.logger.debug(
      { patternId: pattern.id, description: pattern.description },
      'Pattern registered'
    );
  }

  /**
   * Unregister a pattern.
   */
  unregisterPattern(patternId: string): boolean {
    const deleted = this.patterns.delete(patternId);
    if (deleted) {
      this.logger.debug({ patternId }, 'Pattern unregistered');
    }
    return deleted;
  }

  /**
   * Record an event and check for pattern triggers.
   *
   * @returns Array of triggered patterns (if any)
   */
  recordEvent(event: Event): PatternTrigger[] {
    const now = Date.now();
    const triggers: PatternTrigger[] = [];

    for (const [patternId, count] of this.patterns) {
      const { pattern } = count;

      // Check if event matches pattern
      if (!this.matchesPattern(event, pattern)) {
        continue;
      }

      // Add timestamp
      count.timestamps.push(now);

      // Prune old timestamps outside window
      const windowStart = now - pattern.windowMs;
      count.timestamps = count.timestamps.filter((t) => t >= windowStart);

      // Check threshold
      if (count.timestamps.length >= pattern.threshold) {
        const trigger: PatternTrigger = {
          pattern,
          count: count.timestamps.length,
          firstOccurrence: new Date(count.timestamps[0] ?? now),
          lastOccurrence: new Date(now),
        };

        triggers.push(trigger);

        this.logger.info(
          {
            patternId,
            count: count.timestamps.length,
            threshold: pattern.threshold,
            windowMs: pattern.windowMs,
          },
          'Pattern threshold crossed'
        );

        // Reset after trigger (prevent continuous triggering)
        count.timestamps = [];
      }
    }

    return triggers;
  }

  /**
   * Get current counts for all patterns (for monitoring).
   */
  getCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    const now = Date.now();

    for (const [patternId, count] of this.patterns) {
      // Only count timestamps within window
      const windowStart = now - count.pattern.windowMs;
      const validCount = count.timestamps.filter((t) => t >= windowStart).length;
      counts.set(patternId, validCount);
    }

    return counts;
  }

  /**
   * Clear all accumulated counts.
   */
  reset(): void {
    for (const count of this.patterns.values()) {
      count.timestamps = [];
    }
    this.logger.debug('All pattern counts reset');
  }

  /**
   * Periodic cleanup of old timestamps.
   */
  cleanup(): void {
    const now = Date.now();

    for (const count of this.patterns.values()) {
      const windowStart = now - count.pattern.windowMs;
      count.timestamps = count.timestamps.filter((t) => t >= windowStart);
    }
  }

  private matchesPattern(event: Event, pattern: Pattern): boolean {
    // Check event type
    if (event.type !== pattern.eventType) {
      return false;
    }

    // Check source if specified
    if (pattern.source !== undefined && event.source !== pattern.source) {
      return false;
    }

    return true;
  }
}

/**
 * Default patterns for common scenarios.
 */
export function createDefaultPatterns(priority: Priority): Pattern[] {
  return [
    {
      id: 'rapid_messages',
      eventType: 'message_received',
      source: 'communication',
      windowMs: 60_000, // 1 minute
      threshold: 5,
      priority,
      description: 'Multiple messages in quick succession',
    },
    {
      id: 'repeated_questions',
      eventType: 'question',
      windowMs: 300_000, // 5 minutes
      threshold: 3,
      priority,
      description: 'Multiple questions without answers',
    },
    {
      id: 'frequent_errors',
      eventType: 'error',
      source: 'system',
      windowMs: 60_000, // 1 minute
      threshold: 3,
      priority,
      description: 'Multiple system errors',
    },
  ];
}

/**
 * Factory function.
 */
export function createPatternAccumulator(logger: Logger, patterns?: Pattern[]): PatternAccumulator {
  return new PatternAccumulator(logger, patterns);
}
