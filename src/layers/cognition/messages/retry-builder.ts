/**
 * Retry Builder
 *
 * Adds messages from previous attempt for smart retry.
 * Reconstructs the assistant tool_calls and tool result messages so the
 * retry model sees the full context of what was already executed.
 */

import type { LoopState } from '../../../types/cognition.js';
import type { Message, ToolCall } from '../../../llm/provider.js';
import type { PreviousAttempt } from '../agentic-loop-types.js';

/**
 * Add messages from previous attempt for smart retry.
 * Reconstructs the assistant tool_calls and tool result messages so the
 * retry model sees the full context of what was already executed.
 */
export function addPreviousAttemptMessages(
  messages: Message[],
  previousAttempt: PreviousAttempt,
  state: LoopState
): void {
  // Add a system note about the retry, including fast model's draft response if available
  // This helps smart model see what was already generated and avoid repeating history
  let retryNote = `[Previous attempt with fast model - retrying with deeper reasoning. Reason: ${previousAttempt.reason}]`;

  if (previousAttempt.responseText) {
    retryNote += `\n\n## Fast Model Draft Response\nThe fast model generated this response: "${previousAttempt.responseText}"\n\nYou may use this response if it's appropriate, or generate a better one. Do NOT repeat the last assistant message from conversation history - generate something fresh.`;
  }

  messages.push({
    role: 'system',
    content: retryNote,
  });

  // Reconstruct tool call messages from previous attempt
  // This is critical so the retry model sees what tools were called and their results
  if (previousAttempt.executedTools.length > 0) {
    // Build tool_calls array for the assistant message
    const toolCalls: ToolCall[] = previousAttempt.executedTools.map((tool) => ({
      id: tool.toolCallId,
      type: 'function' as const,
      function: {
        name: tool.name.replace(/\./g, '_'), // Sanitize for API format
        arguments: JSON.stringify(tool.args),
      },
    }));

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    });

    // Add tool result messages
    for (const result of previousAttempt.toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: JSON.stringify(result.success ? result.data : { error: result.error }),
      });
    }
  }

  // Mark all previous tools as executed (for side effect tracking)
  for (const tool of previousAttempt.executedTools) {
    state.executedTools.push(tool);
  }
  for (const result of previousAttempt.toolResults) {
    state.toolResults.push(result);

    // Rebuild collectedThoughts from previous core.thought results.
    // compileIntentsFromToolResults skips core.thought in toolResults and uses
    // collectedThoughts exclusively, so we must reconstruct it here.
    if (result.toolName === 'core.thought' && result.success) {
      const data = result.data as Record<string, unknown> | undefined;
      if (data?.['success'] === true && typeof data['content'] === 'string') {
        state.collectedThoughts.push(data['content']);
      }
    }
  }
}
