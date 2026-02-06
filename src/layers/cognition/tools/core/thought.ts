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
    { name: 'action', type: 'string', description: 'Action: emit', required: true },
    {
      name: 'content',
      type: 'string',
      description:
        'A hypothesis or open question that needs future investigation. Must be something you CANNOT resolve right now. NOT for observations, strategy notes, or summarizing what just happened.',
      required: true,
    },
  ];

  return {
    name: 'core.thought',
    maxCallsPerTurn: 1,
    description:
      'Flag an unresolved question for future investigation. ONLY for things you cannot resolve now and that may matter later. Do NOT call this to narrate, strategize, summarize, or reason about the current conversation. If you can act on it now, act instead of thinking. Bad: "User is interested in AI tools" (narration). Bad: "I should keep it technical" (strategy). Good: "User mentioned chest pain last week — should check if resolved".',
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
