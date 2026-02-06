/**
 * Tool Call Validators
 *
 * Validates tool_call/tool_result pair integrity in messages.
 * Filters out orphaned tool results that would cause API errors.
 * This is a safety net - the primary fix is in conversation-manager slicing.
 */

import type { Logger } from '../../../types/logger.js';
import type { Message } from '../../../llm/provider.js';

/**
 * Validate tool_call/tool_result pair integrity in messages.
 * Filters out orphaned tool results that would cause API errors.
 *
 * @param messages Messages to validate
 * @param logger Logger for warnings
 * @returns Validated messages with orphans removed
 */
export function validateToolCallPairs(messages: Message[], logger: Logger): Message[] {
  // Collect all tool_call IDs from assistant messages
  const toolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        toolCallIds.add(tc.id);
      }
    }
  }

  // Filter out orphaned tool results
  const validatedMessages: Message[] = [];
  let orphanCount = 0;

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      if (!toolCallIds.has(msg.tool_call_id)) {
        // Orphaned tool result - no matching tool_call
        orphanCount++;
        logger.warn(
          { tool_call_id: msg.tool_call_id },
          'Filtering orphaned tool result before LLM call'
        );
        continue; // Skip this message
      }
    }
    validatedMessages.push(msg);
  }

  if (orphanCount > 0) {
    logger.error(
      { orphanCount, totalMessages: messages.length },
      'Orphaned tool results detected - this indicates a bug in history slicing'
    );
  }

  return validatedMessages;
}
