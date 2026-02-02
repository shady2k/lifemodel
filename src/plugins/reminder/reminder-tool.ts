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
} from '../../types/plugin.js';
import type {
  Reminder,
  SemanticDateAnchor,
  ReminderDueData,
  ReminderSummary,
} from './reminder-types.js';
import { REMINDER_EVENT_KINDS, REMINDER_STORAGE_KEYS } from './reminder-types.js';
import { resolveSemanticAnchor, formatRecurrence } from './date-parser.js';

/**
 * Plugin ID for reminder plugin.
 */
export const REMINDER_PLUGIN_ID = 'reminder';

/**
 * Get the user's timezone by recipientId.
 */
type GetTimezoneFunc = (recipientId: string) => string;

/**
 * Result type for the unified reminder tool.
 */
interface ReminderToolResult {
  success: boolean;
  action: string;
  reminderId?: string;
  scheduledFor?: Date;
  isRecurring?: boolean;
  reminders?: ReminderSummary[];
  total?: number;
  error?: string;
  receivedParams?: string[];
  schema?: Record<string, unknown>;
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
      relative: {
        type: 'object',
        required: false,
        description: 'Required when anchor.type="relative"',
        properties: {
          unit: {
            type: 'string',
            required: true,
            enum: ['minute', 'hour', 'day', 'week', 'month'],
          },
          amount: { type: 'number', required: true },
        },
      },
      absolute: {
        type: 'object',
        required: false,
        description: 'Required when anchor.type="absolute"',
        properties: {
          special: {
            type: 'string',
            required: false,
            enum: [
              'tomorrow',
              'next_week',
              'next_month',
              'this_evening',
              'tonight',
              'this_afternoon',
            ],
          },
          year: { type: 'number', required: false },
          month: { type: 'number', required: false },
          day: { type: 'number', required: false },
          hour: { type: 'number', required: false },
          minute: { type: 'number', required: false },
          dayOfWeek: {
            type: 'number',
            required: false,
            description: '0=Sunday, 6=Saturday (for "next Monday" etc.)',
          },
        },
      },
      recurring: {
        type: 'object',
        required: false,
        description: 'Required when anchor.type="recurring"',
        properties: {
          frequency: { type: 'string', required: true, enum: ['daily', 'weekly', 'monthly'] },
          interval: { type: 'number', required: true, default: 1 },
          hour: { type: 'number', required: false },
          minute: { type: 'number', required: false },
          daysOfWeek: {
            type: 'array',
            items: 'number (0-6)',
            required: false,
            description: 'For weekly',
          },
          dayOfMonth: { type: 'number', required: false, description: 'For monthly, fixed day' },
          anchorDay: {
            type: 'number',
            required: false,
            description: 'For monthly with constraint',
          },
          constraint: {
            type: 'string',
            required: false,
            enum: ['next-weekend', 'next-weekday', 'next-saturday', 'next-sunday'],
          },
        },
      },
    },
  },
  tags: { type: 'array', items: 'string', required: false },
};

const SCHEMA_CANCEL = {
  action: { type: 'string', required: true, enum: ['cancel'] },
  reminderId: { type: 'string', required: true, description: 'ID returned by create or list' },
};

const SCHEMA_LIST = {
  action: { type: 'string', required: true, enum: ['list'] },
  limit: { type: 'number', required: false, default: 10 },
};

/**
 * OpenAI-compatible JSON Schema for the reminder tool.
 * Uses proper nested properties so OpenAI strict mode enforces structure.
 *
 * Key requirements for OpenAI strict mode:
 * - All fields in `required` array (optional fields use type: ["type", "null"])
 * - `additionalProperties: false` on all object types
 */
