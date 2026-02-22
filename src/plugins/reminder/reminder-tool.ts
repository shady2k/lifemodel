/**
 * Reminder Plugin Tools
 *
 * Single unified tool for creating, listing, and cancelling reminders.
 */

import type { Logger } from '../../types/logger.js';
import type {
  PluginPrimitives,
  PluginTool,
  PluginToolContext,
  ScheduleOptions,
  FireContext,
} from '../../types/plugin.js';
import type {
  Reminder,
  SemanticDateAnchor,
  ReminderDueData,
  ReminderSummary,
  AdvanceNotice,
  ReminderAdvanceNoticeData,
  RelativeTime,
  AbsoluteTime,
  RecurringTime,
  ReminderOccurrence,
  DateConstraint,
} from './reminder-types.js';
import { REMINDER_EVENT_KINDS, REMINDER_STORAGE_KEYS } from './reminder-types.js';
import { resolveSemanticAnchor, formatRecurrence } from './date-parser.js';
import { DateTime } from 'luxon';

/**
 * Plugin ID for reminder plugin.
 */
export const REMINDER_PLUGIN_ID = 'reminder';

/**
 * Get the user's timezone by recipientId.
 * Always returns a valid IANA timezone (falls back to server timezone if not configured).
 */
type GetTimezoneFunc = (recipientId: string) => string;
type IsTimezoneConfiguredFunc = (recipientId: string) => boolean;
type GetUserPatternsFunc = (recipientId: string) => { wakeHour?: number | null } | null | undefined;

/**
 * Result type for the unified reminder tool.
 */
interface ReminderToolResult {
  success: boolean;
  action: string;
  reminderId?: string;
  scheduledFor?: Date;
  isRecurring?: boolean;
  timezoneNote?: string;
  reminders?: ReminderSummary[];
  total?: number;
  error?: string;
  receivedParams?: string[];
  schema?: Record<string, unknown>;
  /** For complete action: when next occurrence fires (recurring only) */
  nextFireAt?: Date;
  /** For complete action: updated completed count */
  completedCount?: number;
}

/**
 * Schema definitions for error responses.
 * These help the LLM self-correct when it sends invalid parameters.
 */
const SCHEMA_CREATE = {
  action: { type: 'string', required: true, enum: ['create'] },
  content: { type: 'string', required: true, description: 'What to remind about' },
  anchor: {
    type: 'object',
    required: true,
    description: 'Semantic date anchor defining WHEN to fire',
    properties: {
      type: { type: 'string', required: true, enum: ['relative', 'absolute', 'recurring'] },
      confidence: { type: 'number', required: true, description: '0-1 confidence score' },
      originalPhrase: {
        type: 'string',
        required: true,
        description: 'Original time expression from user',
      },
      // relative fields
      unit: {
        type: 'string',
        required: false,
        enum: ['minute', 'hour', 'day', 'week', 'month'],
        description: 'For type="relative": time unit',
      },
      amount: {
        type: 'number',
        required: false,
        description: 'For type="relative": number of units',
      },
      // absolute fields
      special: {
        type: 'string',
        required: false,
        enum: ['tomorrow', 'next_week', 'next_month', 'this_evening', 'tonight', 'this_afternoon'],
        description: 'For type="absolute": named time shortcut',
      },
      year: { type: 'number', required: false },
      month: { type: 'number', required: false, description: '1-12' },
      day: { type: 'number', required: false, description: '1-31' },
      hour: { type: 'number', required: false, description: '0-23' },
      minute: { type: 'number', required: false, description: '0-59' },
      dayOfWeek: {
        type: 'number',
        required: false,
        description: '0=Sunday, 6=Saturday (for "next Monday" etc.)',
      },
      // recurring fields
      frequency: {
        type: 'string',
        required: false,
        enum: ['daily', 'weekly', 'monthly'],
        description: 'For type="recurring": recurrence frequency',
      },
      interval: { type: 'number', required: false, description: 'Every N periods (default: 1)' },
      daysOfWeek: {
        type: 'array',
        items: 'number (0-6)',
        required: false,
        description: 'For weekly recurrence',
      },
      dayOfMonth: { type: 'number', required: false, description: 'For monthly, fixed day (1-31)' },
      dayOfMonthEnd: {
        type: 'number',
        required: false,
        description:
          'End day for monthly range (1-31). Fires daily from dayOfMonth to dayOfMonthEnd.',
      },
      anchorDay: {
        type: 'number',
        required: false,
        description: 'For monthly with constraint (1-31)',
      },
      constraint: {
        type: 'string',
        required: false,
        enum: ['next-weekend', 'next-weekday', 'next-saturday', 'next-sunday'],
      },
    },
  },
  advanceNotice: {
    type: 'object',
    required: false,
    description: 'Optional advance notice (e.g., "remind me 30 minutes before")',
    properties: {
      before: { type: 'object', required: true },
      confidence: { type: 'number', required: true },
      originalPhrase: { type: 'string', required: true },
    },
  },
  tags: { type: 'array', items: 'string', required: false },
  internal: {
    type: 'boolean',
    required: false,
    description: "Self-scheduled reminder (agent's own commitment)",
  },
};

const SCHEMA_CANCEL = {
  action: { type: 'string', required: true, enum: ['cancel'] },
  reminderId: { type: 'string', required: true, description: 'ID returned by create or list' },
};

const SCHEMA_COMPLETE = {
  action: { type: 'string', required: true, enum: ['complete'] },
  reminderId: { type: 'string', required: true, description: 'ID returned by create or list' },
};

const SCHEMA_LIST = {
  action: { type: 'string', required: true, enum: ['list'] },
  limit: { type: 'number', required: false, default: 10 },
};

/**
 * OpenAI-compatible JSON Schema for the reminder tool.
 * Canonical (non-strict) form: only truly required fields in `required`.
 * Optional fields use plain types without nullable union.
 * Strict mode transformation is applied dynamically in vercel-ai-provider.ts
 * for models that support it (OpenAI, Claude).
 */
