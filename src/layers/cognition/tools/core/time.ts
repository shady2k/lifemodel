/**
 * Core Time Tool
 *
 * Get time information: current time and elapsed time since events.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Conversation provider for time-based queries.
 */
export interface ConversationProvider {
  getLastMessageTime(recipientId?: string): Date | null;
  getLastContactTime(recipientId?: string): Date | null;
}

/**
 * Dependencies for time tool.
 */
export interface TimeToolDeps {
  conversationProvider?: ConversationProvider | undefined;
}

/**
 * Format duration for human readability.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${String(days)} day${days > 1 ? 's' : ''} ago`;
  if (hours > 0) return `${String(hours)} hour${hours > 1 ? 's' : ''} ago`;
  if (minutes > 0) return `${String(minutes)} minute${minutes > 1 ? 's' : ''} ago`;
  return 'just now';
}

/**
 * Create the core.time tool.
 */
export function createTimeTool(deps: TimeToolDeps): Tool {
  const parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'Action: now or since', required: true },
    { name: 'timezone', type: 'string', description: 'IANA timezone (for now)', required: false },
    {
      name: 'event',
      type: 'string',
      description: 'Event: lastMessage, lastContact, or ISO timestamp (for since)',
      required: false,
    },
    // chatId removed - system uses context.recipientId automatically
  ];

  return {
    name: 'core.time',
    description:
      'Get time information. Actions: now (current time), since (elapsed time from event).',
    tags: ['current-time', 'elapsed', 'timezone'],
    hasSideEffects: false,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args, context) => {
      const action = args['action'] as string;

      switch (action) {
        case 'now': {
          const now = new Date();
          const timezone = args['timezone'] as string | undefined;

          if (timezone) {
            try {
              const formatted = now.toLocaleString('en-US', { timeZone: timezone });
              return Promise.resolve({
                success: true,
                action: 'now',
                time: formatted,
                timezone,
                iso: now.toISOString(),
              });
            } catch {
              return Promise.resolve({
                success: true,
                action: 'now',
                time: now.toISOString(),
                timezone: 'UTC',
                iso: now.toISOString(),
              });
            }
          }

          return Promise.resolve({
            success: true,
            action: 'now',
            time: now.toISOString(),
            timezone: 'system',
            iso: now.toISOString(),
          });
        }

        case 'since': {
          const event = args['event'] as string | undefined;
          if (!event) {
            return Promise.resolve({
              success: false,
              action: 'since',
              error: 'Missing required parameter: event',
            });
          }

          // Use context.recipientId - system knows the current conversation
          const recipientId = context?.recipientId;
          let eventTime: Date | null = null;

          if (event === 'lastMessage' && deps.conversationProvider) {
            eventTime = deps.conversationProvider.getLastMessageTime(recipientId);
          } else if (event === 'lastContact' && deps.conversationProvider) {
            eventTime = deps.conversationProvider.getLastContactTime(recipientId);
          } else {
            const parsed = new Date(event);
            if (!isNaN(parsed.getTime())) {
              eventTime = parsed;
            }
          }

          if (!eventTime) {
            return Promise.resolve({
              success: false,
              action: 'since',
              error: `Event not found: ${event}`,
            });
          }

          const now = Date.now();
          const diffMs = now - eventTime.getTime();
          const diffSeconds = Math.floor(diffMs / 1000);
          const diffMinutes = Math.floor(diffSeconds / 60);
          const diffHours = Math.floor(diffMinutes / 60);
          const diffDays = Math.floor(diffHours / 24);

          return Promise.resolve({
            success: true,
            action: 'since',
            eventTime: eventTime.toISOString(),
            elapsed: {
              ms: diffMs,
              seconds: diffSeconds,
              minutes: diffMinutes,
              hours: diffHours,
              days: diffDays,
            },
            human: formatDuration(diffMs),
          });
        }

        default:
          return Promise.resolve({
            success: false,
            action,
            error: `Unknown action: ${action}. Use "now" or "since".`,
          });
      }
    },
  };
}
