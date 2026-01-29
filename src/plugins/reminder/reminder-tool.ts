/**
 * Reminder Plugin Tools
 *
 * LLM tools for creating, listing, and cancelling reminders.
 */

import type { Logger } from '../../types/logger.js';
import type { PluginPrimitives, PluginTool, ScheduleOptions } from '../../types/plugin.js';
import type {
  Reminder,
  SemanticDateAnchor,
  CreateReminderResult,
  ListRemindersResult,
  CancelReminderResult,
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
 * Create reminder plugin tools.
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
   * Create reminder tool.
   */
  const createReminderTool: PluginTool = {
    name: 'createReminder',
    description: `Create a reminder for the user. Extract the semantic meaning of when they want to be reminded, and I will calculate the exact time. Use this when user says things like "remind me to...", "don't let me forget...", "set a reminder for...".`,
    parameters: [
      {
        name: 'content',
        type: 'string',
        description: 'What to remind the user about',
        required: true,
      },
      {
        name: 'anchor',
        type: 'object',
        description: `Semantic date anchor. Extract the time expression meaning into this structure:
- For relative times like "in 30 minutes": { type: "relative", relative: { unit: "minute", amount: 30 }, confidence: 0.9, originalPhrase: "in 30 minutes" }
- For absolute times like "tomorrow at 3pm": { type: "absolute", absolute: { special: "tomorrow", hour: 15, minute: 0 }, confidence: 0.9, originalPhrase: "tomorrow at 3pm" }
- For recurring like "every day at 9am": { type: "recurring", recurring: { frequency: "daily", interval: 1, hour: 9, minute: 0 }, confidence: 0.9, originalPhrase: "every day at 9am" }

Time units: minute, hour, day, week, month
Special times: tomorrow, next_week, next_month, this_evening, tonight, this_afternoon
Day of week: 0=Sunday through 6=Saturday
Frequencies: daily, weekly, monthly`,
        required: true,
      },
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID where the reminder was requested',
        required: true,
      },
      {
        name: 'tags',
        type: 'array',
        description: 'Optional tags for organizing reminders',
        required: false,
      },
    ],
    execute: async (args): Promise<CreateReminderResult> => {
      try {
        const content = args['content'] as string;
        const anchorArg = args['anchor'];
        const chatIdArg = args['chatId'];
        const tags = args['tags'] as string[] | undefined;

        if (!content || !anchorArg || !chatIdArg) {
          return { success: false, error: 'Missing required parameters' };
        }

        const anchor = anchorArg as SemanticDateAnchor;
        const chatId = chatIdArg as string;

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
            chatId,
            triggerAt: resolved.triggerAt.toISOString(),
            isRecurring: resolved.recurrence !== null,
          },
          'Reminder created'
        );

        return {
          success: true,
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
          error: error instanceof Error ? error.message : 'Failed to create reminder',
        };
      }
    },
  };

  /**
   * List reminders tool.
   */
  const listRemindersTool: PluginTool = {
    name: 'listReminders',
    description:
      'List active reminders for the user. Use this when user asks about their reminders or wants to see what reminders they have set.',
    parameters: [
      {
        name: 'chatId',
        type: 'string',
        description: 'Chat ID to list reminders for',
        required: true,
      },
      {
        name: 'limit',
        type: 'number',
        description: 'Maximum number of reminders to return (default: 10)',
        required: false,
      },
    ],
    execute: async (args): Promise<ListRemindersResult> => {
      try {
        const chatId = args['chatId'] as string;
        const limitArg = args['limit'];
        const limit = typeof limitArg === 'number' ? limitArg : 10;

        if (!chatId) {
          return { reminders: [], total: 0 };
        }

        const reminders = await loadReminders();

        // Filter to active reminders for this chat
        const activeReminders = Array.from(reminders.values())
          .filter((r) => r.chatId === chatId && r.status === 'active')
          .sort((a, b) => a.triggerAt.getTime() - b.triggerAt.getTime())
          .slice(0, limit);

        const summaries: ReminderSummary[] = activeReminders.map((r) => {
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
          reminders: summaries,
          total: activeReminders.length,
        };
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to list reminders'
        );
        return { reminders: [], total: 0 };
      }
    },
  };

  /**
   * Cancel reminder tool.
   */
  const cancelReminderTool: PluginTool = {
    name: 'cancelReminder',
    description:
      'Cancel an active reminder. Use this when user wants to delete or cancel a reminder they previously set.',
    parameters: [
      {
        name: 'reminderId',
        type: 'string',
        description: 'ID of the reminder to cancel',
        required: true,
      },
    ],
    execute: async (args): Promise<CancelReminderResult> => {
      try {
        const reminderId = args['reminderId'] as string;

        if (!reminderId) {
          return { success: false, error: 'Reminder ID is required' };
        }

        const reminders = await loadReminders();
        const reminder = reminders.get(reminderId);

        if (!reminder) {
          return { success: false, error: 'Reminder not found' };
        }

        if (reminder.status !== 'active') {
          return { success: false, error: `Reminder is already ${reminder.status}` };
        }

        // Cancel the schedule
        if (reminder.scheduleId) {
          await scheduler.cancel(reminder.scheduleId);
        }

        // Update status
        reminder.status = 'cancelled';
        await saveReminders(reminders);

        logger.info({ reminderId }, 'Reminder cancelled');

        return { success: true };
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'Failed to cancel reminder'
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to cancel reminder',
        };
      }
    },
  };

  return [createReminderTool, listRemindersTool, cancelReminderTool];
}

/**
 * Handle a reminder due event.
 * Called when a scheduled reminder fires.
 */
export async function handleReminderDue(
  data: ReminderDueData,
  storage: PluginPrimitives['storage'],
  logger: Logger
): Promise<void> {
  try {
    // Load reminders
    const stored = await storage.get<Reminder[]>(REMINDER_STORAGE_KEYS.REMINDERS);
    if (!stored) return;

    const reminders = new Map<string, Reminder>();
    for (const r of stored) {
      r.triggerAt = new Date(r.triggerAt);
      r.createdAt = new Date(r.createdAt);
      reminders.set(r.id, r);
    }

    const reminder = reminders.get(data.reminderId);
    if (!reminder) {
      logger.warn({ reminderId: data.reminderId }, 'Reminder not found for due event');
      return;
    }

    // Update fire count
    reminder.fireCount++;

    // If one-time, mark as completed
    if (!reminder.recurrence) {
      reminder.status = 'completed';
      logger.debug({ reminderId: data.reminderId }, 'One-time reminder completed');
    } else {
      logger.debug(
        { reminderId: data.reminderId, fireCount: reminder.fireCount },
        'Recurring reminder fired'
      );
    }

    // Save updated reminders
    await storage.set(REMINDER_STORAGE_KEYS.REMINDERS, Array.from(reminders.values()));
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        reminderId: data.reminderId,
      },
      'Failed to handle reminder due event'
    );
  }
}