const REMINDER_RAW_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'cancel', 'complete'],
      description: 'Action to perform',
    },
    content: {
      type: 'string',
      description: 'What to remind about (required for create)',
    },
    anchor: {
      type: 'object',
      description: 'Semantic date anchor (required for create). Extract time from user message.',
      properties: {
        type: {
          type: 'string',
          enum: ['relative', 'absolute', 'recurring'],
          description: 'Type of time expression',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score 0-1',
        },
        originalPhrase: {
          type: 'string',
          description: 'Original time expression from user (e.g., "завтра", "in 2 hours")',
        },
        // relative fields (flat)
        unit: {
          type: 'string',
          enum: ['minute', 'hour', 'day', 'week', 'month'],
          description: 'For type="relative": time unit',
        },
        amount: {
          type: 'number',
          description: 'For type="relative": number of units',
        },
        // absolute fields (flat)
        special: {
          type: 'string',
          enum: [
            'tomorrow',
            'next_week',
            'next_month',
            'this_evening',
            'tonight',
            'this_afternoon',
          ],
          description: 'For type="absolute": named time shortcut',
        },
        year: { type: 'number' },
        month: { type: 'number', description: '1-12' },
        day: { type: 'number', description: '1-31' },
        hour: { type: 'number', description: '0-23' },
        minute: { type: 'number', description: '0-59' },
        dayOfWeek: {
          type: 'number',
          description: '0=Sunday, 6=Saturday (for "next Monday" etc.)',
        },
        // recurring fields (flat)
        frequency: {
          type: 'string',
          enum: ['daily', 'weekly', 'monthly'],
          description: 'For type="recurring": recurrence frequency',
        },
        interval: {
          type: 'number',
          description: 'Every N periods (default: 1)',
        },
        daysOfWeek: {
          type: 'array',
          items: { type: 'number' },
          description: 'For weekly: days of week (0=Sun, 6=Sat)',
        },
        dayOfMonth: {
          type: 'number',
          description: 'For monthly: fixed day (1-31)',
        },
        dayOfMonthEnd: {
          type: 'number',
          description:
            'End day for monthly range (1-31). Fires daily from dayOfMonth to dayOfMonthEnd.',
        },
        anchorDay: {
          type: 'number',
          description: 'For monthly with constraint: anchor day (1-31)',
        },
        constraint: {
          type: 'string',
          enum: ['next-weekend', 'next-weekday', 'next-saturday', 'next-sunday'],
          description: 'Constraint to apply after anchorDay',
        },
      },
      required: ['type', 'confidence', 'originalPhrase'],
    },
    advanceNotice: {
      type: 'object',
      description: 'Optional advance notice (e.g., "remind me 30 minutes before")',
      properties: {
        before: {
          type: 'object',
          properties: {
            unit: {
              type: 'string',
              enum: ['minute', 'hour', 'day', 'week', 'month'],
            },
            amount: { type: 'number', minimum: 1 },
          },
          required: ['unit', 'amount'],
          additionalProperties: false,
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        originalPhrase: { type: 'string' },
      },
      required: ['before', 'confidence', 'originalPhrase'],
      additionalProperties: false,
    },
    reminderId: {
      type: 'string',
      description: 'Reminder ID (required for cancel)',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional tags for organizing',
    },
    limit: {
      type: 'number',
      description: 'Max reminders to return (list only, default: 10)',
    },
    internal: {
      type: 'boolean',
      description: "Self-scheduled reminder (agent's own commitment, not user-facing)",
    },
  },
  required: ['action'],
  additionalProperties: false,
};

/**
 * Normalize a flat anchor (LLM-facing format) into nested SemanticDateAnchor (internal format).
 * Validates that required sub-fields are present for each anchor type.
 */
function normalizeAnchor(
  flat: Record<string, unknown>
): { success: true; anchor: SemanticDateAnchor } | { success: false; error: string } {
  const type = flat['type'] as string;
  const confidence = flat['confidence'] as number;
  const originalPhrase = flat['originalPhrase'] as string;

  const anchorType = type as SemanticDateAnchor['type'];

  switch (type) {
    case 'relative': {
      const unit = flat['unit'] as string | undefined;
      const amount = flat['amount'] as number | undefined;
      if (!unit || amount == null) {
        return {
          success: false,
          error:
            'anchor.type is "relative" but missing "unit" and/or "amount". ' +
            'Example: { type: "relative", unit: "hour", amount: 2, confidence: 0.9, originalPhrase: "in 2 hours" }',
        };
      }
      const anchor: SemanticDateAnchor = {
        type: anchorType,
        confidence,
        originalPhrase,
        relative: { unit: unit as RelativeTime['unit'], amount },
      };
      return { success: true, anchor };
    }

    case 'absolute': {
      const special = flat['special'] as string | undefined;
      const year = flat['year'] as number | undefined;
      const month = flat['month'] as number | undefined;
      const day = flat['day'] as number | undefined;
      const hour = flat['hour'] as number | undefined;
      const minute = flat['minute'] as number | undefined;
      const dayOfWeek = flat['dayOfWeek'] as number | undefined;

      if (
        special == null &&
        year == null &&
        month == null &&
        day == null &&
        hour == null &&
        minute == null &&
        dayOfWeek == null
      ) {
        return {
          success: false,
          error:
            'anchor.type is "absolute" but no time fields provided. ' +
            'Example: { type: "absolute", special: "tomorrow", confidence: 0.9, originalPhrase: "завтра" }',
        };
      }

      const absolute: Record<string, unknown> = {};
      if (special != null) absolute['special'] = special;
      if (year != null) absolute['year'] = year;
      if (month != null) absolute['month'] = month;
      if (day != null) absolute['day'] = day;
      if (hour != null) absolute['hour'] = hour;
      if (minute != null) absolute['minute'] = minute;
      if (dayOfWeek != null) absolute['dayOfWeek'] = dayOfWeek;

      const anchor: SemanticDateAnchor = {
        type: anchorType,
        confidence,
        originalPhrase,
        absolute: absolute as unknown as AbsoluteTime,
      };
      return { success: true, anchor };
    }

    case 'recurring': {
      const frequency = flat['frequency'] as string | undefined;
      if (!frequency) {
        return {
          success: false,
          error:
            'anchor.type is "recurring" but missing "frequency". ' +
            'Example: { type: "recurring", frequency: "daily", interval: 1, hour: 9, confidence: 0.9, originalPhrase: "every day at 9am" }',
        };
      }

      const recurring: Record<string, unknown> = {
        frequency,
        interval: (flat['interval'] as number | undefined) ?? 1,
      };
      const hour = flat['hour'] as number | undefined;
      const minute = flat['minute'] as number | undefined;
      const daysOfWeek = flat['daysOfWeek'] as number[] | undefined;
      const dayOfMonth = flat['dayOfMonth'] as number | undefined;
      const dayOfMonthEnd = flat['dayOfMonthEnd'] as number | undefined;
      const anchorDay = flat['anchorDay'] as number | undefined;
      const constraint = flat['constraint'] as string | undefined;

      if (hour != null) recurring['hour'] = hour;
      if (minute != null) recurring['minute'] = minute;
      if (daysOfWeek != null) recurring['daysOfWeek'] = daysOfWeek;
      if (dayOfMonth != null) recurring['dayOfMonth'] = dayOfMonth;
      if (dayOfMonthEnd != null) recurring['dayOfMonthEnd'] = dayOfMonthEnd;
      if (anchorDay != null) recurring['anchorDay'] = anchorDay;
      if (constraint != null) recurring['constraint'] = constraint as DateConstraint;

      const anchor: SemanticDateAnchor = {
        type: anchorType,
        confidence,
        originalPhrase,
        recurring: recurring as unknown as RecurringTime,
      };
      return { success: true, anchor };
    }

    default:
      return { success: false, error: `Unknown anchor type: ${type}` };
  }
}

