/**
 * Core Thought Tool
 *
 * Queue thoughts for future processing - enables thought cascades.
 */

import type { Tool } from '../types.js';

/**
 * Create the core.thought tool.
 */
export function createThoughtTool(): Tool {
  return {
    name: 'core.thought',
    description:
      'Queue a thought for future processing. Use only when concrete follow-up or deeper analysis is needed. Do NOT use for vague "monitoring". Example: User says "I have an interview tomorrow" → emit thought to check in later.',
    tags: ['thinking', 'follow-up', 'reflection'],
    hasSideEffects: true,
    parameters: [
      { name: 'action', type: 'string', description: 'Action: emit', required: true },
      {
        name: 'content',
        type: 'string',
        description: 'The thought to process later',
        required: true,
      },
      {
        name: 'reason',
        type: 'string',
        description: 'Why this thought matters (optional, for observability)',
        required: false,
      },
    ],
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