const REMINDER_RAW_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'list', 'cancel'],
      description: 'Action to perform',
    },
    content: {
      type: ['string', 'null'],
      description: 'What to remind about (required for create)',
    },
    anchor: {
      type: ['object', 'null'],
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
        relative: {
          type: ['object', 'null'],
          description: 'For type="relative" (e.g., "in 30 minutes")',
          properties: {
            unit: {
              type: 'string',
              enum: ['minute', 'hour', 'day', 'week', 'month'],
            },
            amount: {
              type: 'number',
              description: 'Number of units',
            },
          },
          required: ['unit', 'amount'],
          additionalProperties: false,
        },
        absolute: {
          type: ['object', 'null'],
          description: 'For type="absolute" (e.g., "tomorrow", "next Monday at 3pm")',
          properties: {
            special: {
              type: ['string', 'null'],
              enum: [
                'tomorrow',
                'next_week',
                'next_month',
                'this_evening',
                'tonight',
                'this_afternoon',
                null,
              ],
              description: 'Named time shortcut',
            },
            year: { type: ['number', 'null'] },
            month: { type: ['number', 'null'], description: '1-12' },
            day: { type: ['number', 'null'], description: '1-31' },
            hour: { type: ['number', 'null'], description: '0-23' },
            minute: { type: ['number', 'null'], description: '0-59' },
            dayOfWeek: {
              type: ['number', 'null'],
              description: '0=Sunday, 6=Saturday (for "next Monday" etc.)',
            },
          },
          required: ['special', 'year', 'month', 'day', 'hour', 'minute', 'dayOfWeek'],
          additionalProperties: false,
        },
        recurring: {
          type: ['object', 'null'],
          description: 'For type="recurring" (e.g., "every day at 9am")',
          properties: {
            frequency: {
              type: 'string',
              enum: ['daily', 'weekly', 'monthly'],
            },
            interval: {
              type: 'number',
              description: 'Every N periods (default: 1)',
            },
            hour: { type: ['number', 'null'], description: '0-23' },
            minute: { type: ['number', 'null'], description: '0-59' },
            daysOfWeek: {
              type: ['array', 'null'],
              items: { type: 'number' },
              description: 'For weekly: days of week (0=Sun, 6=Sat)',
            },
            dayOfMonth: {
              type: ['number', 'null'],
              description: 'For monthly: fixed day (1-31)',
            },
            anchorDay: {
              type: ['number', 'null'],
              description: 'For monthly with constraint: anchor day (1-31)',
            },
            constraint: {
              type: ['string', 'null'],
              enum: ['next-weekend', 'next-weekday', 'next-saturday', 'next-sunday', null],
              description: 'Constraint to apply after anchorDay',
            },
          },
          required: [
            'frequency',
            'interval',
            'hour',
            'minute',
            'daysOfWeek',
            'dayOfMonth',
            'anchorDay',
            'constraint',
          ],
          additionalProperties: false,
        },
      },
      required: ['type', 'confidence', 'originalPhrase', 'relative', 'absolute', 'recurring'],
      additionalProperties: false,
    },
    reminderId: {
      type: ['string', 'null'],
      description: 'Reminder ID (required for cancel)',
    },
    tags: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description: 'Optional tags for organizing',
    },
    limit: {
      type: ['number', 'null'],
      description: 'Max reminders to return (list only, default: 10)',
    },
  },
  required: ['action', 'content', 'anchor', 'reminderId', 'tags', 'limit'],
  additionalProperties: false,
};

/**
 * Create the unified reminder tool.
 */
