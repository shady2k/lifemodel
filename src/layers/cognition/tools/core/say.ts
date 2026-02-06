/**
 * core.say - Send Intermediate Message Tool
 *
 * Sends a brief message to the user immediately while the agentic loop
 * continues processing. Use for acknowledgments like "Let me check..."
 * before calling tools that take time.
 *
 * IMPORTANT: This tool is intercepted by the agentic loop (like core.defer
 * and core.escalate). The execute function should never be called directly.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.say tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.say and sends the message
 * via onImmediateIntent.
 */
export function createSayTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'text',
      type: 'string',
      description:
        'Brief message to send immediately (1-2 sentences). ' +
        'Use for acknowledgments before tool calls, not as your final response.',
      required: true,
    },
  ];

  return {
    name: 'core.say',
    description:
      'Send a brief intermediate message while continuing to process. ' +
      'Use ONLY for short acknowledgments before tool calls (e.g., "Let me check...", "One moment..."). ' +
      'Do NOT use as your final response — you must still output {"response": "text"} when done. ' +
      'Maximum 2 calls per turn.',
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    tags: ['messaging', 'intermediate'],
    hasSideEffects: true,
    execute: (args: Record<string, unknown>) => {
      // This should never be called - the agentic loop intercepts core.say
      return Promise.reject(
        new Error(
          'core.say should not be executed directly - it is intercepted by the agentic loop. ' +
            `Received args: ${JSON.stringify(args)}`
        )
      );
    },
  };
}
