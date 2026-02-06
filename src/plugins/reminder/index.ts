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
} from '../../types/plugin.js';
import {
  createReminderTools,
  handleReminderDue,
  handleReminderAdvanceNotice,
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
    primitives.logger.debug('Registered event schema for reminder_due and reminder_advance_notice');

    // Create tools using services.getTimezone for timezone resolution
    pluginTools = createReminderTools(primitives, (recipientId) =>
      primitives.services.getTimezone(recipientId)
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
    }
  },
};

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
