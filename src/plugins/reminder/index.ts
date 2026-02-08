/**
 * Reminder Plugin
 *
 * Extracts reminders from natural language, supports recurrence,
 * and notifies users when reminders are due.
 */

import { z } from 'zod';
import type {
  PluginV2,
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
  MigrationBundle,
  EventSchema,
  ScheduleEntry,
} from '../../types/plugin.js';
import { DateTime } from 'luxon';
import {
  createReminderTools,
  handleReminderDue,
  handleReminderAdvanceNotice,
  handleDailyAgenda,
  REMINDER_PLUGIN_ID,
} from './reminder-tool.js';
import type { ReminderDueData, ReminderAdvanceNoticeData } from './reminder-types.js';
import { REMINDER_EVENT_KINDS } from './reminder-types.js';

/**
 * Zod schema for reminder_due event validation.
 */
const reminderDueSchema = z.object({
  kind: z.literal('plugin_event'),
  eventKind: z.literal(REMINDER_EVENT_KINDS.REMINDER_DUE),
  pluginId: z.literal(REMINDER_PLUGIN_ID),
  fireId: z.string().optional(),
  payload: z.object({
    reminderId: z.string(),
    recipientId: z.string(),
    content: z.string(),
    isRecurring: z.boolean(),
    fireCount: z.number(),
    tags: z.array(z.string()).optional(),
    scheduledAt: z.string().optional(),
  }),
});

/**
 * Zod schema for reminder_advance_notice event validation.
 */
const reminderAdvanceNoticeSchema = z.object({
  kind: z.literal('plugin_event'),
  eventKind: z.literal(REMINDER_EVENT_KINDS.REMINDER_ADVANCE_NOTICE),
  pluginId: z.literal(REMINDER_PLUGIN_ID),
  fireId: z.string().optional(),
  payload: z.object({
    reminderId: z.string(),
    recipientId: z.string(),
    content: z.string(),
    // ISO string - scheduler doesn't revive nested Dates
    actualReminderAt: z.string(),
    advanceNoticeBefore: z.object({
      unit: z.enum(['minute', 'hour', 'day', 'week', 'month']),
      amount: z.number(),
    }),
    isRecurring: z.boolean(),
    fireCount: z.number(),
    tags: z.array(z.string()).optional(),
  }),
});

/**
 * Zod schema for daily_agenda event validation.
 */
const dailyAgendaSchema = z.object({
  kind: z.literal('plugin_event'),
  eventKind: z.literal(REMINDER_EVENT_KINDS.DAILY_AGENDA),
  pluginId: z.literal(REMINDER_PLUGIN_ID),
  fireId: z.string().optional(),
  payload: z.object({
    recipientId: z.string(),
  }),
});

/**
 * Plugin state (set during activation).
 */
let pluginPrimitives: PluginPrimitives | null = null;
let pluginTools: PluginTool[] = [];

/**
 * Reminder plugin manifest.
 */
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: REMINDER_PLUGIN_ID,
  name: 'Reminder Plugin',
  version: '1.0.0',
  description: 'Create and manage reminders with natural language support and recurrence',
  provides: [{ type: 'tool', id: 'reminder' }],
  requires: ['scheduler', 'storage', 'signalEmitter', 'logger'],
  limits: {
    maxSchedules: 200, // Max 100 active reminders (with potential dual schedules for advance notice)
    maxStorageMB: 10, // 10MB storage limit
  },
};

/**
 * Reminder plugin lifecycle.
 */
