/**
 * Core Schedule Tool
 *
 * Schedule future events for follow-ups, reminders, or delayed processing.
 */

import type { Tool } from '../types.js';

/** Minimum delay: 1 second */
const MIN_DELAY = 1000;

/** Maximum delay: 7 days */
const MAX_DELAY = 7 * 24 * 60 * 60 * 1000;

/**
 * Create the core.schedule tool.
 */
export function createScheduleTool(): Tool {
  return {
    name: 'core.schedule',
    description: 'Schedule a future event. Use for follow-ups, reminders, or delayed processing.',
    tags: ['schedule', 'future', 'events'],
    hasSideEffects: true,
    parameters: [
      { name: 'action', type: 'string', description: 'Action: create', required: true },
      {
        name: 'delayMs',
        type: 'number',
        description: 'Delay in milliseconds before event fires',
        required: true,
      },
      {
        name: 'eventType',
        type: 'string',
        description: 'Type of event (e.g., followUp, checkIn)',
        required: true,
      },
      {
        name: 'eventContext',
        type: 'object',
        description: 'Context data for the event',
        required: false,
      },
    ],
    execute: (args) => {
      const action = args['action'] as string;

      if (action !== 'create') {
        return Promise.resolve({
          success: false,
          action,
          error: `Unknown action: ${action}. Use "create".`,
        });
      }

      const delayMs = args['delayMs'] as number | undefined;
      const eventType = args['eventType'] as string | undefined;
      const eventContext = (args['eventContext'] as Record<string, unknown> | undefined) ?? {};

      // Validate required parameters
      if (delayMs === undefined || typeof delayMs !== 'number') {
        return Promise.resolve({
          success: false,
          action: 'create',
          error: 'Missing required parameter: delayMs (number)',
        });
      }
      if (!eventType) {
        return Promise.resolve({
          success: false,
          action: 'create',
          error: 'Missing required parameter: eventType',
        });
      }

      // Validate delay bounds
      if (delayMs < MIN_DELAY || delayMs > MAX_DELAY) {
        return Promise.resolve({
          success: false,
          action: 'create',
          error: `Invalid delayMs: must be between ${String(MIN_DELAY)} (1 sec) and ${String(MAX_DELAY)} (7 days)`,
        });
      }

      // Return validated payload for compileIntents()
      return Promise.resolve({
        success: true,
        action: 'create',
        delayMs,
        eventType,
        eventContext,
      });
    },
  };
}
