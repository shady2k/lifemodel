/**
 * History Builder
 *
 * Builds initial messages for the conversation.
 * Injects conversation history as proper OpenAI messages with tool_calls visible.
 */

import { getEffectiveTimezone, formatTimestampPrefix } from '../../../utils/date.js';
import type { Message, ContentPart } from '../../../llm/provider.js';
import type { LoopContext, PromptBuilders } from '../agentic-loop-types.js';
import type { ToolContext } from '../tools/types.js';
import type { ImageAttachment } from '../../../types/signal.js';

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
        msg.content = `${prefix}\n${msg.content}`;
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
  // User messages & reactions → 'user' role (natural user interaction)
  // Proactive/system triggers → 'system' role (instructions to the model)
  const triggerPrompt = promptBuilders.buildTriggerPrompt(context, useSmart);
  const isUserInteraction =
    context.triggerSignal.type === 'user_message' ||
    context.triggerSignal.type === 'message_reaction';

  // For non-user triggers (proactive, motor_result, etc.), inject a boundary marker
  // between conversation history and the trigger. Weak models (glm-4.7-flash) treat
  // the last assistant message as "what I just said" and continue from there,
  // echoing <msg_time> tags and ignoring the trigger. A user-role boundary breaks
  // this continuation pattern.
  // Reactions are user interactions (feedback on a message), so they skip the boundary.
  if (!isUserInteraction && context.conversationHistory.length > 0) {
    messages.push({
      role: 'user',
      content:
        '[End of conversation history. All messages above were already handled and responded to. A new, unrelated system event follows.]',
    });
  }

  // Build the trigger message — attach contentParts for vision if images are present
  const triggerData = context.triggerSignal.data as { images?: ImageAttachment[] } | undefined;
  const triggerImages = isUserInteraction ? triggerData?.images : undefined;

  if (triggerImages?.length) {
    const parts: ContentPart[] = [{ type: 'text', text: triggerPrompt }];
    for (const img of triggerImages) {
      parts.push({ type: 'image', image: img.data, mediaType: img.mediaType });
    }
    messages.push({ role: 'user', content: triggerPrompt, contentParts: parts });
  } else {
    messages.push({ role: isUserInteraction ? 'user' : 'system', content: triggerPrompt });
  }

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
    triggerType: context.triggerSignal.type,
  };
}
