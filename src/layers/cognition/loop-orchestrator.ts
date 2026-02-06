/**
 * Loop Orchestrator
 *
 * Builds LLM requests, filters tools, and sets proactive tool budget.
 */

import type { LoopState } from '../../types/cognition.js';
import type { OpenAIChatTool, MinimalOpenAIChatTool } from '../../llm/tool-schema.js';
import type { ResponseFormat } from '../../llm/provider.js';
import type { Message } from '../../llm/provider.js';
import type { LoopContext, ToolCompletionRequest } from './agentic-loop-types.js';
import { isProactiveTrigger } from './prompts/runtime-snapshot.js';

/**
 * Build a ToolCompletionRequest for the LLM.
 */
export function buildRequest(
  messages: Message[],
  tools: (OpenAIChatTool | MinimalOpenAIChatTool)[],
  forceRespond: boolean
): ToolCompletionRequest {
  const toolChoice: 'auto' | 'none' = forceRespond ? 'none' : 'auto';

  const responseFormat: ResponseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'agent_response',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          response: {
            type: 'string',
            description: 'Your response to the user',
          },
          status: {
            type: 'string',
            enum: ['active', 'awaiting_answer', 'closed', 'idle'],
            description:
              'Optional: conversation status for follow-up timing. Use awaiting_answer if you asked a question.',
          },
          urgent: {
            type: 'boolean',
            description:
              'Set true ONLY for immediate, time-sensitive user impact (safety, deadline in hours). Thought triggers only.',
          },
        },
        required: ['response'],
      },
    },
  };

  return {
    messages,
    tools: forceRespond ? [] : tools,
    toolChoice,
    parallelToolCalls: false, // Sequential for determinism
    responseFormat,
  };
}

/**
 * Filter tools based on context.
 * - Can't escalate from smart model (already using it)
 * - Can't emit thoughts when processing a thought (prevents infinite loops)
 * - Can't do housekeeping (thought/agent) during proactive contact (prevents prep loops)
 */
export function filterToolsForContext(
  tools: (OpenAIChatTool | MinimalOpenAIChatTool)[],
  context: LoopContext,
  useSmart: boolean
): (OpenAIChatTool | MinimalOpenAIChatTool)[] {
  const isThoughtTrigger = context.triggerSignal.type === 'thought';
  const isProactive =
    context.triggerSignal.type === 'contact_urge' || isProactiveTrigger(context.triggerSignal);

  return tools.filter((t) => {
    if (typeof t !== 'object') return true;
    const name = t.function.name;

    // Can't escalate from smart model
    if (useSmart && (name === 'core.escalate' || name === 'core_escalate')) {
      return false;
    }

    // Thought processing: limited tool set (memory + remember + setInterest only)
    if (isThoughtTrigger) {
      if (name === 'core.thought' || name === 'core_thought') return false; // prevents loops
      if (name === 'core.say' || name === 'core_say') return false; // no user waiting
      if (name === 'core.state' || name === 'core_state') return false; // snapshot sufficient
      if (name === 'core.agent' || name === 'core_agent') return false; // no micro-updates
    }

    // Reaction processing: limited tool set (setInterest + remember + memory only)
    if (context.triggerSignal.type === 'message_reaction') {
      if (name === 'core.thought' || name === 'core_thought') return false;
      if (name === 'core.say' || name === 'core_say') return false;
      if (name === 'core.state' || name === 'core_state') return false;
      if (name === 'core.agent' || name === 'core_agent') return false;
    }

    // Proactive contact: no housekeeping tools (prevents endless preparation)
    if (isProactive) {
      if (name === 'core.thought' || name === 'core_thought') return false;
      if (name === 'core.agent' || name === 'core_agent') return false;
    }

    return true;
  });
}

/**
 * Set tool budgets for autonomous triggers.
 * Mutates state.proactiveToolBudget if not already set.
 */
export function maybeSetProactiveToolBudget(
  state: LoopState,
  context: LoopContext,
  logger: { debug: (obj: Record<string, unknown>, msg: string) => void }
): void {
  if (state.proactiveToolBudget !== undefined) return;

  const isThoughtTrigger = context.triggerSignal.type === 'thought';
  const isProactive =
    context.triggerSignal.type === 'contact_urge' || isProactiveTrigger(context.triggerSignal);

  if (isProactive) {
    state.proactiveToolBudget = 4;
    logger.debug({ budget: 4 }, 'Proactive contact: tool budget set');
  } else if (isThoughtTrigger) {
    state.proactiveToolBudget = 3;
    logger.debug({ budget: 3 }, 'Thought processing: tool budget set');
  } else if (context.triggerSignal.type === 'plugin_event') {
    state.proactiveToolBudget = 4;
    logger.debug({ budget: 4 }, 'Plugin event: tool budget set');
  }
}

export { isProactiveTrigger };