/**
 * Create the unified reminder tool.
 */
export function createReminderTools(
  primitives: PluginPrimitives,
  getTimezone: GetTimezoneFunc,
  isTimezoneConfigured?: IsTimezoneConfiguredFunc,
  getUserPatterns?: GetUserPatternsFunc
): PluginTool[] {
  const { storage, scheduler, logger } = primitives;

  /**
   * Load all reminders from storage.
   */
  async function loadReminders(): Promise<Map<string, Reminder>> {
    const stored = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
    const map = new Map<string, Reminder>();
    if (stored) {
      for (const r of stored) {
        r.triggerAt = new Date(r.triggerAt);
        r.createdAt = new Date(r.createdAt);
        // Revive lastCompletedAt date if present
        if (r.lastCompletedAt) {
          r.lastCompletedAt = new Date(r.lastCompletedAt);
        }
        // Handle existing reminders without new fields (for backward compatibility)
        const reminderPartial = r as Partial<Reminder> & { triggerAt: Date; createdAt: Date };
        if (reminderPartial.advanceNotice === undefined) {
          reminderPartial.advanceNotice = null;
        }
        if (reminderPartial.advanceNoticeScheduleId === undefined) {
          reminderPartial.advanceNoticeScheduleId = null;
        }
        if (reminderPartial.lastCompletedAt === undefined) {
          reminderPartial.lastCompletedAt = null;
        }
        reminderPartial.completedCount ??= 0;
        map.set(r.id, r);
      }
    }
    return map;
  }

  /**
   * Save all reminders to storage.
   */
  async function saveReminders(reminders: Map<string, Reminder>): Promise<void> {
    await storage.set(REMINDER_STORAGE_KEYS.REMINDERS, Array.from(reminders.values()));
  }

  /**
   * Load all reminder occurrences from storage.
   */
  async function loadOccurrences(): Promise<Map<string, ReminderOccurrence>> {
    const stored = await storage.get<ReminderOccurrence[]>(
      REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES
    );
    const map = new Map<string, ReminderOccurrence>();
    if (stored) {
      for (const occ of stored) {
        occ.scheduledAt = new Date(occ.scheduledAt);
        if (occ.firedAt) occ.firedAt = new Date(occ.firedAt);
        if (occ.completedAt) occ.completedAt = new Date(occ.completedAt);
        map.set(occ.id, occ);
      }
    }
    return map;
  }

  /**
   * Save all reminder occurrences to storage.
   */
  async function saveOccurrences(occurrences: Map<string, ReminderOccurrence>): Promise<void> {
    await storage.set(REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES, Array.from(occurrences.values()));
  }

  /**
   * Create a new occurrence for a reminder.
   */
  function createOccurrence(
    reminderId: string,
    sequence: number,
    scheduledAt: Date,
    status: 'fired' | 'completed' | 'skipped' = 'fired'
  ): ReminderOccurrence {
    return {
      id: `occ_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      reminderId,
      sequence,
      scheduledAt,
      firedAt: status === 'fired' ? new Date() : null,
      completedAt: status === 'completed' ? new Date() : null,
      status,
    };
  }

  /**
   * Calculate when to send advance notice.
   * CRITICAL: Calculate in user's timezone, not UTC, for DST correctness.
   */
  function calculateAdvanceNoticeTime(
    reminderTime: Date,
    before: RelativeTime,
    userTimezone: string
  ): Date {
    // Convert to user's timezone first
    const dt = DateTime.fromJSDate(reminderTime, { zone: userTimezone });

    let advanceDt: DateTime;
    const unit = before.unit;
    if (unit === 'minute') {
      advanceDt = dt.minus({ minutes: before.amount });
    } else if (unit === 'hour') {
      advanceDt = dt.minus({ hours: before.amount });
    } else if (unit === 'day') {
      advanceDt = dt.minus({ days: before.amount });
    } else if (unit === 'week') {
      advanceDt = dt.minus({ weeks: before.amount });
    } else {
      // unit === 'month' (all other cases exhausted)
      advanceDt = dt.minus({ months: before.amount });
    }

    return advanceDt.toJSDate();
  }

  /**
   * Create a new reminder.
   */
  async function createReminder(
    content: string,
    anchor: SemanticDateAnchor,
    recipientId: string,
    tags?: string[],
    advanceNotice?: AdvanceNotice,
    internal?: boolean
  ): Promise<ReminderToolResult> {
    try {
      const timezone = getTimezone(recipientId);
      const userPatterns = getUserPatterns?.(recipientId);
      const wakeHour = userPatterns?.wakeHour ?? 8;
      const resolved = resolveSemanticAnchor(anchor, new Date(), timezone, wakeHour);
      const reminderId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      // Validate advance notice constraints BEFORE creating any schedules
      // This prevents orphaned schedules if validation fails
      if (advanceNotice) {
        // For recurring reminders, enforce "same-day earlier" semantics
        if (resolved.recurrence) {
          if (!['minute', 'hour'].includes(advanceNotice.before.unit)) {
            return {
              success: false,
              action: 'create',
              error: 'Advance notice for recurring reminders supports minutes/hours only in v1.',
            };
          }

          const reminderLocal = DateTime.fromJSDate(resolved.triggerAt, { zone: timezone });
          const minutesSinceMidnight = reminderLocal.hour * 60 + reminderLocal.minute;
          const offsetMinutes =
            advanceNotice.before.unit === 'minute'
              ? advanceNotice.before.amount
              : advanceNotice.before.amount * 60;

          if (offsetMinutes >= minutesSinceMidnight) {
            return {
              success: false,
              action: 'create',
              error: 'Advance notice must be earlier on the same day for recurring reminders.',
            };
          }
        }
      }

      const reminder: Reminder = {
        id: reminderId,
        content,
        recipientId,
        triggerAt: resolved.triggerAt,
        recurrence: resolved.recurrence,
        semanticAnchor: anchor,
        status: 'active',
        createdAt: new Date(),
        timezone: resolved.recurrence ? timezone : null,
        fireCount: 0,
        lastCompletedAt: null,
        completedCount: 0,
        scheduleId: null,
        advanceNotice: advanceNotice ?? null,
        advanceNoticeScheduleId: null,
        internal: internal ?? false,
      };

      if (tags) {
        reminder.tags = tags;
      }

      const scheduleData: Record<string, unknown> = {
        kind: internal ? REMINDER_EVENT_KINDS.SELF_SCHEDULED : REMINDER_EVENT_KINDS.REMINDER_DUE,
        reminderId,
        recipientId,
        content,
        isRecurring: resolved.recurrence !== null,
        fireCount: 0,
        scheduledAt: resolved.triggerAt.toISOString(),
        internal: internal ?? false,
      };
      if (tags) {
        scheduleData['tags'] = tags;
      }

      const scheduleOptions: ScheduleOptions = {
        fireAt: resolved.triggerAt,
        data: scheduleData,
      };
      if (resolved.recurrence) {
        scheduleOptions.recurrence = resolved.recurrence;
        scheduleOptions.timezone = timezone;
      }

      const scheduleId = await scheduler.schedule(scheduleOptions);
      reminder.scheduleId = scheduleId;

      // Create advance notice schedule if specified (validation already done above)
      if (advanceNotice) {
        // Calculate advance notice in user's timezone for DST correctness
        const advanceNoticeTime = calculateAdvanceNoticeTime(
          resolved.triggerAt,
          advanceNotice.before,
          timezone // Pass timezone for proper calculation
        );

        // Warn if advance notice is in the past
        if (advanceNoticeTime < new Date()) {
          logger.warn(
            { reminderId, advanceNoticeTime, triggerAt: resolved.triggerAt },
            'Advance notice time is in the past - may fire immediately'
          );
        }

        const advanceNoticeData: Record<string, unknown> = {
          kind: REMINDER_EVENT_KINDS.REMINDER_ADVANCE_NOTICE,
          reminderId,
          recipientId,
          content,
          // Store as ISO string - scheduler doesn't revive nested Dates
          actualReminderAt: resolved.triggerAt.toISOString(),
          advanceNoticeBefore: advanceNotice.before,
          isRecurring: resolved.recurrence !== null,
          fireCount: 0,
        };
        if (tags) {
          advanceNoticeData['tags'] = tags;
        }

        const advanceNoticeOptions: ScheduleOptions = {
          fireAt: advanceNoticeTime,
          data: advanceNoticeData,
        };

        if (resolved.recurrence) {
          advanceNoticeOptions.recurrence = resolved.recurrence;
          advanceNoticeOptions.timezone = timezone;
        }

        const advanceNoticeScheduleId = await scheduler.schedule(advanceNoticeOptions);
        reminder.advanceNoticeScheduleId = advanceNoticeScheduleId;
      }

      const reminders = await loadReminders();
      reminders.set(reminderId, reminder);
      await saveReminders(reminders);

      logger.info(
        {
          reminderId,
          recipientId,
          content,
          triggerAt: resolved.triggerAt,
          isRecurring: resolved.recurrence !== null,
        },
        'Reminder created'
      );

      const result: ReminderToolResult = {
        success: true,
        action: 'create',
        reminderId,
        scheduledFor: resolved.triggerAt,
        isRecurring: resolved.recurrence !== null,
      };

      if (isTimezoneConfigured && !isTimezoneConfigured(recipientId)) {
        result.timezoneNote =
          `Timezone was inferred (${timezone}), not explicitly configured. ` +
          `Ask the user to confirm their timezone if this reminder is time-sensitive.`;
      }

      return result;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to create reminder'
      );
      return {
        success: false,
        action: 'create',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * List reminders for a recipient.
   */
  async function listReminders(recipientId: string, limit = 10): Promise<ReminderToolResult> {
    try {
      const reminders = await loadReminders();

      const filtered = Array.from(reminders.values())
        .filter((r) => r.recipientId === recipientId && r.status === 'active')
        .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime())
        .slice(0, limit);

      const summaries: ReminderSummary[] = filtered.map((r) => {
        const summary: ReminderSummary = {
          id: r.id,
          content: r.content,
          nextFireAt: r.triggerAt,
          isRecurring: r.recurrence !== null,
        };
        if (r.recurrence) {
          summary.recurrenceDesc = formatRecurrence(r.recurrence);
        }
        return summary;
      });

      return {
        success: true,
        action: 'list',
        reminders: summaries,
        total: summaries.length,
      };
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to list reminders'
      );
      return {
        success: false,
        action: 'list',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Cancel a reminder.
   */
  async function cancelReminder(
    reminderId: string,
    recipientId: string
  ): Promise<ReminderToolResult> {
    try {
      const reminders = await loadReminders();
      const reminder = reminders.get(reminderId);

      if (!reminder) {
        return {
          success: false,
          action: 'cancel',
          error: 'Reminder not found',
        };
      }

      if (reminder.recipientId !== recipientId) {
        logger.warn(
          {
            reminderId,
            requestedRecipientId: recipientId,
            actualRecipientId: reminder.recipientId,
          },
          'Attempted to cancel reminder from different recipient'
        );
        return {
          success: false,
          action: 'cancel',
          error: 'Reminder not found',
        };
      }

      if (reminder.scheduleId) {
        await scheduler.cancel(reminder.scheduleId);
      }

      // Cancel advance notice schedule if exists
      if (reminder.advanceNoticeScheduleId) {
        await scheduler.cancel(reminder.advanceNoticeScheduleId);
      }

      reminder.status = 'cancelled';
      await saveReminders(reminders);

      logger.info({ reminderId }, 'Reminder cancelled');

      return {
        success: true,
        action: 'cancel',
        reminderId,
      };
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to cancel reminder'
      );
      return {
        success: false,
        action: 'cancel',
        error: 'Failed to cancel reminder',
      };
    }
  }

  /**
   * Complete a reminder.
   * For one-time: sets status to 'completed', cancels schedules, creates occurrence.
   * For recurring: updates parent cache, creates/updates occurrence, advances schedule if needed.
   */
  async function completeReminder(
    reminderId: string,
    recipientId: string
  ): Promise<ReminderToolResult> {
    try {
      const reminders = await loadReminders();
      const reminder = reminders.get(reminderId);

      // Guard: not found
      if (!reminder) {
        return {
          success: false,
          action: 'complete',
          error: 'Reminder not found',
        };
      }

      // Guard: wrong recipient
      if (reminder.recipientId !== recipientId) {
        logger.warn(
          {
            reminderId,
            requestedRecipientId: recipientId,
            actualRecipientId: reminder.recipientId,
          },
          'Attempted to complete reminder from different recipient'
        );
        return {
          success: false,
          action: 'complete',
          error: 'Reminder not found',
        };
      }

      // Guard: already completed (one-time)
      if (reminder.status === 'completed') {
        return {
          success: false,
          action: 'complete',
          error: 'Reminder already completed',
        };
      }

      // Guard: cancelled
      if (reminder.status === 'cancelled') {
        return {
          success: false,
          action: 'complete',
          error: 'Reminder is cancelled',
        };
      }

      const now = new Date();
      const occurrences = await loadOccurrences();
      const isRecurring = reminder.recurrence !== null;

      if (isRecurring) {
        // RECURRING: Update parent cache, create/update occurrence, maybe skip schedule

        // Find existing occurrence for current cycle (scheduledAt close to now or in past)
        const schedule = reminder.scheduleId
          ? (await scheduler.getSchedules()).find((s) => s.id === reminder.scheduleId)
          : null;
        const nextFireAt = schedule?.nextFireAt ?? reminder.triggerAt;

        // Find existing fired occurrence for current cycle
        const firedOccurrence = Array.from(occurrences.values())
          .filter((o) => o.reminderId === reminderId && o.status === 'fired')
          .sort((a, b) => (b.firedAt?.getTime() ?? 0) - (a.firedAt?.getTime() ?? 0))[0];

        // Determine if the current cycle already fired.
        // Check the occurrence ledger first; fall back to comparing fireCount vs
        // completedCount for reminders that fired before the ledger was introduced.
        // If fireCount > completedCount, there's an unacknowledged fire (post-fire completion).
        const currentCycleAlreadyFired =
          !!firedOccurrence || reminder.fireCount > reminder.completedCount;

        let occurrence: ReminderOccurrence;
        if (firedOccurrence) {
          // Update existing occurrence to completed
          firedOccurrence.status = 'completed';
          firedOccurrence.completedAt = now;
          occurrence = firedOccurrence;
        } else {
          // Create new occurrence for completion (pre-fire or legacy fire without ledger)
          const existing = Array.from(occurrences.values()).filter(
            (o) => o.reminderId === reminderId
          );
          const sequence =
            existing.length > 0 ? Math.max(...existing.map((o) => o.sequence)) + 1 : 0;
          occurrence = createOccurrence(reminderId, sequence, nextFireAt, 'completed');
          occurrences.set(occurrence.id, occurrence);
        }

        // Update parent cache
        reminder.lastCompletedAt = now;
        reminder.completedCount++;

        // Only skip if completing BEFORE fire. If the current cycle already fired
        // (tracked by occurrence ledger or fireCount), the scheduler already advanced
        // nextFireAt to the NEXT cycle — skipping would jump an extra cycle.
        // For range reminders, use skipToNextWindow which works regardless of fire state.
        let newNextFireAt: Date | null = null;
        const isRangeRecurrence =
          reminder.recurrence?.dayOfMonth != null && reminder.recurrence?.dayOfMonthEnd != null;
        if (isRangeRecurrence && reminder.scheduleId) {
          // Range: jump past entire window (works regardless of fire state)
          newNextFireAt = await scheduler.skipToNextWindow(reminder.scheduleId);
          if (newNextFireAt && reminder.advanceNoticeScheduleId) {
            await scheduler.skipToNextWindow(reminder.advanceNoticeScheduleId);
          }
        } else if (!currentCycleAlreadyFired && reminder.scheduleId && nextFireAt > now) {
          newNextFireAt = await scheduler.skipCurrentOccurrence(reminder.scheduleId);
          if (newNextFireAt) {
            // Also advance advance notice schedule if exists
            if (reminder.advanceNoticeScheduleId) {
              await scheduler.skipCurrentOccurrence(reminder.advanceNoticeScheduleId);
            }
          }
        }

        await saveReminders(reminders);
        await saveOccurrences(occurrences);

        logger.info(
          {
            reminderId,
            completedCount: reminder.completedCount,
            nextFireAt: newNextFireAt,
          },
          'Recurring reminder completed'
        );

        const result: ReminderToolResult = {
          success: true,
          action: 'complete',
          reminderId,
          completedCount: reminder.completedCount,
        };

        if (newNextFireAt) {
          result.nextFireAt = newNextFireAt;
        }

        return result;
      } else {
        // ONE-TIME: Set status to completed, cancel schedules, create occurrence

        reminder.status = 'completed';
        reminder.lastCompletedAt = now;
        reminder.completedCount = 1;

        // Cancel main schedule
        if (reminder.scheduleId) {
          await scheduler.cancel(reminder.scheduleId);
        }

        // Cancel advance notice schedule if exists
        if (reminder.advanceNoticeScheduleId) {
          await scheduler.cancel(reminder.advanceNoticeScheduleId);
        }

        // Create occurrence
        const occurrence = createOccurrence(reminderId, 0, reminder.triggerAt, 'completed');
        occurrences.set(occurrence.id, occurrence);

        await saveReminders(reminders);
        await saveOccurrences(occurrences);

        logger.info({ reminderId }, 'One-time reminder completed');

        return {
          success: true,
          action: 'complete',
          reminderId,
          completedCount: 1,
        };
      }
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to complete reminder'
      );
      return {
        success: false,
        action: 'complete',
        error: 'Failed to complete reminder',
      };
    }
  }

  const reminderTool: PluginTool = {
    name: 'reminder',
    description: `Manage reminders. Supports ONE-TIME and RECURRING (daily/weekly/monthly).
Actions: create, list, cancel, complete. Use 'anchor' with type:"recurring" for repeating reminders.
Supports advance notice (e.g., "remind me 30 minutes before") via 'advanceNotice' parameter.
Use 'complete' to mark a reminder as done (one-time) or acknowledge completion (recurring).
Set 'internal:true' for self-scheduled reminders (your own commitments, not user-facing).`,
    tags: [
      'one-time',
      'recurring',
      'daily',
      'weekly',
      'monthly',
      'create',
      'list',
      'cancel',
      'complete',
      'advance-notice',
    ],
    rawParameterSchema: REMINDER_RAW_SCHEMA,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "create", "list", "cancel", or "complete"',
        required: true,
        enum: ['create', 'list', 'cancel', 'complete'],
      },
      {
        name: 'content',
        type: 'string',
        description: 'What to remind about (required for create)',
        required: false,
      },
      {
        name: 'anchor',
        type: 'object',
        description: `Semantic date anchor for create action. All fields flat on anchor object — NO nesting.
- Relative: { type: "relative", unit: "hour", amount: 2, confidence: 0.9, originalPhrase: "in 2 hours" }
- Absolute: { type: "absolute", special: "tomorrow", confidence: 0.9, originalPhrase: "завтра" }
- Absolute (date): { type: "absolute", day: 15, month: 1, hour: 15, confidence: 0.9, originalPhrase: "January 15 at 3pm" }
- Recurring (fixed day): { type: "recurring", frequency: "daily", interval: 1, hour: 9, confidence: 0.9, originalPhrase: "every day at 9am" }
- Recurring (day range): { type: "recurring", frequency: "monthly", interval: 1, dayOfMonth: 20, dayOfMonthEnd: 25, hour: 10, confidence: 0.9, originalPhrase: "с 20 по 25 каждого месяца" }
  Fires daily within the range until completed, then jumps to next month.
- Recurring (constrained): { type: "recurring", frequency: "monthly", interval: 1, anchorDay: 10, constraint: "next-weekend", confidence: 0.9, originalPhrase: "weekend after 10th each month" }`,
        required: false,
      },
      {
        name: 'advanceNotice',
        type: 'object',
        description: 'Optional advance notice (e.g., "remind me 30 minutes before")',
        required: false,
      },
      {
        name: 'reminderId',
        type: 'string',
        description: 'Reminder ID (required for cancel, returned by create/list)',
        required: false,
      },
      {
        name: 'tags',
        type: 'array',
        description: 'Optional tags for organizing (create only)',
        required: false,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Max reminders to return (list only, default: 10)',
        required: false,
      },
      {
        name: 'internal',
        type: 'boolean',
        description: "Self-scheduled reminder (agent's own commitment, not user-facing)",
        required: false,
      },
    ],
    validate: (args) => {
      // Simple validation for reminder - check action is valid
      const a = args as Record<string, unknown>;
      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }
      if (!['create', 'list', 'cancel', 'complete'].includes(a['action'])) {
        return { success: false, error: 'action: must be one of [create, list, cancel, complete]' };
      }
      // Validate dayOfMonthEnd range constraints (flat anchor fields)
      const anchor = a['anchor'] as Record<string, unknown> | undefined;
      if (anchor?.['type'] === 'recurring' && anchor['dayOfMonthEnd'] != null) {
        const dayOfMonthEnd = Number(anchor['dayOfMonthEnd']);
        const dayOfMonth = Number(anchor['dayOfMonth']);
        if (anchor['dayOfMonth'] == null) {
          return { success: false, error: 'dayOfMonthEnd requires dayOfMonth to be set' };
        }
        if (dayOfMonthEnd < 1 || dayOfMonthEnd > 31) {
          return { success: false, error: 'dayOfMonthEnd must be between 1 and 31' };
        }
        if (dayOfMonthEnd < dayOfMonth) {
          return { success: false, error: 'dayOfMonthEnd must be >= dayOfMonth' };
        }
        if (anchor['frequency'] !== 'monthly') {
          return {
            success: false,
            error: 'dayOfMonthEnd is only supported with monthly frequency',
          };
        }
        if (anchor['anchorDay'] != null || anchor['constraint'] != null) {
          return {
            success: false,
            error: 'dayOfMonthEnd cannot be used with anchorDay/constraint',
          };
        }
      }
      return { success: true, data: a };
    },
    execute: async (args, context?: PluginToolContext): Promise<ReminderToolResult> => {
      const action = args['action'];
      if (typeof action !== 'string') {
        return {
          success: false,
          action: 'unknown',
          error: 'Missing or invalid action parameter',
          receivedParams: Object.keys(args),
          schema: {
            availableActions: {
              create: SCHEMA_CREATE,
              list: SCHEMA_LIST,
              cancel: SCHEMA_CANCEL,
              complete: SCHEMA_COMPLETE,
            },
          },
        };
      }

      const recipientId = context?.recipientId;
      if (!recipientId) {
        return {
          success: false,
          action,
          error: 'No recipient context available',
        };
      }

      switch (action) {
        case 'create': {
          const content = args['content'] as string | undefined;
          const anchorArg = args['anchor'] as Record<string, unknown> | undefined;
          const tags = args['tags'] as string[] | undefined;
          const advanceNoticeArg = args['advanceNotice'] as
            | Record<string, unknown>
            | undefined
            | null;

          if (!content || !anchorArg) {
            return {
              success: false,
              action: 'create',
              error: 'Missing required parameters: content, anchor',
              receivedParams: Object.keys(args),
              schema: SCHEMA_CREATE,
            };
          }

          // Validate anchor.type is present and valid
          const validAnchorTypes = ['relative', 'absolute', 'recurring'];
          if (!anchorArg['type'] || !validAnchorTypes.includes(anchorArg['type'] as string)) {
            return {
              success: false,
              action: 'create',
              error: `Invalid anchor: missing or invalid "type" field. Must be one of: ${validAnchorTypes.join(', ')}. Example: { type: "absolute", special: "tomorrow", confidence: 0.9, originalPhrase: "завтра" }`,
              receivedParams: Object.keys(args),
              schema: SCHEMA_CREATE,
            };
          }

          // Normalize flat anchor into nested SemanticDateAnchor
          const normalized = normalizeAnchor(anchorArg);
          if (!normalized.success) {
            return {
              success: false,
              action: 'create',
              error: normalized.error,
              receivedParams: Object.keys(args),
              schema: SCHEMA_CREATE,
            };
          }

          // Validate advanceNotice if provided
          if (advanceNoticeArg != null) {
            const before = advanceNoticeArg['before'] as Record<string, unknown> | null | undefined;
            const unit = before?.['unit'];
            const amount = before?.['amount'];

            const validUnits = ['minute', 'hour', 'day', 'week', 'month'];
            if (
              !before ||
              !validUnits.includes(unit as string) ||
              typeof amount !== 'number' ||
              !Number.isFinite(amount) ||
              amount < 1
            ) {
              return {
                success: false,
                action: 'create',
                error:
                  'Invalid advanceNotice.before: unit must be minute|hour|day|week|month and amount >= 1',
                receivedParams: Object.keys(args),
                schema: SCHEMA_CREATE,
              };
            }
          }

          // Normalize null to undefined for advanceNotice
          const normalizedAdvanceNotice =
            advanceNoticeArg === null ? undefined : (advanceNoticeArg as unknown as AdvanceNotice);

          // Extract internal flag
          const internal = args['internal'] === true;

          return createReminder(
            content,
            normalized.anchor,
            recipientId,
            tags,
            normalizedAdvanceNotice,
            internal
          );
        }

        case 'list': {
          const limitArg = args['limit'];
          const limit = typeof limitArg === 'number' ? limitArg : 10;
          return listReminders(recipientId, limit);
        }

        case 'cancel': {
          const reminderId = args['reminderId'];
          if (typeof reminderId !== 'string' || !reminderId) {
            return {
              success: false,
              action: 'cancel',
              error: 'Missing required parameter: reminderId',
              receivedParams: Object.keys(args),
              schema: SCHEMA_CANCEL,
            };
          }
          return cancelReminder(reminderId, recipientId);
        }

        case 'complete': {
          const reminderId = args['reminderId'];
          if (typeof reminderId !== 'string' || !reminderId) {
            return {
              success: false,
              action: 'complete',
              error: 'Missing required parameter: reminderId',
              receivedParams: Object.keys(args),
              schema: SCHEMA_COMPLETE,
            };
          }
          return completeReminder(reminderId, recipientId);
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "create", "list", "cancel", or "complete".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: {
                create: SCHEMA_CREATE,
                list: SCHEMA_LIST,
                cancel: SCHEMA_CANCEL,
                complete: SCHEMA_COMPLETE,
              },
            },
          };
      }
    },
  };

  return [reminderTool];
}

/**
 * Handle reminder due event (called by scheduler).
 */
export async function handleReminderDue(
  data: ReminderDueData,
  storage: PluginPrimitives['storage'],
  logger: Logger,
  intentEmitter: PluginPrimitives['intentEmitter'],
  fireContext?: FireContext,
  getTimezone?: (recipientId: string) => string
): Promise<void> {
  logger.info(
    {
      reminderId: data.reminderId,
      recipientId: data.recipientId,
      content: data.content,
      isRecurring: data.isRecurring,
      fireCount: data.fireCount,
      internal: data.internal,
    },
    'Reminder due'
  );

  // Handle self-scheduled (internal) reminders differently
  // For internal reminders, we only update storage (fire count) and let the signal
  // flow to trigger-sections for the self_scheduled trigger section
  if (data.internal) {
    // Update fireCount for recurring internal reminders
    if (data.isRecurring) {
      try {
        const stored = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
        if (stored) {
          const reminder = stored.find((r) => r.id === data.reminderId);
          if (reminder) {
            reminder.fireCount += 1;
            await storage.set(REMINDER_STORAGE_KEYS.REMINDERS, stored);
            await createOccurrenceOnFire(
              storage,
              data.reminderId,
              fireContext?.scheduledFor ?? null,
              logger
            );
          }
        }
      } catch (error) {
        logger.error(
          { reminderId: data.reminderId, error },
          'Failed to update internal reminder fire count'
        );
      }
    }
    // Don't emit pending intention - the signal itself carries the self_scheduled trigger
    return;
  }

  // UNIFIED overdue detection for both one-time and recurring reminders
  // Use fireContext.scheduledFor (accurate) or fall back to data.scheduledAt (backward compat)
  const scheduledFor =
    fireContext?.scheduledFor ?? (data.scheduledAt ? new Date(data.scheduledAt) : null);
  const firedAt = fireContext?.firedAt ?? new Date();
  const delayMs = scheduledFor ? firedAt.getTime() - scheduledFor.getTime() : 0;
  const isOverdue = delayMs > 5 * 60 * 1000;

  // Build overdue note with user's timezone
  let overdueNote = '';
  if (isOverdue && scheduledFor) {
    const tz = getTimezone?.(data.recipientId) ?? 'UTC';
    const scheduledTimeStr = DateTime.fromJSDate(scheduledFor, { zone: tz }).toFormat('HH:mm');
    const delayMinutes = Math.round(delayMs / 60000);
    overdueNote = ` Note: was due at ${scheduledTimeStr}, delayed ~${String(delayMinutes)} minutes.`;
  }

  if (data.isRecurring) {
    // Read fireCount from storage (source of truth) — schedule data's fireCount is stale
    let storedFireCount = 0;
    try {
      const stored = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
      if (stored) {
        const reminder = stored.find((r) => r.id === data.reminderId);
        if (reminder) {
          storedFireCount = reminder.fireCount;
          reminder.fireCount = storedFireCount + 1;
          await storage.set(REMINDER_STORAGE_KEYS.REMINDERS, stored);

          // Create occurrence entry for this fire with accurate scheduledFor
          await createOccurrenceOnFire(storage, data.reminderId, scheduledFor, logger);
        }
      }
    } catch (error) {
      logger.error({ reminderId: data.reminderId, error }, 'Failed to update reminder fire count');
    }

    // Emit pending intention for recurring reminders after first fire
    if (storedFireCount > 0) {
      intentEmitter.emitPendingIntention(
        `Recurring reminder (fired ${String(storedFireCount + 1)} times): "${data.content}".${overdueNote}`,
        data.recipientId
      );
    }
  } else if (isOverdue) {
    intentEmitter.emitPendingIntention(
      `Reminder: "${data.content}".${overdueNote}`,
      data.recipientId
    );
  }
}

/**
 * Create an occurrence entry when a reminder fires.
 * Internal helper for handleReminderDue.
 */
async function createOccurrenceOnFire(
  storage: PluginPrimitives['storage'],
  reminderId: string,
  scheduledAt: Date | null,
  logger: Logger
): Promise<void> {
  try {
    const stored = await storage.get<ReminderOccurrence[]>(
      REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES
    );
    const occurrences = stored ?? [];

    // Revive dates from JSON serialization
    for (const occ of occurrences) {
      occ.scheduledAt = new Date(occ.scheduledAt);
      if (occ.firedAt) occ.firedAt = new Date(occ.firedAt);
      if (occ.completedAt) occ.completedAt = new Date(occ.completedAt);
    }

    // Derive sequence from max existing + 1 (safe for gaps/pruning)
    const existing = occurrences.filter((o) => o.reminderId === reminderId);
    const sequence = existing.length > 0 ? Math.max(...existing.map((o) => o.sequence)) + 1 : 0;

    const occurrence: ReminderOccurrence = {
      id: `occ_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      reminderId,
      sequence,
      scheduledAt: scheduledAt ?? new Date(),
      firedAt: new Date(),
      completedAt: null,
      status: 'fired',
    };

    occurrences.push(occurrence);
    await storage.set(REMINDER_STORAGE_KEYS.REMINDER_OCCURRENCES, occurrences);
  } catch (error) {
    // Non-critical: log but don't fail the reminder delivery
    logger.error(
      { reminderId, error: error instanceof Error ? error.message : String(error) },
      'Failed to create occurrence entry'
    );
  }
}

