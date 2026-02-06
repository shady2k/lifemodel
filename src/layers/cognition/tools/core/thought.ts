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
        'An unresolved question or hunch — NOT a user fact (use core.remember for those)',
      required: true,
    },
    {
      name: 'reason',
      type: 'string',
      description: 'Why this thought matters (optional, for observability)',
      required: false,
    },
  ];

  return {
    name: 'core.thought',
    maxCallsPerTurn: 2,
    description:
      'Queue a background thought for later processing (like a human side-thought during conversation). NOT for narrating your current actions or reasoning about the current response. Multiple thoughts are batched into one. Example: "User mentioned switching jobs — might explain recent stress".',
    tags: ['thinking', 'follow-up', 'reflection'],
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

      const reason = args['reason'] as string | undefined;

      return Promise.resolve({
        success: true,
        action: 'emit',
        content,
        reason,
        message: 'Thought queued for future processing',
      });
    },
  };
}
