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
 * Arguments for core.final tool call.
 */
export interface CoreFinalArgs {
  /** Terminal type: respond, no_action, or defer */
  type: 'respond' | 'no_action' | 'defer';
  /** Payload specific to the terminal type */
  payload: FinalPayload;
}

/**
 * Raw JSON Schema for core.final discriminated union.
 *
 * Uses oneOf at the root level with each branch containing:
 * 1. type: { const: "..." } - the discriminator value
 * 2. payload: { ... } - the corresponding payload schema
 *
 * This ensures type and payload are properly coupled (e.g., type="respond" MUST have respond payload).
 * Note: OpenAI strict mode requires additionalProperties: false at all levels.
 */
const FINAL_PARAMETER_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      description: 'Send a message to the user',
      properties: {
        type: { type: 'string', const: 'respond' },
        payload: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message to send to the user' },
            conversationStatus: {
              type: 'string',
              enum: ['active', 'awaiting_answer', 'closed', 'idle'],
              description:
                'active = mid-conversation, awaiting_answer = asked question, closed = goodbye, idle = statement made',
            },
            confidence: {
              type: 'number',
              description: 'Confidence 0-1. Below 0.6 triggers deeper reasoning.',
            },
          },
          required: ['text', 'conversationStatus', 'confidence'],
          additionalProperties: false,
        },
      },
      required: ['type', 'payload'],
      additionalProperties: false,
    },
    {
      type: 'object',
      description: 'No user contact needed',
      properties: {
        type: { type: 'string', const: 'no_action' },
        payload: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why no action is needed' },
          },
          required: ['reason'],
          additionalProperties: false,
        },
      },
      required: ['type', 'payload'],
      additionalProperties: false,
    },
    {
      type: 'object',
      description: 'Defer action for later',
      properties: {
        type: { type: 'string', const: 'defer' },
        payload: {
          type: 'object',
          properties: {
            signalType: {
              type: 'string',
              description: 'Signal type being deferred (e.g., "contact_urge")',
            },
            reason: { type: 'string', description: 'Why the agent is deferring' },
            deferHours: { type: 'number', description: 'Hours to defer (2-8 typical)' },
          },
          required: ['signalType', 'reason', 'deferHours'],
          additionalProperties: false,
        },
      },
      required: ['type', 'payload'],
      additionalProperties: false,
    },
  ],
} as const;

/**
 * Create the core.final tool definition.
 *
 * Note: This tool's execute function should never be called in practice -
 * the agentic loop intercepts calls to core.final and uses the arguments
 * to build the final result directly.
 */
export function createFinalTool(): Tool {
  // Parameters kept for backward compatibility (e.g., tool introspection)
  // but rawParameterSchema is used for actual schema generation
  const parameters: ToolParameter[] = [
    {
      name: 'type',
      type: 'string',
      description:
        'Terminal type: "respond" (send message to user), "no_action" (no contact needed), or "defer" (postpone for later)',
      required: true,
    },
    {
      name: 'payload',
      type: 'object',
      description: `Payload object based on type:
- For "respond": { text: string, conversationStatus: "active"|"awaiting_answer"|"closed"|"idle", confidence: number (0-1) }
- For "no_action": { reason: string }
- For "defer": { signalType: string, reason: string, deferHours: number }`,
      required: true,
    },
  ];

  return {
    name: 'core.final',
    description: `Finalize the agent loop with a structured terminal state. Call this when you're done processing and ready to respond (or explicitly decide not to respond).

Terminal types:
- "respond": Send a message to the user. Required payload fields: text, conversationStatus, confidence.
  - conversationStatus: "active" (mid-conversation), "awaiting_answer" (asked question), "closed" (goodbye), "idle" (statement made)
  - confidence: 0-1 (below 0.6 triggers deeper reasoning)
- "no_action": No user contact needed. Required payload fields: reason.
- "defer": Don't act now, reconsider later. Required payload fields: signalType, reason, deferHours.

IMPORTANT: You MUST call this tool to end the loop. The loop will not terminate without it.`,
    parameters,
    rawParameterSchema: FINAL_PARAMETER_SCHEMA as unknown as Record<string, unknown>,
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
