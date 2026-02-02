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
import { validateAgainstParameters } from '../validation.js';

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
  const parameters: ToolParameter[] = [
    {
      name: 'type',
      type: 'string',
      enum: ['respond', 'no_action', 'defer'],
      description: 'respond|no_action|defer',
      required: true,
    },
    { name: 'text', type: 'string', description: 'Message (for respond)', required: false },
    {
      name: 'conversationStatus',
      type: 'string',
      enum: ['active', 'awaiting_answer', 'closed', 'idle'],
      description: 'awaiting_answer→3min, active/idle→30min, closed→4hr',
      required: false,
    },
    {
      name: 'confidence',
      type: 'number',
      description: '0-1, <0.6 triggers retry (for respond)',
      required: false,
    },
    {
      name: 'reason',
      type: 'string',
      description: 'Why (for no_action/defer)',
      required: false,
    },
    {
      name: 'signalType',
      type: 'string',
      description: 'Signal deferred (for defer)',
      required: false,
    },
    { name: 'deferHours', type: 'number', description: 'Hours (for defer)', required: false },
  ];

  return {
    name: 'core.final',
    description:
      'End loop. MUST call to finish. Examples: {type:"respond",text:"Hi",conversationStatus:"active",confidence:0.9} or {type:"no_action",reason:"..."}',
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
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
