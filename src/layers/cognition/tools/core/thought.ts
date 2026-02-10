/**
 * Core Thought Tool
 *
 * Queue thoughts for future processing - enables thought cascades.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.thought tool.
 */
export function createThoughtTool(): Tool {
  const parameters: ToolParameter[] = [
    { name: 'action', type: 'string', description: 'Required. Must be: emit', required: true },
    {
      name: 'content',
      type: 'string',
      description:
        'An unresolved question you genuinely want to figure out. NOT for action items, reminders, or observations about what just happened.',
      required: true,
    },
  ];

  return {
    name: 'core.thought',
    maxCallsPerTurn: 3,
    description:
      'Save a genuine unresolved question — something you want to FIGURE OUT, not something to DO. Example: {"action": "emit", "content": "Why did user seem deflated about Langflow?"}\nNot for action items ("check if resolved" → use core.schedule), not for narration ("User is..." → just respond), not for strategy ("I should..." → just do it).',
    tags: ['follow-up', 'investigation'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args) => {
      const action = args['action'] as string;

      if (action !== 'emit') {
        return Promise.resolve({
          success: false,
          action,
          error: `Unknown action: ${action}. Use "emit".`,
        });
      }

      const content = args['content'] as string | undefined;
      if (!content) {
        return Promise.resolve({
          success: false,
          action: 'emit',
          error: 'Missing required parameter: content',
        });
      }

      if (content.length < 5) {
        return Promise.resolve({
          success: false,
          action: 'emit',
          error: 'Thought content too short (minimum 5 characters)',
        });
      }

      return Promise.resolve({
        success: true,
        action: 'emit',
        content,
        message: 'Queued for investigation. Respond to the user now.',
      });
    },
  };
}
