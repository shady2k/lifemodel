/**
 * core.conversationStatus - Conversation Status Tool
 *
 * This tool allows the LLM to set the conversation follow-up timing.
 * Call before asking questions to indicate you expect a reply soon.
 *
 * IMPORTANT: This tool is intercepted by the agentic loop and does NOT execute normally.
 * When called, the status is stored in loop state for the final response.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.conversationStatus tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.conversationStatus and stores the status.
 */
export function createConversationStatusTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'status',
      type: 'string',
      enum: ['active', 'awaiting_answer', 'closed', 'idle'],
      description:
        'awaiting_answer: expect reply soon (3min timeout). active/idle: normal (30min timeout). closed: conversation ended (4hr timeout).',
      required: true,
    },
  ];

  return {
    name: 'core.conversationStatus',
    description: 'Set conversation follow-up timing. Call before asking questions.',
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    tags: ['conversation'],
    hasSideEffects: false,
    execute: (args: Record<string, unknown>) => {
      // This should never be called - the agentic loop intercepts core.conversationStatus
      return Promise.reject(
        new Error(
          'core.conversationStatus should not be executed - it sets loop state. ' +
            `Received args: ${JSON.stringify(args)}`
        )
      );
    },
  };
}
