/**
 * Reminder Plugin Types
 *
 * Type definitions for reminders, semantic date anchors, and recurrence.
 */

import type { RecurrenceSpec } from '../../types/plugin.js';

/**
 * Status of a reminder.
 */
export type ReminderStatus = 'active' | 'completed' | 'cancelled';

/**
 * A stored reminder.
 */
export interface Reminder {
  /** Unique reminder ID */
  id: string;

  /** What to remind about */
  content: string;

  /** Chat ID where reminder was created */
  chatId: string;

  /** When to fire (UTC for one-time) */
  triggerAt: Date;

  /** Recurrence specification (null for one-time) */
  recurrence: RecurrenceSpec | null;

  /** Original semantic anchor from LLM */
  semanticAnchor: SemanticDateAnchor;

  /** Current status */
  status: ReminderStatus;

  /** When the reminder was created */
  createdAt: Date;

  /** User's timezone (IANA name) for recurring reminders */
  timezone: string | null;

  /** Tags for organization */
  tags?: string[];

  /** Number of times fired (for recurring) */
  fireCount: number;

  /** Associated schedule ID (from scheduler primitive) */
  scheduleId: string | null;
}

/**
 * Type of semantic date anchor.
 */
export type SemanticAnchorType = 'relative' | 'absolute' | 'recurring';

/**
 * Semantic date anchor - LLM extracts meaning, app calculates dates.
 *
 * This allows natural language processing without the LLM needing
 * to know the current time or calculate dates.
 */
export interface SemanticDateAnchor {
  /** Type of anchor */
  type: SemanticAnchorType;

  /** Relative time specification (e.g., "in 30 minutes") */
  relative?: RelativeTime;

  /** Absolute time specification (e.g., "tomorrow at 3pm") */
  absolute?: AbsoluteTime;

  /** Recurring specification (e.g., "every day at 9am") */
  recurring?: RecurringTime;

  /** LLM's confidence in the interpretation (0-1) */
  confidence: number;

  /** Original phrase from user */
  originalPhrase: string;
}

/**
 * Relative time specification.
 */
export interface RelativeTime {
  /** Time unit */
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month';

  /** Amount of units */
  amount: number;
}

/**
 * Absolute time specification.
 */
export interface AbsoluteTime {
  /** Year (optional - defaults to current/next) */
  year?: number;

  /** Month (1-12, optional) */
  month?: number;

  /** Day of month (1-31, optional) */
  day?: number;

  /** Hour (0-23, optional) */
  hour?: number;

  /** Minute (0-59, optional - defaults to 0) */
  minute?: number;

  /** Special named time */
  special?: 'tomorrow' | 'next_week' | 'next_month' | 'this_evening' | 'tonight' | 'this_afternoon';

  /** Day of week for "next Monday" etc (0=Sunday, 6=Saturday) */
  dayOfWeek?: number;
}

/**
 * Constraint for finding dates relative to an anchor day.
 */
export type DateConstraint =
  | 'next-weekend' // First Saturday-Sunday on or after anchor
  | 'next-weekday' // First Mon-Fri on or after anchor
  | 'next-saturday' // First Saturday on or after anchor
  | 'next-sunday'; // First Sunday on or after anchor

/**
 * Recurring time specification.
 */
export interface RecurringTime {
  /** Frequency */
  frequency: 'daily' | 'weekly' | 'monthly';

  /** Interval (every N days/weeks/months) */
  interval: number;

  /** Days of week for weekly (0=Sunday, 6=Saturday) */
  daysOfWeek?: number[];

  /** Day of month for monthly (1-31) - fixed day approach */
  dayOfMonth?: number;

  /**
   * Anchor day for constraint-based scheduling (1-31).
   * Used with 'constraint' for patterns like "weekend after 10th".
   */
  anchorDay?: number;

  /**
   * Constraint to apply after anchor day.
   * E.g., anchorDay=10 + constraint='next-weekend' = "first weekend after 10th"
   */
  constraint?: DateConstraint;

  /** Hour of day (0-23) */
  hour?: number;

  /** Minute (0-59) */
  minute?: number;
}

/**
 * Result of creating a reminder.
 */
export interface CreateReminderResult {
  /** Whether creation succeeded */
  success: boolean;

  /** Created reminder ID */
  reminderId?: string;

  /** When the reminder is scheduled for */
  scheduledFor?: Date;

  /** Whether this is a recurring reminder */
  isRecurring?: boolean;

  /** Error message if failed */
  error?: string;
}

/**
 * Result of listing reminders.
 */
export interface ListRemindersResult {
  /** Active reminders */
  reminders: ReminderSummary[];

  /** Total count */
  total: number;
}

/**
 * Summary of a reminder for listing.
 */
export interface ReminderSummary {
  /** Reminder ID */
  id: string;

  /** What to remind about */
  content: string;

  /** When it fires next */
  nextFireAt: Date;

  /** Whether it's recurring */
  isRecurring: boolean;

  /** Recurrence description if recurring */
  recurrenceDesc?: string;
}

/**
 * Result of cancelling a reminder.
 */
export interface CancelReminderResult {
  /** Whether cancellation succeeded */
  success: boolean;

  /** Error message if failed */
  error?: string;
}

/**
 * Reminder due event data (emitted when reminder fires).
 */
export interface ReminderDueData {
  /** Reminder ID */
  reminderId: string;

  /** Chat ID to notify */
  chatId: string;

  /** Reminder content */
  content: string;

  /** Whether this is a recurring reminder */
  isRecurring: boolean;

  /** Fire count (how many times it has fired) */
  fireCount: number;

  /** Tags */
  tags?: string[];
}

/**
 * Event kinds emitted by the reminder plugin.
 */
export const REMINDER_EVENT_KINDS = {
  /** Reminder is due and should be delivered */
  REMINDER_DUE: 'com.lifemodel.reminder:reminder_due',
} as const;

/**
 * Storage keys used by the reminder plugin.
 */
export const REMINDER_STORAGE_KEYS = {
  /** All reminders */
  REMINDERS: 'reminders',
} as const;
