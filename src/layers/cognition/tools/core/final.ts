/**
 * core.final - Terminal Tool for Agentic Loop
 *
 * This tool signals the end of the agentic loop with a structured terminal state.
 * It uses a discriminated union schema to handle different terminal types:
 * - respond: Send a message to the user
 * - no_action: No user contact needed
 * - defer: Postpone action for later
 *
 * IMPORTANT: This tool is NOT executed - it's just parsed. When the model
 * calls core.final, the loop ends immediately and the arguments are used
 * to build the final result.
 */

import type { Tool, ToolParameter } from '../types.js';

/**
 * Payload for 'respond' terminal type.
 */
export interface RespondPayload {
  /** The message to send to the user */
  text: string;
  /** Conversation status for follow-up timing */
  conversationStatus: 'active' | 'awaiting_answer' | 'closed' | 'idle';
  /** Confidence in this response (0-1). Below 0.6 triggers smart retry. */
  confidence: number;
}

/**
 * Payload for 'no_action' terminal type.
 */
export interface NoActionPayload {
  /** Why no action is needed */
  reason: string;
}

/**
 * Payload for 'defer' terminal type.
 */
export interface DeferPayload {
  /** Signal type being deferred (e.g., 'contact_urge', 'pattern_break') */
  signalType: string;
  /** Why the agent is deferring */
  reason: string;
  /** Hours to defer (2-8 typical) */
  deferHours: number;
}

/**
 * Union type for all terminal payloads.
 */
export type FinalPayload = RespondPayload | NoActionPayload | DeferPayload;

/**
 * Arguments for core.final tool call (flat format).
 * All fields at root level - server validates based on type.
 */
export interface CoreFinalArgs {
  /** Terminal type: respond, no_action, or defer */
  type: 'respond' | 'no_action' | 'defer';

  // For "respond" type:
  text?: string;
  conversationStatus?: 'active' | 'awaiting_answer' | 'closed' | 'idle';
  confidence?: number;

  // For "no_action" and "defer" types:
  reason?: string;

  // For "defer" type only:
  signalType?: string;
  deferHours?: number;

  /** @deprecated Legacy nested payload - use flat fields instead */
  payload?: FinalPayload;
}

/**
 * Create the core.final tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.final and uses the arguments
 * to build the final result directly.
 */
export function createFinalTool(): Tool {
  // Flat parameters - all fields at root level
  const parameters: ToolParameter[] = [
    {
      name: 'type',
      type: 'string',
      description: 'Terminal type: respond | no_action | defer',
      required: true,
    },
    {
      name: 'text',
      type: 'string',
      description: 'Message to send (required for respond)',
      required: false,
    },
    {
      name: 'conversationStatus',
      type: 'string',
      description: 'Status: active | awaiting_answer | closed | idle (required for respond)',
      required: false,
    },
    {
      name: 'confidence',
      type: 'number',
      description: 'Confidence 0-1 (required for respond). Below 0.6 triggers retry.',
      required: false,
    },
    {
      name: 'reason',
      type: 'string',
      description: 'Why no action / why deferring (required for no_action and defer)',
      required: false,
    },
    {
      name: 'signalType',
      type: 'string',
      description: 'Signal type being deferred (required for defer)',
      required: false,
    },
    {
      name: 'deferHours',
      type: 'number',
      description: 'Hours to defer (required for defer)',
      required: false,
    },
  ];

  return {
    name: 'core.final',
    description: `End the loop with a terminal state. FLAT FORMAT - all fields at root level.

Examples:
- respond: { type: "respond", text: "Hello!", conversationStatus: "active", confidence: 0.9 }
- no_action: { type: "no_action", reason: "No response needed" }
- defer: { type: "defer", reason: "User busy", signalType: "contact_urge", deferHours: 4 }

IMPORTANT: You MUST call this tool to end the loop.`,
    parameters,
    // No rawParameterSchema needed - flat parameters are converted automatically
    tags: ['terminal', 'required'],
    hasSideEffects: false, // This tool doesn't execute - it just signals termination
    execute: (args: Record<string, unknown>) => {
      // This should never be called - the agentic loop intercepts core.final
      // If we get here, something is wrong
      return Promise.reject(
        new Error(
          'core.final should not be executed - it signals loop termination. ' +
            `Received args: ${JSON.stringify(args)}`
        )
      );
    },
  };
}