export function createReminderTools(
  primitives: PluginPrimitives,
  getTimezone: GetTimezoneFunc
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
   * Create a new reminder.
   */
  async function createReminder(
    content: string,
    anchor: SemanticDateAnchor,
    recipientId: string,
    tags?: string[]
  ): Promise<ReminderToolResult> {
    try {
      const timezone = getTimezone(recipientId);
      const resolved = resolveSemanticAnchor(anchor, new Date(), timezone);
      const reminderId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

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
        scheduleId: null,
      };

      if (tags) {
        reminder.tags = tags;
      }

      const scheduleData: Record<string, unknown> = {
        kind: REMINDER_EVENT_KINDS.REMINDER_DUE,
        reminderId,
        recipientId,
        content,
        isRecurring: resolved.recurrence !== null,
        fireCount: 0,
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

      return {
        success: true,
        action: 'create',
        reminderId,
        scheduledFor: resolved.triggerAt,
        isRecurring: resolved.recurrence !== null,
      };
    } catch (error) {
      logger.error(
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

  const reminderTool: PluginTool = {
    name: 'reminder',
    description: `Manage reminders. Supports ONE-TIME and RECURRING (daily/weekly/monthly).
Actions: create, list, cancel. Use 'anchor' with type:"recurring" for repeating reminders.`,
    tags: ['one-time', 'recurring', 'daily', 'weekly', 'monthly', 'create', 'list', 'cancel'],
    rawParameterSchema: REMINDER_RAW_SCHEMA,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "create", "list", or "cancel"',
        required: true,
        enum: ['create', 'list', 'cancel'],
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
        description: `Semantic date anchor for create action. Extract the time expression:
- Relative: { type: "relative", relative: { unit: "minute"|"hour"|"day"|"week"|"month", amount: number }, confidence: 0.9, originalPhrase: "..." }
- Absolute: { type: "absolute", absolute: { special?: "tomorrow"|"next_week"|"next_month"|"this_evening"|"tonight"|"this_afternoon", year?: number, month?: number, day?: number, hour?: number, minute?: number, dayOfWeek?: 0-6 }, confidence: 0.9, originalPhrase: "..." }
- Recurring (fixed day): { type: "recurring", recurring: { frequency: "daily"|"weekly"|"monthly", interval: number, hour?: number, minute?: number, daysOfWeek?: number[], dayOfMonth?: number }, confidence: 0.9, originalPhrase: "..." }
- Recurring (constrained): { type: "recurring", recurring: { frequency: "monthly", interval: 1, anchorDay: 10, constraint: "next-weekend"|"next-weekday"|"next-saturday"|"next-sunday", hour?: number, minute?: number }, confidence: 0.9, originalPhrase: "..." }
  Example: "weekend after 10th each month" -> anchorDay: 10, constraint: "next-weekend"`,
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
    ],
    validate: (args) => {
      // Simple validation for reminder - check action is valid
      const a = args as Record<string, unknown>;
      if (!a['action'] || typeof a['action'] !== 'string') {
        return { success: false, error: 'action: required' };
      }
      if (!['create', 'list', 'cancel'].includes(a['action'])) {
        return { success: false, error: 'action: must be one of [create, list, cancel]' };
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
            availableActions: { create: SCHEMA_CREATE, list: SCHEMA_LIST, cancel: SCHEMA_CANCEL },
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
              error: `Invalid anchor: missing or invalid "type" field. Must be one of: ${validAnchorTypes.join(', ')}. For "tomorrow", use: { type: "absolute", absolute: { special: "tomorrow" }, confidence: 0.9, originalPhrase: "завтра" }`,
              receivedParams: Object.keys(args),
              schema: SCHEMA_CREATE,
            };
          }

          return createReminder(
            content,
            anchorArg as unknown as SemanticDateAnchor,
            recipientId,
            tags
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

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "create", "list", or "cancel".`,
            receivedParams: Object.keys(args),
            schema: {
              availableActions: { create: SCHEMA_CREATE, list: SCHEMA_LIST, cancel: SCHEMA_CANCEL },
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
  logger: Logger
): Promise<void> {
  logger.info(
    {
      reminderId: data.reminderId,
      recipientId: data.recipientId,
      content: data.content,
      isRecurring: data.isRecurring,
      fireCount: data.fireCount,
    },
    'Reminder due'
  );

  if (data.isRecurring) {
    try {
      const stored = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
      if (stored) {
        const reminder = stored.find((r) => r.id === data.reminderId);
        if (reminder) {
          reminder.fireCount = data.fireCount + 1;
          await storage.set(REMINDER_STORAGE_KEYS.REMINDERS, stored);
        }
      }
    } catch (error) {
      logger.error({ reminderId: data.reminderId, error }, 'Failed to update reminder fire count');
    }
  }
}
