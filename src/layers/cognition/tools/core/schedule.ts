/**
 * Core Schedule Tool
 *
 * Schedule future events for follow-ups, reminders, or delayed processing.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/** Minimum delay: 1 second */
const MIN_DELAY = 1000;

/** Maximum delay: 7 days */
const MAX_DELAY = 7 * 24 * 60 * 60 * 1000;

/**
 * Create the core.schedule tool.
 */
export function createScheduleTool(): Tool {
  const parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'Required. Must be: create', required: true },
    { name: 'delayMs', type: 'number', description: 'Delay in ms (1s-7d)', required: true },
    { name: 'eventType', type: 'string', description: 'followUp, checkIn, etc.', required: true },
    { name: 'eventContext', type: 'object', description: 'Event data', required: false },
  ];

  return {
    name: 'core.schedule',
    description:
      'Schedule future events (follow-ups, reminders). Example: {"action": "create", "delayMs": 3600000, "eventType": "followUp"}',
    tags: ['schedule', 'future', 'events'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
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