/**
 * Handle reminder advance notice event.
 * NOTE: Does NOT emit message directly - goes through COGNITION like main reminder.
 * Does NOT update fireCount - main reminder handler handles that.
 */
export function handleReminderAdvanceNotice(
  data: ReminderAdvanceNoticeData,
  _storage: PluginPrimitives['storage'],
  logger: Logger,
  intentEmitter: PluginPrimitives['intentEmitter']
): void {
  logger.info(
    {
      reminderId: data.reminderId,
      recipientId: data.recipientId,
      content: data.content,
      actualReminderAt: data.actualReminderAt,
      advanceNoticeBefore: data.advanceNoticeBefore,
    },
    'Reminder advance notice'
  );

  const duration = formatAdvanceNoticeDuration(data.advanceNoticeBefore);

  intentEmitter.emitPendingIntention(
    `Upcoming reminder in ${duration}: "${data.content}". Give the user a gentle heads-up so they can prepare.`,
    data.recipientId
  );

  logger.info(
    { reminderId: data.reminderId, duration },
    `Advance notice: ${data.content} is coming up in ${duration}`
  );
}

function formatAdvanceNoticeDuration(before: RelativeTime): string {
  const amount = before.amount;
  const unit = before.unit;
  const amountStr = String(amount);
  return amount === 1 ? `1 ${unit}` : `${amountStr} ${unit}s`;
}

