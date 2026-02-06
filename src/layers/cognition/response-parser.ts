/**
 * Response Parser
 *
 * Parses LLM response content, handling both JSON schema and plain text.
 * Pure module — no state mutation.
 */

import type { ConversationStatus } from '../../types/cognition.js';

/**
 * Parse LLM response content, handling both JSON schema and plain text.
 * When toolChoice is 'none', we use JSON schema with {response: string, status?: string}.
 * Returns both the response text and optional conversation status.
 */
export function parseResponseContent(content: string | null): {
  text: string | null;
  status?: ConversationStatus;
  urgent?: boolean;
} {
  if (!content) {
    return { text: null };
  }

  const trimmed = content.trim();

  // Try to parse as JSON first (from JSON schema mode)
  try {
    let jsonStr = trimmed;

    // Handle markdown code blocks
    if (jsonStr.startsWith('```')) {
      const match = /```(?:json)?\s*([\s\S]*?)```/.exec(jsonStr);
      if (match) {
        jsonStr = match[1]?.trim() ?? jsonStr;
      }
    }

    // Try to find JSON object in response
    const jsonMatch = /\{[\s\S]*"response"[\s\S]*\}/.exec(jsonStr);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as {
      response?: string;
      status?: string;
      urgent?: boolean;
    };
    // Check for string type explicitly - empty string "" is a valid "no response" value
    // Using !== undefined because "" is falsy but valid
    if (parsed.response !== undefined && typeof parsed.response === 'string') {
      // Validate status if provided
      const validStatuses = ['active', 'awaiting_answer', 'closed', 'idle'];
      const status =
        parsed.status && validStatuses.includes(parsed.status)
          ? (parsed.status as ConversationStatus)
          : undefined;

      // Empty response means "don't send a message" - return null for text
      const responseText = parsed.response.trim() || null;

      const urgent = parsed.urgent === true;

      return { text: responseText, ...(status ? { status } : {}), ...(urgent ? { urgent } : {}) };
    }
  } catch {
    // Not JSON or parsing failed - use as plain text
  }

  // Fallback: use as plain text
  return { text: trimmed };
}
