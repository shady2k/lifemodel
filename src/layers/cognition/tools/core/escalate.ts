/**
 * core.escalate - Smart Model Escalation Tool
 *
 * This tool allows the fast model to request deeper reasoning by switching to the smart model.
 * It is only available to the fast model - the smart model cannot escalate further.
 *
 * IMPORTANT: This tool is intercepted by the agentic loop and does NOT execute normally.
 * When called, the loop restarts with the smart model, preserving tool results.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.escalate tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.escalate and restarts with the smart model.
 */
export function createEscalateTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'reason',
      type: 'string',
      description: 'Why escalation is needed (e.g., "Complex multi-step reasoning required")',
      required: true,
    },
  ];

  return {
    name: 'core.escalate',
    description:
      'Request deeper reasoning by switching to the smart model. Use when genuinely uncertain or facing complex multi-step reasoning.',
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    tags: ['escalation'],
    hasSideEffects: false,
    execute: (args: Record<string, unknown>) => {
      // This should never be called - the agentic loop intercepts core.escalate
      return Promise.reject(
        new Error(
          'core.escalate should not be executed - it triggers smart model escalation. ' +
            `Received args: ${JSON.stringify(args)}`
        )
      );
    },
  };
}
