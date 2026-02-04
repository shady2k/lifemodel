/**
 * core.defer - Defer Proactive Contact Tool
 *
 * This tool allows the LLM to defer proactive contact for later.
 * Use when you decide NOT to reach out now (user busy, late hour, etc.).
 * Only for proactive triggers, not user messages.
 *
 * IMPORTANT: This tool is TERMINAL - it ends the agentic loop.
 * When called, the loop returns a DeferTerminal result.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Create the core.defer tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.defer and returns a DeferTerminal.
 */
export function createDeferTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'signalType',
      type: 'string',
      description: 'Signal type to defer (usually "contact_urge" for proactive contact)',
      required: true,
    },
    {
      name: 'reason',
      type: 'string',
      description: 'Why deferring (e.g., "User seems busy", "Late evening")',
      required: true,
    },
    {
      name: 'deferHours',
      type: 'number',
      description: 'Hours to defer (typically 2-8)',
      required: true,
    },
  ];

  return {
    name: 'core.defer',
    description:
      'Defer proactive contact for later. Use when you decide NOT to reach out now (user busy, late hour, etc.). Only for proactive triggers, not user messages. TERMINAL: ends the loop.',
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    tags: ['terminal', 'deferral'],
    hasSideEffects: false,
    execute: (args: Record<string, unknown>) => {
      // This should never be called - the agentic loop intercepts core.defer
      return Promise.reject(
        new Error(
          'core.defer should not be executed - it ends the loop with DeferTerminal. ' +
            `Received args: ${JSON.stringify(args)}`
        )
      );
    },
  };
}
