/**
 * Scheduler Primitive Implementation
 *
 * Provides scheduled event functionality for plugins.
 * Supports one-time and recurring schedules with DST-aware timing.
 */

import { DateTime } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import type { Logger } from '../types/logger.js';
import type {
  SchedulerPrimitive,
  ScheduleOptions,
  ScheduleEntry,
  RecurrenceConstraint,
} from '../types/plugin.js';
import type { StoragePrimitiveImpl } from './storage-primitive.js';

/**
 * Configuration for scheduler primitive.
 */
export interface SchedulerPrimitiveConfig {
  /** Warning threshold for schedule count */
  warningScheduleCount: number;

  /** Hard limit for schedule count (null = unlimited) */
  maxSchedules: number | null;

  /** Number of recent fire IDs to retain for deduplication */
  dedupeRetention: number;
}

const DEFAULT_CONFIG: SchedulerPrimitiveConfig = {
  warningScheduleCount: 1000,
  maxSchedules: null,
  dedupeRetention: 10,
};

/**
 * Storage keys used by scheduler.
 */
const STORAGE_KEYS = {
  schedules: 'schedules',
  firedPrefix: 'fired:',
} as const;

/**
 * Scheduler primitive implementation.
 */
export class SchedulerPrimitiveImpl implements SchedulerPrimitive {
  private readonly pluginId: string;
  private readonly storage: StoragePrimitiveImpl;
  private readonly logger: Logger;
  private readonly config: SchedulerPrimitiveConfig;

  /** In-memory cache of schedules */
  private schedules = new Map<string, ScheduleEntry>();

  /** Track if we've logged warnings */
  private countWarningLogged = false;

  constructor(
    pluginId: string,
    storage: StoragePrimitiveImpl,
    logger: Logger,
    config: Partial<SchedulerPrimitiveConfig> = {}
  ) {
    this.pluginId = pluginId;
    this.storage = storage;
    this.logger = logger.child({ component: 'scheduler-primitive', pluginId });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate a cron expression. Throws if invalid.
   */
  static validateCron(cronExpr: string): void {
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) {
      throw new Error(`Invalid cron expression: expected 5-6 fields, got ${String(fields.length)}`);
    }
    // Let cron-parser validate the actual syntax
    CronExpressionParser.parse(cronExpr);
  }

  /**
   * Parse cron and get next occurrence.
   * Returns DateTime or null if parsing fails (with warning log).
   */
  private parseCronNext(
    cronExpr: string,
    currentDate: Date,
    timezone: string | null
  ): DateTime | null {
    try {
      const cron = CronExpressionParser.parse(cronExpr, {
        currentDate,
        tz: timezone ?? 'UTC',
      });
      return DateTime.fromJSDate(cron.next().toDate(), { zone: timezone ?? 'utc' });
    } catch (error) {
      // This shouldn't happen if validation passed at creation time
      this.logger.warn(
        { cron: cronExpr, error: error instanceof Error ? error.message : String(error) },
        'Cron parse failed unexpectedly'
      );
      return null;
    }
  }

  /**
   * Initialize scheduler - load schedules from storage.
   */
  async initialize(): Promise<void> {
    const stored = await this.storage.get<ScheduleEntry[]>(STORAGE_KEYS.schedules);
    if (stored) {
      for (const entry of stored) {
        // Convert date strings back to Date objects
        entry.nextFireAt = new Date(entry.nextFireAt);
        entry.createdAt = new Date(entry.createdAt);
        if (entry.recurrence?.endDate) {
          entry.recurrence.endDate = new Date(entry.recurrence.endDate);
        }
        this.schedules.set(entry.id, entry);
      }
      this.logger.debug({ count: this.schedules.size }, 'Loaded schedules from storage');
    }
  }

  /**
   * Schedule a new event.
   */
  async schedule(options: ScheduleOptions): Promise<string> {
    // Check limits
    if (this.config.maxSchedules !== null && this.schedules.size >= this.config.maxSchedules) {
      throw new Error(
        `Schedule limit exceeded for plugin ${this.pluginId}: ${String(this.config.maxSchedules)}`
      );
    }

    // Warn if approaching limit
    if (!this.countWarningLogged && this.schedules.size >= this.config.warningScheduleCount) {
      this.logger.warn(
        { pluginId: this.pluginId, count: this.schedules.size },
        'Plugin schedule count approaching warning threshold'
      );
      this.countWarningLogged = true;
    }

    // Validate cron expression at creation time (fail-fast per CLAUDE.md)
    if (options.recurrence?.cron) {
      SchedulerPrimitiveImpl.validateCron(options.recurrence.cron);
    }

    const id = options.id ?? this.generateScheduleId();
    const now = new Date();

    // Calculate local time for recurring schedules
    let localTime: string | null = null;
    if (options.recurrence && options.timezone) {
      const dt = DateTime.fromJSDate(options.fireAt, { zone: options.timezone });
      localTime = dt.toFormat('HH:mm');
    }

    const entry: ScheduleEntry = {
      id,
      pluginId: this.pluginId,
      nextFireAt: options.fireAt,
      recurrence: options.recurrence ?? null,
      timezone: options.timezone ?? null,
      localTime,
      data: options.data,
      createdAt: now,
      fireCount: 0,
    };

    this.schedules.set(id, entry);
    await this.persistSchedules();

    this.logger.debug(
      {
        scheduleId: id,
        nextFireAt: entry.nextFireAt.toISOString(),
        recurrence: entry.recurrence?.frequency,
      },
      'Schedule created'
    );

    return id;
  }