/**
 * Handle daily agenda event.
 * Emits pending intentions for today's upcoming reminders so the agent
 * is aware of appointments on first user contact.
 */
/**
 * Result from daily agenda processing — used by onEvent to enrich the signal
 * or suppress it when there's nothing to report.
 */
export interface DailyAgendaResult {
  /** Formatted agenda items within the 18h horizon (e.g., '"Pay internet" at 09:00'). */
  agendaItems: string[];
  /** True when no reminders are due within the horizon — caller should suppress the signal. */
  suppressSignal: boolean;
}

export async function handleDailyAgenda(
  storage: PluginPrimitives['storage'],
  scheduler: PluginPrimitives['scheduler'],
  logger: Logger,
  intentEmitter: PluginPrimitives['intentEmitter'],
  getTimezone: GetTimezoneFunc,
  recipientId: string
): Promise<DailyAgendaResult> {
  const empty: DailyAgendaResult = { agendaItems: [], suppressSignal: true };

  try {
    logger.debug({ recipientId }, 'Daily agenda handler started');

    const reminders = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
    if (!reminders || reminders.length === 0) {
      logger.debug({ recipientId }, 'No reminders found for daily agenda');
      return empty;
    }

    logger.debug(
      { recipientId, totalReminders: reminders.length },
      'Loaded reminders for daily agenda'
    );

    const activeReminders = reminders.filter(
      (r) => r.status === 'active' && r.recipientId === recipientId && r.scheduleId
    );

    if (activeReminders.length === 0) {
      logger.debug(
        { recipientId, totalReminders: reminders.length },
        'No active reminders with schedules for daily agenda'
      );
      return empty;
    }

    // Get all schedules to find nextFireAt
    const schedules = await scheduler.getSchedules();
    const scheduleMap = new Map(schedules.map((s) => [s.id, s]));

    const now = Date.now();
    const horizon = 18 * 60 * 60 * 1000; // 18 hours ahead
    const timezone = getTimezone(recipientId);
    let emitted = 0;

    const agendaItems: string[] = [];
    for (const reminder of activeReminders) {
      const schedule = reminder.scheduleId ? scheduleMap.get(reminder.scheduleId) : undefined;
      if (!schedule) continue;

      const fireAt = schedule.nextFireAt.getTime();
      if (fireAt > now && fireAt < now + horizon) {
        const fireTime = DateTime.fromJSDate(schedule.nextFireAt, { zone: timezone });
        const formattedTime = fireTime.toFormat('HH:mm');
        agendaItems.push(`"${reminder.content}" at ${formattedTime}`);
        emitted++;
      }
    }

    if (agendaItems.length > 0) {
      // Batch all agenda items into a single intention to avoid rate limits
      const summary =
        agendaItems.length === 1
          ? `Upcoming reminder: ${String(agendaItems[0])}.`
          : `Upcoming reminders: ${agendaItems.join('; ')}.`;

      logger.debug(
        { recipientId, agendaItems, summary },
        'Emitting pending intention for daily agenda'
      );
      intentEmitter.emitPendingIntention(summary, recipientId, { ttlMs: horizon });
    } else {
      logger.debug(
        { recipientId, horizon, activeReminders: activeReminders.length },
        'No agenda items found within horizon'
      );
    }

    logger.info({ recipientId, emitted, total: activeReminders.length }, 'Daily agenda processed');
    return { agendaItems, suppressSignal: agendaItems.length === 0 };
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), recipientId },
      'Failed to process daily agenda'
    );
    return empty;
  }
}
