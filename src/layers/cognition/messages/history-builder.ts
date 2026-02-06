/**
 * History Builder
 *
 * Builds initial messages for the conversation.
 * Injects conversation history as proper OpenAI messages with tool_calls visible.
 */

import { getEffectiveTimezone, formatTimestampPrefix } from '../../../utils/date.js';
import type { Message } from '../../../llm/provider.js';
import type { LoopContext, PromptBuilders } from '../agentic-loop-types.js';
import type { ToolContext } from '../tools/types.js';

/**
 * Build initial messages for the conversation.
 * Injects conversation history as proper OpenAI messages with tool_calls visible.
 */
export function buildInitialMessages(
  context: LoopContext,
  useSmart: boolean,
  promptBuilders: PromptBuilders
): Message[] {
  const systemPrompt = promptBuilders.buildSystemPrompt(context, useSmart);
  const messages: Message[] = [{ role: 'system', content: systemPrompt }];

  // Inject conversation history as proper messages (not flattened text)
  // This allows the LLM to see previous tool_calls and avoid re-execution
  if (context.conversationHistory.length > 0) {
    const effectiveTimezone = getEffectiveTimezone(
      context.userModel['defaultTimezone'] as string | undefined,
      context.userModel['timezoneOffset'] as number | null | undefined
    );
    const now = new Date();

    for (const histMsg of context.conversationHistory) {
      const msg: Message = {
        role: histMsg.role,
        content: histMsg.content,
      };

      // Prepend timestamp to user/assistant messages with non-null content
      // Skip tool messages, system messages, and null-content assistant messages (tool_calls only)
      if (
        histMsg.timestamp &&
        msg.content != null &&
        (histMsg.role === 'user' || histMsg.role === 'assistant')
      ) {
        const ts =
          histMsg.timestamp instanceof Date
            ? histMsg.timestamp
            : new Date(histMsg.timestamp as unknown as string);
        const prefix = formatTimestampPrefix(ts, now, effectiveTimezone);
        msg.content = `${prefix} ${msg.content}`;
      }

      // Include tool_calls for assistant messages
      if (histMsg.tool_calls && histMsg.tool_calls.length > 0) {
        msg.tool_calls = histMsg.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        }));
      }

      // Include tool_call_id for tool messages
      if (histMsg.tool_call_id) {
        msg.tool_call_id = histMsg.tool_call_id;
      }

      messages.push(msg);
    }
  }

  // Add current trigger - role depends on trigger type
  // User messages → 'user' role (natural conversation)
  // Proactive/system triggers → 'system' role (instructions to the model)
  const triggerPrompt = promptBuilders.buildTriggerPrompt(context, useSmart);
  const isUserMessage = context.triggerSignal.type === 'user_message';
  messages.push({ role: isUserMessage ? 'user' : 'system', content: triggerPrompt });

  return messages;
}

/**
 * Build tool context from loop context.
 */
export function buildToolContext(context: LoopContext): ToolContext {
  return {
    recipientId: context.recipientId ?? '',
    userId: context.userId,
    correlationId: context.tickId,
  };
}