  /**
   * Cancel a scheduled event.
   */
  async cancel(scheduleId: string): Promise<boolean> {
    const existed = this.schedules.has(scheduleId);
    if (existed) {
      this.schedules.delete(scheduleId);
      await this.persistSchedules();
      // Clean up fired IDs
      await this.storage.delete(`${STORAGE_KEYS.firedPrefix}${scheduleId}`);
      this.logger.debug({ scheduleId }, 'Schedule cancelled');
    }
    return existed;
  }

  /**
   * Get all active schedules.
   */
  getSchedules(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Update data for an existing schedule.
   * Used to sync manifest changes (like emitSignal) to existing schedules.
   * @returns true if schedule was found and updated, false if not found
   */
  async updateScheduleData(scheduleId: string, data: Record<string, unknown>): Promise<boolean> {
    const entry = this.schedules.get(scheduleId);
    if (!entry) {
      return false;
    }
    entry.data = data;
    await this.persistSchedules();
    return true;
  }

  /**
   * Check for due schedules and return those that should fire.
   * Called by SchedulerService on each tick.
   *
   * @param now Current time
   * @returns Array of [entry, fireId] tuples for due schedules
   */
  async checkDueSchedules(now: Date): Promise<{ entry: ScheduleEntry; fireId: string }[]> {
    const dueSchedules: { entry: ScheduleEntry; fireId: string }[] = [];

    for (const entry of this.schedules.values()) {
      if (entry.nextFireAt <= now) {
        // Generate fire ID for idempotency
        const fireId = `${entry.id}:${String(entry.nextFireAt.getTime())}`;

        // Check if already fired (dedupe)
        const alreadyFired = await this.checkFired(entry.id, fireId);
        if (alreadyFired) {
          this.logger.trace({ scheduleId: entry.id, fireId }, 'Skipping already-fired schedule');
          // Still need to advance recurring schedule
          if (entry.recurrence) {
            await this.advanceRecurringSchedule(entry, now);
          } else {
            // One-time schedule that was fired - remove it
            this.schedules.delete(entry.id);
          }
          continue;
        }

        dueSchedules.push({ entry, fireId });
      }
    }

    return dueSchedules;
  }

  /**
   * Mark a schedule as fired and update for next occurrence.
   */
  async markFired(scheduleId: string, fireId: string, now: Date): Promise<void> {
    const entry = this.schedules.get(scheduleId);
    if (!entry) return;

    // Record fire ID for deduplication
    await this.recordFired(scheduleId, fireId);

    entry.fireCount++;

    if (entry.recurrence) {
      // Advance to next occurrence
      await this.advanceRecurringSchedule(entry, now);
    } else {
      // One-time schedule - remove after firing
      this.schedules.delete(scheduleId);
      this.logger.debug({ scheduleId }, 'One-time schedule completed and removed');
    }

    await this.persistSchedules();
  }

  /**
   * Get all schedule data for migration.
   */
  getMigrationData(): ScheduleEntry[] {
    return Array.from(this.schedules.values());
  }

  /**
   * Restore schedules from migration bundle.
   */
  async restoreFromMigration(schedules: ScheduleEntry[]): Promise<void> {
    this.schedules.clear();
    for (const entry of schedules) {
      this.schedules.set(entry.id, entry);
    }
    await this.persistSchedules();
  }

  /**
   * Advance a recurring schedule to its next occurrence.
   */
  private async advanceRecurringSchedule(entry: ScheduleEntry, now: Date): Promise<void> {
    if (!entry.recurrence) return;

    const nextFire = this.calculateNextOccurrence(entry, now);

    if (!nextFire) {
      // Recurrence ended
      this.schedules.delete(entry.id);
      this.logger.debug({ scheduleId: entry.id }, 'Recurring schedule ended');
      await this.storage.delete(`${STORAGE_KEYS.firedPrefix}${entry.id}`);
      return;
    }

    entry.nextFireAt = nextFire;

    this.logger.trace(
      { scheduleId: entry.id, nextFireAt: nextFire.toISOString() },
      'Advanced recurring schedule'
    );
  }

  /**
   * Calculate next occurrence for a recurring schedule.
   * DST-aware for local time schedules.
   */
  private calculateNextOccurrence(entry: ScheduleEntry, now: Date): Date | null {
    const recurrence = entry.recurrence;
    if (!recurrence) {
      return null;
    }

    // Check max occurrences
    if (recurrence.maxOccurrences != null && entry.fireCount >= recurrence.maxOccurrences) {
      return null;
    }

    // Use Luxon for DST-aware calculations if timezone is set
    let nextFire: DateTime | undefined;

    if (entry.timezone && entry.localTime) {
      // Parse local time
      const [hour, minute] = entry.localTime.split(':').map(Number);
      let dt = DateTime.fromJSDate(entry.nextFireAt, { zone: entry.timezone });

      // Advance based on recurrence
      switch (recurrence.frequency) {
        case 'daily':
          dt = dt.plus({ days: recurrence.interval });
          break;
        case 'weekly':
          if (recurrence.daysOfWeek && recurrence.daysOfWeek.length > 0) {
            // Find next matching day of week
            dt = this.findNextDayOfWeek(dt, recurrence.daysOfWeek, recurrence.interval);
          } else {
            dt = dt.plus({ weeks: recurrence.interval });
          }
          break;
        case 'monthly':
          if (recurrence.anchorDay !== undefined && recurrence.constraint) {
            // Constraint-based: "weekend after 10th", etc.
            dt = this.findNextConstrainedMonthDay(
              dt,
              recurrence.anchorDay,
              recurrence.constraint,
              recurrence.interval
            );
          } else if (recurrence.dayOfMonth) {
            dt = this.findNextMonthDay(dt, recurrence.dayOfMonth, recurrence.interval);
          } else {
            dt = dt.plus({ months: recurrence.interval });
          }
          break;
        case 'custom':
          if (recurrence.cron) {
            const cronResult = this.parseCronNext(recurrence.cron, dt.toJSDate(), entry.timezone);
            if (cronResult) {
              // Cron provides complete time - return early, skip localTime adjustment
              nextFire = cronResult;
              break;
            }
            // Fallback only if cron unexpectedly fails (shouldn't happen with validation)
          }
          dt = dt.plus({ days: recurrence.interval });
          break;
      }

      // Set the local time (DST-aware) - skip for cron (already has correct time)
      nextFire ??= dt.set({ hour, minute, second: 0, millisecond: 0 });
    } else {
      // UTC calculation
      const dt = DateTime.fromJSDate(entry.nextFireAt, { zone: 'utc' });

      switch (recurrence.frequency) {
        case 'daily':
          nextFire = dt.plus({ days: recurrence.interval });
          break;
        case 'weekly':
          nextFire = dt.plus({ weeks: recurrence.interval });
          break;
        case 'monthly':
          nextFire = dt.plus({ months: recurrence.interval });
          break;
        case 'custom':
          if (recurrence.cron) {
            const cronResult = this.parseCronNext(recurrence.cron, dt.toJSDate(), null);
            if (cronResult) {
              nextFire = cronResult;
              break;
            }
          }
          nextFire = dt.plus({ days: recurrence.interval });
          break;
        default:
          nextFire = dt.plus({ days: 1 });
      }
    }

    // Ensure next fire is in the future
    const nowDt = DateTime.fromJSDate(now);
    if (nextFire <= nowDt) {
      // Recursively find next valid occurrence
      const tempEntry = { ...entry, nextFireAt: nextFire.toJSDate() };
      return this.calculateNextOccurrence(tempEntry, now);
    }

    // Check end date
    if (recurrence.endDate && nextFire.toJSDate() > recurrence.endDate) {
      return null;
    }

    return nextFire.toJSDate();
  }

  /**
   * Find next occurrence on specified days of week.
   */
  private findNextDayOfWeek(dt: DateTime, daysOfWeek: number[], intervalWeeks: number): DateTime {
    const currentDow = dt.weekday % 7; // Convert to 0=Sunday format
    const sortedDays = [...daysOfWeek].sort((a, b) => a - b);

    // Find next day in current week
    for (const dow of sortedDays) {
      if (dow > currentDow) {
        return dt.plus({ days: dow - currentDow });
      }
    }

    // Move to next interval week, first matching day
    const firstDay = sortedDays[0] ?? 0;
    const daysToNextWeek = 7 - currentDow + firstDay;
    return dt.plus({ days: daysToNextWeek + (intervalWeeks - 1) * 7 });
  }

  /**
   * Find next occurrence on specified day of month.
   */
  private findNextMonthDay(dt: DateTime, dayOfMonth: number, intervalMonths: number): DateTime {
    const nextDt = dt.plus({ months: intervalMonths });

    // Handle months with fewer days
    const daysInMonth = nextDt.daysInMonth ?? 28;
    const targetDay = Math.min(dayOfMonth, daysInMonth);

    return nextDt.set({ day: targetDay });
  }

  /**
   * Find next constrained occurrence (e.g., "weekend after 10th").
   */
  private findNextConstrainedMonthDay(
    dt: DateTime,
    anchorDay: number,
    constraint: RecurrenceConstraint,
    intervalMonths: number
  ): DateTime {
    // Move to next interval month
    const nextDt = dt.plus({ months: intervalMonths });

    // Clamp anchor day to valid range for this month
    const daysInMonth = nextDt.daysInMonth ?? 28;
    const clampedAnchorDay = Math.min(anchorDay, daysInMonth);

    // Set to anchor day
    const anchor = nextDt.set({ day: clampedAnchorDay });

    // Apply constraint
    return this.applyConstraint(anchor, constraint);
  }

  /**
   * Apply a constraint to find the target date from an anchor.
   */
  private applyConstraint(anchor: DateTime, constraint: RecurrenceConstraint): DateTime {
    // Luxon weekday: 1=Monday, 7=Sunday
    const dayOfWeek = anchor.weekday;

    switch (constraint) {
      case 'next-weekend': {
        // Find first Saturday (weekday 6) on or after anchor
        let daysUntilSaturday: number;
        if (dayOfWeek === 6) {
          daysUntilSaturday = 0;
        } else if (dayOfWeek === 7) {
          daysUntilSaturday = 6; // Sunday -> next Saturday
        } else {
          daysUntilSaturday = 6 - dayOfWeek;
        }
        return anchor.plus({ days: daysUntilSaturday });
      }

      case 'next-saturday': {
        let daysUntilSaturday: number;
        if (dayOfWeek === 6) {
          daysUntilSaturday = 0;
        } else if (dayOfWeek === 7) {
          daysUntilSaturday = 6;
        } else {
          daysUntilSaturday = 6 - dayOfWeek;
        }
        return anchor.plus({ days: daysUntilSaturday });
      }

      case 'next-sunday': {
        let daysUntilSunday: number;
        if (dayOfWeek === 7) {
          daysUntilSunday = 0;
        } else {
          daysUntilSunday = 7 - dayOfWeek;
        }
        return anchor.plus({ days: daysUntilSunday });
      }

      case 'next-weekday': {
        let daysUntilWeekday: number;
        if (dayOfWeek <= 5) {
          daysUntilWeekday = 0;
        } else if (dayOfWeek === 6) {
          daysUntilWeekday = 2; // Saturday -> Monday
        } else {
          daysUntilWeekday = 1; // Sunday -> Monday
        }
        return anchor.plus({ days: daysUntilWeekday });
      }

      default:
        return anchor;
    }
  }

  /**
   * Check if a fire ID has already been processed.
   */
  private async checkFired(scheduleId: string, fireId: string): Promise<boolean> {
    const key = `${STORAGE_KEYS.firedPrefix}${scheduleId}`;
    const firedIds = await this.storage.get<string[]>(key);
    return firedIds?.includes(fireId) ?? false;
  }

  /**
   * Record a fire ID for deduplication.
   */
  private async recordFired(scheduleId: string, fireId: string): Promise<void> {
    const key = `${STORAGE_KEYS.firedPrefix}${scheduleId}`;
    let firedIds = (await this.storage.get<string[]>(key)) ?? [];

    // Add new fire ID
    firedIds.push(fireId);

    // Trim to retention limit
    if (firedIds.length > this.config.dedupeRetention) {
      firedIds = firedIds.slice(-this.config.dedupeRetention);
    }

    await this.storage.set(key, firedIds);
  }

  /**
   * Persist schedules to storage.
   */
  private async persistSchedules(): Promise<void> {
    const scheduleArray = Array.from(this.schedules.values());
    await this.storage.set(STORAGE_KEYS.schedules, scheduleArray);
  }

  /**
   * Generate a unique schedule ID.
   */
  private generateScheduleId(): string {
    return `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Create a scheduler primitive for a plugin.
 */
export function createSchedulerPrimitive(
  pluginId: string,
  storage: StoragePrimitiveImpl,
  logger: Logger,
  config?: Partial<SchedulerPrimitiveConfig>
): SchedulerPrimitiveImpl {
  return new SchedulerPrimitiveImpl(pluginId, storage, logger, config);
}