const lifecycle: PluginLifecycleV2 = {
  /**
   * Activate the plugin.
   */
  activate(primitives: PluginPrimitives): void {
    pluginPrimitives = primitives;
    primitives.logger.info('Reminder plugin activating');

    // Register event schemas for validation
    // Type assertion needed due to zod's optional() returning T | undefined vs T? property
    primitives.services.registerEventSchema(
      REMINDER_EVENT_KINDS.REMINDER_DUE,
      reminderDueSchema as unknown as EventSchema
    );
    primitives.services.registerEventSchema(
      REMINDER_EVENT_KINDS.REMINDER_ADVANCE_NOTICE,
      reminderAdvanceNoticeSchema as unknown as EventSchema
    );
    primitives.services.registerEventSchema(
      REMINDER_EVENT_KINDS.DAILY_AGENDA,
      dailyAgendaSchema as unknown as EventSchema
    );
    primitives.logger.debug(
      'Registered event schemas for reminder_due, reminder_advance_notice, and daily_agenda'
    );

    // Schedule daily agenda (restart-safe)
    scheduleDailyAgenda(primitives).catch((err: unknown) => {
      primitives.logger.error({ err }, 'Failed to schedule daily agenda');
    });

    // Create tools using services.getTimezone for timezone resolution
    pluginTools = createReminderTools(
      primitives,
      (recipientId) => primitives.services.getTimezone(recipientId),
      (recipientId) => primitives.services.isTimezoneConfigured(recipientId)
    );

    primitives.logger.info('Reminder plugin activated');
  },

  /**
   * Deactivate the plugin.
   */
  deactivate(): void {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info('Reminder plugin deactivating');
    }
    pluginPrimitives = null;
    pluginTools = [];
  },

  /**
   * Health check.
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!pluginPrimitives) {
      return { healthy: false, message: 'Plugin not activated' };
    }

    try {
      // Check storage is accessible
      await pluginPrimitives.storage.keys();
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: `Storage error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  /**
   * Migrate from previous version.
   */
  migrate(fromVersion: string, bundle: MigrationBundle): MigrationBundle {
    // For v1.0.0, just pass through - no migration needed
    if (pluginPrimitives) {
      pluginPrimitives.logger.info({ fromVersion }, 'Reminder plugin migrating');
    }
    return bundle;
  },

  /**
   * Handle plugin events (called by scheduler when reminders fire).
   */
  async onEvent(eventKind: string, payload: Record<string, unknown>): Promise<void> {
    if (!pluginPrimitives) return;

    if (eventKind === REMINDER_EVENT_KINDS.REMINDER_DUE) {
      await handleReminderDue(
        payload as unknown as ReminderDueData,
        pluginPrimitives.storage,
        pluginPrimitives.logger,
        pluginPrimitives.intentEmitter
      );
    } else if (eventKind === REMINDER_EVENT_KINDS.REMINDER_ADVANCE_NOTICE) {
      handleReminderAdvanceNotice(
        payload as unknown as ReminderAdvanceNoticeData,
        pluginPrimitives.storage,
        pluginPrimitives.logger,
        pluginPrimitives.intentEmitter
      );
    } else if (eventKind === REMINDER_EVENT_KINDS.DAILY_AGENDA) {
      await handleDailyAgenda(
        pluginPrimitives.storage,
        pluginPrimitives.scheduler,
        pluginPrimitives.logger,
        pluginPrimitives.intentEmitter,
        (rid) => pluginPrimitives?.services.getTimezone(rid) ?? 'Europe/Moscow',
        (payload['recipientId'] as string | undefined) ?? 'default'
      );
    }
  },
};

/**
 * Schedule daily agenda check (restart-safe).
 * Follows the same pattern as calories plugin's scheduleWeightCheckin.
 */
async function scheduleDailyAgenda(primitives: PluginPrimitives): Promise<void> {
  // Use a stable recipientId — daily agenda applies to the default user
  const recipientId = 'default';
  const scheduleId = `daily_agenda_${recipientId}`;

  // Check if schedule already exists (restart-safe — preserve existing, scheduler handles catch-up)
  const existing = await primitives.scheduler.getSchedules();
  const hasExisting = existing.some((s: ScheduleEntry) => s.id === scheduleId);
  if (hasExisting) {
    primitives.logger.debug({ scheduleId }, 'Daily agenda schedule already exists');
    return;
  }

  const userPatterns = primitives.services.getUserPatterns(recipientId);
  const wakeHour = userPatterns?.wakeHour ?? 8;
  const timezone = primitives.services.getTimezone(recipientId);

  // Calculate next occurrence of wake hour
  const now = DateTime.now().setZone(timezone);
  let fireAt = now.set({ hour: wakeHour, minute: 0, second: 0, millisecond: 0 });
  if (fireAt <= now) {
    fireAt = fireAt.plus({ days: 1 });
  }

  await primitives.scheduler.schedule({
    id: scheduleId,
    fireAt: fireAt.toJSDate(),
    recurrence: { frequency: 'daily', interval: 1 },
    timezone,
    data: {
      kind: REMINDER_EVENT_KINDS.DAILY_AGENDA,
      recipientId,
    },
  });

  primitives.logger.info(
    { scheduleId, fireAt: fireAt.toISO(), timezone, wakeHour },
    'Daily agenda schedule created'
  );
}

/**
 * Get plugin tools (for manual registration if needed).
 * Must be called after activation.
 */
export function getTools(): PluginTool[] {
  return pluginTools;
}

/**
 * The reminder plugin instance.
 * Tools are created during activation and accessed via the getter.
 */
const reminderPlugin: PluginV2 = {
  manifest,
  lifecycle,
  // Tools getter - returns tools created during activation
  get tools() {
    return pluginTools;
  },
};

export default reminderPlugin;
export { REMINDER_PLUGIN_ID };
export type { ReminderDueData } from './reminder-types.js';
export { REMINDER_EVENT_KINDS } from './reminder-types.js';
