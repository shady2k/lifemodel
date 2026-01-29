/**
 * Reminder Plugin Tools
 *
 * Single unified tool for creating, listing, and cancelling reminders.
 */

import type { Logger } from '../../types/logger.js';
import type { PluginPrimitives, PluginTool, ScheduleOptions } from '../../types/plugin.js';
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
export const REMINDER_PLUGIN_ID = 'com.lifemodel.reminder';

/**
 * Get the user's timezone.
 * Should return a valid IANA timezone (defaults to 'UTC').
 */
type GetTimezoneFunc = (chatId?: string) => string;

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
}

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
        // Convert date strings back to Date objects
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
    chatId: string,
    tags?: string[]
  ): Promise<ReminderToolResult> {
    try {
      // Get user's timezone
      const timezone = getTimezone(chatId);

      // Resolve the semantic anchor to a concrete date
      const resolved = resolveSemanticAnchor(anchor, new Date(), timezone);

      // Generate reminder ID
      const reminderId = `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

      // Create the reminder
      const reminder: Reminder = {
        id: reminderId,
        content,
        chatId,
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

      // Schedule the reminder
      const scheduleData: Record<string, unknown> = {
        kind: REMINDER_EVENT_KINDS.REMINDER_DUE,
        reminderId,
        chatId,
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

      // Save to storage
      const reminders = await loadReminders();
      reminders.set(reminderId, reminder);
      await saveReminders(reminders);

      logger.info(
        {
          reminderId,
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
   * List reminders for a chat.
   */
  async function listReminders(chatId: string, limit = 10): Promise<ReminderToolResult> {
    try {
      const reminders = await loadReminders();

      // Filter by chat and active status
      const filtered = Array.from(reminders.values())
        .filter((r) => r.chatId === chatId && r.status === 'active')
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
  async function cancelReminder(reminderId: string): Promise<ReminderToolResult> {
    try {
      const reminders = await loadReminders();
      const reminder = reminders.get(reminderId);

      if (!reminder) {
        return {
          success: false,
          action: 'cancel',
          error: `Reminder ${reminderId} not found`,
        };
      }

      // Cancel the schedule
      if (reminder.scheduleId) {
        await scheduler.cancel(reminder.scheduleId);
      }

      // Update status
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
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Unified reminder tool.
   */
  const reminderTool: PluginTool = {
    name: 'reminder',
    description: `Manage reminders for the user. Actions: create, list, cancel.

Use this when user says things like:
- "remind me to..." / "напомни мне..." -> action: create
- "what reminders do I have?" / "какие у меня напоминания?" -> action: list
- "cancel the reminder" / "отмени напоминание" -> action: cancel

For creating reminders, extract the semantic meaning of WHEN they want to be reminded into the 'anchor' parameter.`,
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "create", "list", or "cancel"',
        required: true,
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
- Recurring: { type: "recurring", recurring: { frequency: "daily"|"weekly"|"monthly", interval: number, hour?: number, minute?: number, daysOfWeek?: number[], dayOfMonth?: number }, confidence: 0.9, originalPhrase: "..." }`,
        required: false,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID (required for create and list)',
        required: false,
      },
      {
        name: 'reminderId',
        type: 'string',
        description: 'Reminder ID (required for cancel)',
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
    execute: async (args): Promise<ReminderToolResult> => {
      const action = args['action'] as string;

      switch (action) {
        case 'create': {
          const content = args['content'] as string | undefined;
          const anchorArg = args['anchor'];
          const chatIdArg = args['chatId'];
          const tags = args['tags'] as string[] | undefined;

          if (!content || !anchorArg || !chatIdArg) {
            return {
              success: false,
              action: 'create',
              error: 'Missing required parameters: content, anchor, chatId',
            };
          }

          return createReminder(
            content,
            anchorArg as SemanticDateAnchor,
            chatIdArg as string,
            tags
          );
        }

        case 'list': {
          const chatId = args['chatId'] as string | undefined;
          if (!chatId) {
            return {
              success: false,
              action: 'list',
              error: 'Missing required parameter: chatId',
            };
          }
          const limitArg = args['limit'];
          const limit = typeof limitArg === 'number' ? limitArg : 10;
          return listReminders(chatId, limit);
        }

        case 'cancel': {
          const reminderId = args['reminderId'] as string | undefined;
          if (!reminderId) {
            return {
              success: false,
              action: 'cancel',
              error: 'Missing required parameter: reminderId',
            };
          }
          return cancelReminder(reminderId);
        }

        default:
          return {
            success: false,
            action: action || 'unknown',
            error: `Unknown action: ${action}. Use "create", "list", or "cancel".`,
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
      chatId: data.chatId,
      content: data.content,
      isRecurring: data.isRecurring,
      fireCount: data.fireCount,
    },
    'Reminder due'
  );

  // Update fire count for recurring reminders
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
